import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig } from "../../src/config.js";
import {
  createPublicOfficeProjector,
  type PublicOfficeProjector,
} from "../../src/modules/public-office/application/public-office-projector.js";
import { tickPublicOffices } from "../../src/modules/public-office/application/tick-public-offices.js";
import {
  createEdgeReportIngestor,
  type EdgeReportIngestor,
} from "../../src/modules/presence/application/ingest-edge-report.js";
import { expireDueLeases } from "../../src/modules/presence/application/expire-leases.js";
import { ProtocolProblem } from "../../src/modules/presence/domain/problem.js";
import type {
  EdgeEvent,
  EdgeReportEnvelope,
  PreparedEdgeReport,
  VerifiedEdgeContext,
} from "../../src/modules/presence/domain/types.js";
import {
  createEdgeReportValidator,
  type EdgeReportValidator,
} from "../../src/platform/contracts/edge-report-validator.js";
import {
  migrate,
  migrationStatus,
  readMigrations,
} from "../../src/platform/db/migrations.js";
import {
  createDatabasePool,
  type DatabasePool,
} from "../../src/platform/db/pool.js";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;

if (testDatabaseUrl === undefined) {
  test(
    "PostgreSQL ingestion integration tests",
    { skip: "Set CONTROL_PLANE_TEST_DATABASE_URL to a dedicated test database" },
    () => undefined,
  );
} else {
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);
  if (
    !databaseName.endsWith("_test") ||
    process.env.ALLOW_CONTROL_PLANE_TEST_DB_RESET !== "true"
  ) {
    throw new Error(
      "Integration tests require an *_test database and ALLOW_CONTROL_PLANE_TEST_DB_RESET=true",
    );
  }

  describe("PostgreSQL Edge ingestion", () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      DATABASE_SSL: "false",
    });
    let pool: DatabasePool;
    let validator: EdgeReportValidator;
    let ingestor: EdgeReportIngestor;
    let projector: PublicOfficeProjector;
    let topology: TestTopology;

    before(async () => {
      pool = createDatabasePool(config);
      await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await migrate(pool, config.migrationsDir);
      await migrate(pool, config.migrationsDir);
      validator = await createEdgeReportValidator(config.contractsDir);
      projector = createPublicOfficeProjector();
      ingestor = createEdgeReportIngestor(pool, 90, projector);
    });

    after(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE control_plane.accounts CASCADE");
      topology = await seedTopology(pool);
    });

    test("readiness checks the complete migration checksum set", async () => {
      assert.equal(
        (await migrationStatus(pool, config.migrationsDir)).ready,
        true,
      );
      const corrupted = await pool.query(
        `UPDATE control_plane.schema_migrations
            SET checksum = repeat('0', 64)
          WHERE name = '0001_control_plane.sql'
          RETURNING checksum`,
      );
      const expected = await readMigrations(config.migrationsDir);
      const expectedChecksum = expected[0]?.checksum;
      assert.ok(expectedChecksum);
      assert.equal(corrupted.rowCount, 1);

      try {
        assert.equal(
          (await migrationStatus(pool, config.migrationsDir)).ready,
          false,
        );
      } finally {
        await pool.query(
          `UPDATE control_plane.schema_migrations
              SET checksum = $1
            WHERE name = '0001_control_plane.sql'`,
          [expectedChecksum],
        );
      }
    });

    test("database schema has no forbidden raw WorkBuddy or mailbox columns", async () => {
      const result = await pool.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'control_plane'`,
      );
      const forbidden = new Set([
        "prompt",
        "message",
        "messages",
        "reply",
        "response",
        "content",
        "tool_args",
        "tool_arguments",
        "tool_input",
        "tool_output",
        "command",
        "output",
        "path",
        "project",
        "project_name",
        "repository",
        "repo",
        "session",
        "session_id",
        "transcript_path",
        "spool",
        "mail_body",
        "email_body",
        "oauth_token",
        "access_token",
        "refresh_token",
        "token",
      ]);
      assert.deepEqual(
        result.rows.filter((column) => forbidden.has(column.column_name)),
        [],
      );
    });

    test("uppercase UUIDs remain current across replay, next sequence, and takeover", async () => {
      const bootA = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
      const bootB = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
      const uppercaseIds = {
        instance_id: topology.instance.toUpperCase(),
        key_id: topology.key.toUpperCase(),
      };
      const first = prepare(
        validator,
        topology,
        bootA,
        null,
        [state(1)],
        uppercaseIds,
      );
      const firstAck = await accept(ingestor, topology, first);
      assert.equal(firstAck.boot_id, bootA.toLowerCase());
      assert.deepEqual(await accept(ingestor, topology, first), firstAck);
      await accept(
        ingestor,
        topology,
        prepare(
          validator,
          topology,
          bootA,
          null,
          [heartbeat(2)],
          uppercaseIds,
        ),
      );
      const takeover = await accept(
        ingestor,
        topology,
        prepare(
          validator,
          topology,
          bootB,
          bootA,
          [state(1)],
          uppercaseIds,
        ),
      );
      assert.equal(takeover.boot_id, bootB.toLowerCase());
    });

    test("identical concurrent first batches collapse to one ACK and one side effect", async () => {
      const report = prepare(
        validator,
        topology,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        null,
        [state(1)],
      );
      const [left, right] = await Promise.all([
        accept(ingestor, topology, report),
        accept(ingestor, topology, report),
      ]);
      assert.deepEqual(left, right);
      assert.deepEqual(await counts(pool), {
        boots: 1,
        receipts: 1,
        events: 1,
        presence: 1,
        intervals: 1,
        revisions: 1,
        outbox: 1,
      });
    });

    test("stats-only Mounts still advance the full public projection", async () => {
      await pool.query(
        `UPDATE control_plane.agent_office_mounts
            SET presence_visible = false
          WHERE id = $1`,
        [topology.mount],
      );
      await accept(
        ingestor,
        topology,
        prepare(
          validator,
          topology,
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          null,
          [state(1)],
        ),
      );

      const projection = await pool.query<{
        revision: string;
        snapshot_payload: {
          agents: unknown[];
          leaderboard: { entries: unknown[] };
        };
      }>(
        `SELECT revision::text, snapshot_payload
           FROM control_plane.office_current_public_projections
          WHERE office_id = $1`,
        [topology.office],
      );
      assert.equal(projection.rows[0]?.revision, "1");
      assert.deepEqual(projection.rows[0]?.snapshot_payload.agents, []);
      assert.deepEqual(
        projection.rows[0]?.snapshot_payload.leaderboard.entries,
        [],
      );
    });

    test("a pre-close heartbeat blocked in-flight is committed before Daily Award settlement", async () => {
      const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const firstAck = await accept(
        ingestor,
        topology,
        prepare(validator, topology, boot, null, [state(1)]),
      );
      const window = await seedClosingSettlementWindow(
        pool,
        topology,
        new Date(firstAck.server_received_at),
      );
      const report = prepare(
        validator,
        topology,
        boot,
        null,
        [heartbeat(2)],
      );
      const receiptBlocker = await pool.connect();
      let blockerActive = false;
      let delayedReport: ReturnType<typeof accept> | undefined;
      let settlement: Promise<number> | undefined;

      try {
        await receiptBlocker.query("BEGIN");
        blockerActive = true;
        await receiptBlocker.query(
          "LOCK TABLE control_plane.edge_report_receipts IN ACCESS EXCLUSIVE MODE",
        );

        delayedReport = accept(ingestor, topology, report);
        await waitForWaitingQuery(
          pool,
          "INSERT INTO control_plane.edge_report_receipts",
        );
        const beforeClose = await pool.query<{ before_close: boolean }>(
          "SELECT clock_timestamp() < $1::timestamptz AS before_close",
          [window.closesAt],
        );
        assert.equal(
          beforeClose.rows[0]?.before_close,
          true,
          "the legal heartbeat must reach ingestion before the Office closes",
        );

        await delay(Math.max(0, window.closesAt.getTime() - Date.now() + 25));
        settlement = tickPublicOffices(
          pool,
          projector,
          new Date(window.closesAt.getTime() + 1),
          5,
        );
        await waitForWaitingQuery(pool, "FOR UPDATE OF office");

        await receiptBlocker.query("COMMIT");
        blockerActive = false;
        const delayedAck = await delayedReport;
        assert.ok(
          new Date(delayedAck.server_received_at).getTime() <
            window.closesAt.getTime(),
          "the heartbeat received before close must remain part of that Office day",
        );
        assert.equal(await settlement, 1);

        const result = await pool.query<{
          outcome: string;
          winner_mount_id: string;
          winner_slacking_seconds: string;
        }>(
          `SELECT
             outcome,
             winner_mount_id,
             winner_slacking_seconds::text
           FROM control_plane.office_day_results
          WHERE office_id = $1
            AND office_local_date = $2::date`,
          [topology.office, window.officeLocalDate],
        );
        assert.deepEqual(result.rows[0], {
          outcome: "winner",
          winner_mount_id: topology.mount,
          winner_slacking_seconds: "900",
        });
      } finally {
        if (blockerActive) {
          await receiptBlocker.query("ROLLBACK").catch(() => undefined);
        }
        receiptBlocker.release();
        const pendingOperations: Promise<unknown>[] = [];
        if (delayedReport !== undefined) pendingOperations.push(delayedReport);
        if (settlement !== undefined) pendingOperations.push(settlement);
        await Promise.allSettled(pendingOperations);
      }
    });

    test("exact replay returns the stored ACK without renewing lease or emitting outbox", async () => {
      const report = prepare(
        validator,
        topology,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        null,
        [state(1)],
      );
      const first = await accept(ingestor, topology, report);
      await pool.query(
        `UPDATE control_plane.current_presence
            SET last_report_received_at =
                  clock_timestamp() - interval '2 minutes',
                lease_expires_at =
                  clock_timestamp() - interval '1 minute'
          WHERE instance_id = $1`,
        [topology.instance],
      );
      const before = await counts(pool);
      const replay = await accept(ingestor, topology, report);
      assert.deepEqual(replay, first);
      assert.deepEqual(await counts(pool), before);
      const presence = await pool.query<{ lease_expires_at: Date }>(
        `SELECT lease_expires_at
           FROM control_plane.current_presence
          WHERE instance_id = $1`,
        [topology.instance],
      );
      const presenceRow = presence.rows[0];
      assert.ok(presenceRow);
      assert.ok(
        presenceRow.lease_expires_at.getTime() < Date.now(),
        "replay must not renew an expired lease",
      );
    });

    test("same range with different payload conflicts and a gap has zero effects", async () => {
      const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, boot, null, [state(1)]),
      );
      const before = await counts(pool);
      await assertProtocolRejects(
        () =>
          accept(
            ingestor,
            topology,
            prepare(validator, topology, boot, null, [
              state(1, "working", "active"),
            ]),
          ),
        "sequence_conflict",
      );
      await assertProtocolRejects(
        () =>
          accept(
            ingestor,
            topology,
            prepare(validator, topology, boot, null, [heartbeat(3)]),
          ),
        "sequence_gap",
      );
      assert.deepEqual(await counts(pool), before);
    });

    test("partial overlap is distinct from reused sequence content conflict", async () => {
      const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, boot, null, [state(1), heartbeat(2)]),
      );
      const before = await counts(pool);
      await assertProtocolRejects(
        () =>
          accept(
            ingestor,
            topology,
            prepare(validator, topology, boot, null, [
              heartbeat(2),
              heartbeat(3),
            ]),
          ),
        "sequence_overlap",
      );
      const changedHeartbeat: EdgeEvent = {
        ...heartbeat(2),
        observed_at: "2026-07-24T12:00:01Z",
      };
      await assertProtocolRejects(
        () =>
          accept(
            ingestor,
            topology,
            prepare(validator, topology, boot, null, [
              changedHeartbeat,
              heartbeat(3),
            ]),
          ),
        "sequence_conflict",
      );
      assert.deepEqual(await counts(pool), before);
    });

    test("locked credential fingerprint must match pre-transaction verification", async () => {
      const report = prepare(
        validator,
        topology,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        null,
        [state(1)],
      );
      await assertProtocolRejects(
        () =>
          ingestor.ingest(report, {
            instanceId: topology.instance,
            keyId: topology.key,
            verification: "ed25519",
            credentialPublicKeySha256: Buffer.alloc(32, 0xff),
          }),
        "invalid_signature",
      );
      assert.deepEqual(await counts(pool), {
        boots: 0,
        receipts: 0,
        events: 0,
        presence: 0,
        intervals: 0,
        revisions: 0,
        outbox: 0,
      });
    });

    test("two CAS-linked successor boots cannot both win", async () => {
      const bootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootA, null, [state(1)]),
      );
      const bootB = prepare(
        validator,
        topology,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        bootA,
        [state(1)],
      );
      const bootC = prepare(
        validator,
        topology,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        bootA,
        [state(1)],
      );
      const results = await Promise.allSettled([
        accept(ingestor, topology, bootB),
        accept(ingestor, topology, bootC),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejection = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      assert.ok(rejection?.reason instanceof ProtocolProblem);
      assert.equal(rejection.reason.code, "stale_boot");
      const boots = await pool.query<{ count: string }>(
        `SELECT count(*) FROM control_plane.agent_instance_boots`,
      );
      assert.equal(Number(boots.rows[0]?.count), 2);
    });

    test("fenced replay and unseen wrong-predecessor boot are stale before sequence lookup", async () => {
      const bootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const bootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const firstA = prepare(
        validator,
        topology,
        bootA,
        null,
        [state(1)],
      );
      await accept(ingestor, topology, firstA);
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootB, bootA, [state(1)]),
      );
      const scrubbed = await pool.query<{
        event_count: string;
        retained_payload_bytes: string;
      }>(
        `SELECT
           (
             SELECT count(*)
               FROM control_plane.edge_event_fingerprints
              WHERE instance_id = $1
                AND boot_generation = 1
           ) AS event_count,
           (
             SELECT COALESCE(sum(octet_length(canonical_payload)), 0)
               FROM control_plane.edge_report_receipts
              WHERE instance_id = $1
                AND boot_generation = 1
           ) AS retained_payload_bytes`,
        [topology.instance],
      );
      assert.deepEqual(scrubbed.rows[0], {
        event_count: "0",
        retained_payload_bytes: "0",
      });
      const before = await counts(pool);
      await assertProtocolRejects(
        () => accept(ingestor, topology, firstA),
        "stale_boot",
      );
      await assertProtocolRejects(
        () =>
          accept(
            ingestor,
            topology,
            prepare(
              validator,
              topology,
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              bootA,
              [state(2)],
            ),
          ),
        "stale_boot",
      );
      assert.deepEqual(await counts(pool), before);
    });

    test("boot takeover after lease expiry closes the old interval at the lease boundary", async () => {
      const bootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const bootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootA, null, [state(1)]),
      );
      const expired = await pool.query<{ lease_expires_at: Date }>(
        `UPDATE control_plane.current_presence
            SET last_report_received_at =
                  clock_timestamp() - interval '2 minutes',
                lease_expires_at =
                  clock_timestamp() - interval '1 minute'
          WHERE instance_id = $1
          RETURNING lease_expires_at`,
        [topology.instance],
      );
      await pool.query(
        `UPDATE control_plane.derived_activity_intervals
            SET started_at = clock_timestamp() - interval '3 minutes'
          WHERE instance_id = $1
            AND ended_at IS NULL`,
        [topology.instance],
      );
      const expiredAt = expired.rows[0]?.lease_expires_at;
      assert.ok(expiredAt);

      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootB, bootA, [state(1)]),
      );
      const intervals = await pool.query<{
        ended_at: Date | null;
        close_reason: string | null;
      }>(
        `SELECT ended_at, close_reason
           FROM control_plane.derived_activity_intervals
          WHERE instance_id = $1
          ORDER BY started_at, id`,
        [topology.instance],
      );
      assert.equal(intervals.rows.length, 2);
      assert.equal(intervals.rows[0]?.close_reason, "lease_expired");
      assert.equal(intervals.rows[0]?.ended_at?.toISOString(), expiredAt.toISOString());
      assert.equal(intervals.rows[1]?.ended_at, null);
    });

    test("heartbeat lease recovery advances the interval end sequence", async () => {
      const bootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const bootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootA, null, [state(1)]),
      );
      await pool.query(
        `UPDATE control_plane.current_presence
            SET last_report_received_at =
                  clock_timestamp() - interval '2 minutes',
                lease_expires_at =
                  clock_timestamp() - interval '1 minute'
          WHERE instance_id = $1`,
        [topology.instance],
      );
      await pool.query(
        `UPDATE control_plane.derived_activity_intervals
            SET started_at = clock_timestamp() - interval '3 minutes'
          WHERE instance_id = $1
            AND ended_at IS NULL`,
        [topology.instance],
      );
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootA, null, [heartbeat(2)]),
      );
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, bootB, bootA, [state(1)]),
      );
      const recovered = await pool.query<{
        start_sequence: string;
        end_sequence: string;
        close_reason: string;
      }>(
        `SELECT start_sequence, end_sequence, close_reason
           FROM control_plane.derived_activity_intervals
          WHERE instance_id = $1
            AND boot_generation = 1
          ORDER BY started_at DESC
          LIMIT 1`,
        [topology.instance],
      );
      assert.deepEqual(recovered.rows[0], {
        start_sequence: "2",
        end_sequence: "2",
        close_reason: "boot_replaced",
      });
    });

    test("lease sweeper closes at the exact expiry and emits one offline revision", async () => {
      const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, boot, null, [state(1)]),
      );
      const expiredAt = await expirePresenceForTest(pool, topology.instance);
      assert.equal(await expireDueLeases(pool), 1);
      assert.equal(await expireDueLeases(pool), 0);

      const presence = await pool.query<{
        lease_closed_at: Date | null;
      }>(
        `SELECT lease_closed_at
           FROM control_plane.current_presence
          WHERE instance_id = $1`,
        [topology.instance],
      );
      assert.equal(
        presence.rows[0]?.lease_closed_at?.toISOString(),
        expiredAt.toISOString(),
      );
      const interval = await pool.query<{
        ended_at: Date;
        close_reason: string;
      }>(
        `SELECT ended_at, close_reason
           FROM control_plane.derived_activity_intervals
          WHERE instance_id = $1`,
        [topology.instance],
      );
      assert.equal(interval.rows[0]?.ended_at.toISOString(), expiredAt.toISOString());
      assert.equal(interval.rows[0]?.close_reason, "lease_expired");
      const offlineEvent = await pool.query<{
        event_type: string;
        projection_format_version: number;
        public_payload: {
          office_revision: number;
          agents: Array<{
            mount_id: string;
            presence: string;
            display_state: null;
          }>;
        };
      }>(
        `SELECT event_type, projection_format_version, public_payload
           FROM control_plane.office_revision_events
          WHERE office_id = $1
          ORDER BY revision DESC
          LIMIT 1`,
        [topology.office],
      );
      assert.equal(offlineEvent.rows[0]?.event_type, "presence_removed");
      assert.equal(offlineEvent.rows[0]?.projection_format_version, 1);
      const offlineAgent = offlineEvent.rows[0]?.public_payload.agents.find(
        (agent) => agent.mount_id === topology.mount,
      );
      assert.deepEqual(
        {
          presence: offlineAgent?.presence,
          display_state: offlineAgent?.display_state,
        },
        { presence: "offline", display_state: null },
      );
    });

    test("heartbeat and lease sweeper serialize without losing the renewed interval", async () => {
      const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await accept(
        ingestor,
        topology,
        prepare(validator, topology, boot, null, [state(1)]),
      );
      await expirePresenceForTest(pool, topology.instance);
      const heartbeatReport = prepare(
        validator,
        topology,
        boot,
        null,
        [heartbeat(2)],
      );
      await Promise.all([
        expireDueLeases(pool),
        accept(ingestor, topology, heartbeatReport),
      ]);

      const presence = await pool.query<{
        last_accepted_sequence: string;
        lease_closed_at: Date | null;
        lease_expires_at: Date;
      }>(
        `SELECT last_accepted_sequence, lease_closed_at, lease_expires_at
           FROM control_plane.current_presence
          WHERE instance_id = $1`,
        [topology.instance],
      );
      assert.equal(presence.rows[0]?.last_accepted_sequence, "2");
      assert.equal(presence.rows[0]?.lease_closed_at, null);
      assert.ok(
        (presence.rows[0]?.lease_expires_at.getTime() ?? 0) > Date.now(),
      );
      const openIntervals = await pool.query<{ count: string }>(
        `SELECT count(*)
           FROM control_plane.derived_activity_intervals
          WHERE instance_id = $1
            AND ended_at IS NULL`,
        [topology.instance],
      );
      assert.equal(Number(openIntervals.rows[0]?.count), 1);
    });

    test("a mid-batch database failure rolls back boot, receipt, events, presence, and outbox", async () => {
      await pool.query(`
        CREATE OR REPLACE FUNCTION control_plane.test_fail_second_event()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.sequence = 2 THEN
            RAISE EXCEPTION 'injected event failure';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await pool.query(`
        CREATE TRIGGER test_fail_second_event
        BEFORE INSERT ON control_plane.edge_event_fingerprints
        FOR EACH ROW EXECUTE FUNCTION control_plane.test_fail_second_event()
      `);
      try {
        const report = prepare(
          validator,
          topology,
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          null,
          [state(1), heartbeat(2)],
        );
        await assertProtocolRejects(
          () => accept(ingestor, topology, report),
          "internal_error",
        );
        assert.deepEqual(await counts(pool), {
          boots: 0,
          receipts: 0,
          events: 0,
          presence: 0,
          intervals: 0,
          revisions: 0,
          outbox: 0,
        });
        const head = await pool.query<{
          current_boot_id: string | null;
          current_boot_generation: string;
        }>(
          `SELECT current_boot_id, current_boot_generation
             FROM control_plane.edge_instance_heads
            WHERE instance_id = $1`,
          [topology.instance],
        );
        assert.deepEqual(head.rows[0], {
          current_boot_id: null,
          current_boot_generation: "0",
        });
      } finally {
        await pool.query(
          `DROP TRIGGER IF EXISTS test_fail_second_event
             ON control_plane.edge_event_fingerprints`,
        );
        await pool.query(
          `DROP FUNCTION IF EXISTS control_plane.test_fail_second_event()`,
        );
      }
    });
  });
}

