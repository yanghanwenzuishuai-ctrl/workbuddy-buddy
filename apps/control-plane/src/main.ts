import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  DevelopmentBypassEdgeVerifier,
  DisabledEdgeVerifier,
} from "./modules/presence/application/edge-verifier.js";
import { expireDueLeases } from "./modules/presence/application/expire-leases.js";
import { createEdgeReportValidator } from "./platform/contracts/edge-report-validator.js";
import { migrate } from "./platform/db/migrations.js";
import { createDatabasePool } from "./platform/db/pool.js";

const config = loadConfig();
const pool = createDatabasePool(config);

try {
  if (config.migrateOnStart) {
    await migrate(pool, config.migrationsDir);
  }
  const validator = await createEdgeReportValidator(config.contractsDir);
  const verifier = config.allowUnverifiedFakeEdge
    ? new DevelopmentBypassEdgeVerifier()
    : new DisabledEdgeVerifier();
  const app = buildApp({
    config,
    pool,
    validator,
    verifier,
    logger: true,
  });
  let sweepRunning = false;
  const leaseSweepTimer = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void expireDueLeases(pool)
      .catch((error: unknown) => {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? error.code
            : "unknown";
        app.log.error({ code }, "lease sweep failed");
      })
      .finally(() => {
        sweepRunning = false;
      });
  }, config.leaseSweepIntervalSeconds * 1_000);
  leaseSweepTimer.unref();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    clearInterval(leaseSweepTimer);
    app.log.info({ signal }, "shutting down control plane");
    await app.close();
    await pool.end();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  process.stderr.write(
    `Control Plane failed to start: ${
      error instanceof Error ? error.message : "unknown error"
    }\n`,
  );
  await pool.end();
  process.exitCode = 1;
}
