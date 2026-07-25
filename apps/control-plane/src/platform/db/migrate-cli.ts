import { loadConfig } from "../../config.js";
import { migrate } from "./migrations.js";
import { createDatabasePool } from "./pool.js";

const config = loadConfig();
const pool = createDatabasePool(config);

try {
  await migrate(pool, config.migrationsDir);
  process.stdout.write("Control Plane migrations are current.\n");
} finally {
  await pool.end();
}
