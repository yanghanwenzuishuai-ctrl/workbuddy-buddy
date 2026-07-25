import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ControlPlaneConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  databaseSslCa: string | undefined;
  migrateOnStart: boolean;
  allowUnverifiedFakeEdge: boolean;
  presenceLeaseTtlSeconds: number;
  leaseSweepIntervalSeconds: number;
  maxRequestBytes: number;
  migrationsDir: string;
  contractsDir: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);
  const allowUnverifiedFakeEdge = parseBoolean(
    environment.ALLOW_UNVERIFIED_FAKE_EDGE,
    false,
  );

  if (nodeEnv === "production" && allowUnverifiedFakeEdge) {
    throw new Error(
      "ALLOW_UNVERIFIED_FAKE_EDGE cannot be enabled when NODE_ENV=production",
    );
  }

  return {
    nodeEnv,
    host: environment.HOST ?? "127.0.0.1",
    port: parseInteger("PORT", environment.PORT, 3000, 1, 65_535),
    databaseUrl:
      environment.DATABASE_URL ??
      "postgres://workbuddy:workbuddy@127.0.0.1:5432/workbuddy",
    databaseSsl: parseBoolean(environment.DATABASE_SSL, false),
    databaseSslCa: environment.DATABASE_SSL_CA || undefined,
    migrateOnStart: parseBoolean(
      environment.MIGRATE_ON_START,
      nodeEnv !== "production",
    ),
    allowUnverifiedFakeEdge,
    presenceLeaseTtlSeconds: parseInteger(
      "PRESENCE_LEASE_TTL_SECONDS",
      environment.PRESENCE_LEASE_TTL_SECONDS,
      90,
      15,
      3_600,
    ),
    leaseSweepIntervalSeconds: parseInteger(
      "LEASE_SWEEP_INTERVAL_SECONDS",
      environment.LEASE_SWEEP_INTERVAL_SECONDS,
      5,
      1,
      300,
    ),
    maxRequestBytes: parseInteger(
      "MAX_REQUEST_BYTES",
      environment.MAX_REQUEST_BYTES,
      131_072,
      16_384,
      1_048_576,
    ),
    migrationsDir:
      environment.MIGRATIONS_DIR ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations"),
    contractsDir:
      environment.CONTRACTS_DIR ??
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../contracts",
      ),
  };
}

function parseNodeEnvironment(
  value: string | undefined,
): ControlPlaneConfig["nodeEnv"] {
  const resolved = value ?? "development";
  if (
    resolved !== "development" &&
    resolved !== "test" &&
    resolved !== "production"
  ) {
    throw new Error(`NODE_ENV must be development, test, or production`);
  }
  return resolved;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean environment value, received ${value}`);
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
