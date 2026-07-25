import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  DatabaseClient,
  DatabasePool,
} from "../../../platform/db/pool.js";
import {
  createPublicOfficeProjector,
  type PublicOfficeProjector,
} from "../../public-office/application/public-office-projector.js";
import { ProtocolProblem } from "../domain/problem.js";
import {
  MAX_SAFE_SEQUENCE,
  type ActivityState,
  type DisplayState,
  type EdgeEvent,
  type EdgeReportAck,
  type PreparedEdgeReport,
  type StateTransitionEvent,
  type VerifiedEdgeContext,
} from "../domain/types.js";

interface InstanceRow extends QueryResultRow {
  id: string;
  logical_agent_id: string;
  status: "active" | "revoked";
  revoked_at: Date | null;
}

interface AgentRow extends QueryResultRow {
  id: string;
  alias: string;
  active_reporting_instance_id: string | null;
}

interface CredentialRow extends QueryResultRow {
  key_id: string;
  instance_id: string;
  public_key: Buffer;
}

interface HeadRow extends QueryResultRow {
  current_boot_id: string | null;
  current_boot_generation: string;
  last_server_received_at: Date | null;
}

interface BootRow extends QueryResultRow {
  boot_id: string;
  previous_boot_id: string | null;
  generation: string;
  next_sequence: string;
}

interface ReceiptRow extends QueryResultRow {
  canonical_sha256: Buffer;
  canonical_payload: Buffer;
  current_protocol: string;
  min_supported_protocol: string;
  instance_id: string;
  boot_id: string;
  last_sequence: string;
  server_received_at: Date;
  lease_expires_at: Date;
}

interface FingerprintRow extends QueryResultRow {
  sequence: string;
  canonical_event: Buffer;
}

interface PresenceRow extends QueryResultRow {
  boot_generation: string;
  boot_id: string;
  last_accepted_sequence: string;
  last_state_sequence: string;
  display_state: DisplayState;
  activity_state: ActivityState;
  pet_id: string;
  display_since: Date;
  activity_since: Date;
  eligible_since: Date | null;
  last_report_received_at: Date;
  lease_expires_at: Date;
  lease_closed_at: Date | null;
}

interface MutablePresence {
  lastAcceptedSequence: number;
  lastStateSequence: number;
  displayState: DisplayState;
  activityState: ActivityState;
  petId: string;
  displaySince: Date;
  activitySince: Date;
  eligibleSince: Date | null;
}

interface AffectedOfficeRow extends QueryResultRow {
  office_id: string;
}

export interface EdgeReportIngestor {
  ingest(
    report: PreparedEdgeReport,
    verified: VerifiedEdgeContext,
  ): Promise<EdgeReportAck>;
}

export function createEdgeReportIngestor(
  pool: DatabasePool,
  leaseTtlSeconds: number,
  publicOfficeProjector: PublicOfficeProjector =
    createPublicOfficeProjector(),
): EdgeReportIngestor {
  return {
    async ingest(
      report: PreparedEdgeReport,
      verified: VerifiedEdgeContext,
    ): Promise<EdgeReportAck> {
      assertVerifiedIdentity(report, verified);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED",
        );
        const ack = await ingestInTransaction(
          client,
          report,
          verified,
          leaseTtlSeconds,
          publicOfficeProjector,
        );
        await client.query("COMMIT");
        return ack;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (error instanceof ProtocolProblem) throw error;
        throw new ProtocolProblem(
          "internal_error",
          500,
          "The report could not be committed atomically.",
        );
      } finally {
        client.release();
      }
    },
  };
}

