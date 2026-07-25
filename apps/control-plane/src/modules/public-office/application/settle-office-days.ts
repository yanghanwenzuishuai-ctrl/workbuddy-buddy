import type { QueryResultRow } from "pg";

import type { DatabaseClient } from "../../../platform/db/pool.js";
import { queryOfficeLeaderboard } from "./office-leaderboard-query.js";

interface DueOfficeDayRow extends QueryResultRow {
  office_local_date: string;
  schedule_version_id: string;
  closes_at: Date;
}

export interface SettledOfficeDay {
  officeLocalDate: string;
  outcome: "winner" | "no_award";
}

export async function settleDueOfficeDays(
  client: DatabaseClient,
  officeId: string,
  asOf: Date,
  limit = 31,
): Promise<SettledOfficeDay[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 366) {
    throw new Error("Settlement limit must be between 1 and 366");
  }
  const due = await client.query<DueOfficeDayRow>(
    `SELECT
       occurrence.office_local_date::text,
       MIN(occurrence.schedule_version_id::text)::uuid
         AS schedule_version_id,
       MAX(occurrence.ends_at) AS closes_at
     FROM control_plane.office_schedule_occurrences occurrence
     WHERE occurrence.office_id = $1
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.office_day_results result
          WHERE result.office_id = occurrence.office_id
            AND result.office_local_date = occurrence.office_local_date
       )
     GROUP BY occurrence.office_local_date
     HAVING MAX(occurrence.ends_at) <= $2
        AND COUNT(DISTINCT occurrence.schedule_version_id) = 1
     ORDER BY occurrence.office_local_date
     LIMIT $3`,
    [officeId, asOf, limit],
  );
  const settled: SettledOfficeDay[] = [];
  for (const day of due.rows) {
    const scores = await queryOfficeLeaderboard(
      client,
      officeId,
      day.office_local_date,
      day.closes_at,
      1,
    );
    const winner = scores[0];
    const inserted =
      winner === undefined
        ? await client.query(
            `INSERT INTO control_plane.office_day_results (
               office_id, office_local_date, schedule_version_id,
               outcome, settled_at
             ) VALUES ($1, $2, $3, 'no_award', $4)
             ON CONFLICT (office_id, office_local_date) DO NOTHING
             RETURNING office_local_date`,
            [
              officeId,
              day.office_local_date,
              day.schedule_version_id,
              asOf,
            ],
          )
        : await client.query(
            `INSERT INTO control_plane.office_day_results (
               office_id, office_local_date, schedule_version_id,
               outcome,
               winner_mount_id, winner_logical_agent_id,
               winner_alias, winner_pet_id,
               winner_slacking_seconds, winner_score_reached_at,
               settled_at
             ) VALUES (
               $1, $2, $3,
               'winner',
               $4, $5,
               $6, $7,
               $8, $9,
               $10
             )
             ON CONFLICT (office_id, office_local_date) DO NOTHING
             RETURNING office_local_date`,
            [
              officeId,
              day.office_local_date,
              day.schedule_version_id,
              winner.mountId,
              winner.logicalAgentId,
              winner.alias,
              winner.petId,
              winner.slackingSeconds,
              winner.scoreReachedAt,
              asOf,
            ],
          );
    if (inserted.rowCount === 1) {
      settled.push({
        officeLocalDate: day.office_local_date,
        outcome: winner === undefined ? "no_award" : "winner",
      });
    }
  }
  return settled;
}
