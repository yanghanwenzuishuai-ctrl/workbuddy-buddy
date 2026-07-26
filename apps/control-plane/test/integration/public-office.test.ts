import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { changeMountConsent } from "../../src/modules/public-office/application/change-mount-consent.js";
import { rotatePublicViewToken } from "../../src/modules/public-office/application/manage-public-view-token.js";
import {
  createOfficeRevisionBroker,
  type OfficeRevisionBroker,
} from "../../src/modules/public-office/application/office-revision-broker.js";
import {
  createPublicOfficeProjector,
  type PublicOfficeProjector,
} from "../../src/modules/public-office/application/public-office-projector.js";
import {
  createPublicOfficeReader,
  type PublicOfficeReader,
} from "../../src/modules/public-office/application/public-office-reader.js";
import { retainOfficeRevisions } from "../../src/modules/public-office/application/retain-office-revisions.js";
import { tickPublicOffices } from "../../src/modules/public-office/application/tick-public-offices.js";
import {
  createPublicOfficeSnapshotValidator,
} from "../../src/platform/contracts/public-office-snapshot-validator.js";
import { createEdgeReportValidator } from "../../src/platform/contracts/edge-report-validator.js";
import { migrate } from "../../src/platform/db/migrations.js";
import {
  createDatabasePool,
  type DatabasePool,
} from "../../src/platform/db/pool.js";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const RAW_TOKEN = "public_office_test_token_0123456789abcdef";
const UNKNOWN_TOKEN = "public_office_unknown_0123456789abcdef";
const PROJECTION_AT = new Date("2099-07-24T12:00:00.000Z");