async function ingestInTransaction(
  client: DatabaseClient,
  report: PreparedEdgeReport,
  verified: VerifiedEdgeContext,
  leaseTtlSeconds: number,
  publicOfficeProjector: PublicOfficeProjector,
): Promise<EdgeReportAck> {
  const { envelope } = report;
  const instance = await lockInstance(client, verified.instanceId);
  const agent = await lockAgent(client, instance);
  await lockAndValidateCredential(client, verified);
  const head = await lockHead(client, instance.id);
  const currentGeneration = parseSafeInteger(
    head.current_boot_generation,
    "current boot generation",
    true,
  );

  const requestedBootId = normalizeUuid(envelope.boot_id);
  const requestedPreviousBootId = normalizeNullableUuid(
    envelope.previous_boot_id,
  );
  const requestedBoot = await findBoot(client, instance.id, requestedBootId);
  const isCurrentBoot = head.current_boot_id === requestedBootId;
  let boot: BootRow | null = requestedBoot;
  let bootGeneration = currentGeneration;
  let isNewBoot = false;

  if (!isCurrentBoot) {
    if (requestedBoot !== null) {
      throw staleBoot();
    }
    if (requestedPreviousBootId !== head.current_boot_id) {
      throw staleBoot();
    }
    if (report.endpoint === "heartbeat") {
      throw new ProtocolProblem(
        "report_semantics_invalid",
        422,
        "A heartbeat cannot establish a new boot.",
      );
    }
    if (envelope.first_sequence !== 1) {
      throw new ProtocolProblem(
        "sequence_gap",
        409,
        "A new boot must start at sequence 1.",
        1,
      );
    }
    if (envelope.events[0]?.kind !== "state_transition") {
      throw new ProtocolProblem(
        "report_semantics_invalid",
        422,
        "A new boot must start with a complete state transition snapshot.",
      );
    }
    if (currentGeneration >= MAX_SAFE_SEQUENCE) {
      throw new ProtocolProblem(
        "report_semantics_invalid",
        422,
        "The instance has exhausted its boot generation range.",
      );
    }
    bootGeneration = currentGeneration + 1;
    isNewBoot = true;
  } else {
    if (boot === null) {
      throw new ProtocolProblem(
        "internal_error",
        500,
        "The current boot head is inconsistent.",
      );
    }
    if (requestedPreviousBootId !== boot.previous_boot_id) {
      throw staleBoot();
    }
    bootGeneration = parseSafeInteger(boot.generation, "boot generation");
  }

  const lastSequence =
    envelope.first_sequence + envelope.events.length - 1;
  const expectedSequence =
    boot === null
      ? 1
      : parseSafeInteger(boot.next_sequence, "next sequence", true);

  if (!isNewBoot && envelope.first_sequence < expectedSequence) {
    const replay = await findReceipt(
      client,
      instance.id,
      bootGeneration,
      envelope.first_sequence,
      lastSequence,
    );
    if (replay !== null) {
      if (
        replay.canonical_sha256.equals(report.canonicalPayloadHash) &&
        replay.canonical_payload.equals(report.canonicalPayload)
      ) {
        return ackFromReceipt(replay);
      }
      throw sequenceProblem(
        "sequence_conflict",
        expectedSequence,
        "The accepted sequence range has different canonical content.",
      );
    }

    const fingerprints = await findFingerprints(
      client,
      instance.id,
      bootGeneration,
      envelope.first_sequence,
      lastSequence,
    );
    if (fingerprints.length === 0) {
      throw new ProtocolProblem(
        "internal_error",
        500,
        "Accepted sequence state is internally inconsistent.",
      );
    }
    const submittedBySequence = new Map(
      report.canonicalEvents.map((item) => [item.event.sequence, item.bytes]),
    );
    if (
      fingerprints.some((stored) => {
        const submitted = submittedBySequence.get(
          parseSafeInteger(stored.sequence, "stored sequence"),
        );
        return submitted !== undefined && !stored.canonical_event.equals(submitted);
      })
    ) {
      throw sequenceProblem(
        "sequence_conflict",
        expectedSequence,
        "At least one accepted sequence has different canonical content.",
      );
    }
    throw sequenceProblem(
      "sequence_overlap",
      expectedSequence,
      "The batch partially overlaps accepted sequences.",
    );
  }

  if (envelope.first_sequence > expectedSequence) {
    throw sequenceProblem(
      "sequence_gap",
      expectedSequence,
      "The batch starts after the next expected sequence.",
    );
  }

  // The Office lock is the settlement watermark: a tick either observes this
  // report's commit, or completes before this report receives its server time.
  const lockedOfficeIds = await lockAffectedOffices(client, agent.id);
  const serverReceivedAt = await nextServerReceivedAt(client, head);
  const leaseExpiresAt = new Date(
    serverReceivedAt.getTime() + leaseTtlSeconds * 1_000,
  );
  let presence = await lockPresence(client, instance.id);

  if (isNewBoot) {
    await fencePreviousBootAndPresence(
      client,
      instance.id,
      head.current_boot_id,
      presence,
      serverReceivedAt,
    );
    await createBootAndAdvanceHead(
      client,
      instance.id,
      requestedBootId,
      requestedPreviousBootId,
      currentGeneration,
      bootGeneration,
      serverReceivedAt,
    );
    boot = {
      boot_id: requestedBootId,
      previous_boot_id: requestedPreviousBootId,
      generation: String(bootGeneration),
      next_sequence: "1",
    };
    presence = null;
  }

  if (boot === null) {
    throw new ProtocolProblem(
      "internal_error",
      500,
      "The accepted boot was not materialized.",
    );
  }

  let leaseWasExpired = false;
  if (
    presence !== null &&
    presence.lease_expires_at.getTime() <= serverReceivedAt.getTime()
  ) {
    if (presence.lease_closed_at === null) {
      await closeOpenActivityInterval(
        client,
        instance.id,
        presence.lease_expires_at,
        parseSafeInteger(
          presence.last_accepted_sequence,
          "last accepted sequence",
        ),
        "lease_expired",
      );
    }
    leaseWasExpired = true;
  }

  const receiptId = randomUUID();
  await insertReceipt(
    client,
    receiptId,
    report,
    verified,
    bootGeneration,
    lastSequence,
    serverReceivedAt,
    leaseExpiresAt,
  );
  await insertFingerprints(client, receiptId, bootGeneration, report);

  const updatedPresence = await applyEvents(
    client,
    instance.id,
    bootGeneration,
    report.envelope.events,
    presence,
    isNewBoot || leaseWasExpired,
    serverReceivedAt,
  );
  await savePresence(
    client,
    instance.id,
    bootGeneration,
    requestedBootId,
    updatedPresence,
    serverReceivedAt,
    leaseExpiresAt,
  );

  await client.query(
    `UPDATE control_plane.agent_instance_boots
        SET next_sequence = $3,
            last_accepted_at = $4
      WHERE instance_id = $1
        AND generation = $2`,
    [instance.id, bootGeneration, lastSequence + 1, serverReceivedAt],
  );
  await client.query(
    `UPDATE control_plane.edge_instance_heads
        SET last_server_received_at = $2
      WHERE instance_id = $1`,
    [instance.id, serverReceivedAt],
  );

  await appendOfficeRevisionEvents(
    client,
    publicOfficeProjector,
    receiptId,
    lockedOfficeIds,
    serverReceivedAt,
  );

  return {
    current_protocol: 1,
    min_supported_protocol: 1,
    instance_id: instance.id,
    boot_id: requestedBootId,
    accepted_through_sequence: lastSequence,
    server_received_at: serverReceivedAt.toISOString(),
    lease_expires_at: leaseExpiresAt.toISOString(),
  };
}

