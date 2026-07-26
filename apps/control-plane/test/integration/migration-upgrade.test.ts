import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { loadConfig } from "../../src/config.js";
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
    "PostgreSQL M2A upgrade migration test",
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

  describe("PostgreSQL M1 to M2A migration", () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      DATABASE_SSL: "false",
    });
    let pool: DatabasePool;

    before(async () => {
      pool = createDatabasePool(config);
    });

    after(async () => {
      await pool.end();
    });

    test("0003 backfills Mount ownership and missing membership without rewriting M1", async () => {
      await pool.query("DROP EXTENSION IF EXISTS btree_gist CASCADE");
      await pool.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      const migrations = await readMigrations(config.migrationsDir);
      const m1Migrations = migrations.slice(0, 2);
      assert.deepEqual(
        m1Migrations.map((migration) => migration.name),
        ["0001_control_plane.sql", "0002_public_office.sql"],
      );
      await pool.query("CREATE SCHEMA control_plane");
      await pool.query(`
        CREATE TABLE control_plane.schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL CHECK (length(checksum) = 64),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      for (const migration of m1Migrations) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO control_plane.schema_migrations (name, checksum)
             VALUES ($1, $2)`,
            [migration.name, migration.checksum],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }

      const ownerAccount = randomUUID();
      const agentAccount = randomUUID();
      const office = randomUUID();
      const room = randomUUID();
      const agent = randomUUID();
      const mount = randomUUID();
      await pool.query(
        `INSERT INTO control_plane.accounts (id)
         VALUES ($1), ($2)`,
        [ownerAccount, agentAccount],
      );
      await pool.query(
        `INSERT INTO control_plane.offices (id, owner_account_id, name)
         VALUES ($1, $2, 'Existing M1 Office')`,
        [office, ownerAccount],
      );
      await pool.query(
        `INSERT INTO control_plane.rooms (id, office_id, name)
         VALUES ($1, $2, 'Lobby')`,
        [room, office],
      );
      await pool.query(
        `INSERT INTO control_plane.logical_agents (
           id, owner_account_id, alias, pet_id
         ) VALUES ($1, $2, 'Existing Agent', 'bloop')`,
        [agent, agentAccount],
      );
      await pool.query(
        `INSERT INTO control_plane.agent_office_mounts (
           id, office_id, logical_agent_id, room_id,
           presence_visible, stats_opt_in
         ) VALUES ($1, $2, $3, $4, true, true)`,
        [mount, office, agent, room],
      );

      await migrate(pool, config.migrationsDir);
      await migrate(pool, config.migrationsDir);
      assert.equal(
        (await migrationStatus(pool, config.migrationsDir)).ready,
        true,
      );
      const upgraded = await pool.query<{
        owner_account_id: string;
        membership_count: string;
        server_count: string;
      }>(
        `SELECT
           mount.owner_account_id,
           (
             SELECT count(*)::text
               FROM control_plane.memberships membership
              WHERE membership.office_id = mount.office_id
                AND membership.account_id = mount.owner_account_id
           ) AS membership_count,
           (
             SELECT count(*)::text
               FROM control_plane.server_identity
           ) AS server_count
         FROM control_plane.agent_office_mounts mount
         WHERE mount.id = $1`,
        [mount],
      );
      assert.deepEqual(upgraded.rows, [
        {
          owner_account_id: agentAccount,
          membership_count: "1",
          server_count: "1",
        },
      ]);
    });
  });
}
