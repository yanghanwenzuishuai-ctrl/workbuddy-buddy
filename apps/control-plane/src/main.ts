import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createOfficeRevisionBroker } from "./modules/public-office/application/office-revision-broker.js";
import { createPublicOfficeProjector } from "./modules/public-office/application/public-office-projector.js";
import { retainOfficeRevisions } from "./modules/public-office/application/retain-office-revisions.js";
import { tickPublicOffices } from "./modules/public-office/application/tick-public-offices.js";
import {
  createEd25519EdgeVerifier,
  DevelopmentBypassEdgeVerifier,
} from "./modules/presence/application/edge-verifier.js";
import { expireDueLeases } from "./modules/presence/application/expire-leases.js";
import { createEdgeReportValidator } from "./platform/contracts/edge-report-validator.js";
import { createPublicOfficeSnapshotValidator } from "./platform/contracts/public-office-snapshot-validator.js";
import { migrate } from "./platform/db/migrations.js";
import { createDatabasePool } from "./platform/db/pool.js";

const config = loadConfig();
const pool = createDatabasePool(config);
const officeRevisionBroker = createOfficeRevisionBroker(pool, (code) => {
  process.stderr.write(`Office revision listener error (${code}).\n`);
});

try {
  if (config.migrateOnStart) {
    await migrate(pool, config.migrationsDir);
  }
  const validator = await createEdgeReportValidator(config.contractsDir);
  const publicSnapshotValidator =
    await createPublicOfficeSnapshotValidator(config.contractsDir);
  const publicOfficeProjector = createPublicOfficeProjector(
    publicSnapshotValidator,
  );
  await officeRevisionBroker.start();
  const verifier = config.allowUnverifiedFakeEdge
    ? new DevelopmentBypassEdgeVerifier()
    : createEd25519EdgeVerifier(pool);
  const app = buildApp({
    config,
    pool,
    validator,
    verifier,
    publicOfficeProjector,
    officeRevisionBroker,
    logger: true,
  });
  let sweepRunning = false;
  const leaseSweepTimer = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    void expireDueLeases(pool, 100, publicOfficeProjector)
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
  let projectionTickRunning = false;
  const projectionTickTimer = setInterval(() => {
    if (projectionTickRunning) return;
    projectionTickRunning = true;
    void tickPublicOffices(
      pool,
      publicOfficeProjector,
      new Date(),
      config.publicProjectionTickSeconds,
      100,
      ({ officeId, error }) => {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? error.code
            : "unknown";
        app.log.error(
          { code, officeId },
          "public Office projection tick failed for one Office",
        );
      },
    )
      .catch((error: unknown) => {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? error.code
            : "unknown";
        app.log.error({ code }, "public Office projection tick failed");
      })
      .finally(() => {
        projectionTickRunning = false;
      });
  }, config.publicProjectionTickSeconds * 1_000);
  projectionTickTimer.unref();
  let retentionRunning = false;
  const publicRetentionTimer = setInterval(() => {
    if (retentionRunning) return;
    retentionRunning = true;
    void retainOfficeRevisions(pool, config.publicReplayMaxRevisions)
      .catch((error: unknown) => {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? error.code
            : "unknown";
        app.log.error({ code }, "public replay retention failed");
      })
      .finally(() => {
        retentionRunning = false;
      });
  }, config.publicRetentionIntervalSeconds * 1_000);
  publicRetentionTimer.unref();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    clearInterval(leaseSweepTimer);
    clearInterval(projectionTickTimer);
    clearInterval(publicRetentionTimer);
    app.log.info({ signal }, "shutting down control plane");
    await app.close();
    await officeRevisionBroker.close();
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
  await officeRevisionBroker.close();
  await pool.end();
  process.exitCode = 1;
}
