import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CONTRACTS_DIR,
  readJson,
  resolveManifestPath,
} from "./contract-helpers.mjs";
import { ProtocolAcceptanceModel } from "./protocol-model.mjs";
import {
  INSTANCE,
  envelope,
  heartbeat,
  state,
} from "./protocol-samples.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const FIXTURES_DIR = path.join(CONTRACTS_DIR, "fixtures");
const MANIFEST_FILE = path.join(FIXTURES_DIR, "manifest.v1.json");
const OTHER_INSTANCE = "22222222-2222-4222-8222-222222222222";
const BOOT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOOT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("state transitions and heartbeats consume one contiguous per-boot sequence", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));

  assert.equal(model.accept(envelope(BOOT_A, [state(1)]), 1_000).ok, true);
  assert.equal(model.accept(envelope(BOOT_A, [heartbeat(2)]), 2_000).ok, true);
  assert.equal(
    model.accept(envelope(BOOT_A, [state(3, "working", "active")]), 3_000).ok,
    true,
  );

  assert.deepEqual(model.inspect(INSTANCE), {
    currentBoot: BOOT_A,
    generation: 1,
    expectedSequence: 4,
    presence: {
      display_state: "working",
      activity_state: "active",
      server_received_at: 3_000,
    },
    leaseRenewedAt: 3_000,
    eligibleSince: null,
  });
});

test("an exact whole-batch replay returns the same ACK without side effects", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  const report = envelope(BOOT_A, [
    state(1),
    state(2, "done", "eligible_idle"),
  ]);
  const first = model.accept(report, 10_000);
  const effects = model.sideEffectCount;
  const replay = model.accept(report, 99_000);

  assert.deepEqual(replay, first);
  assert.equal(model.sideEffectCount, effects);
  assert.equal(model.inspect(INSTANCE).leaseRenewedAt, 10_000);
  assert.equal(model.inspect(INSTANCE).eligibleSince, 10_000);
});

test("same range with a different canonical envelope conflicts", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  const report = envelope(BOOT_A, [state(1)]);
  model.accept(report, 10_000);

  const changed = { ...report, sent_at: "2026-07-24T12:01:00Z" };
  assert.deepEqual(model.accept(changed, 11_000), {
    ok: false,
    code: "sequence_conflict",
    expected_sequence: 2,
  });
  assert.equal(model.sideEffectCount, 1);
});

test("same sequence with different content conflicts", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  model.accept(envelope(BOOT_A, [state(1)]), 1_000);

  const conflict = model.accept(
    envelope(BOOT_A, [state(1, "working", "active")]),
    2_000,
  );
  assert.deepEqual(conflict, {
    ok: false,
    code: "sequence_conflict",
    expected_sequence: 2,
  });
  assert.equal(model.sideEffectCount, 1);
});

test("gaps, intrinsic discontinuities and partial overlaps reject atomically", async () => {
  const policy = await readJson(POLICY_FILE);
  const model = new ProtocolAcceptanceModel(policy);
  model.accept(envelope(BOOT_A, [state(1)]), 1_000);

  assert.deepEqual(model.accept(envelope(BOOT_A, [state(3)]), 2_000), {
    ok: false,
    code: policy.batch.gap,
    expected_sequence: 2,
  });

  const discontinuous = envelope(BOOT_A, [state(2), state(3)]);
  discontinuous.events[1].sequence = 4;
  assert.deepEqual(model.accept(discontinuous, 2_000), {
    ok: false,
    code: policy.batch.gap,
    expected_sequence: 3,
  });
  assert.equal(model.inspect(INSTANCE).expectedSequence, 2);

  model.accept(envelope(BOOT_A, [state(2), heartbeat(3)]), 3_000);
  assert.deepEqual(model.accept(envelope(BOOT_A, [heartbeat(3)]), 4_000), {
    ok: false,
    code: policy.batch.partial_overlap,
    expected_sequence: 4,
  });
  assert.equal(model.sideEffectCount, 3);
});

test("a CAS-linked sequence-1 new boot fences every prior boot", async () => {
  const policy = await readJson(POLICY_FILE);
  const model = new ProtocolAcceptanceModel(policy);
  const bootAFirstReport = envelope(BOOT_A, [state(1)]);
  model.accept(bootAFirstReport, 1_000);

  const invalidCandidate = model.accept(
    envelope(BOOT_B, [state(2)], { previous_boot_id: BOOT_A }),
    2_000,
  );
  assert.deepEqual(invalidCandidate, {
    ok: false,
    code: "sequence_gap",
    expected_sequence: 1,
  });
  assert.equal(model.inspect(INSTANCE).currentBoot, BOOT_A);

  assert.equal(
    model.accept(
      envelope(BOOT_B, [state(1)], { previous_boot_id: BOOT_A }),
      3_000,
    ).ok,
    true,
  );
  const afterTakeover = model.inspect(INSTANCE);
  assert.equal(afterTakeover.currentBoot, BOOT_B);
  assert.equal(afterTakeover.generation, 2);

  const stale = model.accept(envelope(BOOT_A, [heartbeat(2)]), 4_000);
  assert.deepEqual(stale, { ok: false, code: "stale_boot" });
  assert.deepEqual(model.accept(bootAFirstReport, 5_000), {
    ok: false,
    code: "stale_boot",
  });
  assert.equal(
    policy.batch.fenced_boot_replay,
    "stale_boot_precedes_replay_lookup",
  );
  assert.deepEqual(model.inspect(INSTANCE), afterTakeover);
});