function assertVerifiedIdentity(
  report: PreparedEdgeReport,
  verified: VerifiedEdgeContext,
): void {
  if (
    normalizeUuid(verified.instanceId) !==
      normalizeUuid(report.envelope.instance_id) ||
    normalizeUuid(verified.keyId) !== normalizeUuid(report.envelope.key_id)
  ) {
    throw new ProtocolProblem(
      "invalid_signature",
      401,
      "The verified device identity does not match the report envelope.",
    );
  }
}

async function lockInstance(
  client: DatabaseClient,
  instanceId: string,
): Promise<InstanceRow> {
  const result = await client.query<InstanceRow>(
    `SELECT id, logical_agent_id, status, revoked_at
       FROM control_plane.agent_instances
      WHERE id = $1
      FOR UPDATE`,
    [instanceId],
  );
  const instance = result.rows[0];
  if (instance === undefined) {
    throw new ProtocolProblem(
      "instance_not_found",
      401,
      "The Agent instance or device credential is unavailable.",
    );
  }
  if (instance.status !== "active" || instance.revoked_at !== null) {
    throw new ProtocolProblem(
      "device_revoked",
      401,
      "The Agent instance or device credential is unavailable.",
    );
  }
  return instance;
}

async function lockAgent(
  client: DatabaseClient,
  instance: InstanceRow,
): Promise<AgentRow> {
  const result = await client.query<AgentRow>(
    `SELECT id, alias, active_reporting_instance_id
       FROM control_plane.logical_agents
      WHERE id = $1
      FOR UPDATE`,
    [instance.logical_agent_id],
  );
  const agent = result.rows[0];
  if (
    agent === undefined ||
    agent.active_reporting_instance_id !== instance.id
  ) {
    throw new ProtocolProblem(
      "device_revoked",
      401,
      "The Agent instance is not the active reporting instance.",
    );
  }
  return agent;
}

