import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type { DatabaseClient } from "../../../platform/db/pool.js";
import { canonicalBytes } from "../../presence/domain/canonical-json.js";
import { ensureScheduleOccurrencesAround } from "../domain/schedule.js";
import { deriveIdleStage } from "../domain/scoring.js";
import type {
  PublicAgent,
  PublicDailyAward,
  PublicLeaderboardEntry,
  PublicOfficeSnapshot,
  PublicRoom,
} from "../domain/types.js";
import { queryOfficeLeaderboard } from "./office-leaderboard-query.js";

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

interface OfficeRow extends QueryResultRow {
  id: string;
  name: string;
  timezone: string;
  demo_data: boolean;
  revision: string;
  local_date: string;
}

interface RoomRow extends QueryResultRow {
  room_id: string;
  name: string;
  scene_capacity: number;
}

interface AgentRow extends QueryResultRow {
  mount_id: string;
  room_id: string;
  alias: string;
  pet_id: string;
  online: boolean;
  display_state: PublicAgent["display_state"];
  eligible_since: Date | null;
  scene_slot: number | null;
}

interface AwardRow extends QueryResultRow {
  office_local_date: string;
  awarded_at: Date;
  winner_mount_id: string;
  winner_alias: string;
  winner_pet_id: string;
  slacking_seconds: string;
}

interface RevisionRow extends QueryResultRow {
  revision: string;
  projection_at: Date;
}

export type OperationalPublicRevisionEventType =
  | "projection_initialized"
  | "projection_ticked"
  | "presence_changed"
  | "presence_removed"
  | "schedule_changed"
  | "office_day_settled";

export type OperationalPublicRevisionSourceKind =
  | "projection_seed"
  | "edge_receipt"
  | "lease_expiry"
  | "schedule_change"
  | "projection_tick"
  | "office_day_settlement";

interface PublicRevisionInputBase {
  officeId: string;
  sourceKey: string;
  sourceReceiptId: string | null;
  at: Date;
}

export interface RecordPublicRevisionInput extends PublicRevisionInputBase {
  eventType: OperationalPublicRevisionEventType;
  sourceKind: OperationalPublicRevisionSourceKind;
}

export interface RecordConsentExpansionRevisionInput
  extends PublicRevisionInputBase {
  eventType: "consent_changed";
  sourceKind: "consent_change";
}

export interface RecordPrivacyLoweringRevisionInput
  extends PublicRevisionInputBase {
  eventType: "consent_changed" | "presence_removed";
  sourceKind: "consent_change";
}

export interface PublicSnapshotValidator {
  assert(snapshot: unknown): asserts snapshot is PublicOfficeSnapshot;
}

export interface PublicOfficeProjector {
  recordRevision(
    client: DatabaseClient,
    input: RecordPublicRevisionInput,
  ): Promise<PublicOfficeSnapshot>;
  recordConsentExpansionRevision(
    client: DatabaseClient,
    input: RecordConsentExpansionRevisionInput,
  ): Promise<PublicOfficeSnapshot>;
  recordPrivacyLoweringRevision(
    client: DatabaseClient,
    input: RecordPrivacyLoweringRevisionInput,
  ): Promise<PublicOfficeSnapshot>;
}

export function createPublicOfficeProjector(
  validator?: PublicSnapshotValidator,
): PublicOfficeProjector {
  return {
    recordRevision(client, input) {
      const runtimeInput: { eventType: string; sourceKind: string } = input;
      if (
        runtimeInput.eventType === "consent_changed" ||
        runtimeInput.sourceKind === "consent_change"
      ) {
        throw new Error(
          "Consent changes must use an explicit consent projection path",
        );
      }
      return recordPublicRevision(client, input, false, validator);
    },
    recordConsentExpansionRevision(client, input) {
      return recordPublicRevision(client, input, false, validator);
    },
    recordPrivacyLoweringRevision(client, input) {
      return recordPublicRevision(client, input, true, validator);
    },
  };
}

