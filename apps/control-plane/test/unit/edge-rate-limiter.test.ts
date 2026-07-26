import assert from "node:assert/strict";
import test from "node:test";

import { createEdgeIngressRateLimiter } from "../../src/modules/presence/application/edge-ingress-rate-limiter.js";
import { createEdgeReportRateLimiter } from "../../src/modules/presence/application/edge-report-rate-limit.js";
import { ProtocolProblem } from "../../src/modules/presence/domain/problem.js";
import type { DatabasePool } from "../../src/platform/db/pool.js";

test("Edge ingress limiter bounds unauthenticated work per source IP", () => {
  const limiter = createEdgeIngressRateLimiter();
  for (let index = 0; index < 900; index += 1) {
    assert.equal(limiter.take("203.0.113.7", 1_000).allowed, true);
  }
  const blocked = limiter.take("203.0.113.7", 1_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal(limiter.take("203.0.113.8", 1_000).allowed, true);
  assert.equal(limiter.take("203.0.113.7", 61_000).allowed, true);
});

test("authenticated Edge limiter returns a bounded retry problem", async () => {
  const pool = {
    query: async () => ({
      rows: [
        {
          report_count: 361,
          event_count: 361,
          retry_after_seconds: 47,
        },
      ],
    }),
  } as unknown as DatabasePool;
  const limiter = createEdgeReportRateLimiter(pool);
  await assert.rejects(
    limiter.consume("11111111-1111-4111-8111-111111111111", 1),
    (error: unknown) =>
      error instanceof ProtocolProblem &&
      error.code === "rate_limited" &&
      error.status === 429 &&
      error.retryAfterSeconds === 47 &&
      error.toBody().retry_after_seconds === 47,
  );
});