async function lockAndValidateCredential(
  client: DatabaseClient,
  verified: VerifiedEdgeContext,
): Promise<void> {
  const result = await client.query<CredentialRow>(
    `SELECT key_id, instance_id, public_key
       FROM control_plane.device_credentials
      WHERE key_id = $1
        AND instance_id = $2
        AND revoked_at IS NULL
        AND valid_until > clock_timestamp()
      FOR UPDATE`,
    [verified.keyId, verified.instanceId],
  );
  const credential = result.rows[0];
  if (credential === undefined) {
    throw new ProtocolProblem(
      "device_revoked",
      401,
      "The Agent instance or device credential is unavailable.",
    );
  }
  if (verified.credentialPublicKeySha256 !== undefined) {
    const lockedFingerprint = createHash("sha256")
      .update(credential.public_key)
      .digest();
    if (!lockedFingerprint.equals(verified.credentialPublicKeySha256)) {
      throw new ProtocolProblem(
        "invalid_signature",
        401,
        "The verified public key changed before the report was committed.",
      );
    }
  }
}

async function lockHead(
  client: DatabaseClient,
  instanceId: string,
): Promise<HeadRow> {
  const result = await client.query<HeadRow>(
    `SELECT current_boot_id, current_boot_generation, last_server_received_at
       FROM control_plane.edge_instance_heads
      WHERE instance_id = $1
      FOR UPDATE`,
    [instanceId],
  );
  const head = result.rows[0];
  if (head === undefined) {
    throw new ProtocolProblem(
      "internal_error",
      500,
      "The Agent instance has no ingestion head.",
    );
  }
  return head;
}

async function findBoot(
  client: DatabaseClient,
  instanceId: string,
  bootId: string,
): Promise<BootRow | null> {
  const result = await client.query<BootRow>(
    `SELECT boot_id, previous_boot_id, generation, next_sequence
       FROM control_plane.agent_instance_boots
      WHERE instance_id = $1
        AND boot_id = $2
      FOR UPDATE`,
    [instanceId, bootId],
  );
  return result.rows[0] ?? null;
}

async function findReceipt(
  client: DatabaseClient,
  instanceId: string,
  bootGeneration: number,
  firstSequence: number,
  lastSequence: number,
): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    `SELECT canonical_sha256, canonical_payload,
            current_protocol, min_supported_protocol,
            instance_id, boot_id, last_sequence,
            server_received_at, lease_expires_at
       FROM control_plane.edge_report_receipts
      WHERE instance_id = $1
        AND boot_generation = $2
        AND first_sequence = $3
        AND last_sequence = $4`,
    [instanceId, bootGeneration, firstSequence, lastSequence],
  );
  return result.rows[0] ?? null;
}

