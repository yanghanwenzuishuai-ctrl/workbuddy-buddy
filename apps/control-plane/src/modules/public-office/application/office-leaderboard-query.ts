import type { QueryResultRow } from "pg";

import type { DatabaseClient } from "../../../platform/db/pool.js";

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

interface LeaderboardScoreRow extends QueryResultRow {
  logical_agent_id: string;
  mount_id: string;
  alias: string;
  pet_id: string;
  slacking_seconds: string;
  score_reached_at: Date;
}

export interface OfficeLeaderboardScore {
  rank: number;
  logicalAgentId: string;
  mountId: string;
  alias: string;
  petId: string;
  slackingSeconds: number;
  scoreReachedAt: Date;
}

export async function queryOfficeLeaderboard(
  client: DatabaseClient,
  officeId: string,
  officeLocalDate: string,
  asOf: Date,
  limit = 500,
): Promise<OfficeLeaderboardScore[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Leaderboard limit must be between 1 and 500");
  }
  const result = await client.query<LeaderboardScoreRow>(
    `WITH raw_intersections AS (
       SELECT
         mount.id AS mount_id,
         mount.logical_agent_id,
         agent.alias,
         agent.pet_id,
         GREATEST(
           activity.started_at,
           qualification.started_at,
           occurrence.starts_at
         ) AS segment_start,
         LEAST(
           COALESCE(
             activity.ended_at,
             CASE
               WHEN presence.instance_id IS NULL
                 THEN activity.started_at
               ELSE LEAST(presence.lease_expires_at, $3::timestamptz)
             END
           ),
           COALESCE(qualification.ended_at, $3::timestamptz),
           occurrence.ends_at,
           $3::timestamptz
         ) AS segment_end
       FROM control_plane.agent_office_mounts mount
       JOIN control_plane.logical_agents agent
         ON agent.id = mount.logical_agent_id
       JOIN control_plane.agent_instances instance
         ON instance.logical_agent_id = agent.id
       JOIN control_plane.derived_activity_intervals activity
         ON activity.instance_id = instance.id
        AND activity.activity_state = 'eligible_idle'
       JOIN control_plane.mount_stats_eligibility_intervals qualification
         ON qualification.office_id = mount.office_id
        AND qualification.mount_id = mount.id
       JOIN control_plane.office_schedule_occurrences occurrence
         ON occurrence.office_id = mount.office_id
        AND occurrence.office_local_date = $2::date
       LEFT JOIN control_plane.current_presence presence
         ON presence.instance_id = activity.instance_id
        AND activity.ended_at IS NULL
        AND presence.lease_closed_at IS NULL
       WHERE mount.office_id = $1
         AND mount.active
         AND mount.stats_opt_in
         AND activity.started_at < occurrence.ends_at
         AND COALESCE(activity.ended_at, $3::timestamptz) > occurrence.starts_at
         AND qualification.started_at < occurrence.ends_at
         AND COALESCE(qualification.ended_at, $3::timestamptz) > occurrence.starts_at
     ),
     valid_intersections AS (
       SELECT *
       FROM raw_intersections
       WHERE segment_end > segment_start
     ),
     ordered_intersections AS (
       SELECT
         *,
         MAX(segment_end) OVER (
           PARTITION BY mount_id
           ORDER BY segment_start, segment_end
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS previous_max_end
       FROM valid_intersections
     ),
     marked_islands AS (
       SELECT
         *,
         CASE
           WHEN previous_max_end IS NULL
             OR segment_start >= previous_max_end
             THEN 1
           ELSE 0
         END AS starts_new_island
       FROM ordered_intersections
     ),
     islanded AS (
       SELECT
         *,
         SUM(starts_new_island) OVER (
           PARTITION BY mount_id
           ORDER BY segment_start, segment_end
           ROWS UNBOUNDED PRECEDING
         ) AS island_id
       FROM marked_islands
     ),
     merged_segments AS (
       SELECT
         mount_id,
         logical_agent_id,
         alias,
         pet_id,
         island_id,
         MIN(segment_start) AS segment_start,
         MAX(segment_end) AS segment_end
       FROM islanded
       GROUP BY
         mount_id,
         logical_agent_id,
         alias,
         pet_id,
         island_id
     ),
     scored_segments AS (
       SELECT
         *,
         GREATEST(
           FLOOR(EXTRACT(EPOCH FROM segment_end - segment_start))::bigint - 900,
           0
         ) AS contribution
       FROM merged_segments
     ),
     totals AS (
       SELECT
         mount_id,
         logical_agent_id,
         alias,
         pet_id,
         SUM(contribution)::bigint AS slacking_seconds,
         MAX(
           segment_start + (900 + contribution) * interval '1 second'
         ) FILTER (WHERE contribution > 0) AS score_reached_at
       FROM scored_segments
       GROUP BY mount_id, logical_agent_id, alias, pet_id
       HAVING SUM(contribution) > 0
     )
     SELECT
       logical_agent_id,
       mount_id,
       alias,
       pet_id,
       slacking_seconds::text,
       score_reached_at
     FROM totals
     ORDER BY
       totals.slacking_seconds DESC,
       totals.score_reached_at ASC,
       totals.logical_agent_id ASC
     LIMIT $4`,
    [officeId, officeLocalDate, asOf, limit],
  );
  return result.rows.map((row, index) => ({
    rank: index + 1,
    logicalAgentId: row.logical_agent_id,
    mountId: row.mount_id,
    alias: row.alias,
    petId: row.pet_id,
    slackingSeconds: parseSafePositiveInteger(
      row.slacking_seconds,
      "slacking seconds",
    ),
    scoreReachedAt: row.score_reached_at,
  }));
}

function parseSafePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SAFE_INTEGER
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}
