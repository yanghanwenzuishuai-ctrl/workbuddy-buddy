import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import { ProtocolAcceptanceModel } from "./protocol-model.mjs";
import { INSTANCE, envelope, state } from "./protocol-samples.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const BOOT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("observed_at skew never changes the authoritative activity boundary", async () => {
  const policy = await readJson(POLICY_FILE);
  const ancient = new ProtocolAcceptanceModel(policy);
  const future = new ProtocolAcceptanceModel(policy);
  const receivedAt = 1_753_358_400_000;

  const ancientAck = ancient.accept(
    envelope(BOOT_A, [state(1, "done", "eligible_idle", "1970-01-01T00:00:00Z")]),
    receivedAt,
  );
  const futureAck = future.accept(
    envelope(BOOT_A, [state(1, "done", "eligible_idle", "2099-12-31T23:59:59Z")]),
    receivedAt,
  );

  assert.equal(ancientAck.server_received_at, receivedAt);
  assert.equal(futureAck.server_received_at, receivedAt);
  assert.equal(ancient.inspect(ancientAck.instance_id).eligibleSince, receivedAt);
  assert.equal(future.inspect(futureAck.instance_id).eligibleSince, receivedAt);
});

test("a replay cannot renew a lease or move received_at forward", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  const report = envelope(BOOT_A, [state(1)]);
  const first = model.accept(report, 10_000);
  const replay = model.accept(report, 1_000_000);

  assert.deepEqual(replay, first);
  assert.equal(model.inspect(first.instance_id).leaseRenewedAt, 10_000);
});

test("eligible-to-eligible transitions preserve the continuous idle boundary", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));

  model.accept(envelope(BOOT_A, [state(1, "done", "eligible_idle")]), 10_000);
  model.accept(envelope(BOOT_A, [state(2, "waiting", "eligible_idle")]), 20_000);
  assert.equal(model.inspect(INSTANCE).eligibleSince, 10_000);

  model.accept(envelope(BOOT_A, [state(3, "working", "active")]), 30_000);
  assert.equal(model.inspect(INSTANCE).eligibleSince, null);

  model.accept(envelope(BOOT_A, [state(4, "done", "eligible_idle")]), 40_000);
  assert.equal(model.inspect(INSTANCE).eligibleSince, 40_000);
});

test("unknown never opens an eligible idle interval", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  model.accept(envelope(BOOT_A, [state(1, "idle", "unknown")]), 10_000);
  assert.equal(model.inspect(INSTANCE).eligibleSince, null);
});

test("client-authored received_at and idle_stage are rejected at the boundary", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));

  for (const injected of [
    { received_at: "2026-07-24T12:00:00Z" },
    { server_received_at: "2026-07-24T12:00:00Z" },
    { events: [{ ...state(1), idle_stage: "fish" }] },
  ]) {
    const report = envelope(BOOT_A, [state(1)]);
    const candidate =
      "events" in injected ? { ...report, events: injected.events } : { ...report, ...injected };
    assert.deepEqual(model.accept(candidate, 10_000), {
      ok: false,
      code: "client_authority_field",
    });
  }
  assert.equal(model.inspect(INSTANCE), null);
});