async function findFingerprints(
  client: DatabaseClient,
  instanceId: string,
  bootGeneration: number,
  firstSequence: number,
  lastSequence: number,
): Promise<FingerprintRow[]> {
  const result = await client.query<FingerprintRow>(
    `SELECT sequence, canonical_event
       FROM control_plane.edge_event_fingerprints
      WHERE instance_id = $1
        AND boot_generation = $2
        AND sequence BETWEEN $3 AND $4
      ORDER BY sequence`,
    [instanceId, bootGeneration, firstSequence, lastSequence],
  );
  return result.rows;
}

async function nextServerReceivedAt(
  client: DatabaseClient,
  head: HeadRow,
): Promise<Date> {
  const result = await client.query<{ server_received_at: Date }>(
    `SELECT GREATEST(
              clock_timestamp(),
              COALESCE($1::timestamptz, '-infinity'::timestamptz)
            ) AS server_received_at`,
    [head.last_server_received_at],
  );
  const receivedAt = result.rows[0]?.server_received_at;
  if (receivedAt === undefined) {
    throw new Error("Database did not provide server_received_at");
  }
  return receivedAt;
}

async function lockAffectedOffices(
  client: DatabaseClient,
  logicalAgentId: string,
): Promise<string[]> {
  const offices = await client.query<AffectedOfficeRow>(
    `SELECT office.id AS office_id
       FROM control_plane.agent_office_mounts mount
       JOIN control_plane.offices office
         ON office.id = mount.office_id
      WHERE mount.logical_agent_id = $1
        AND mount.active
        AND (mount.presence_visible OR mount.stats_opt_in)
      ORDER BY office.id
      FOR UPDATE OF office`,
    [logicalAgentId],
  );
  return offices.rows.map((office) => office.office_id);
}

async function lockPresence(
  client: DatabaseClient,
  instanceId: string,
): Promise<PresenceRow | null> {
  const result = await client.query<PresenceRow>(
    `SELECT boot_generation, boot_id,
            last_accepted_sequence, last_state_sequence,
            display_state, activity_state, pet_id,
            display_since, activity_since, eligible_since,
            last_report_received_at, lease_expires_at, lease_closed_at
       FROM control_plane.current_presence
      WHERE instance_id = $1
      FOR UPDATE`,
    [instanceId],
  );
  return result.rows[0] ?? null;
}

async function fencePreviousBootAndPresence(
  client: DatabaseClient,
  instanceId: string,
  previousBootId: string | null,
  presence: PresenceRow | null,
  serverReceivedAt: Date,
): Promise<void> {
  if (previousBootId !== null) {
    await client.query(
      `UPDATE control_plane.agent_instance_boots
          SET fenced_at = $3
        WHERE instance_id = $1
          AND boot_id = $2
          AND fenced_at IS NULL`,
      [instanceId, previousBootId, serverReceivedAt],
    );
    await scrubFencedBootReplayMaterial(client, instanceId, previousBootId);
  }
  if (presence !== null) {
    const leaseExpired =
      presence.lease_expires_at.getTime() <= serverReceivedAt.getTime();
    if (!leaseExpired || presence.lease_closed_at === null) {
      await closeOpenActivityInterval(
        client,
        instanceId,
        leaseExpired ? presence.lease_expires_at : serverReceivedAt,
        parseSafeInteger(
          presence.last_accepted_sequence,
          "last accepted sequence",
        ),
        leaseExpired ? "lease_expired" : "boot_replaced",
      );
    }
    await client.query(
      `DELETE FROM control_plane.current_presence
        WHERE instance_id = $1`,
      [instanceId],
    );
  }
}

