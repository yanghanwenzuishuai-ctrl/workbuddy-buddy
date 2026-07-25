import type { QueryResultRow } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";
import type { PublicOfficeProjector } from "./public-office-projector.js";
import { settleDueOfficeDays } from "./settle-office-days.js";

interface CandidateRow extends QueryResultRow {
  id: string;
}

interface LockedOfficeRow extends QueryResultRow {
  generated_at: Date | null;
  token_active: boolean;
}

export interface PublicOfficeTickFailure {
  officeId: string;
  error: unknown;
}

export async function tickPublicOffices(
  pool: DatabasePool,
  projector: PublicOfficeProjector,
  asOf: Date,
  minimumIntervalSeconds: number,
  officeLimit = 100,
  onOfficeFailure?: (failure: PublicOfficeTickFailure) => void,
): Promise<number> {
  if (
    !Number.isInteger(minimumIntervalSeconds) ||
    minimumIntervalSeconds < 5 ||
    minimumIntervalSeconds > 300
  ) {
    throw new Error("Projection tick interval must be between 5 and 300 seconds");
  }
  if (!Number.isInteger(officeLimit) || officeLimit < 1 || officeLimit > 1_000) {
    throw new Error("Office tick limit must be between 1 and 1000");
  }
  const candidates = await pool.query<CandidateRow>(
    `SELECT office.id
       FROM control_plane.offices office
       JOIN control_plane.office_public_view_tokens token
         ON token.office_id = office.id
        AND token.revoked_at IS NULL
        AND (token.expires_at IS NULL OR token.expires_at > $1)
       LEFT JOIN control_plane.office_current_public_projections projection
         ON projection.office_id = office.id
      WHERE office.deletion_requested_at IS NULL
        AND (
          projection.generated_at IS NULL
          OR projection.generated_at
             <= $1::timestamptz - $2 * interval '1 second'
        )
      ORDER BY office.id
      LIMIT $3`,
    [asOf, minimumIntervalSeconds, officeLimit],
  );

  let advanced = 0;
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<LockedOfficeRow>(
        `SELECT
           projection.generated_at,
           EXISTS (
             SELECT 1
               FROM control_plane.office_public_view_tokens token
              WHERE token.office_id = office.id
                AND token.revoked_at IS NULL
                AND (
                  token.expires_at IS NULL
                  OR token.expires_at > $2
                )
           ) AS token_active
         FROM control_plane.offices office
         LEFT JOIN control_plane.office_current_public_projections projection
           ON projection.office_id = office.id
         WHERE office.id = $1
           AND office.deletion_requested_at IS NULL
         FOR UPDATE OF office`,
        [candidate.id, asOf],
      );
      const office = locked.rows[0];
      if (
        office === undefined ||
        !office.token_active ||
        (office.generated_at !== null &&
          office.generated_at.getTime() >
            asOf.getTime() - minimumIntervalSeconds * 1_000)
      ) {
        await client.query("COMMIT");
        continue;
      }

      const settlements = await settleDueOfficeDays(
        client,
        candidate.id,
        asOf,
      );
      const settled = settlements.length > 0;
      await projector.recordRevision(client, {
        officeId: candidate.id,
        eventType: settled ? "office_day_settled" : "projection_ticked",
        sourceKind: settled ? "office_day_settlement" : "projection_tick",
        sourceKey: `${
          settled ? "settlement" : "tick"
        }:${asOf.toISOString()}`,
        sourceReceiptId: null,
        at: asOf,
      });
      await client.query("COMMIT");
      advanced += 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (onOfficeFailure === undefined) throw error;
      onOfficeFailure({ officeId: candidate.id, error });
    } finally {
      client.release();
    }
  }
  return advanced;
}
