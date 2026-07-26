import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  DatabaseClient,
  DatabasePool,
} from "../../../platform/db/pool.js";
import { digestCapability } from "../../identity/domain/capability.js";
import type { ClaimPairingInput } from "../../onboarding/domain/input.js";
import { OnboardingProblem } from "../../onboarding/domain/problem.js";
import { consumeOnboardingRateLimit } from "../../onboarding/application/ip-rate-limit.js";

const CREDENTIAL_LIFETIME_DAYS = 180;
const MAX_FAILED_PAIRING_ATTEMPTS = 8;

interface PairingRow extends QueryResultRow {
  id: string;
  logical_agent_id: string;
  status: "pending" | "claimed";
  failed_claim_attempts: number;
  expires_at: Date;
  claimed_public_key_hash: Buffer | null;
  claimed_instance_id: string | null;
  claimed_key_id: string | null;
  claimed_at: Date | null;
}

interface ClaimedCredentialRow extends QueryResultRow {
  valid_until: Date;
}

interface ServerIdentityRow extends QueryResultRow {
  server_id: string;
}

interface ClockRow extends QueryResultRow {
  now: Date;
  valid_until: Date;
}

export interface ClaimPairingResult {
  server_id: string;
  instance_id: string;
  key_id: string;
  logical_agent_id: string;
  heartbeat_interval_seconds: number;
  credential_valid_until: string;
}