async function scrubFencedBootReplayMaterial(
  client: DatabaseClient,
  instanceId: string,
  bootId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM control_plane.edge_event_fingerprints
      WHERE instance_id = $1
        AND boot_generation = (
          SELECT generation
            FROM control_plane.agent_instance_boots
           WHERE instance_id = $1
             AND boot_id = $2
        )`,
    [instanceId, bootId],
  );
  await client.query(
    `UPDATE control_plane.edge_report_receipts
        SET canonical_payload = ''::bytea
      WHERE instance_id = $1
        AND boot_id = $2`,
    [instanceId, bootId],
  );
}

async function createBootAndAdvanceHead(
  client: DatabaseClient,
  instanceId: string,
  bootId: string,
  previousBootId: string | null,
  previousGeneration: number,
  generation: number,
  serverReceivedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO control_plane.agent_instance_boots (
       instance_id, generation, boot_id, previous_boot_id,
       next_sequence, first_accepted_at, last_accepted_at
     ) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [instanceId, generation, bootId, previousBootId, serverReceivedAt],
  );
  const result = await client.query(
    `UPDATE control_plane.edge_instance_heads
        SET current_boot_id = $4,
            current_boot_generation = $3
      WHERE instance_id = $1
        AND current_boot_generation = $2
        AND current_boot_id IS NOT DISTINCT FROM $5`,
    [instanceId, previousGeneration, generation, bootId, previousBootId],
  );
  if (result.rowCount !== 1) {
    throw staleBoot();
  }
}

async function insertReceipt(
  client: DatabaseClient,
  receiptId: string,
  report: PreparedEdgeReport,
  verified: VerifiedEdgeContext,
  bootGeneration: number,
  lastSequence: number,
  serverReceivedAt: Date,
  leaseExpiresAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO control_plane.edge_report_receipts (
       id, instance_id, boot_generation, boot_id, key_id,
       first_sequence, last_sequence, event_count,
       canonical_sha256, canonical_payload,
       sent_at, client_version,
       server_received_at, lease_expires_at,
       current_protocol, min_supported_protocol
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10,
       $11, $12,
       $13, $14,
       1, 1
     )`,
    [
      receiptId,
      verified.instanceId,
      bootGeneration,
      report.envelope.boot_id,
      verified.keyId,
      report.envelope.first_sequence,
      lastSequence,
      report.envelope.events.length,
      report.canonicalPayloadHash,
      report.canonicalPayload,
      report.envelope.sent_at,
      report.envelope.client_version,
      serverReceivedAt,
      leaseExpiresAt,
    ],
  );
}

