import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config.js";

test("production refuses the fake Edge verifier bypass", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ALLOW_UNVERIFIED_FAKE_EDGE: "true",
      }),
    /cannot be enabled/,
  );
});

test("lease TTL and body limit are bounded configuration", () => {
  assert.throws(
    () =>
      loadConfig({
        PRESENCE_LEASE_TTL_SECONDS: "5",
      }),
    /between 15 and 3600/,
  );
  assert.throws(
    () =>
      loadConfig({
        MAX_REQUEST_BYTES: "not-a-number",
      }),
    /must be an integer/,
  );
});

test("production defaults to explicit migrations", () => {
  assert.equal(loadConfig({ NODE_ENV: "production" }).migrateOnStart, false);
  assert.equal(
    loadConfig({ NODE_ENV: "production", MIGRATE_ON_START: "true" })
      .migrateOnStart,
    true,
  );
});

test("public projection cadence and replay retention are bounded", () => {
  const config = loadConfig({});
  assert.equal(config.publicProjectionTickSeconds, 30);
  assert.equal(config.publicReplayMaxRevisions, 256);
  assert.throws(
    () =>
      loadConfig({
        PUBLIC_PROJECTION_TICK_SECONDS: "1",
      }),
    /between 5 and 300/,
  );
  assert.throws(
    () =>
      loadConfig({
        PUBLIC_REPLAY_MAX_REVISIONS: "100001",
      }),
    /between 1 and 100000/,
  );
});

test("proxy trust is disabled by default and accepts only a small hop count", () => {
  assert.equal(loadConfig({}).trustProxyHops, 0);
  assert.equal(loadConfig({ TRUST_PROXY_HOPS: "1" }).trustProxyHops, 1);
  assert.throws(
    () => loadConfig({ TRUST_PROXY_HOPS: "5" }),
    /between 0 and 4/,
  );
});
