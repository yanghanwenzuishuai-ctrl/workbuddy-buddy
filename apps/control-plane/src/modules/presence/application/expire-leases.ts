import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  DatabaseClient,
  DatabasePool,
} from "../../../platform/db/pool.js";
import { MAX_SAFE_SEQUENCE } from "../domain/types.js";

interface CandidateRow extends QueryResultRow {
  instance_id: string;
}

interface InstanceRow extends QueryResultRow {
  logical_agent_id: string;
}

interface PresenceRow extends QueryResultRow {
  last_accepted_sequence: string;
  pet_id: string;
  lease_expires_at: Date;
  lease_closed_at: Date | null;
}

interface MountRow extends QueryResultRow {
  id: string;
  office_id: string;
  room_id: string;
  scene_slot: number | null;
  alias: string;
}

export async function expireDueLeases(
  pool: DatabasePool,
  limit = 100,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Lease sweep limit must be between 1 and 1000");
  }
  const candidates = await pool.query<CandidateRow>(
    `SELECT instance_id
       FROM control_plane.current_presence
      WHERE lease_closed_at IS NULL
        AND lease_expires_at <= clock_timestamp()
      ORDER BY lease_expires_at, instance_id
      LIMIT $1`,
    [limit],
  );

  let expired = 0;
  for (const candidate of candidates.rows) {
    if (await expireOneLease(pool, candidate.instance_id)) expired += 1;
  }
  return expired;
}

async function expireOneLease(
  pool: DatabasePool,
  instanceId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED");

    const instanceResult = await client.query<InstanceRow>(
      `SELECT logical_agent_id
         FROM control_plane.agent_instances
        WHERE id = $1
        FOR UPDATE`,
      [instanceId],
    );
    const instance = instanceResult.rows[0];
    if (instance === undefined) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `SELECT id
         FROM control_plane.logical_agents
        WHERE id = $1
        FOR UPDATE`,
      [instance.logical_agent_id],
    );
    await client.query(
      `SELECT instance_id
         FROM control_plane.edge_instance_heads
        WHERE instance_id = $1
        FOR UPDATE`,
      [instanceId],
    );
    const presenceResult = await client.query<PresenceRow>(
      `SELECT last_accepted_sequence, pet_id,
              lease_expires_at, lease_closed_at
         FROM control_plane.current_presence
        WHERE instance_id = $1
        FOR UPDATE`,
      [instanceId],
    );
    const presence = presenceResult.rows[0];
    if (
      presence === undefined ||
      presence.lease_closed_at !== null ||
      !(await leaseIsDue(client, presence.lease_expires_at))
    ) {
      await client.query("COMMIT");
      return false;
    }

    const lastAcceptedSequence = parseSafeSequence(
      presence.last_accepted_sequence,
    );
    const intervalResult = await client.query(
      `UPDATE control_plane.derived_activity_intervals
          SET ended_at = $2,
              end_sequence = $3,
              close_reason = 'lease_expired'
        WHERE instance_id = $1
          AND ended_at IS NULL`,
      [instanceId, presence.lease_expires_at, lastAcceptedSequence],
    );
    if (intervalResult.rowCount !== 1) {
      throw new Error("Expected exactly one open activity interval");
    }
    await client.query(
      `UPDATE control_plane.current_presence
          SET lease_closed_at = lease_expires_at
        WHERE instance_id = $1`,
      [instanceId],
    );
    await appendOfflineOfficeRevisions(
      client,
      instance.logical_agent_id,
      instanceId,
      presence.pet_id,
      presence.lease_expires_at,
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function leaseIsDue(
  client: DatabaseClient,
  leaseExpiresAt: Date,
): Promise<boolean> {
  const result = await client.query<{ due: boolean }>(
    `SELECT $1::timestamptz <= clock_timestamp() AS due`,
    [leaseExpiresAt],
  );
  return result.rows[0]?.due === true;
}

async function appendOfflineOfficeRevisions(
  client: DatabaseClient,
  logicalAgentId: string,
  instanceId: string,
  petId: string,
  leaseExpiresAt: Date,
): Promise<void> {
  const mounts = await client.query<MountRow>(
    `SELECT m.id, m.office_id, m.room_id, m.scene_slot, a.alias
       FROM control_plane.agent_office_mounts m
       JOIN control_plane.logical_agents a ON a.id = m.logical_agent_id
       JOIN control_plane.offices o ON o.id = m.office_id
      WHERE m.logical_agent_id = $1
        AND m.active
        AND m.presence_visible
      ORDER BY m.office_id
      FOR UPDATE OF o`,
    [logicalAgentId],
  );
  const sourceKey = `lease:${instanceId}:${leaseExpiresAt.toISOString()}`;

  for (const mount of mounts.rows) {
    const revisionResult = await client.query<{ revision: string }>(
      `UPDATE control_plane.offices
          SET revision = revision + 1
        WHERE id = $1
        RETURNING revision`,
      [mount.office_id],
    );
    const revision = parseSafeSequence(revisionResult.rows[0]?.revision, true);
    const publicPayload = {
      mount_id: mount.id,
      room_id: mount.room_id,
      alias: mount.alias,
      pet_id: petId,
      presence: "offline",
      display_state: null,
      idle_stage: "none",
      scene_slot: mount.scene_slot,
    };
    await client.query(
      `INSERT INTO control_plane.office_revision_events (
         office_id, revision, event_type, public_payload, created_at
       ) VALUES ($1, $2, 'presence_removed', $3, $4)`,
      [mount.office_id, revision, publicPayload, leaseExpiresAt],
    );
    await client.query(
      `INSERT INTO control_plane.domain_outbox (
         id, office_id, office_revision,
         source_kind, source_key, source_receipt_id,
         effect_kind, public_payload, created_at
       ) VALUES (
         $1, $2, $3,
         'lease_expiry', $4, NULL,
         'office_revision', $5, $6
       )`,
      [
        randomUUID(),
        mount.office_id,
        revision,
        sourceKey,
        publicPayload,
        leaseExpiresAt,
      ],
    );
  }
}

function parseSafeSequence(
  value: string | number | undefined,
  allowZero = false,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1) ||
    parsed > MAX_SAFE_SEQUENCE
  ) {
    throw new Error("Invalid database sequence");
  }
  return parsed;
}
