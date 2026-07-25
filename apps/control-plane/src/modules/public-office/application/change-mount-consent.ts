import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";
import type { PublicOfficeProjector } from "./public-office-projector.js";

interface MountConsentRow extends QueryResultRow {
  office_id: string;
  presence_visible: boolean;
  stats_opt_in: boolean;
  poster_opt_in: boolean;
  active: boolean;
}

export interface ChangeMountConsentInput {
  mountId: string;
  presenceVisible?: boolean;
  statsOptIn?: boolean;
  posterOptIn?: boolean;
  changedAt: Date;
}

export interface ChangeMountConsentResult {
  changed: boolean;
  officeId: string | null;
  revision: number | null;
}

export async function changeMountConsent(
  pool: DatabasePool,
  projector: PublicOfficeProjector,
  input: ChangeMountConsentInput,
): Promise<ChangeMountConsentResult> {
  if (
    input.presenceVisible === undefined &&
    input.statsOptIn === undefined &&
    input.posterOptIn === undefined
  ) {
    throw new Error("At least one consent value must be supplied");
  }
  if (!Number.isFinite(input.changedAt.getTime())) {
    throw new Error("Consent change time is invalid");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mountResult = await client.query<MountConsentRow>(
      `SELECT
         mount.office_id,
         mount.presence_visible,
         mount.stats_opt_in,
         mount.poster_opt_in,
         mount.active
       FROM control_plane.agent_office_mounts mount
       JOIN control_plane.offices office
         ON office.id = mount.office_id
       WHERE mount.id = $1
       FOR UPDATE OF office, mount`,
      [input.mountId],
    );
    const mount = mountResult.rows[0];
    if (mount === undefined || !mount.active) {
      await client.query("COMMIT");
      return { changed: false, officeId: null, revision: null };
    }

    const next = {
      presenceVisible: input.presenceVisible ?? mount.presence_visible,
      statsOptIn: input.statsOptIn ?? mount.stats_opt_in,
      posterOptIn: input.posterOptIn ?? mount.poster_opt_in,
    };
    const changed =
      next.presenceVisible !== mount.presence_visible ||
      next.statsOptIn !== mount.stats_opt_in ||
      next.posterOptIn !== mount.poster_opt_in;
    if (!changed) {
      await client.query("COMMIT");
      return {
        changed: false,
        officeId: mount.office_id,
        revision: null,
      };
    }

    if (mount.stats_opt_in && !next.statsOptIn) {
      await client.query(
        `UPDATE control_plane.mount_stats_eligibility_intervals
            SET ended_at = $2,
                close_reason = 'stats_opt_out'
          WHERE mount_id = $1
            AND ended_at IS NULL`,
        [input.mountId, input.changedAt],
      );
    } else if (!mount.stats_opt_in && next.statsOptIn) {
      await client.query(
        `INSERT INTO control_plane.mount_stats_eligibility_intervals (
           id, office_id, mount_id, started_at
         ) VALUES ($1, $2, $3, $4)`,
        [
          randomUUID(),
          mount.office_id,
          input.mountId,
          input.changedAt,
        ],
      );
    }

    await client.query(
      `UPDATE control_plane.agent_office_mounts
          SET presence_visible = $2,
              stats_opt_in = $3,
              poster_opt_in = $4,
              updated_at = $5
        WHERE id = $1`,
      [
        input.mountId,
        next.presenceVisible,
        next.statsOptIn,
        next.posterOptIn,
        input.changedAt,
      ],
    );

    const privacyLowering =
      (mount.presence_visible && !next.presenceVisible) ||
      (mount.stats_opt_in && !next.statsOptIn) ||
      (mount.poster_opt_in && !next.posterOptIn);
    const revisionInput = {
      officeId: mount.office_id,
      eventType: "consent_changed" as const,
      sourceKind: "consent_change" as const,
      sourceKey: `consent:${input.mountId}:${randomUUID()}`,
      sourceReceiptId: null,
      at: input.changedAt,
    };
    const snapshot = privacyLowering
      ? await projector.recordPrivacyLoweringRevision(
          client,
          revisionInput,
        )
      : await projector.recordConsentExpansionRevision(
          client,
          revisionInput,
        );
    await client.query("COMMIT");
    return {
      changed: true,
      officeId: mount.office_id,
      revision: snapshot.office_revision,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
