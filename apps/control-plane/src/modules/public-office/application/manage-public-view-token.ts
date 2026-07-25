import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  DatabaseClient,
  DatabasePool,
} from "../../../platform/db/pool.js";

interface LockedOfficeRow extends QueryResultRow {
  revision: string;
}

export interface RotatedPublicViewToken {
  rawToken: string;
  expiresAt: Date | null;
}

export async function rotatePublicViewToken(
  pool: DatabasePool,
  officeId: string,
  changedAt: Date,
  expiresAt: Date | null = null,
): Promise<RotatedPublicViewToken | null> {
  assertTokenDates(changedAt, expiresAt);
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const office = await lockOffice(client, officeId);
    if (office === null) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE control_plane.office_public_view_tokens
          SET revoked_at = GREATEST(created_at, $2::timestamptz)
        WHERE office_id = $1
          AND revoked_at IS NULL`,
      [officeId, changedAt],
    );
    await client.query(
      `INSERT INTO control_plane.office_public_view_tokens (
         id, office_id, token_hash, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), officeId, tokenHash, changedAt, expiresAt],
    );
    await notifyTokenChange(client, officeId, office.revision);
    await client.query("COMMIT");
    return { rawToken, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokePublicViewToken(
  pool: DatabasePool,
  officeId: string,
  changedAt: Date,
): Promise<boolean> {
  assertTokenDates(changedAt, null);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const office = await lockOffice(client, officeId);
    if (office === null) {
      await client.query("COMMIT");
      return false;
    }
    const revoked = await client.query(
      `UPDATE control_plane.office_public_view_tokens
          SET revoked_at = GREATEST(created_at, $2::timestamptz)
        WHERE office_id = $1
          AND revoked_at IS NULL`,
      [officeId, changedAt],
    );
    if (revoked.rowCount !== 0) {
      await notifyTokenChange(client, officeId, office.revision);
    }
    await client.query("COMMIT");
    return revoked.rowCount !== 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockOffice(
  client: DatabaseClient,
  officeId: string,
): Promise<LockedOfficeRow | null> {
  const result = await client.query<LockedOfficeRow>(
    `SELECT revision::text
       FROM control_plane.offices
      WHERE id = $1
        AND deletion_requested_at IS NULL
      FOR UPDATE`,
    [officeId],
  );
  return result.rows[0] ?? null;
}

async function notifyTokenChange(
  client: DatabaseClient,
  officeId: string,
  revision: string,
): Promise<void> {
  await client.query(
    `SELECT pg_notify(
       'control_plane_office_revision_v1',
       json_build_object(
         'office_id', $1::uuid,
         'revision', $2::bigint
       )::text
     )`,
    [officeId, revision],
  );
}

function assertTokenDates(changedAt: Date, expiresAt: Date | null): void {
  if (!Number.isFinite(changedAt.getTime())) {
    throw new Error("Token change time is invalid");
  }
  if (
    expiresAt !== null &&
    (!Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= changedAt.getTime())
  ) {
    throw new Error("Token expiration must be after creation");
  }
}
