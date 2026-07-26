import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import {
  createPublicOfficeProjector,
  type PublicOfficeProjector,
} from "../../src/modules/public-office/application/public-office-projector.js";
import { createPublicOfficeSnapshotValidator } from "../../src/platform/contracts/public-office-snapshot-validator.js";
import { createEdgeReportValidator } from "../../src/platform/contracts/edge-report-validator.js";
import { migrate } from "../../src/platform/db/migrations.js";
import {
  createDatabasePool,
  type DatabasePool,
} from "../../src/platform/db/pool.js";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;

if (testDatabaseUrl === undefined) {
  test(
    "PostgreSQL onboarding integration tests",
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

  describe("PostgreSQL Office onboarding and Edge pairing", () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      DATABASE_SSL: "false",
    });
    let pool: DatabasePool;
    let projector: PublicOfficeProjector;
    let app: ReturnType<typeof buildApp>;

    before(async () => {
      pool = createDatabasePool(config);
      await pool.query("DROP EXTENSION IF EXISTS btree_gist CASCADE");
      await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await migrate(pool, config.migrationsDir);
      await migrate(pool, config.migrationsDir);
      const snapshotValidator =
        await createPublicOfficeSnapshotValidator(config.contractsDir);
      projector = createPublicOfficeProjector(snapshotValidator);
      app = buildApp({
        config,
        pool,
        validator: await createEdgeReportValidator(config.contractsDir),
        publicOfficeProjector: projector,
      });
    });

    after(async () => {
      await app.close();
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE control_plane.accounts CASCADE");
      await pool.query("TRUNCATE control_plane.onboarding_ip_rate_limits");
    });

    test("one transaction creates a private Office topology and hash-only pairing", async () => {
      const created = await createOffice(app);
      assert.equal(created.response.statusCode, 201);
      assert.equal(created.response.headers["cache-control"], "private, no-store");
      assert.match(created.body.pairing_code, /^[A-Za-z0-9_-]{43}$/);
      assert.match(created.body.status_token, /^[A-Za-z0-9_-]{43}$/);
      assert.match(created.body.office_url, /^\/o\/[A-Za-z0-9_-]{43}$/);
      assert.ok(
        new Date(created.body.expires_at).getTime() > Date.now() + 4 * 60_000,
      );

      const topology = await pool.query<{
        discoverability: string;
        demo_data: boolean;
        room_count: string;
        member_count: string;
        mount_count: string;
        schedule_rule_count: string;
        qualification_count: string;
        revision: string;
      }>(
        `SELECT
           office.discoverability,
           office.demo_data,
           (SELECT count(*) FROM control_plane.rooms room
             WHERE room.office_id = office.id)::text AS room_count,
           (SELECT count(*) FROM control_plane.memberships membership
             WHERE membership.office_id = office.id)::text AS member_count,
           (SELECT count(*) FROM control_plane.agent_office_mounts mount
             WHERE mount.office_id = office.id)::text AS mount_count,
           (SELECT count(*) FROM control_plane.office_schedule_rules rule
             WHERE rule.office_id = office.id)::text AS schedule_rule_count,
           (SELECT count(*)
              FROM control_plane.mount_stats_eligibility_intervals interval
              WHERE interval.office_id = office.id)::text AS qualification_count,
           office.revision::text
         FROM control_plane.offices office`,
      );
      assert.deepEqual(topology.rows, [
        {
          discoverability: "unlisted",
          demo_data: false,
          room_count: "1",
          member_count: "1",
          mount_count: "1",
          schedule_rule_count: "5",
          qualification_count: "1",
          revision: "1",
        },
      ]);

      const stored = await pool.query<{
        pairing_code_hash: Buffer;
        status_secret_hash: Buffer;
      }>(
        `SELECT pairing_code_hash, status_secret_hash
           FROM control_plane.onboarding_pairings`,
      );
      assert.deepEqual(
        stored.rows[0]?.pairing_code_hash,
        createHash("sha256").update(created.body.pairing_code).digest(),
      );
      assert.deepEqual(
        stored.rows[0]?.status_secret_hash,
        createHash("sha256").update(created.body.status_token).digest(),
      );

      const publicToken = created.body.office_url.slice("/o/".length);
      assert.notEqual(publicToken, created.body.pairing_code);
      assert.notEqual(publicToken, created.body.status_token);
      const snapshot = await app.inject({
        method: "GET",
        url: `/api/v1/offices/${publicToken}/snapshot`,
      });
      assert.equal(snapshot.statusCode, 200);
      assert.equal(snapshot.json().agents[0]?.presence, "offline");

      const publicIsNotStatusAuth = await app.inject({
        method: "GET",
        url: `/api/v1/onboarding/pairings/${publicToken}`,
        remoteAddress: "198.51.100.10",
      });
      assert.equal(publicIsNotStatusAuth.statusCode, 404);
    });

    test("claim is atomic and exactly idempotent for the same public key", async () => {
      const created = await createOffice(app);
      const publicKey = Buffer.alloc(32, 7).toString("base64");
      const claimBody = {
        pairing_code: created.body.pairing_code,
        public_key: publicKey,
        client_version: "0.1.0",
      };
      const [first, concurrentReplay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/edge/enrollment/claim",
          payload: claimBody,
          remoteAddress: "198.51.100.20",
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/edge/enrollment/claim",
          payload: claimBody,
          remoteAddress: "198.51.100.21",
        }),
      ]);
      assert.equal(first.statusCode, 200);
      assert.equal(concurrentReplay.statusCode, 200);
      assert.deepEqual(first.json(), concurrentReplay.json());
      assert.match(first.json().server_id, /^[0-9a-f-]{36}$/);
      assert.equal(first.json().heartbeat_interval_seconds, 30);

      const persisted = await pool.query<{
        instance_count: string;
        credential_count: string;
        head_count: string;
        active_reporting_instance_id: string;
      }>(
        `SELECT
           (SELECT count(*) FROM control_plane.agent_instances)::text
             AS instance_count,
           (SELECT count(*) FROM control_plane.device_credentials)::text
             AS credential_count,
           (SELECT count(*) FROM control_plane.edge_instance_heads)::text
             AS head_count,
           agent.active_reporting_instance_id
         FROM control_plane.logical_agents agent`,
      );
      assert.deepEqual(persisted.rows, [
        {
          instance_count: "1",
          credential_count: "1",
          head_count: "1",
          active_reporting_instance_id: first.json().instance_id,
        },
      ]);

      const changedClientVersionReplay = await app.inject({
        method: "POST",
        url: "/api/v1/edge/enrollment/claim",
        payload: { ...claimBody, client_version: "0.1.1" },
        remoteAddress: "198.51.100.22",
      });
      assert.equal(changedClientVersionReplay.statusCode, 200);
      assert.deepEqual(changedClientVersionReplay.json(), first.json());

      const otherKey = await app.inject({
        method: "POST",
        url: "/api/v1/edge/enrollment/claim",
        payload: {
          ...claimBody,
          public_key: Buffer.alloc(32, 8).toString("base64"),
        },
        remoteAddress: "198.51.100.23",
      });
      assert.equal(otherKey.statusCode, 409);
      assert.equal(otherKey.json().code, "pairing_conflict");

      const status = await app.inject({
        method: "GET",
        url: `/api/v1/onboarding/pairings/${created.body.status_token}`,
        remoteAddress: "198.51.100.24",
      });
      assert.equal(status.statusCode, 200);
      assert.deepEqual(status.json(), { status: "claimed" });
    });

    test("expired pairings cannot enroll and remain observable as expired", async () => {
      const created = await createOffice(app);
      await pool.query(
        `UPDATE control_plane.onboarding_pairings
            SET expires_at = created_at + interval '1 microsecond'`,
      );
      const status = await app.inject({
        method: "GET",
        url: `/api/v1/onboarding/pairings/${created.body.status_token}`,
        remoteAddress: "198.51.100.30",
      });
      assert.deepEqual(status.json(), { status: "expired" });

      const claim = await app.inject({
        method: "POST",
        url: "/api/v1/edge/enrollment/claim",
        payload: {
          pairing_code: created.body.pairing_code,
          public_key: Buffer.alloc(32, 4).toString("base64"),
          client_version: "0.1.0",
        },
        remoteAddress: "198.51.100.31",
      });
      assert.equal(claim.statusCode, 410);
      assert.equal(claim.json().code, "pairing_expired");
      assert.equal(
        (await pool.query("SELECT 1 FROM control_plane.agent_instances"))
          .rowCount,
        0,
      );
    });

    test("database constraints reject active Mounts without membership", async () => {
      const created = await createOffice(app);
      assert.equal(created.response.statusCode, 201);
      const membership = await pool.query<{ id: string }>(
        "SELECT id FROM control_plane.memberships",
      );
      await assert.rejects(async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM control_plane.memberships WHERE id = $1",
            [membership.rows[0]?.id],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      });
      assert.equal(
        (await pool.query("SELECT 1 FROM control_plane.memberships")).rowCount,
        1,
      );
    });

    test("Office creation is bounded per source IP", async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const created = await createOffice(app, "203.0.113.80");
        assert.equal(created.response.statusCode, 201);
      }
      const limited = await createOffice(app, "203.0.113.80");
      assert.equal(limited.response.statusCode, 429);
      assert.equal(limited.response.json().code, "rate_limited");
      assert.ok(Number(limited.response.headers["retry-after"]) >= 1);
    });
  });
}

interface CreatedOfficeBody {
  pairing_code: string;
  status_token: string;
  expires_at: string;
  office_url: string;
}

async function createOffice(
  app: ReturnType<typeof buildApp>,
  remoteAddress = "198.51.100.1",
): Promise<{
  response: Awaited<ReturnType<typeof app.inject>>;
  body: CreatedOfficeBody;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/onboarding/offices",
    remoteAddress,
    payload: {
      office_name: "摸鱼研究所",
      alias: "Sora",
      pet_id: "sora-shiba",
      presence_visible: true,
      stats_opt_in: true,
      poster_opt_in: false,
    },
  });
  return { response, body: response.json() as CreatedOfficeBody };
}
