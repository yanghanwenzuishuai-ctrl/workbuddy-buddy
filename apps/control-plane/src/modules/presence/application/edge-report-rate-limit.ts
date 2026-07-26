import type { QueryResultRow } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";
import { ProtocolProblem } from "../domain/problem.js";

const WINDOW_SECONDS = 300;
const MAX_REPORTS_PER_WINDOW = 360;
const MAX_EVENTS_PER_WINDOW = 2_048;

interface RateRow extends QueryResultRow {
  report_count: number;
  event_count: number;
  retry_after_seconds: number;
}

export interface EdgeReportRateLimiter {
  consume(instanceId: string, eventCount: number): Promise<void>;
}

export function createEdgeReportRateLimiter(
  pool: DatabasePool,
): EdgeReportRateLimiter {
  return {
    async consume(instanceId, eventCount) {
      const result = await pool.query<RateRow>(
        `WITH request_clock AS (
           SELECT clock_timestamp() AS now
         )
         INSERT INTO control_plane.edge_report_rate_limits AS rate (
           instance_id, window_started_at,
           report_count, event_count, updated_at
         )
         SELECT $1, now, 1, $2, now
           FROM request_clock
         ON CONFLICT (instance_id) DO UPDATE
           SET window_started_at = CASE
                 WHEN rate.window_started_at
                        <= EXCLUDED.window_started_at
                           - ($3::text || ' seconds')::interval
                   THEN EXCLUDED.window_started_at
                 ELSE rate.window_started_at
               END,
               report_count = CASE
                 WHEN rate.window_started_at
                        <= EXCLUDED.window_started_at
                           - ($3::text || ' seconds')::interval
                   THEN 1
                 ELSE rate.report_count + 1
               END,
               event_count = CASE
                 WHEN rate.window_started_at
                        <= EXCLUDED.window_started_at
                           - ($3::text || ' seconds')::interval
                   THEN $2
                 ELSE rate.event_count + $2
               END,
               updated_at = EXCLUDED.updated_at
         RETURNING
           report_count,
           event_count,
           GREATEST(
             0,
             CEIL(
               EXTRACT(
                 EPOCH FROM (
                   window_started_at
                     + ($3::text || ' seconds')::interval
                     - clock_timestamp()
                 )
               )
             )::integer
           ) AS retry_after_seconds`,
        [instanceId, eventCount, WINDOW_SECONDS],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Edge report rate limit did not update");
      }
      if (
        row.report_count > MAX_REPORTS_PER_WINDOW ||
        row.event_count > MAX_EVENTS_PER_WINDOW
      ) {
        throw new ProtocolProblem(
          "rate_limited",
          429,
          "The device report rate is temporarily limited.",
          undefined,
          Math.max(1, row.retry_after_seconds),
        );
      }
    },
  };
}