async function insertFingerprints(
  client: DatabaseClient,
  receiptId: string,
  bootGeneration: number,
  report: PreparedEdgeReport,
): Promise<void> {
  for (const canonical of report.canonicalEvents) {
    const event = canonical.event;
    const state =
      event.kind === "state_transition"
        ? event
        : null;
    await client.query(
      `INSERT INTO control_plane.edge_event_fingerprints (
         instance_id, boot_generation, sequence, receipt_id,
         kind, canonical_sha256, canonical_event, observed_at,
         display_state, activity_state, pet_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        report.envelope.instance_id,
        bootGeneration,
        event.sequence,
        receiptId,
        event.kind,
        canonical.hash,
        canonical.bytes,
        event.observed_at,
        state?.display_state ?? null,
        state?.activity_state ?? null,
        state?.pet_id ?? null,
      ],
    );
  }
}

async function applyEvents(
  client: DatabaseClient,
  instanceId: string,
  bootGeneration: number,
  events: EdgeEvent[],
  prior: PresenceRow | null,
  leaseBoundaryBroken: boolean,
  serverReceivedAt: Date,
): Promise<MutablePresence> {
  let current = prior === null ? null : mutablePresence(prior);
  let needsOpenInterval = leaseBoundaryBroken;

  for (const event of events) {
    if (event.kind === "heartbeat") {
      if (current === null) {
        throw new ProtocolProblem(
          "internal_error",
          500,
          "A heartbeat has no current presence snapshot.",
        );
      }
      if (needsOpenInterval) {
        await openActivityInterval(
          client,
          instanceId,
          bootGeneration,
          current.activityState,
          event.sequence,
          serverReceivedAt,
        );
        if (current.activityState === "eligible_idle") {
          current.eligibleSince = serverReceivedAt;
        }
        needsOpenInterval = false;
      }
      current.lastAcceptedSequence = event.sequence;
      continue;
    }

    const previousActivity = current?.activityState;
    const activityChanged =
      current === null || previousActivity !== event.activity_state;
    if (activityChanged && !needsOpenInterval && current !== null) {
      await closeOpenActivityInterval(
        client,
        instanceId,
        serverReceivedAt,
        event.sequence,
        "state_changed",
      );
    }
    if (activityChanged || needsOpenInterval) {
      await openActivityInterval(
        client,
        instanceId,
        bootGeneration,
        event.activity_state,
        event.sequence,
        serverReceivedAt,
      );
      needsOpenInterval = false;
    }

    current = applyStateTransition(
      current,
      event,
      serverReceivedAt,
      leaseBoundaryBroken || activityChanged,
    );
  }

  if (current === null) {
    throw new ProtocolProblem(
      "internal_error",
      500,
      "The report did not produce a current presence snapshot.",
    );
  }
  return current;
}

function applyStateTransition(
  current: MutablePresence | null,
  event: StateTransitionEvent,
  at: Date,
  resetEligibleBoundary: boolean,
): MutablePresence {
  const displayChanged =
    current === null || current.displayState !== event.display_state;
  const activityChanged =
    current === null || current.activityState !== event.activity_state;
  let eligibleSince: Date | null = null;
  if (event.activity_state === "eligible_idle") {
    eligibleSince =
      !resetEligibleBoundary &&
      current?.activityState === "eligible_idle" &&
      current.eligibleSince !== null
        ? current.eligibleSince
        : at;
  }
  return {
    lastAcceptedSequence: event.sequence,
    lastStateSequence: event.sequence,
    displayState: event.display_state,
    activityState: event.activity_state,
    petId: event.pet_id,
    displaySince: displayChanged ? at : (current?.displaySince ?? at),
    activitySince: activityChanged ? at : (current?.activitySince ?? at),
    eligibleSince,
  };
}

function mutablePresence(row: PresenceRow): MutablePresence {
  return {
    lastAcceptedSequence: parseSafeInteger(
      row.last_accepted_sequence,
      "last accepted sequence",
    ),
    lastStateSequence: parseSafeInteger(
      row.last_state_sequence,
      "last state sequence",
    ),
    displayState: row.display_state,
    activityState: row.activity_state,
    petId: row.pet_id,
    displaySince: row.display_since,
    activitySince: row.activity_since,
    eligibleSince: row.eligible_since,
  };
}

async function closeOpenActivityInterval(
  client: DatabaseClient,
  instanceId: string,
  endedAt: Date,
  endSequence: number,
  closeReason:
    | "state_changed"
    | "lease_expired"
    | "boot_replaced"
    | "instance_revoked"
    | "retention",
): Promise<void> {
  const result = await client.query(
    `UPDATE control_plane.derived_activity_intervals
        SET ended_at = $2,
            end_sequence = $3,
            close_reason = $4
      WHERE instance_id = $1
        AND ended_at IS NULL`,
    [instanceId, endedAt, endSequence, closeReason],
  );
  if (result.rowCount !== 1) {
    throw new Error("Expected exactly one open activity interval");
  }
}

async function openActivityInterval(
  client: DatabaseClient,
  instanceId: string,
  bootGeneration: number,
  activityState: ActivityState,
  startSequence: number,
  startedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO control_plane.derived_activity_intervals (
       id, instance_id, boot_generation, activity_state,
       started_at, start_sequence
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      instanceId,
      bootGeneration,
      activityState,
      startedAt,
      startSequence,
    ],
  );
}

async function savePresence(
  client: DatabaseClient,
  instanceId: string,
  bootGeneration: number,
  bootId: string,
  presence: MutablePresence,
  serverReceivedAt: Date,
  leaseExpiresAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO control_plane.current_presence (
       instance_id, boot_generation, boot_id,
       last_accepted_sequence, last_state_sequence,
       display_state, activity_state, pet_id,
       display_since, activity_since, eligible_since,
       last_report_received_at, lease_expires_at, lease_closed_at
     ) VALUES (
       $1, $2, $3,
       $4, $5,
       $6, $7, $8,
       $9, $10, $11,
       $12, $13, NULL
     )
     ON CONFLICT (instance_id) DO UPDATE
       SET boot_generation = EXCLUDED.boot_generation,
           boot_id = EXCLUDED.boot_id,
           last_accepted_sequence = EXCLUDED.last_accepted_sequence,
           last_state_sequence = EXCLUDED.last_state_sequence,
           display_state = EXCLUDED.display_state,
           activity_state = EXCLUDED.activity_state,
           pet_id = EXCLUDED.pet_id,
           display_since = EXCLUDED.display_since,
           activity_since = EXCLUDED.activity_since,
           eligible_since = EXCLUDED.eligible_since,
           last_report_received_at = EXCLUDED.last_report_received_at,
           lease_expires_at = EXCLUDED.lease_expires_at,
           lease_closed_at = NULL`,
    [
      instanceId,
      bootGeneration,
      bootId,
      presence.lastAcceptedSequence,
      presence.lastStateSequence,
      presence.displayState,
      presence.activityState,
      presence.petId,
      presence.displaySince,
      presence.activitySince,
      presence.eligibleSince,
      serverReceivedAt,
      leaseExpiresAt,
    ],
  );
}

async function appendOfficeRevisionEvents(
  client: DatabaseClient,
  publicOfficeProjector: PublicOfficeProjector,
  receiptId: string,
  lockedOfficeIds: readonly string[],
  serverReceivedAt: Date,
): Promise<void> {
  for (const officeId of lockedOfficeIds) {
    await publicOfficeProjector.recordRevision(client, {
      officeId,
      eventType: "presence_changed",
      sourceKind: "edge_receipt",
      sourceKey: receiptId,
      sourceReceiptId: receiptId,
      at: serverReceivedAt,
    });
  }
}

function ackFromReceipt(receipt: ReceiptRow): EdgeReportAck {
  return {
    current_protocol: parseSafeInteger(
      receipt.current_protocol,
      "current protocol",
    ),
    min_supported_protocol: parseSafeInteger(
      receipt.min_supported_protocol,
      "minimum supported protocol",
    ),
    instance_id: receipt.instance_id,
    boot_id: receipt.boot_id,
    accepted_through_sequence: parseSafeInteger(
      receipt.last_sequence,
      "last sequence",
    ),
    server_received_at: receipt.server_received_at.toISOString(),
    lease_expires_at: receipt.lease_expires_at.toISOString(),
  };
}

function parseSafeInteger(
  value: string | number | undefined,
  label: string,
  allowOnePastMaximum = false,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const maximum = allowOnePastMaximum
    ? MAX_SAFE_SEQUENCE + 1
    : MAX_SAFE_SEQUENCE;
  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > maximum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

function normalizeNullableUuid(value: string | null): string | null {
  return value === null ? null : normalizeUuid(value);
}

function staleBoot(): ProtocolProblem {
  return new ProtocolProblem(
    "stale_boot",
    409,
    "The report boot is not the instance's current CAS-linked boot.",
  );
}

function sequenceProblem(
  code: "sequence_gap" | "sequence_overlap" | "sequence_conflict",
  expectedSequence: number,
  detail: string,
): ProtocolProblem {
  return new ProtocolProblem(
    code,
    409,
    detail,
    expectedSequence <= MAX_SAFE_SEQUENCE ? expectedSequence : undefined,
  );
}
