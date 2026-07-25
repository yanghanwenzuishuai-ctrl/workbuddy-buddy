import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { DatabasePool } from "../../src/platform/db/pool.js";
import { createEdgeReportValidator } from "../../src/platform/contracts/edge-report-validator.js";

const config = loadConfig({ NODE_ENV: "test" });
const validator = await createEdgeReportValidator(config.contractsDir);
const unavailablePool = {} as DatabasePool;

test("liveness is independent of PostgreSQL readiness", async (t) => {
  const app = buildApp({ config, pool: unavailablePool, validator });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/livez" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("Edge writes fail closed when no verifier is configured", async (t) => {
  const app = buildApp({ config, pool: unavailablePool, validator });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/edge/events:batch",
    payload: {
      protocol_version: 1,
      instance_id: "11111111-1111-4111-8111-111111111111",
      key_id: "33333333-3333-4333-8333-333333333333",
      boot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      previous_boot_id: null,
      first_sequence: 1,
      events: [
        {
          sequence: 1,
          kind: "state_transition",
          observed_at: "2026-07-24T12:00:00Z",
          display_state: "idle",
          activity_state: "unknown",
          pet_id: "sora-shiba",
        },
      ],
      sent_at: "2026-07-24T12:00:01Z",
      client_version: "0.1.0",
      signature: `${"A".repeat(86)}==`,
    },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "temporarily_unavailable");
});

test("malformed JSON maps to the contract invalid_request problem", async (t) => {
  const app = buildApp({ config, pool: unavailablePool, validator });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/edge/events:batch",
    headers: { "content-type": "application/json" },
    payload: '{"protocol_version":1,',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["content-type"], "application/problem+json; charset=utf-8");
  assert.equal(response.json().code, "invalid_request");
});

test("unsupported request media types do not become internal errors", async (t) => {
  const app = buildApp({ config, pool: unavailablePool, validator });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/edge/events:batch",
    headers: { "content-type": "application/xml" },
    payload: "<report />",
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "invalid_request");
});