test("a delayed unseen boot cannot reverse-fence the current boot", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  assert.equal(model.accept(envelope(BOOT_A, [state(1)]), 1_000).ok, true);
  assert.equal(
    model.accept(
      envelope(BOOT_B, [state(1)], { previous_boot_id: BOOT_A }),
      2_000,
    ).ok,
    true,
  );
  const beforeDelayedBoot = model.inspect(INSTANCE);

  assert.deepEqual(model.accept(envelope(BOOT_C, [state(1)]), 3_000), {
    ok: false,
    code: "stale_boot",
  });
  assert.deepEqual(
    model.accept(
      envelope(BOOT_C, [state(2)], { previous_boot_id: BOOT_A }),
      4_000,
    ),
    {
      ok: false,
      code: "stale_boot",
    },
  );
  assert.deepEqual(model.inspect(INSTANCE), beforeDelayedBoot);
});

test("a new boot starts with a complete state snapshot, not a heartbeat", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  assert.deepEqual(model.accept(envelope(BOOT_A, [heartbeat(1)]), 1_000), {
    ok: false,
    code: "report_semantics_invalid",
  });
  assert.equal(model.inspect(INSTANCE)?.currentBoot ?? null, null);

  assert.equal(
    model.accept(
      envelope(BOOT_A, [state(1, "idle", "unknown"), heartbeat(2)]),
      2_000,
    ).ok,
    true,
  );
  assert.deepEqual(model.inspect(INSTANCE).presence, {
    display_state: "idle",
    activity_state: "unknown",
    server_received_at: 2_000,
  });
});

test("sequence and boot generations are isolated per instance", async () => {
  const model = new ProtocolAcceptanceModel(await readJson(POLICY_FILE));
  model.accept(envelope(BOOT_A, [state(1)]), 1_000);
  model.accept(
    envelope(BOOT_A, [state(1)], { instance_id: OTHER_INSTANCE }),
    2_000,
  );
  assert.equal(model.inspect(INSTANCE).expectedSequence, 2);
  assert.equal(model.inspect(OTHER_INSTANCE).expectedSequence, 2);
  assert.equal(model.inspect(INSTANCE).generation, 1);
  assert.equal(model.inspect(OTHER_INSTANCE).generation, 1);
});

test("schema-valid semantic fixtures fail with their declared protocol code", async (t) => {
  const manifest = await readJson(MANIFEST_FILE);
  const cases = manifest.schema_cases.filter(
    (entry) => entry.expect_schema_valid && !entry.expect_protocol_valid,
  );
  assert.ok(cases.length > 0);

  for (const entry of cases) {
    await t.test(entry.scenario, async () => {
      const report = await readJson(
        resolveManifestPath(entry.fixture, FIXTURES_DIR),
      );
      assert.equal(
        modelResultCode(
          new ProtocolAcceptanceModel(await readJson(POLICY_FILE)),
          report,
        ),
        entry.expected_problem_code,
        entry.fixture,
      );
    });
  }
});

test("stateful replay fixture is idempotent, then detects conflicting content", async () => {
  const policy = await readJson(POLICY_FILE);
  const manifest = await readJson(MANIFEST_FILE);
  const scenario = manifest.protocol_scenarios.find(
    (entry) =>
      entry.scenario === "exact_replay_then_same_sequence_different_payload",
  );
  assert.ok(scenario);
  const fixture = await readJson(
    resolveManifestPath(scenario.fixture, FIXTURES_DIR),
  );
  const { original, exact_replay: exactReplay, conflicting_replay: conflict } =
    fixture;
  const model = new ProtocolAcceptanceModel(policy);

  const seedEvents = Array.from(
    { length: original.first_sequence - 1 },
    (_, index) =>
      index === 0 ? state(1, "working", "active") : heartbeat(index + 1),
  );
  assert.ok(seedEvents.length <= policy.batch.maximum_events);
  const seed = {
    ...original,
    previous_boot_id: null,
    first_sequence: 1,
    events: seedEvents,
    signature: "C".repeat(86) + "==",
  };
  assert.equal(model.accept(seed, 500).ok, true);

  const first = model.accept(original, 1_000);
  const effects = model.sideEffectCount;
  const replay = model.accept(exactReplay, 2_000);
  assert.deepEqual(replay, first);
  assert.equal(model.sideEffectCount, effects);
  assert.deepEqual(model.accept(conflict, 3_000), {
    ok: false,
    code: scenario.expected_conflicting_replay_problem_code,
    expected_sequence: original.first_sequence + original.events.length,
  });
  assert.equal(model.sideEffectCount, effects);
});

function modelResultCode(model, report) {
  const result = model.accept(report, 1_000);
  return result.ok ? null : result.code;
}
