import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  DatabaseClient,
  DatabasePool,
} from "../../../platform/db/pool.js";
import { claimPairing, type ClaimPairingResult } from "../../enrollment/application/claim-pairing.js";
import { issueCapability, digestCapability } from "../../identity/domain/capability.js";
import type {
  ClaimPairingInput,
  CreateOfficeOnboardingInput,
} from "../domain/input.js";
import { OnboardingProblem } from "../domain/problem.js";
import type { PublicOfficeProjector } from "../../public-office/application/public-office-projector.js";
import { consumeOnboardingRateLimit } from "./ip-rate-limit.js";

const PAIRING_LIFETIME_MINUTES = 5;

interface ClockRow extends QueryResultRow {
  now: Date;
  expires_at: Date;
}

interface StatusRow extends QueryResultRow {
  status: "pending" | "claimed";
  expires_at: Date;
  now: Date;
}

export interface CreateOfficeOnboardingResult {
  pairing_code: string;
  status_token: string;
  expires_at: string;
  office_url: string;
}

export interface PairingStatusResult {
  status: "pending" | "claimed" | "expired";
}

export interface OnboardingService {
  createOffice(
    input: CreateOfficeOnboardingInput,
    ip: string,
  ): Promise<CreateOfficeOnboardingResult>;
  getPairingStatus(
    statusCapability: string,
    ip: string,
  ): Promise<PairingStatusResult>;
  claim(
    input: ClaimPairingInput,
    ip: string,
  ): Promise<ClaimPairingResult>;
}

export function createOnboardingService(
  pool: DatabasePool,
  projector: PublicOfficeProjector,
  heartbeatIntervalSeconds = 30,
): OnboardingService {
  return {
    async createOffice(input, ip) {
      await consumeOnboardingRateLimit(pool, ip, "create");
      return createOfficeOnboarding(pool, projector, input);
    },
    async getPairingStatus(statusCapability, ip) {
      await consumeOnboardingRateLimit(pool, ip, "poll");
      const result = await pool.query<StatusRow>(
        `SELECT
           pairing.status,
           pairing.expires_at,
           clock_timestamp() AS now
         FROM control_plane.onboarding_pairings pairing
         WHERE pairing.status_secret_hash = $1`,
        [digestCapability(statusCapability)],
      );
      const pairing = result.rows[0];
      if (pairing === undefined) {
        throw new OnboardingProblem(
          "pairing_not_found",
          404,
          "The pairing is unavailable.",
        );
      }
      if (pairing.status === "claimed") return { status: "claimed" };
      return {
        status:
          pairing.expires_at.getTime() <= pairing.now.getTime()
            ? "expired"
            : "pending",
      };
    },
    claim(input, ip) {
      return claimPairing(
        pool,
        input,
        ip,
        heartbeatIntervalSeconds,
      );
    },
  };
}

