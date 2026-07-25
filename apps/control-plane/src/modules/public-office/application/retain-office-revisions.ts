import type { QueryResultRow } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";

interface OfficeCandidateRow extends QueryResultRow {
  id: string;
}

interface OfficeHeadRow extends QueryResultRow {
  revision: string;
  minimum_replay_revision: string;
}

interface PendingRow extends QueryResultRow {
  first_pending_revision: string | null;
}

export async function retainOfficeRevisions(
  pool: DatabasePool,
  maxReplayRevisions: number,
  officeLimit = 100,
): Promise<number> {
  if (
    !Number.isInteger(maxReplayRevisions) ||
    maxReplayRevisions < 1 ||
    maxReplayRevisions > 100_000
  ) {
    throw new Error("Replay retention must be between 1 and 100000 revisions");
  }
  if (!Number.isInteger(officeLimit) || officeLimit < 1 || officeLimit > 1_000) {
    throw new Error("Office retention limit must be between 1 and 1000");
  }
  const candidates = await pool.query<OfficeCandidateRow>(
    `SELECT id
       FROM control_plane.offices
      WHERE revision - minimum_replay_revision > $1
      ORDER BY id
      LIMIT $2`,
    [maxReplayRevisions, officeLimit],
  );
  let retained = 0;
  for (const candidate of candidates.rows) {
    if (
      await retainOneOffice(
        pool,
        candidate.id,
        maxReplayRevisions,
      )
    ) {
      retained += 1;
    }
  }
  return retained;
}

async function retainOneOffice(
  pool: DatabasePool,
  officeId: string,
  maxReplayRevisions: number,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const headResult = await client.query<OfficeHeadRow>(
      `SELECT revision, minimum_replay_revision
         FROM control_plane.offices
        WHERE id = $1
        FOR UPDATE`,
      [officeId],
    );
    const head = headResult.rows[0];
    if (head === undefined) {
      await client.query("COMMIT");
      return false;
    }
    const current = parseRevision(head.revision);
    const minimum = parseRevision(head.minimum_replay_revision);
    const desiredCutoff = current - maxReplayRevisions;
    if (desiredCutoff <= minimum) {
      await client.query("COMMIT");
      return false;
    }
    const pendingResult = await client.query<PendingRow>(
      `SELECT MIN(office_revision)::text AS first_pending_revision
         FROM control_plane.domain_outbox
        WHERE office_id = $1
          AND published_at IS NULL
          AND office_revision <= $2`,
      [officeId, desiredCutoff],
    );
    const firstPending =
      pendingResult.rows[0]?.first_pending_revision === null ||
      pendingResult.rows[0]?.first_pending_revision === undefined
        ? null
        : parseRevision(pendingResult.rows[0].first_pending_revision);
    const safeCutoff =
      firstPending === null
        ? desiredCutoff
        : Math.min(desiredCutoff, firstPending - 1);
    if (safeCutoff <= minimum) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(
      `DELETE FROM control_plane.office_revision_events
        WHERE office_id = $1
          AND revision <= $2`,
      [officeId, safeCutoff],
    );
    await client.query(
      `UPDATE control_plane.offices
          SET minimum_replay_revision = $2
        WHERE id = $1`,
      [officeId, safeCutoff],
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

function parseRevision(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid persisted Office revision");
  }
  return parsed;
}