export async function claimPairing(
  pool: DatabasePool,
  input: ClaimPairingInput,
  ip: string,
  heartbeatIntervalSeconds: number,
): Promise<ClaimPairingResult> {
  await consumeOnboardingRateLimit(pool, ip, "claim");
  const client = await pool.connect();
  let committedProblem: OnboardingProblem | undefined;
  try {
    await client.query("BEGIN");
    const clock = await claimClock(client);
    const pairingResult = await client.query<PairingRow>(
      `SELECT
         id,
         logical_agent_id,
         status,
         failed_claim_attempts,
         expires_at,
         claimed_public_key_hash,
         claimed_instance_id,
         claimed_key_id,
         claimed_at
       FROM control_plane.onboarding_pairings
       WHERE pairing_code_hash = $1
       FOR UPDATE`,
      [digestCapability(input.pairingCode)],
    );
    const pairing = pairingResult.rows[0];
    if (pairing === undefined) {
      await client.query("COMMIT");
      committedProblem = new OnboardingProblem(
        "pairing_not_found",
        404,
        "The pairing is unavailable.",
      );
      throw committedProblem;
    }

    const publicKeyHash = createHash("sha256")
      .update(input.publicKey)
      .digest();
    if (pairing.status === "claimed") {
      if (
        pairing.claimed_public_key_hash === null ||
        !pairing.claimed_public_key_hash.equals(publicKeyHash) ||
        pairing.claimed_instance_id === null ||
        pairing.claimed_key_id === null
      ) {
        await recordFailedAttempt(client, pairing);
        await client.query("COMMIT");
        committedProblem = pairingConflict();
        throw committedProblem;
      }
      const credential = await loadClaimedCredential(client, pairing);
      const serverId = await loadServerId(client);
      await client.query("COMMIT");
      return claimResult(
        serverId,
        pairing.claimed_instance_id,
        pairing.claimed_key_id,
        pairing.logical_agent_id,
        heartbeatIntervalSeconds,
        credential.valid_until,
      );
    }

    if (pairing.expires_at.getTime() <= clock.now.getTime()) {
      await recordFailedAttempt(client, pairing);
      await client.query("COMMIT");
      committedProblem = new OnboardingProblem(
        "pairing_expired",
        410,
        "The pairing has expired.",
      );
      throw committedProblem;
    }
    if (pairing.failed_claim_attempts >= MAX_FAILED_PAIRING_ATTEMPTS) {
      await client.query("COMMIT");
      committedProblem = new OnboardingProblem(
        "rate_limited",
        429,
        "Too many attempts for this pairing.",
        300,
      );
      throw committedProblem;
    }

    const active = await client.query<{ active_reporting_instance_id: string | null }>(
      `SELECT active_reporting_instance_id
         FROM control_plane.logical_agents
        WHERE id = $1
        FOR UPDATE`,
      [pairing.logical_agent_id],
    );
    const agent = active.rows[0];
    if (agent === undefined) throw new Error("Pairing logical Agent is missing");
    if (agent.active_reporting_instance_id !== null) {
      throw pairingConflict();
    }

    const instanceId = randomUUID();
    const keyId = randomUUID();
    await client.query(
      `INSERT INTO control_plane.agent_instances (
         id, logical_agent_id, created_at
       ) VALUES ($1, $2, $3)`,
      [instanceId, pairing.logical_agent_id, clock.now],
    );
    try {
      await client.query(
        `INSERT INTO control_plane.device_credentials (
           key_id, instance_id, public_key, created_at, valid_until
         ) VALUES ($1, $2, $3, $4, $5)`,
        [keyId, instanceId, input.publicKey, clock.now, clock.valid_until],
      );
    } catch (error) {
      if (postgresCode(error) === "23505") throw pairingConflict();
      throw error;
    }
    await client.query(
      `INSERT INTO control_plane.edge_instance_heads (instance_id)
       VALUES ($1)`,
      [instanceId],
    );
    await client.query(
      `UPDATE control_plane.logical_agents
          SET active_reporting_instance_id = $2
        WHERE id = $1`,
      [pairing.logical_agent_id, instanceId],
    );
    await client.query(
      `UPDATE control_plane.onboarding_pairings
          SET status = 'claimed',
              claimed_public_key_hash = $2,
              claimed_instance_id = $3,
              claimed_key_id = $4,
              claimed_client_version = $5,
              claimed_at = $6
        WHERE id = $1`,
      [
        pairing.id,
        publicKeyHash,
        instanceId,
        keyId,
        input.clientVersion,
        clock.now,
      ],
    );
    const serverId = await loadServerId(client);
    await client.query("COMMIT");
    return claimResult(
      serverId,
      instanceId,
      keyId,
      pairing.logical_agent_id,
      heartbeatIntervalSeconds,
      clock.valid_until,
    );
  } catch (error) {
    if (error !== committedProblem) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function claimClock(client: DatabaseClient): Promise<ClockRow> {
  const result = await client.query<ClockRow>(
    `SELECT
       clock_timestamp() AS now,
       clock_timestamp() + ($1::text || ' days')::interval AS valid_until`,
    [CREDENTIAL_LIFETIME_DAYS],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Database did not provide claim time");
  return row;
}

async function recordFailedAttempt(
  client: DatabaseClient,
  pairing: PairingRow,
): Promise<void> {
  await client.query(
    `UPDATE control_plane.onboarding_pairings
        SET failed_claim_attempts = LEAST(32, failed_claim_attempts + 1)
      WHERE id = $1`,
    [pairing.id],
  );
}

async function loadClaimedCredential(
  client: DatabaseClient,
  pairing: PairingRow,
): Promise<ClaimedCredentialRow> {
  const result = await client.query<ClaimedCredentialRow>(
    `SELECT valid_until
       FROM control_plane.device_credentials
      WHERE key_id = $1
        AND instance_id = $2
        AND revoked_at IS NULL`,
    [pairing.claimed_key_id, pairing.claimed_instance_id],
  );
  const credential = result.rows[0];
  if (credential === undefined) {
    throw new Error("Claimed pairing credential is unavailable");
  }
  return credential;
}

async function loadServerId(client: DatabaseClient): Promise<string> {
  const result = await client.query<ServerIdentityRow>(
    `SELECT server_id FROM control_plane.server_identity WHERE singleton`,
  );
  const serverId = result.rows[0]?.server_id;
  if (serverId === undefined) throw new Error("Control Plane server ID is missing");
  return serverId;
}

function claimResult(
  serverId: string,
  instanceId: string,
  keyId: string,
  logicalAgentId: string,
  heartbeatIntervalSeconds: number,
  validUntil: Date,
): ClaimPairingResult {
  return {
    server_id: serverId,
    instance_id: instanceId,
    key_id: keyId,
    logical_agent_id: logicalAgentId,
    heartbeat_interval_seconds: heartbeatIntervalSeconds,
    credential_valid_until: validUntil.toISOString(),
  };
}

function pairingConflict(): OnboardingProblem {
  return new OnboardingProblem(
    "pairing_conflict",
    409,
    "The pairing was claimed by another device key.",
  );
}

function postgresCode(error: unknown): unknown {
  if (error !== null && typeof error === "object" && "code" in error) {
    return error.code;
  }
  return undefined;
}