async function recordPublicRevision(
  client: DatabaseClient,
  input:
    | RecordPublicRevisionInput
    | RecordConsentExpansionRevisionInput
    | RecordPrivacyLoweringRevisionInput,
  invalidateReplayHistory: boolean,
  validator: PublicSnapshotValidator | undefined,
): Promise<PublicOfficeSnapshot> {
  await client.query("SAVEPOINT public_office_projection");
  try {
    const revisionResult = await client.query<RevisionRow>(
      `WITH projection_clock AS (
           SELECT GREATEST(
             clock_timestamp(),
             $2::timestamptz,
             COALESCE(
               (
                 SELECT generated_at
                   FROM control_plane.office_current_public_projections
                  WHERE office_id = $1
               ),
               '-infinity'::timestamptz
             )
           ) AS projection_at
         )
         UPDATE control_plane.offices
            SET revision = revision + 1
           FROM projection_clock
          WHERE offices.id = $1
            AND offices.revision < 9007199254740991
          RETURNING offices.revision, projection_clock.projection_at`,
      [input.officeId, input.at],
    );
    const projectionAt = revisionResult.rows[0]?.projection_at;
    if (projectionAt === undefined) {
      throw new Error("Office revision could not advance");
    }
    const revision = parseSafeInteger(
      revisionResult.rows[0]?.revision,
      "office revision",
    );
    await ensureScheduleOccurrencesAround(
      client,
      input.officeId,
      projectionAt,
    );
    const snapshot = await buildPublicOfficeSnapshot(
      client,
      input.officeId,
      revision,
      projectionAt,
    );
    validator?.assert(snapshot);
    const canonicalPayload = canonicalBytes(snapshot);

    await client.query(
      `INSERT INTO control_plane.office_revision_events (
           office_id, revision, event_type, public_payload,
           canonical_payload, created_at, projection_format_version
         ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [
        input.officeId,
        revision,
        input.eventType,
        snapshot,
        canonicalPayload,
        projectionAt,
      ],
    );
    await client.query(
      `INSERT INTO control_plane.office_current_public_projections (
           office_id, revision, snapshot_payload, canonical_payload, generated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (office_id) DO UPDATE
           SET revision = EXCLUDED.revision,
               snapshot_payload = EXCLUDED.snapshot_payload,
               canonical_payload = EXCLUDED.canonical_payload,
               generated_at = EXCLUDED.generated_at`,
      [input.officeId, revision, snapshot, canonicalPayload, projectionAt],
    );
    await client.query(
      `INSERT INTO control_plane.domain_outbox (
           id, office_id, office_revision,
           source_kind, source_key, source_receipt_id,
           effect_kind, public_payload, created_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           'office_revision', $7, $8
         )`,
      [
        randomUUID(),
        input.officeId,
        revision,
        input.sourceKind,
        input.sourceKey,
        input.sourceReceiptId,
        { revision },
        projectionAt,
      ],
    );
    await client.query(
      `UPDATE control_plane.domain_outbox
            SET published_at = $3
          WHERE office_id = $1
            AND office_revision = $2
            AND published_at IS NULL`,
      [input.officeId, revision, projectionAt],
    );

    if (invalidateReplayHistory) {
      await client.query(
        `DELETE FROM control_plane.office_revision_events
            WHERE office_id = $1
              AND revision < $2`,
        [input.officeId, revision],
      );
      await client.query(
        `UPDATE control_plane.offices
              SET minimum_replay_revision = $2 - 1
            WHERE id = $1`,
        [input.officeId, revision],
      );
    }

    await client.query(
      `SELECT pg_notify(
           'control_plane_office_revision_v1',
           json_build_object(
             'office_id', $1::uuid,
             'revision', $2::bigint
           )::text
         )`,
      [input.officeId, revision],
    );
    await client.query("RELEASE SAVEPOINT public_office_projection");
    return snapshot;
  } catch (error) {
    await client
      .query("ROLLBACK TO SAVEPOINT public_office_projection")
      .catch(() => undefined);
    await client
      .query("RELEASE SAVEPOINT public_office_projection")
      .catch(() => undefined);
    throw error;
  }
}

async function buildPublicOfficeSnapshot(
  client: DatabaseClient,
  officeId: string,
  revision: number,
  at: Date,
): Promise<PublicOfficeSnapshot> {
  const officeResult = await client.query<OfficeRow>(
    `SELECT
       o.id, o.name, o.timezone, o.demo_data, o.revision,
       COALESCE(
         (
           SELECT occurrence.office_local_date
             FROM control_plane.office_schedule_occurrences occurrence
            WHERE occurrence.office_id = o.id
              AND occurrence.starts_at <= $2
              AND occurrence.ends_at > $2
            ORDER BY occurrence.starts_at DESC, occurrence.id
            LIMIT 1
         ),
         ($2::timestamptz AT TIME ZONE o.timezone)::date
       )::text AS local_date
     FROM control_plane.offices o
     WHERE o.id = $1`,
    [officeId, at],
  );
  const office = officeResult.rows[0];
  if (office === undefined) {
    throw new Error("Office disappeared while building its public projection");
  }
  if (parseSafeInteger(office.revision, "stored office revision") !== revision) {
    throw new Error("Office revision changed during projection materialization");
  }

  const roomsResult = await client.query<RoomRow>(
    `SELECT id AS room_id, name, scene_capacity
       FROM control_plane.rooms
      WHERE office_id = $1
      ORDER BY created_at, id`,
    [officeId],
  );
  const rooms: PublicRoom[] = roomsResult.rows.map((room) => ({
    room_id: room.room_id,
    name: room.name,
    scene_capacity: room.scene_capacity,
  }));

  const agentsResult = await client.query<AgentRow>(
    `SELECT
       mount.id AS mount_id,
       mount.room_id,
       agent.alias,
       agent.pet_id,
       presence.instance_id IS NOT NULL AS online,
       presence.display_state,
       eligibility.eligible_since,
       mount.scene_slot
     FROM control_plane.agent_office_mounts mount
     JOIN control_plane.logical_agents agent
       ON agent.id = mount.logical_agent_id
     LEFT JOIN control_plane.agent_instances instance
       ON instance.id = agent.active_reporting_instance_id
      AND instance.status = 'active'
     LEFT JOIN control_plane.current_presence presence
       ON presence.instance_id = instance.id
      AND presence.lease_closed_at IS NULL
      AND presence.lease_expires_at > $2
     LEFT JOIN LATERAL (
       SELECT MIN(
         GREATEST(
           activity.started_at,
           qualification.started_at,
           occurrence.starts_at
         )
       ) AS eligible_since
       FROM control_plane.derived_activity_intervals activity
       JOIN control_plane.mount_stats_eligibility_intervals qualification
         ON qualification.office_id = mount.office_id
        AND qualification.mount_id = mount.id
       JOIN control_plane.office_schedule_occurrences occurrence
         ON occurrence.office_id = mount.office_id
        AND occurrence.starts_at <= $2
        AND occurrence.ends_at > $2
       WHERE presence.instance_id IS NOT NULL
         AND mount.stats_opt_in
         AND activity.instance_id = presence.instance_id
         AND activity.activity_state = 'eligible_idle'
         AND activity.started_at <= $2
         AND COALESCE(activity.ended_at, $2 + interval '1 microsecond') > $2
         AND qualification.started_at <= $2
         AND COALESCE(
           qualification.ended_at,
           $2 + interval '1 microsecond'
         ) > $2
     ) eligibility ON true
     WHERE mount.office_id = $1
       AND mount.active
       AND mount.presence_visible
     ORDER BY
       mount.room_id,
       mount.scene_slot NULLS LAST,
       mount.id`,
    [officeId, at],
  );
  const agents: PublicAgent[] = agentsResult.rows.map((agent) => {
    const online = agent.online;
    return {
      mount_id: agent.mount_id,
      room_id: agent.room_id,
      alias: agent.alias,
      pet_id: agent.pet_id,
      presence: online ? "online" : "offline",
      display_state: online ? agent.display_state : null,
      idle_stage:
        online && agent.eligible_since !== null
          ? deriveIdleStage(
              {
                startedAtMs: agent.eligible_since.getTime(),
                endedAtMs: null,
              },
              at.getTime(),
            )
          : "none",
      scene_slot: agent.scene_slot,
    };
  });

  const leaderboardScores = await queryOfficeLeaderboard(
    client,
    officeId,
    office.local_date,
    at,
  );
  const leaderboard: PublicLeaderboardEntry[] = leaderboardScores.map(
    (entry) => ({
      rank: entry.rank,
      mount_id: entry.mountId,
      alias: entry.alias,
      pet_id: entry.petId,
      slacking_seconds: entry.slackingSeconds,
    }),
  );

  const awardResult = await client.query<AwardRow & { publicly_visible: boolean }>(
    `SELECT
       result.office_local_date::text,
       result.settled_at AS awarded_at,
       result.winner_mount_id,
       result.winner_alias,
       result.winner_pet_id,
       result.winner_slacking_seconds::text AS slacking_seconds,
       (
         result.outcome = 'winner'
         AND mount.id IS NOT NULL
         AND mount.active
         AND mount.stats_opt_in
       ) AS publicly_visible
     FROM control_plane.office_day_results result
     LEFT JOIN control_plane.agent_office_mounts mount
       ON mount.office_id = result.office_id
      AND mount.id = result.winner_mount_id
     WHERE result.office_id = $1
     ORDER BY result.office_local_date DESC
     LIMIT 1`,
    [officeId],
  );
  const award = awardResult.rows[0];
  const dailyAward: PublicDailyAward | null =
    award === undefined || !award.publicly_visible
      ? null
      : {
          office_local_date: award.office_local_date,
          awarded_at: award.awarded_at.toISOString(),
          final: true,
          winner: {
            mount_id: award.winner_mount_id,
            alias: award.winner_alias,
            pet_id: award.winner_pet_id,
            slacking_seconds: parseSafeInteger(
              award.slacking_seconds,
              "award slacking seconds",
            ),
          },
        };

  return {
    schema_version: 1,
    office_revision: revision,
    generated_at: at.toISOString(),
    office: {
      name: office.name,
      local_date: office.local_date,
      timezone: office.timezone,
    },
    rooms,
    agents,
    leaderboard: {
      office_local_date: office.local_date,
      status:
        award?.office_local_date === office.local_date
          ? "final"
          : "provisional",
      as_of: at.toISOString(),
      entries: leaderboard,
    },
    daily_award: dailyAward,
    demo_data: office.demo_data,
    disclaimer: "趣味统计 · 非考勤依据",
  };
}

function parseSafeInteger(
  value: string | number | undefined,
  field: string,
  allowZero = false,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1) ||
    parsed > MAX_SAFE_INTEGER
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}
