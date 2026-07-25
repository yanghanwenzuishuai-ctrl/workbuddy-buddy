import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";

import Fastify from "fastify";

import type { OfficeRevisionBroker } from "../../src/modules/public-office/application/office-revision-broker.js";
import { createPublicOfficeProjector } from "../../src/modules/public-office/application/public-office-projector.js";
import {
  parsePublicRevisionCursor,
  type PublicOfficeReader,
} from "../../src/modules/public-office/application/public-office-reader.js";
import { createPublicRateLimiter } from "../../src/modules/public-office/application/public-rate-limiter.js";
import { registerPublicOfficeRoutes } from "../../src/modules/public-office/application/public-office-routes.js";
import { tickPublicOffices } from "../../src/modules/public-office/application/tick-public-offices.js";

test("public revision cursors accept only canonical safe decimal integers", () => {
  assert.equal(parsePublicRevisionCursor(undefined), undefined);
  assert.equal(parsePublicRevisionCursor("0"), 0);
  assert.equal(
    parsePublicRevisionCursor("9007199254740991"),
    9_007_199_254_740_991,
  );
  for (const invalid of [
    "",
    "00",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e3",
    "9007199254740992",
    ["1"],
  ]) {
    assert.throws(() => parsePublicRevisionCursor(invalid));
  }
});

test("public rate limits include invalid-token keys and bound active streams", () => {
  const limiter = createPublicRateLimiter();
  const releases: Array<() => void> = [];
  for (let index = 0; index < 5; index += 1) {
    const decision = limiter.takeStream(
      "127.0.0.1",
      "not-a-valid-token",
      1_000,
    );
    assert.equal(decision.allowed, true);
    releases.push(decision.release);
  }
  assert.equal(
    limiter.takeStream("127.0.0.1", "not-a-valid-token", 1_000).allowed,
    false,
  );
  releases[0]?.();
  assert.equal(
    limiter.takeStream("127.0.0.1", "not-a-valid-token", 1_000).allowed,
    true,
  );
});

test("public stream limits cannot be bypassed by rotating tokens from one IP", () => {
  const limiter = createPublicRateLimiter();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      limiter.takeStream("198.51.100.7", `rotated-token-${index}`, 1_000)
        .allowed,
      true,
    );
  }
  assert.equal(
    limiter.takeStream("198.51.100.7", "rotated-token-6", 1_000).allowed,
    false,
  );
});

test("one shared Office token supports at least 500 distinct guest IPs", () => {
  const limiter = createPublicRateLimiter();
  const decisions = Array.from({ length: 500 }, (_, index) =>
    limiter.takeStream(
      `198.51.${Math.floor(index / 250)}.${(index % 250) + 1}`,
      "one-shared-office-token",
      1_000,
    ),
  );
  assert.equal(decisions.every((decision) => decision.allowed), true);
  for (const decision of decisions) decision.release();
});

test("SSE releases its locked page before drain and rechecks capability afterward", async (context) => {
  const app = Fastify({ logger: false });
  const payloads = [1, 2].map((revision) =>
    Buffer.from(JSON.stringify({ office_revision: revision }), "utf8"),
  );
  const cursors: number[] = [];
  let releases = 0;
  let streamResponse: ServerResponse | undefined;
  let closeListenersAtBackpressureWrite = 0;
  let signalFirstRelease = (): void => undefined;
  const firstRelease = new Promise<void>((resolve) => {
    signalFirstRelease = resolve;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.includes("/events")) return;
    streamResponse = reply.raw;
    const originalWrite = reply.raw.write.bind(reply.raw);
    reply.raw.write = ((chunk: unknown, ...args: unknown[]) => {
      const frame = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      if (frame.includes("event: office.snapshot")) {
        closeListenersAtBackpressureWrite = reply.raw.listenerCount("close");
        return false;
      }
      return Reflect.apply(originalWrite, reply.raw, [
        chunk,
        ...args,
      ]) as boolean;
    }) as typeof reply.raw.write;
  });

  const page = {
    status: "ok" as const,
    officeId: "office-1",
    currentRevision: 2,
    minimumReplayRevision: 0,
    events: payloads.map((canonicalPayload, index) => ({
      revision: index + 1,
      canonicalPayload,
    })),
  };
  const reader: PublicOfficeReader = {
    capabilityFor() {
      return { rawDigest: Buffer.alloc(32), formatValid: true };
    },
    async getSnapshot() {
      return null;
    },
    async getStreamPage() {
      return page;
    },
    async acquireLockedStreamPage(_capability, cursor) {
      cursors.push(cursor);
      if (cursors.length === 1) {
        return {
          page,
          release: async () => {
            releases += 1;
            signalFirstRelease();
          },
        };
      }
      return {
        page: { status: "not_found" },
        release: async () => {
          releases += 1;
        },
      };
    },
  };
  const broker: OfficeRevisionBroker = {
    async start() {},
    subscribe() {
      return () => undefined;
    },
    async close() {},
  };
  registerPublicOfficeRoutes(app, {
    reader,
    broker,
    rateLimiter: createPublicRateLimiter(),
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  context.after(async () => {
    streamResponse?.destroy();
    await app.close();
  });

  const response = await fetch(
    `${baseUrl}/api/v1/offices/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/events?after_revision=0`,
  );
  assert.equal(response.status, 200);
  await firstRelease;
  assert.deepEqual(cursors, [0]);
  assert.equal(releases, 1);
  assert.equal(
    streamResponse!.listenerCount("close"),
    closeListenersAtBackpressureWrite + 1,
  );

  streamResponse!.emit("drain");
  await response.text();
  assert.deepEqual(cursors, [0, 1]);
  assert.equal(releases, 2);
});

test("ordinary projection entrypoint rejects consent changes at runtime", () => {
  const projector = createPublicOfficeProjector();
  assert.throws(
    () =>
      projector.recordRevision({} as never, {
        officeId: "00000000-0000-4000-8000-000000000001",
        eventType: "consent_changed",
        sourceKind: "consent_change",
        sourceKey: "must-not-bypass-privacy-path",
        sourceReceiptId: null,
        at: new Date("2099-01-01T00:00:00.000Z"),
      } as never),
    /explicit consent projection path/,
  );
});

test("production tick callback isolates one broken Office from later candidates", async () => {
  const officeIds = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  let connectionIndex = 0;
  const clients = officeIds.map((officeId) => ({
    async query(statement: string) {
      if (statement.includes("FOR UPDATE OF office")) {
        return {
          rowCount: 1,
          rows: [{ generated_at: null, token_active: true }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
    officeId,
  }));
  const pool = {
    async query() {
      return { rowCount: 2, rows: officeIds.map((id) => ({ id })) };
    },
    async connect() {
      const client = clients[connectionIndex];
      connectionIndex += 1;
      if (client === undefined) throw new Error("Unexpected connection");
      return client;
    },
  };
  const failures: string[] = [];
  const advanced = await tickPublicOffices(
    pool as never,
    {
      async recordRevision(client) {
        const officeId = (client as unknown as { officeId: string }).officeId;
        if (officeId === officeIds[0]) throw new Error("bad Office");
        return {} as never;
      },
      async recordConsentExpansionRevision() {
        return {} as never;
      },
      async recordPrivacyLoweringRevision() {
        return {} as never;
      },
    },
    new Date("2099-01-01T00:00:00.000Z"),
    30,
    100,
    ({ officeId }) => failures.push(officeId),
  );

  assert.equal(advanced, 1);
  assert.deepEqual(failures, [officeIds[0]]);
  assert.equal(connectionIndex, 2);
});
