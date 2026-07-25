import { createHash } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";
import type { PublicOfficeSnapshot } from "../domain/types.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_SAFE_REVISION = 9_007_199_254_740_991;
const REPLAY_PAGE_MAX_BYTES = 1_048_576;

interface SnapshotRow extends QueryResultRow {
  office_id: string;
  revision: string;
  minimum_replay_revision: string;
  snapshot_payload: PublicOfficeSnapshot;
  canonical_payload: Buffer;
}

interface ReplayRow extends QueryResultRow {
  revision: string;
  canonical_payload: Buffer | null;
}

interface StreamHeadRow extends QueryResultRow {
  office_id: string;
  revision: string;
  minimum_replay_revision: string;
}

interface TokenOfficeRow extends QueryResultRow {
  office_id: string;
}

export interface PublicCapability {
  rawDigest: Buffer;
  formatValid: boolean;
}

export interface PublicSnapshotRecord {
  officeId: string;
  revision: number;
  minimumReplayRevision: number;
  snapshot: PublicOfficeSnapshot;
  canonicalPayload: Buffer;
  capability: PublicCapability;
}

export interface PublicReplayEvent {
  revision: number;
  canonicalPayload: Buffer;
}

export interface PublicStreamPage {
  status: "ok" | "not_found" | "revision_gap";
  officeId?: string;
  currentRevision?: number;
  minimumReplayRevision?: number;
  events?: PublicReplayEvent[];
}

export interface PublicStreamPageLease {
  page: PublicStreamPage;
  release(): Promise<void>;
}

export interface PublicOfficeReader {
  getSnapshot(rawToken: string): Promise<PublicSnapshotRecord | null>;
  getStreamPage(
    capability: PublicCapability,
    cursor: number,
    limit?: number,
  ): Promise<PublicStreamPage>;
  acquireLockedStreamPage(
    capability: PublicCapability,
    cursor: number,
    limit?: number,
  ): Promise<PublicStreamPageLease>;
  capabilityFor(rawToken: string): PublicCapability;
}