async function createOfficeOnboarding(
  pool: DatabasePool,
  projector: PublicOfficeProjector,
  input: CreateOfficeOnboardingInput,
): Promise<CreateOfficeOnboardingResult> {
  const pairingCode = issueCapability();
  const statusCapability = issueCapability();
  const publicViewCapability = issueCapability();
  const ids = {
    account: randomUUID(),
    office: randomUUID(),
    room: randomUUID(),
    membership: randomUUID(),
    agent: randomUUID(),
    mount: randomUUID(),
    pairing: randomUUID(),
    publicView: randomUUID(),
    schedule: randomUUID(),
    qualification: randomUUID(),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const clock = await onboardingClock(client);
    await client.query(
      `INSERT INTO control_plane.accounts (id, created_at)
       VALUES ($1, $2)`,
      [ids.account, clock.now],
    );
    await client.query(
      `INSERT INTO control_plane.offices (
         id, owner_account_id, name, timezone, locale,
         discoverability, demo_data, created_at
       ) VALUES (
         $1, $2, $3, 'Asia/Shanghai', 'zh-CN',
         'unlisted', false, $4
       )`,
      [ids.office, ids.account, input.office_name, clock.now],
    );
    await client.query(
      `INSERT INTO control_plane.rooms (
         id, office_id, name, scene_capacity, created_at
       ) VALUES ($1, $2, 'Lobby', 24, $3)`,
      [ids.room, ids.office, clock.now],
    );
    await client.query(
      `INSERT INTO control_plane.memberships (
         id, office_id, account_id, created_at
       ) VALUES ($1, $2, $3, $4)`,
      [ids.membership, ids.office, ids.account, clock.now],
    );
    await client.query(
      `INSERT INTO control_plane.logical_agents (
         id, owner_account_id, alias, pet_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [ids.agent, ids.account, input.alias, input.pet_id, clock.now],
    );
    await client.query(
      `INSERT INTO control_plane.agent_office_mounts (
         id, office_id, logical_agent_id, owner_account_id, room_id,
         active, scene_slot,
         presence_visible, stats_opt_in, poster_opt_in,
         activated_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         true, 0,
         $6, $7, $8,
         $9, $9
       )`,
      [
        ids.mount,
        ids.office,
        ids.agent,
        ids.account,
        ids.room,
        input.presence_visible,
        input.stats_opt_in,
        input.poster_opt_in,
        clock.now,
      ],
    );
    if (input.stats_opt_in) {
      await client.query(
        `INSERT INTO control_plane.mount_stats_eligibility_intervals (
           id, office_id, mount_id, started_at
         ) VALUES ($1, $2, $3, $4)`,
        [ids.qualification, ids.office, ids.mount, clock.now],
      );
    }
    await client.query(
      `INSERT INTO control_plane.office_public_view_tokens (
         id, office_id, token_hash, created_at
       ) VALUES ($1, $2, $3, $4)`,
      [
        ids.publicView,
        ids.office,
        publicViewCapability.digest,
        clock.now,
      ],
    );
    await client.query(
      `INSERT INTO control_plane.office_schedule_versions (
         id, office_id, version, timezone,
         effective_from_local_date, created_at
       ) VALUES (
         $1, $2, 1, 'Asia/Shanghai',
         ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
         $3
       )`,
      [ids.schedule, ids.office, clock.now],
    );
    for (let isoWeekday = 1; isoWeekday <= 5; isoWeekday += 1) {
      await client.query(
        `INSERT INTO control_plane.office_schedule_rules (
           id, office_id, schedule_version_id, iso_weekday,
           start_local_time, end_local_time, end_day_offset
         ) VALUES (
           $1, $2, $3, $4,
           TIME '09:00', TIME '18:00', 0
         )`,
        [randomUUID(), ids.office, ids.schedule, isoWeekday],
      );
    }
    await client.query(
      `INSERT INTO control_plane.onboarding_pairings (
         id, account_id, office_id, logical_agent_id, mount_id,
         pairing_code_hash, status_secret_hash,
         created_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7,
         $8, $9
       )`,
      [
        ids.pairing,
        ids.account,
        ids.office,
        ids.agent,
        ids.mount,
        pairingCode.digest,
        statusCapability.digest,
        clock.now,
        clock.expires_at,
      ],
    );
    await projector.recordRevision(client, {
      officeId: ids.office,
      eventType: "projection_initialized",
      sourceKind: "projection_seed",
      sourceKey: `onboarding:${ids.pairing}`,
      sourceReceiptId: null,
      at: clock.now,
    });
    await client.query("COMMIT");
    return {
      pairing_code: pairingCode.raw,
      status_token: statusCapability.raw,
      expires_at: clock.expires_at.toISOString(),
      office_url: `/o/${publicViewCapability.raw}`,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function onboardingClock(client: DatabaseClient): Promise<ClockRow> {
  const result = await client.query<ClockRow>(
    `SELECT
       clock_timestamp() AS now,
       clock_timestamp() + ($1::text || ' minutes')::interval AS expires_at`,
    [PAIRING_LIFETIME_MINUTES],
  );
  const clock = result.rows[0];
  if (clock === undefined) {
    throw new Error("Database did not provide onboarding time");
  }
  return clock;
}
