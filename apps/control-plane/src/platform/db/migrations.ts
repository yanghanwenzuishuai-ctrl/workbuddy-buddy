import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { DatabaseClient, DatabasePool } from "./pool.js";

const MIGRATION_LOCK_ID = "749773185136469";
const MIGRATION_PATTERN = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  ready: boolean;
  expected: string | null;
  applied: string | null;
}

export async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(directory, name), "utf8");
      return {
        name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
}

export async function migrate(
  pool: DatabasePool,
  directory: string,
): Promise<void> {
  const migrations = await readMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_ID,
    ]);
    await ensureMigrationTable(client);

    const applied = await client.query<{
      name: string;
      checksum: string;
    }>(
      `SELECT name, checksum
         FROM control_plane.schema_migrations
        ORDER BY name`,
    );
    const appliedByName = new Map(
      applied.rows.map((row) => [row.name, row.checksum]),
    );

    for (const migration of migrations) {
      const existingChecksum = appliedByName.get(migration.name);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Applied migration ${migration.name} has checksum drift`,
          );
        }
        continue;
      }
      await applyMigration(client, migration);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID])
      .catch(() => undefined);
    client.release();
  }
}

export async function migrationStatus(
  pool: DatabasePool,
  directory: string,
): Promise<MigrationStatus> {
  const migrations = await readMigrations(directory);
  const expected = migrations.at(-1)?.name ?? null;
  try {
    const result = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum
         FROM control_plane.schema_migrations
        ORDER BY name`,
    );
    const applied = result.rows.at(-1)?.name ?? null;
    const ready =
      result.rows.length === migrations.length &&
      migrations.every((migration, index) => {
        const row = result.rows[index];
        return (
          row?.name === migration.name && row.checksum === migration.checksum
        );
      });
    return { ready, expected, applied };
  } catch {
    return { ready: false, expected, applied: null };
  }
}

async function ensureMigrationTable(client: DatabaseClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS control_plane");
  await client.query(`
    CREATE TABLE IF NOT EXISTS control_plane.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL CHECK (length(checksum) = 64),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

async function applyMigration(
  client: DatabaseClient,
  migration: Migration,
): Promise<void> {
  await client.query("BEGIN");
  try {
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
  }
}