export function createPublicOfficeReader(
  pool: DatabasePool,
): PublicOfficeReader {
  return {
    capabilityFor(rawToken) {
      return {
        rawDigest: createHash("sha256").update(rawToken, "utf8").digest(),
        formatValid: TOKEN_PATTERN.test(rawToken),
      };
    },

    async getSnapshot(rawToken) {
      const capability = this.capabilityFor(rawToken);
      const result = await pool.query<SnapshotRow>(
        `SELECT
           office.id AS office_id,
           office.revision,
           office.minimum_replay_revision,
           projection.snapshot_payload,
           projection.canonical_payload
         FROM control_plane.office_public_view_tokens token
         JOIN control_plane.offices office
           ON office.id = token.office_id
          AND office.deletion_requested_at IS NULL
         JOIN control_plane.office_current_public_projections projection
           ON projection.office_id = office.id
          AND projection.revision = office.revision
         WHERE token.token_hash = $1
           AND $2::boolean
           AND token.revoked_at IS NULL
           AND (token.expires_at IS NULL OR token.expires_at > clock_timestamp())`,
        [capability.rawDigest, capability.formatValid],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        officeId: row.office_id,
        revision: parseRevision(row.revision),
        minimumReplayRevision: parseRevision(row.minimum_replay_revision),
        snapshot: row.snapshot_payload,
        canonicalPayload: row.canonical_payload,
        capability,
      };
    },

    async getStreamPage(capability, cursor, limit = 100) {
      const lease = await this.acquireLockedStreamPage(
        capability,
        cursor,
        limit,
      );
      try {
        return lease.page;
      } finally {
        await lease.release();
      }
    },

    async acquireLockedStreamPage(capability, cursor, limit = 100) {
      assertRevision(cursor);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("Public replay page limit is invalid");
      }
      const client = await pool.connect();
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };
      try {
        await client.query("BEGIN");
        const candidateResult = await client.query<TokenOfficeRow>(
          `SELECT token.office_id
             FROM control_plane.office_public_view_tokens token
             JOIN control_plane.offices office
               ON office.id = token.office_id
              AND office.deletion_requested_at IS NULL
            WHERE token.token_hash = $1
              AND $2::boolean
              AND token.revoked_at IS NULL
              AND (
                token.expires_at IS NULL
                OR token.expires_at > clock_timestamp()
              )`,
          [capability.rawDigest, capability.formatValid],
        );
        const candidateOfficeId = candidateResult.rows[0]?.office_id;
        if (candidateOfficeId === undefined) {
          return {
            page: { status: "not_found" },
            release,
          };
        }
        const officeLock = await client.query(
          `SELECT id
             FROM control_plane.offices
            WHERE id = $1
              AND deletion_requested_at IS NULL
            FOR SHARE`,
          [candidateOfficeId],
        );
        if (officeLock.rowCount !== 1) {
          return {
            page: { status: "not_found" },
            release,
          };
        }
        const headResult = await client.query<StreamHeadRow>(
          `SELECT
             office.id AS office_id,
             office.revision,
             office.minimum_replay_revision
           FROM control_plane.office_public_view_tokens token
           JOIN control_plane.offices office
             ON office.id = token.office_id
            AND office.deletion_requested_at IS NULL
           JOIN control_plane.office_current_public_projections projection
             ON projection.office_id = office.id
            AND projection.revision = office.revision
           WHERE token.token_hash = $1
             AND $2::boolean
             AND token.office_id = $3
             AND token.revoked_at IS NULL
             AND (
               token.expires_at IS NULL
               OR token.expires_at > clock_timestamp()
             )
           FOR SHARE OF token`,
          [
            capability.rawDigest,
            capability.formatValid,
            candidateOfficeId,
          ],
        );
        const head = headResult.rows[0];
        if (head === undefined) {
          return {
            page: { status: "not_found" },
            release,
          };
        }
        const currentRevision = parseRevision(head.revision);
        const minimumReplayRevision = parseRevision(
          head.minimum_replay_revision,
        );
        if (cursor < minimumReplayRevision) {
          return {
            page: {
              status: "revision_gap",
              officeId: head.office_id,
              currentRevision,
              minimumReplayRevision,
            },
            release,
          };
        }
        const eventResult = await client.query<ReplayRow>(
          `WITH replay_page AS (
             SELECT
               revision,
               canonical_payload,
               ROW_NUMBER() OVER (ORDER BY revision) AS ordinal,
               SUM(octet_length(canonical_payload))
                 OVER (ORDER BY revision) AS cumulative_bytes
             FROM (
               SELECT revision, canonical_payload
                 FROM control_plane.office_revision_events
                WHERE office_id = $1
                  AND revision > $2
                  AND projection_format_version = 1
                ORDER BY revision
                LIMIT $3
             ) candidates
           )
           SELECT revision, canonical_payload
             FROM replay_page
            WHERE ordinal = 1
               OR cumulative_bytes <= $4
            ORDER BY revision`,
          [head.office_id, cursor, limit, REPLAY_PAGE_MAX_BYTES],
        );
        return {
          page: {
            status: "ok",
            officeId: head.office_id,
            currentRevision,
            minimumReplayRevision,
            events: eventResult.rows.map((row) => {
              if (row.canonical_payload === null) {
                throw new Error(
                  "Replayable projection has no canonical payload",
                );
              }
              return {
                revision: parseRevision(row.revision),
                canonicalPayload: row.canonical_payload,
              };
            }),
          },
          release,
        };
      } catch (error) {
        released = true;
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        throw error;
      }
    },
  };
}

export function parsePublicRevisionCursor(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError("Revision cursor must be canonical decimal");
  }
  const revision = Number(value);
  assertRevision(revision);
  return revision;
}

function parseRevision(value: string | number): number {
  const revision = Number(value);
  assertRevision(revision);
  return revision;
}

function assertRevision(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_REVISION
  ) {
    throw new RangeError("Revision is outside the safe cursor range");
  }
}
