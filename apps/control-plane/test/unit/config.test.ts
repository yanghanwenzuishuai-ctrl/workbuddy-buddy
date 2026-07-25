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