interface TestTopology {
  account: string;
  office: string;
  room: string;
  agent: string;
  instance: string;
  key: string;
  mount: string;
}

async function seedTopology(pool: DatabasePool): Promise<TestTopology> {
  const topology: TestTopology = {
    account: randomUUID(),
    office: randomUUID(),
    room: randomUUID(),
    agent: randomUUID(),
    instance: randomUUID(),
    key: randomUUID(),
    mount: randomUUID(),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO control_plane.accounts (id) VALUES ($1)`,
      [topology.account],
    );
    await client.query(
      `INSERT INTO control_plane.offices (id, owner_account_id, name)
       VALUES ($1, $2, 'Test Office')`,
      [topology.office, topology.account],
    );
    await client.query(
      `INSERT INTO control_plane.rooms (id, office_id, name)
       VALUES ($1, $2, 'Lobby')`,
      [topology.room, topology.office],
    );
    await client.query(
      `INSERT INTO control_plane.memberships (
         id, office_id, account_id
       ) VALUES ($1, $2, $3)`,
      [randomUUID(), topology.office, topology.account],
    );
    await client.query(
      `INSERT INTO control_plane.logical_agents (
         id, owner_account_id, alias, pet_id
       ) VALUES ($1, $2, 'Sora', 'sora-shiba')`,
      [topology.agent, topology.account],
    );
    await client.query(
      `INSERT INTO control_plane.agent_instances (id, logical_agent_id)
       VALUES ($1, $2)`,
      [topology.instance, topology.agent],
    );
    await client.query(
      `UPDATE control_plane.logical_agents
          SET active_reporting_instance_id = $2
        WHERE id = $1`,
      [topology.agent, topology.instance],
    );
    await client.query(
      `INSERT INTO control_plane.device_credentials (
         key_id, instance_id, public_key, valid_until
       ) VALUES (
         $1, $2, decode(repeat('00', 32), 'hex'),
         clock_timestamp() + interval '1 day'
       )`,
      [topology.key, topology.instance],
    );
    await client.query(
      `INSERT INTO control_plane.edge_instance_heads (instance_id)
       VALUES ($1)`,
      [topology.instance],
    );
    await client.query(
      `INSERT INTO control_plane.agent_office_mounts (
         id, office_id, logical_agent_id, room_id, scene_slot,
         presence_visible, stats_opt_in, poster_opt_in
       ) VALUES ($1, $2, $3, $4, 0, true, true, true)`,
      [
        topology.mount,
        topology.office,
        topology.agent,
        topology.room,
      ],
    );
    await client.query("COMMIT");
    return topology;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface ClosingSettlementWindow {
  officeLocalDate: string;
  closesAt: Date;
}

async function seedClosingSettlementWindow(
  pool: DatabasePool,
  topology: TestTopology,
  firstReceivedAt: Date,
): Promise<ClosingSettlementWindow> {
  const timing = await pool.query<{
    office_local_date: string;
    closes_at: Date;
  }>(
    `SELECT
       (closing.closes_at AT TIME ZONE 'UTC')::date::text
         AS office_local_date,
       closing.closes_at
     FROM (
       SELECT date_trunc(
         'milliseconds',
         GREATEST(
           clock_timestamp() + interval '8 seconds',
           $1::timestamptz + interval '8 seconds'
         )
       ) AS closes_at
     ) closing`,
    [firstReceivedAt],
  );
  const row = timing.rows[0];
  if (row === undefined) throw new Error("Settlement window clock missing");
  const startsAt = new Date(row.closes_at.getTime() - 30 * 60 * 1_000);
  const priorLeaseExpiresAt = new Date(row.closes_at.getTime() - 2_000);
  const scheduleVersionId = randomUUID();
  const scheduleRuleId = randomUUID();
  const isoWeekday =
    new Date(`${row.office_local_date}T12:00:00.000Z`).getUTCDay() || 7;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE control_plane.current_presence
          SET activity_since = $2,
              eligible_since = $2,
              lease_expires_at = $3
        WHERE instance_id = $1`,
      [topology.instance, startsAt, priorLeaseExpiresAt],
    );
    await client.query(
      `UPDATE control_plane.derived_activity_intervals
          SET started_at = $2
        WHERE instance_id = $1
          AND ended_at IS NULL`,
      [topology.instance, startsAt],
    );
    await client.query(
      `INSERT INTO control_plane.mount_stats_eligibility_intervals (
         id, office_id, mount_id, started_at
       ) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), topology.office, topology.mount, startsAt],
    );
    await client.query(
      `INSERT INTO control_plane.office_schedule_versions (
         id, office_id, version, timezone, effective_from_local_date
       ) VALUES ($1, $2, 1, 'UTC', $3::date)`,
      [scheduleVersionId, topology.office, row.office_local_date],
    );
    await client.query(
      `INSERT INTO control_plane.office_schedule_rules (
         id, office_id, schedule_version_id, iso_weekday,
         start_local_time, end_local_time, end_day_offset
       ) VALUES (
         $1, $2, $3, $4,
         TIME '00:00', TIME '00:01', 0
       )`,
      [scheduleRuleId, topology.office, scheduleVersionId, isoWeekday],
    );
    await client.query(
      `INSERT INTO control_plane.office_schedule_occurrences (
         id, office_id, schedule_version_id, schedule_rule_id,
         office_local_date, starts_at, ends_at
       ) VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
      [
        randomUUID(),
        topology.office,
        scheduleVersionId,
        scheduleRuleId,
        row.office_local_date,
        startsAt,
        row.closes_at,
      ],
    );
    await client.query(
      `INSERT INTO control_plane.office_public_view_tokens (
         id, office_id, token_hash
       ) VALUES ($1, $2, $3)`,
      [randomUUID(), topology.office, Buffer.alloc(32, 7)],
    );
    await client.query("COMMIT");
    return {
      officeLocalDate: row.office_local_date,
      closesAt: row.closes_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForWaitingQuery(
  pool: DatabasePool,
  queryFragment: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE '%' || $1 || '%'
       ) AS waiting`,
      [queryFragment],
    );
    if (waiting.rows[0]?.waiting) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for PostgreSQL query: ${queryFragment}`);
}