if (testDatabaseUrl === undefined) {
  test(
    "PostgreSQL Public Office integration tests",
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

  describe("PostgreSQL Public Office projection and transport", () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      DATABASE_SSL: "false",
    });
    let pool: DatabasePool;
    let projector: PublicOfficeProjector;
    let reader: PublicOfficeReader;
    let broker: OfficeRevisionBroker;
    let app: ReturnType<typeof buildApp>;
    let baseUrl: string;
    let topology: PublicTopology;
    let snapshotValidator: Awaited<
      ReturnType<typeof createPublicOfficeSnapshotValidator>
    >;

    before(async () => {
      pool = createDatabasePool(config);
      await pool.query("DROP EXTENSION IF EXISTS btree_gist CASCADE");
      await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await migrate(pool, config.migrationsDir);
      snapshotValidator = await createPublicOfficeSnapshotValidator(
        config.contractsDir,
      );
      projector = createPublicOfficeProjector(snapshotValidator);
      reader = createPublicOfficeReader(pool);
      broker = createOfficeRevisionBroker(pool);
      await broker.start();
      app = buildApp({
        config,
        pool,
        validator: await createEdgeReportValidator(config.contractsDir),
        publicOfficeProjector: projector,
        officeRevisionBroker: broker,
      });
      baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    });

    after(async () => {
      await app.close();
      await broker.close();
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE control_plane.accounts CASCADE");
      topology = await seedPublicTopology(pool, projector);
    });

    test("empty migration installs native exclusion constraints without overlap triggers", async () => {
      const extension = await pool.query<{ extname: string }>(
        `SELECT extname
           FROM pg_extension
          WHERE extname = 'btree_gist'`,
      );
      assert.deepEqual(extension.rows, [{ extname: "btree_gist" }]);

      const constraints = await pool.query<{ conname: string }>(
        `SELECT conname
           FROM pg_constraint
          WHERE connamespace = 'control_plane'::regnamespace
            AND contype = 'x'
          ORDER BY conname`,
      );
      assert.deepEqual(
        constraints.rows.map((row) => row.conname),
        [
          "derived_activity_intervals_no_overlap",
          "mount_stats_eligibility_intervals_no_overlap",
          "office_schedule_occurrences_no_overlap",
          "office_schedule_occurrences_one_version_per_day",
        ],
      );

      const raceProneTriggers = await pool.query<{ tgname: string }>(
        `SELECT tgname
           FROM pg_trigger
          WHERE tgrelid IN (
              'control_plane.derived_activity_intervals'::regclass,
              'control_plane.mount_stats_eligibility_intervals'::regclass,
              'control_plane.office_schedule_occurrences'::regclass
          )
            AND NOT tgisinternal
            AND tgname IN (
              'derived_activity_intervals_no_overlap',
              'mount_stats_eligibility_intervals_no_overlap',
              'office_schedule_occurrences_no_conflict'
          )`,
      );
      assert.deepEqual(raceProneTriggers.rows, []);
    });

    test("snapshot bytes, ETag, consent filters, stage and ranking are immutable per revision", async () => {
      const first = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      const second = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });

      assert.equal(first.statusCode, 200);
      assert.equal(first.headers["cache-control"], "private, no-store");
      assert.equal(first.headers.etag, '"office-1"');
      assert.equal(first.headers["x-office-revision"], "1");
      assert.equal(first.body, second.body);

      const snapshot = JSON.parse(first.body) as {
        office_revision: number;
        agents: Array<{ idle_stage: string; pet_id: string }>;
        leaderboard: {
          entries: Array<{ mount_id: string; slacking_seconds: number }>;
        };
      };
      snapshotValidator.assert(snapshot);
      assert.equal(snapshot.office_revision, 1);
      assert.deepEqual(snapshot.agents, [
        {
          alias: "Sora",
          display_state: "done",
          idle_stage: "salted",
          mount_id: topology.mount,
          pet_id: "sora-shiba",
          presence: "online",
          room_id: topology.room,
          scene_slot: 0,
        },
      ]);
      assert.deepEqual(snapshot.leaderboard.entries, [
        {
          alias: "Sora",
          mount_id: topology.mount,
          pet_id: "sora-shiba",
          rank: 1,
          slacking_seconds: 900,
        },
      ]);
    });

    test("public Office page is same-origin, no-store and protected from referrer leaks", async () => {
      const page = await app.inject({
        method: "GET",
        url: `/o/${RAW_TOKEN}`,
      });
      const script = await app.inject({
        method: "GET",
        url: "/office.js",
      });
      const stylesheet = await app.inject({
        method: "GET",
        url: "/office.css",
      });
      const petPreview = await app.inject({
        method: "GET",
        url: "/pets/sora-shiba/preview.png",
      });
      const unknownPetPreview = await app.inject({
        method: "GET",
        url: "/pets/not-a-real-pet/preview.png",
      });

      assert.equal(page.statusCode, 200);
      assert.equal(page.headers["cache-control"], "private, no-store");
      assert.equal(page.headers["referrer-policy"], "no-referrer");
      assert.match(
        String(page.headers["content-security-policy"]),
        /connect-src 'self'/,
      );
      assert.equal(page.body.includes("WORKBUDDY BUDDY"), true);
      assert.equal(script.statusCode, 200);
      assert.equal(script.body.includes("/api/v1/offices/"), true);
      assert.equal(stylesheet.statusCode, 200);
      assert.equal(stylesheet.body.includes("@media"), true);
      assert.equal(petPreview.statusCode, 200);
      assert.equal(petPreview.headers["content-type"], "image/png");
      assert.equal(
        petPreview.headers["cross-origin-resource-policy"],
        "same-origin",
      );
      assert.equal(unknownPetPreview.statusCode, 404);
    });

    test("malformed, unknown, expired and revoked capabilities share one safe 404", async () => {
      const malformed = await app.inject({
        method: "GET",
        url: "/api/v1/offices/short/snapshot",
      });
      const unknown = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${UNKNOWN_TOKEN}/snapshot`,
      });
      await pool.query(
        `UPDATE control_plane.office_public_view_tokens
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE office_id = $1`,
        [topology.office],
      );
      const expired = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      await pool.query(
        `UPDATE control_plane.office_public_view_tokens
            SET expires_at = NULL,
                revoked_at = clock_timestamp()
          WHERE office_id = $1`,
        [topology.office],
      );
      const revoked = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });

      for (const response of [malformed, unknown, expired, revoked]) {
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers["cache-control"], "private, no-store");
        assert.equal(response.body.includes(RAW_TOKEN), false);
        assert.equal(response.body.includes(UNKNOWN_TOKEN), false);
      }
      assert.equal(malformed.body, unknown.body);
      assert.equal(unknown.body, expired.body);
      assert.equal(expired.body, revoked.body);
    });

    test("public capability rotation returns one new secret while persisting hashes only", async () => {
      const rotated = await rotatePublicViewToken(
        pool,
        topology.office,
        new Date(PROJECTION_AT.getTime() + 60_000),
      );
      assert.ok(rotated);
      assert.match(rotated.rawToken, /^[A-Za-z0-9_-]{43}$/);

      const oldView = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      const newView = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${rotated.rawToken}/snapshot`,
      });
      assert.equal(oldView.statusCode, 404);
      assert.equal(newView.statusCode, 200);

      const persisted = await pool.query<{
        active: string;
        raw_secret_matches: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE revoked_at IS NULL)::text AS active,
           count(*) FILTER (
             WHERE encode(token_hash, 'escape') = $2
           )::text AS raw_secret_matches
         FROM control_plane.office_public_view_tokens
         WHERE office_id = $1`,
        [topology.office, rotated.rawToken],
      );
      assert.deepEqual(persisted.rows[0], {
        active: "1",
        raw_secret_matches: "0",
      });
    });

    test("token rotation notification closes an active SSE using the old capability", async () => {
      const controller = new AbortController();
      const stream = await fetch(
        `${baseUrl}/api/v1/offices/${RAW_TOKEN}/events?after_revision=1`,
        { signal: controller.signal },
      );
      assert.equal(stream.status, 200);
      const streamReader = stream.body?.getReader();
      assert.ok(streamReader);

      const rotated = await rotatePublicViewToken(
        pool,
        topology.office,
        new Date(PROJECTION_AT.getTime() + 60_000),
      );
      assert.ok(rotated);

      try {
        const closed = await withTimeout(
          streamReader.read(),
          2_000,
          "old-capability SSE did not close after token rotation",
        );
        assert.equal(closed.done, true);
      } finally {
        controller.abort();
      }
    });

    test("SSE replays the exact canonical full snapshot and validates cursors", async () => {
      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      const controller = new AbortController();
      const stream = await fetch(
        `${baseUrl}/api/v1/offices/${RAW_TOKEN}/events?after_revision=0`,
        { signal: controller.signal },
      );
      assert.equal(stream.status, 200);
      assert.equal(stream.headers.get("cache-control"), "private, no-store");
      assert.equal(stream.headers.get("x-accel-buffering"), "no");
      const streamReader = stream.body?.getReader();
      assert.ok(streamReader);
      const chunk = await streamReader.read();
      const frame = new TextDecoder().decode(chunk.value);
      controller.abort();
      assert.match(frame, /^id: 1\nevent: office\.snapshot\ndata: /);
      assert.equal(
        frame.slice(frame.indexOf("data: ") + 6, frame.indexOf("\n\n")),
        snapshot.body,
      );

      const mismatch = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/events?after_revision=0`,
        headers: { "last-event-id": "1" },
      });
      assert.equal(mismatch.statusCode, 400);
      const future = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/events?after_revision=2`,
      });
      assert.equal(future.statusCode, 400);
    });

    test("SSE replay leases serialize disclosure before a consent withdrawal commit", async () => {
      const lease = await reader.acquireLockedStreamPage(
        reader.capabilityFor(RAW_TOKEN)!,
        0,
      );
      assert.equal(lease.page.status, "ok");
      assert.equal(
        lease.page.events?.[0]?.canonicalPayload
          .toString("utf8")
          .includes("Sora"),
        true,
      );

      let withdrawalCommitted = false;
      const withdrawal = changeMountConsent(pool, projector, {
        mountId: topology.mount,
        presenceVisible: false,
        changedAt: new Date(PROJECTION_AT.getTime() + 60_000),
      }).then((result) => {
        withdrawalCommitted = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(withdrawalCommitted, false);

      await lease.release();
      assert.equal((await withdrawal).revision, 2);
      assert.equal(withdrawalCommitted, true);
      const staleCursor = await reader.getStreamPage(
        reader.capabilityFor(RAW_TOKEN)!,
        0,
      );
      assert.equal(staleCursor.status, "revision_gap");
    });

    test("privacy-lowering projection invalidates unsafe replay without hiding stats-only Mounts", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT id
             FROM control_plane.offices
            WHERE id = $1
            FOR UPDATE`,
          [topology.office],
        );
        await client.query(
          `UPDATE control_plane.agent_office_mounts
              SET presence_visible = false,
                  updated_at = $2
            WHERE id = $1`,
          [topology.mount, new Date(PROJECTION_AT.getTime() + 60_000)],
        );
        await projector.recordPrivacyLoweringRevision(client, {
          officeId: topology.office,
          eventType: "consent_changed",
          sourceKind: "consent_change",
          sourceKey: `consent:${topology.mount}:presence:off`,
          sourceReceiptId: null,
          at: new Date(PROJECTION_AT.getTime() + 60_000),
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      assert.equal(snapshot.statusCode, 200);
      const body = JSON.parse(snapshot.body) as {
        agents: unknown[];
        leaderboard: { entries: unknown[] };
      };
      assert.deepEqual(body.agents, []);
      assert.equal(body.leaderboard.entries.length, 1);

      const unsafeCursor = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/events?after_revision=0`,
      });
      assert.equal(unsafeCursor.statusCode, 409);
      assert.equal(unsafeCursor.headers["x-office-revision"], "2");
      assert.equal(
        (JSON.parse(unsafeCursor.body) as { code: string }).code,
        "revision_gap",
      );

      const safePage = await reader.getStreamPage(
        reader.capabilityFor(RAW_TOKEN)!,
        1,
      );
      assert.equal(safePage.status, "ok");
      assert.deepEqual(
        safePage.events?.map((event) => event.revision),
        [2],
      );
    });

    test("stats opt-out resets the public idle stage and removes leaderboard data", async () => {
      const changedAt = new Date(PROJECTION_AT.getTime() + 60_000);
      assert.deepEqual(
        await changeMountConsent(pool, projector, {
          mountId: topology.mount,
          statsOptIn: false,
          changedAt,
        }),
        {
          changed: true,
          officeId: topology.office,
          revision: 2,
        },
      );

      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      const body = JSON.parse(snapshot.body) as {
        agents: Array<{ idle_stage: string }>;
        leaderboard: { entries: unknown[] };
      };
      assert.equal(body.agents[0]?.idle_stage, "none");
      assert.deepEqual(body.leaderboard.entries, []);
    });

    test("projection ticks settle one immutable Daily Award and expose it publicly", async () => {
      const settlementAt = new Date("2099-07-25T00:00:00.000Z");
      assert.equal(
        await tickPublicOffices(
          pool,
          projector,
          settlementAt,
          30,
        ),
        1,
      );
      assert.equal(
        await tickPublicOffices(
          pool,
          projector,
          settlementAt,
          30,
        ),
        0,
      );

      const result = await pool.query<{
        outcome: string;
        winner_mount_id: string;
        winner_slacking_seconds: string;
      }>(
        `SELECT outcome, winner_mount_id, winner_slacking_seconds::text
           FROM control_plane.office_day_results
          WHERE office_id = $1
            AND office_local_date = DATE '2099-07-24'`,
        [topology.office],
      );
      assert.deepEqual(result.rows[0], {
        outcome: "winner",
        winner_mount_id: topology.mount,
        winner_slacking_seconds: "990",
      });

      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      const body = JSON.parse(snapshot.body) as {
        office_revision: number;
        daily_award: {
          office_local_date: string;
          final: boolean;
          winner: { mount_id: string; slacking_seconds: number };
        };
      };
      assert.equal(body.office_revision, 2);
      assert.equal(body.daily_award.office_local_date, "2099-07-24");
      assert.equal(body.daily_award.final, true);
      assert.deepEqual(body.daily_award.winner, {
        alias: "Sora",
        mount_id: topology.mount,
        pet_id: "sora-shiba",
        slacking_seconds: 990,
      });

      await assert.rejects(
        pool.query(
          `UPDATE control_plane.office_day_results
              SET winner_alias = 'Changed'
            WHERE office_id = $1
              AND office_local_date = DATE '2099-07-24'`,
          [topology.office],
        ),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "55000",
      );
    });

    test("zero-score Office days settle once as no-award", async () => {
      await pool.query(
        `DELETE FROM control_plane.derived_activity_intervals
          WHERE instance_id = (
            SELECT agent.active_reporting_instance_id
              FROM control_plane.agent_office_mounts mount
              JOIN control_plane.logical_agents agent
                ON agent.id = mount.logical_agent_id
             WHERE mount.id = $1
          )`,
        [topology.mount],
      );
      const settlementAt = new Date("2099-07-25T00:00:00.000Z");
      assert.equal(
        await tickPublicOffices(
          pool,
          projector,
          settlementAt,
          30,
        ),
        1,
      );
      const result = await pool.query<{
        outcome: string;
        winner_mount_id: string | null;
      }>(
        `SELECT outcome, winner_mount_id
           FROM control_plane.office_day_results
          WHERE office_id = $1
            AND office_local_date = DATE '2099-07-24'`,
        [topology.office],
      );
      assert.deepEqual(result.rows[0], {
        outcome: "no_award",
        winner_mount_id: null,
      });
      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${RAW_TOKEN}/snapshot`,
      });
      assert.equal(
        (JSON.parse(snapshot.body) as { daily_award: unknown }).daily_award,
        null,
      );
    });

    test("the database rejects overlapping score intervals and revision mutation", async () => {
      await assert.rejects(
        pool.query(
          `INSERT INTO control_plane.mount_stats_eligibility_intervals (
             id, office_id, mount_id, started_at, ended_at, close_reason
           ) VALUES (
             $1, $2, $3,
             $4::timestamptz - interval '1 hour',
             $4::timestamptz + interval '1 hour',
             'stats_opt_out'
           )`,
          [randomUUID(), topology.office, topology.mount, PROJECTION_AT],
        ),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23P01",
      );
      await assert.rejects(
        pool.query(
          `UPDATE control_plane.office_revision_events
              SET public_payload = public_payload
            WHERE office_id = $1
              AND revision = 1`,
          [topology.office],
        ),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "55000",
      );
    });

    test("native half-open exclusions serialize concurrent interval inserts", async () => {
      await pool.query(
        `UPDATE control_plane.derived_activity_intervals
            SET ended_at = $2,
                end_sequence = 1,
                close_reason = 'state_changed'
          WHERE instance_id = $1
            AND ended_at IS NULL`,
        [topology.instance, PROJECTION_AT],
      );
      await pool.query(
        `UPDATE control_plane.mount_stats_eligibility_intervals
            SET ended_at = $2,
                close_reason = 'stats_opt_out'
          WHERE mount_id = $1
            AND ended_at IS NULL`,
        [topology.mount, PROJECTION_AT],
      );

      const activityInsert = `
        INSERT INTO control_plane.derived_activity_intervals (
          id, instance_id, boot_generation, activity_state,
          started_at, ended_at, start_sequence, end_sequence, close_reason
        ) VALUES ($1, $2, 1, 'active', $3, $4, $5, $5, 'state_changed')`;
      await assertConcurrentExclusionConflict(
        pool,
        {
          text: activityInsert,
          values: [
            randomUUID(),
            topology.instance,
            new Date("2099-07-24T13:00:00.000Z"),
            new Date("2099-07-24T14:00:00.000Z"),
            2,
          ],
        },
        {
          text: activityInsert,
          values: [
            randomUUID(),
            topology.instance,
            new Date("2099-07-24T13:30:00.000Z"),
            new Date("2099-07-24T14:30:00.000Z"),
            3,
          ],
        },
      );
      await pool.query(activityInsert, [
        randomUUID(),
        topology.instance,
        new Date("2099-07-24T14:00:00.000Z"),
        new Date("2099-07-24T15:00:00.000Z"),
        3,
      ]);

      const statsInsert = `
        INSERT INTO control_plane.mount_stats_eligibility_intervals (
          id, office_id, mount_id, started_at, ended_at, close_reason
        ) VALUES ($1, $2, $3, $4, $5, 'stats_opt_out')`;
      await assertConcurrentExclusionConflict(
        pool,
        {
          text: statsInsert,
          values: [
            randomUUID(),
            topology.office,
            topology.mount,
            new Date("2099-07-24T13:00:00.000Z"),
            new Date("2099-07-24T14:00:00.000Z"),
          ],
        },
        {
          text: statsInsert,
          values: [
            randomUUID(),
            topology.office,
            topology.mount,
            new Date("2099-07-24T13:30:00.000Z"),
            new Date("2099-07-24T14:30:00.000Z"),
          ],
        },
      );
      await pool.query(statsInsert, [
        randomUUID(),
        topology.office,
        topology.mount,
        new Date("2099-07-24T14:00:00.000Z"),
        new Date("2099-07-24T15:00:00.000Z"),
      ]);

      const occurrenceInsert = `
        INSERT INTO control_plane.office_schedule_occurrences (
          id, office_id, schedule_version_id, schedule_rule_id,
          office_local_date, starts_at, ends_at
        ) VALUES ($1, $2, $3, $4, DATE '2099-07-25', $5, $6)`;
      await assertConcurrentExclusionConflict(
        pool,
        {
          text: occurrenceInsert,
          values: [
            randomUUID(),
            topology.office,
            topology.scheduleVersion,
            topology.scheduleRules[0],
            new Date("2099-07-25T09:00:00.000Z"),
            new Date("2099-07-25T11:00:00.000Z"),
          ],
        },
        {
          text: occurrenceInsert,
          values: [
            randomUUID(),
            topology.office,
            topology.scheduleVersion,
            topology.scheduleRules[1],
            new Date("2099-07-25T10:00:00.000Z"),
            new Date("2099-07-25T12:00:00.000Z"),
          ],
        },
      );
      await pool.query(occurrenceInsert, [
        randomUUID(),
        topology.office,
        topology.scheduleVersion,
        topology.scheduleRules[1],
        new Date("2099-07-25T11:00:00.000Z"),
        new Date("2099-07-25T12:00:00.000Z"),
      ]);
    });

    test("retention atomically advances the minimum cursor and preserves a continuous replay tail", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT id
             FROM control_plane.offices
            WHERE id = $1
            FOR UPDATE`,
          [topology.office],
        );
        for (let index = 2; index <= 4; index += 1) {
          await projector.recordRevision(client, {
            officeId: topology.office,
            eventType: "presence_changed",
            sourceKind: "edge_receipt",
            sourceKey: `retention-test:${index}`,
            sourceReceiptId: null,
            at: new Date(PROJECTION_AT.getTime() + index * 60_000),
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      assert.equal(await retainOfficeRevisions(pool, 2), 1);
      const persisted = await pool.query<{
        revision: string;
        minimum_replay_revision: string;
        retained_revisions: string[];
      }>(
        `SELECT
           o.revision::text,
           o.minimum_replay_revision::text,
           ARRAY(
             SELECT event.revision::text
               FROM control_plane.office_revision_events event
              WHERE event.office_id = o.id
              ORDER BY event.revision
           ) AS retained_revisions
         FROM control_plane.offices o
         WHERE o.id = $1`,
        [topology.office],
      );
      assert.deepEqual(persisted.rows[0], {
        revision: "4",
        minimum_replay_revision: "2",
        retained_revisions: ["3", "4"],
      });

      const expired = await reader.getStreamPage(
        reader.capabilityFor(RAW_TOKEN)!,
        1,
      );
      assert.equal(expired.status, "revision_gap");
      const tail = await reader.getStreamPage(
        reader.capabilityFor(RAW_TOKEN)!,
        2,
      );
      assert.equal(tail.status, "ok");
      assert.deepEqual(
        tail.events?.map((event) => event.revision),
        [3, 4],
      );
    });
  });
}

interface PublicTopology {
  office: string;
  room: string;
  mount: string;
  instance: string;
  scheduleVersion: string;
  scheduleRules: string[];
}

async function seedPublicTopology(
  pool: DatabasePool,
  projector: PublicOfficeProjector,
): Promise<PublicTopology> {
  const ids = {
    account: randomUUID(),
    office: randomUUID(),
    room: randomUUID(),
    agent: randomUUID(),
    instance: randomUUID(),
    boot: randomUUID(),
    mount: randomUUID(),
    token: randomUUID(),
    schedule: randomUUID(),
    qualification: randomUUID(),
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO control_plane.accounts (id, created_at)
       VALUES ($1, TIMESTAMPTZ '2099-07-24 09:00:00Z')`,
      [ids.account],
    );
    await client.query(
      `INSERT INTO control_plane.offices (
         id, owner_account_id, name, timezone, discoverability, demo_data
       ) VALUES ($1, $2, 'Salted Fish Lab', 'UTC', 'listed_demo', true)`,
      [ids.office, ids.account],
    );
    await client.query(
      `INSERT INTO control_plane.memberships (
         id, office_id, account_id, created_at
       ) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), ids.office, ids.account, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.rooms (
         id, office_id, name, scene_capacity, created_at
       ) VALUES ($1, $2, 'Lobby', 24, $3)`,
      [ids.room, ids.office, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.logical_agents (
         id, owner_account_id, alias, pet_id, created_at
       ) VALUES ($1, $2, 'Sora', 'sora-shiba', $3)`,
      [ids.agent, ids.account, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.agent_instances (
         id, logical_agent_id, created_at
       ) VALUES ($1, $2, $3)`,
      [ids.instance, ids.agent, PROJECTION_AT],
    );
    await client.query(
      `UPDATE control_plane.logical_agents
          SET active_reporting_instance_id = $2
        WHERE id = $1`,
      [ids.agent, ids.instance],
    );
    await client.query(
      `INSERT INTO control_plane.agent_instance_boots (
         instance_id, generation, boot_id, previous_boot_id,
         next_sequence, first_accepted_at, last_accepted_at
       ) VALUES ($1, 1, $2, NULL, 2, $3, $3)`,
      [ids.instance, ids.boot, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.edge_instance_heads (
         instance_id, current_boot_id, current_boot_generation,
         last_server_received_at
       ) VALUES ($1, $2, 1, $3)`,
      [ids.instance, ids.boot, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.current_presence (
         instance_id, boot_generation, boot_id,
         last_accepted_sequence, last_state_sequence,
         display_state, activity_state, pet_id,
         display_since, activity_since, eligible_since,
         last_report_received_at, lease_expires_at, lease_closed_at
       ) VALUES (
         $1, 1, $2,
         1, 1,
         'done', 'eligible_idle', 'sora-shiba',
         $3::timestamptz,
         $3::timestamptz - interval '30 minutes',
         $3::timestamptz - interval '30 minutes',
         $3::timestamptz - interval '1 second',
         $3::timestamptz + interval '90 seconds',
         NULL
       )`,
      [ids.instance, ids.boot, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.derived_activity_intervals (
         id, instance_id, boot_generation, activity_state,
         started_at, start_sequence
       ) VALUES (
         $1, $2, 1, 'eligible_idle',
         $3::timestamptz - interval '30 minutes', 1
       )`,
      [randomUUID(), ids.instance, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.agent_office_mounts (
         id, office_id, logical_agent_id, room_id,
         active, scene_slot,
         presence_visible, stats_opt_in, poster_opt_in,
         activated_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         true, 0,
         true, true, true,
         $5::timestamptz - interval '2 hours',
         $5::timestamptz - interval '2 hours'
       )`,
      [ids.mount, ids.office, ids.agent, ids.room, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.mount_stats_eligibility_intervals (
         id, office_id, mount_id, started_at
       ) VALUES (
         $1, $2, $3, $4::timestamptz - interval '2 hours'
       )`,
      [ids.qualification, ids.office, ids.mount, PROJECTION_AT],
    );
    await client.query(
      `INSERT INTO control_plane.office_public_view_tokens (
         id, office_id, token_hash, created_at
       ) VALUES ($1, $2, $3, TIMESTAMPTZ '2020-01-01 00:00:00Z')`,
      [
        ids.token,
        ids.office,
        createHash("sha256").update(RAW_TOKEN).digest(),
      ],
    );
    await client.query(
      `INSERT INTO control_plane.office_schedule_versions (
         id, office_id, version, timezone, effective_from_local_date,
         created_at
       ) VALUES ($1, $2, 1, 'UTC', DATE '2020-01-01', $3)`,
      [ids.schedule, ids.office, PROJECTION_AT],
    );
    const scheduleRules: string[] = [];
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const scheduleRule = randomUUID();
      scheduleRules.push(scheduleRule);
      await client.query(
        `INSERT INTO control_plane.office_schedule_rules (
           id, office_id, schedule_version_id, iso_weekday,
           start_local_time, end_local_time, end_day_offset
         ) VALUES ($1, $2, $3, $4, TIME '00:00', TIME '00:00', 1)`,
        [scheduleRule, ids.office, ids.schedule, weekday],
      );
    }
    await projector.recordRevision(client, {
      officeId: ids.office,
      eventType: "projection_initialized",
      sourceKind: "projection_seed",
      sourceKey: `seed:${ids.office}`,
      sourceReceiptId: null,
      at: PROJECTION_AT,
    });
    await client.query("COMMIT");
    return {
      office: ids.office,
      room: ids.room,
      mount: ids.mount,
      instance: ids.instance,
      scheduleVersion: ids.schedule,
      scheduleRules,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface ConcurrentInsert {
  text: string;
  values: unknown[];
}

async function assertConcurrentExclusionConflict(
  pool: DatabasePool,
  firstInsert: ConcurrentInsert,
  secondInsert: ConcurrentInsert,
): Promise<void> {
  const first = await pool.connect();
  const second = await pool.connect();
  let firstTransactionOpen = false;
  let secondTransactionOpen = false;
  let secondSettled = false;
  let secondOutcome:
    | Promise<{ ok: true } | { ok: false; error: unknown }>
    | undefined;

  try {
    await first.query("BEGIN");
    firstTransactionOpen = true;
    await second.query("BEGIN");
    secondTransactionOpen = true;
    const backend = await second.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const secondPid = backend.rows[0]?.pid;
    assert.notEqual(secondPid, undefined);

    await first.query(firstInsert.text, firstInsert.values);
    secondOutcome = second
      .query(secondInsert.text, secondInsert.values)
      .then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
      .finally(() => {
        secondSettled = true;
      });

    await waitForBackendLock(pool, secondPid, () => secondSettled);
    await first.query("COMMIT");
    firstTransactionOpen = false;

    const outcome = await secondOutcome;
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      assert.fail("overlapping insert unexpectedly succeeded");
    }
    assert.equal(databaseErrorCode(outcome.error), "23P01");
    await second.query("ROLLBACK");
    secondTransactionOpen = false;
  } finally {
    if (firstTransactionOpen) {
      await first.query("ROLLBACK").catch(() => undefined);
    }
    if (secondOutcome !== undefined) {
      await secondOutcome.catch(() => undefined);
    }
    if (secondTransactionOpen) {
      await second.query("ROLLBACK").catch(() => undefined);
    }
    first.release();
    second.release();
  }
}

async function waitForBackendLock(
  pool: DatabasePool,
  pid: number | undefined,
  isSettled: () => boolean,
): Promise<void> {
  assert.notEqual(pid, undefined);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (isSettled()) {
      assert.fail(
        "conflicting insert settled instead of waiting for the concurrent transaction",
      );
    }
    const activity = await pool.query<{
      state: string;
      wait_event_type: string | null;
    }>(
      `SELECT state, wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    );
    const row = activity.rows[0];
    if (row?.state === "active" && row.wait_event_type === "Lock") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("conflicting insert did not reach a PostgreSQL lock wait");
}

function databaseErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
