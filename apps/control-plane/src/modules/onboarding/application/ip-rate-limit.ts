import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";
import { OnboardingProblem } from "../domain/problem.js";

const LIMITS = {
  create: 6,
  claim: 30,
  poll: 1_200,
} as const;

type RateKind = keyof typeof LIMITS;

interface RateRow extends QueryResultRow {
  office_create_count: number;
  claim_count: number;
  poll_count: number;
  retry_after_seconds: number;
}

export async function consumeOnboardingRateLimit(
  pool: DatabasePool,
  ip: string,
  kind: RateKind,
): Promise<void> {
  const increments = {
    create: kind === "create" ? 1 : 0,
    claim: kind === "claim" ? 1 : 0,
    poll: kind === "poll" ? 1 : 0,
  };
  const result = await pool.query<RateRow>(
    `WITH request_clock AS (
       SELECT clock_timestamp() AS now
     )
     INSERT INTO control_plane.onboarding_ip_rate_limits AS rate (
       ip_hash, window_started_at,
       office_create_count, claim_count, poll_count, updated_at
     )
     SELECT $1, now, $2, $3, $4, now
       FROM request_clock
     ON CONFLICT (ip_hash) DO UPDATE
       SET window_started_at = CASE
             WHEN rate.window_started_at
                    <= EXCLUDED.window_started_at - interval '5 minutes'
               THEN EXCLUDED.window_started_at
             ELSE rate.window_started_at
           END,
           office_create_count = CASE
             WHEN rate.window_started_at
                    <= EXCLUDED.window_started_at - interval '5 minutes'
               THEN $2
             ELSE rate.office_create_count + $2
           END,
           claim_count = CASE
             WHEN rate.window_started_at
                    <= EXCLUDED.window_started_at - interval '5 minutes'
               THEN $3
             ELSE rate.claim_count + $3
           END,
           poll_count = CASE
             WHEN rate.window_started_at
                    <= EXCLUDED.window_started_at - interval '5 minutes'
               THEN $4
             ELSE rate.poll_count + $4
           END,
           updated_at = EXCLUDED.updated_at
     RETURNING
       office_create_count,
       claim_count,
       poll_count,
       GREATEST(
         0,
         CEIL(
           EXTRACT(
             EPOCH FROM (
               window_started_at + interval '5 minutes' - clock_timestamp()
             )
           )
         )::integer
       ) AS retry_after_seconds`,
    [
      createHash("sha256").update(ip, "utf8").digest(),
      increments.create,
      increments.claim,
      increments.poll,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Onboarding rate limit did not update");
  const count =
    kind === "create"
      ? row.office_create_count
      : kind === "claim"
        ? row.claim_count
        : row.poll_count;
  if (count > LIMITS[kind]) {
    throw new OnboardingProblem(
      "rate_limited",
      429,
      "Too many onboarding requests.",
      Math.max(1, row.retry_after_seconds),
    );
  }
}