function prepare(
  validator: EdgeReportValidator,
  topology: TestTopology,
  bootId: string,
  previousBootId: string | null,
  events: EdgeEvent[],
  overrides: Partial<EdgeReportEnvelope> = {},
): PreparedEdgeReport {
  const envelope: EdgeReportEnvelope = {
    protocol_version: 1,
    instance_id: topology.instance,
    key_id: topology.key,
    boot_id: bootId,
    previous_boot_id: previousBootId,
    first_sequence: events[0]?.sequence ?? 1,
    events,
    sent_at: "2026-07-24T12:00:01Z",
    client_version: "0.1.0",
    signature: `${"A".repeat(86)}==`,
    ...overrides,
  };
  return validator.prepare(envelope, "batch");
}

function state(
  sequence: number,
  displayState: "idle" | "working" = "idle",
  activityState: "eligible_idle" | "active" = "eligible_idle",
): EdgeEvent {
  return {
    sequence,
    kind: "state_transition",
    observed_at: "2026-07-24T12:00:00Z",
    display_state: displayState,
    activity_state: activityState,
    pet_id: "sora-shiba",
  };
}

function heartbeat(sequence: number): EdgeEvent {
  return {
    sequence,
    kind: "heartbeat",
    observed_at: "2026-07-24T12:00:00Z",
  };
}

