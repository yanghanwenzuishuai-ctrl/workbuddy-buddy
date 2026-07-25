import pg from "pg";

import type { ControlPlaneConfig } from "../../config.js";

const { Pool } = pg;

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createDatabasePool(config: ControlPlaneConfig): DatabasePool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "workbuddy-buddy-control-plane",
    ssl: config.databaseSsl
      ? {
          rejectUnauthorized: true,
          ...(config.databaseSslCa === undefined
            ? {}
            : { ca: config.databaseSslCa }),
        }
      : undefined,
  });
  pool.on("error", (error) => {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    process.stderr.write(`PostgreSQL idle client error (${code}).\n`);
  });
  return pool;
}