function accept(
  ingestor: EdgeReportIngestor,
  topology: TestTopology,
  report: PreparedEdgeReport,
) {
  const verified: VerifiedEdgeContext = {
    instanceId: topology.instance,
    keyId: topology.key,
    verification: "development_bypass",
  };
  return ingestor.ingest(report, verified);
}

async function assertProtocolRejects(
  operation: () => Promise<unknown>,
  code: ProtocolProblem["code"],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return error instanceof ProtocolProblem && error.code === code;
  });
}

async function counts(pool: DatabasePool): Promise<Record<string, number>> {
  const result = await pool.query<{
    boots: string;
    receipts: string;
    events: string;
    presence: string;
    intervals: string;
    revisions: string;
    outbox: string;
  }>(`
    SELECT
      (SELECT count(*) FROM control_plane.agent_instance_boots) AS boots,
      (SELECT count(*) FROM control_plane.edge_report_receipts) AS receipts,
      (SELECT count(*) FROM control_plane.edge_event_fingerprints) AS events,
      (SELECT count(*) FROM control_plane.current_presence) AS presence,
      (SELECT count(*) FROM control_plane.derived_activity_intervals) AS intervals,
      (SELECT count(*) FROM control_plane.office_revision_events) AS revisions,
      (SELECT count(*) FROM control_plane.domain_outbox) AS outbox
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error("Count query returned no row");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  );
}

async function expirePresenceForTest(
  pool: DatabasePool,
  instanceId: string,
): Promise<Date> {
  const expired = await pool.query<{ lease_expires_at: Date }>(
    `UPDATE control_plane.current_presence
        SET last_report_received_at =
              clock_timestamp() - interval '2 minutes',
            lease_expires_at =
              clock_timestamp() - interval '1 minute',
            lease_closed_at = NULL
      WHERE instance_id = $1
      RETURNING lease_expires_at`,
    [instanceId],
  );
  await pool.query(
    `UPDATE control_plane.derived_activity_intervals
        SET started_at = clock_timestamp() - interval '3 minutes'
      WHERE instance_id = $1
        AND ended_at IS NULL`,
    [instanceId],
  );
  const expiredAt = expired.rows[0]?.lease_expires_at;
  if (expiredAt === undefined) throw new Error("Presence fixture missing");
  return expiredAt;
}
