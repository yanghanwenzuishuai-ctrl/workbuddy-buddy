import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import {
  deriveSlacking,
  EligibleIntervalModel,
} from "./slacking-model.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const MINUTE = 60_000;

function atMinutes(policy, minutes, activityState = "eligible_idle") {
  return deriveSlacking(policy, {
    activityState,
    eligibleSince: 0,
    now: minutes * MINUTE,
    leaseExpiresAt: 2 * 60 * MINUTE,
  });
}

test("15/25/35/60 minute boundaries are inclusive and grace is not scored", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.equal(policy.slacking.stage_boundary_inclusive, true);
  assert.equal(
    policy.slacking.score_seconds_formula,
    "max(0, continuous_eligible_seconds - grace_seconds)",
  );

  assert.deepEqual(
    deriveSlacking(policy, {
      activityState: "eligible_idle",
      eligibleSince: 0,
      now: 15 * MINUTE - 1_000,
      leaseExpiresAt: 2 * 60 * MINUTE,
    }),
    { idle_stage: "none", slacking_seconds: 0 },
  );
  assert.deepEqual(atMinutes(policy, 15), {
    idle_stage: "fresh",
    slacking_seconds: 0,
  });
  assert.deepEqual(atMinutes(policy, 25), {
    idle_stage: "salted",
    slacking_seconds: 10 * 60,
  });
  assert.deepEqual(atMinutes(policy, 35), {
    idle_stage: "costume",
    slacking_seconds: 20 * 60,
  });
  assert.deepEqual(atMinutes(policy, 60), {
    idle_stage: "fish",
    slacking_seconds: 45 * 60,
  });
});

test("unknown, active, blocked waiting and failed activity never derive a stage", async () => {
  const policy = await readJson(POLICY_FILE);
  for (const activityState of ["unknown", "active", "waiting", "failed"]) {
    assert.deepEqual(atMinutes(policy, 60, activityState), {
      idle_stage: "none",
      slacking_seconds: 0,
    });
  }

  assert.equal(
    atMinutes(policy, 25, "eligible_idle").idle_stage,
    "salted",
    "display=waiting may still be eligible only when activity_state is eligible_idle",
  );
});

test("lease expiry breaks the interval and reconnect never backfills offline time", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.deepEqual(
    deriveSlacking(policy, {
      activityState: "eligible_idle",
      eligibleSince: 0,
      now: 25 * MINUTE,
      leaseExpiresAt: 20 * MINUTE,
    }),
    { idle_stage: "none", slacking_seconds: 0 },
  );
  assert.deepEqual(
    deriveSlacking(policy, {
      activityState: "eligible_idle",
      eligibleSince: 25 * MINUTE,
      now: 39 * MINUTE,
      leaseExpiresAt: 40 * MINUTE,
    }),
    { idle_stage: "none", slacking_seconds: 0 },
  );
});

test("stats opt-out and eligibility intersection changes restart the full grace period", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.deepEqual(policy.slacking.interval_breakers, [
    "non_eligible_activity",
    "lease_expired",
    "boot_replaced",
    "stats_opt_out",
    "mount_deactivated",
    "schedule_window_closed",
    "schedule_version_changed",
  ]);
  assert.equal(policy.slacking.resume_starts_new_interval, true);

  const interval = new EligibleIntervalModel();
  interval.apply("stats_opt_in", 0);
  assert.equal(interval.apply("eligible_activity", 0), 0);
  assert.equal(interval.apply("stats_opt_out", 20 * MINUTE), null);
  assert.equal(
    interval.apply("stats_opt_in", 30 * MINUTE),
    30 * MINUTE,
    "rejoining starts a new intersection at server receive time",
  );

  assert.deepEqual(
    deriveSlacking(policy, {
      activityState: "eligible_idle",
      eligibleSince: interval.eligibleSince,
      now: 45 * MINUTE - 1_000,
      leaseExpiresAt: 2 * 60 * MINUTE,
    }),
    { idle_stage: "none", slacking_seconds: 0 },
  );
  assert.deepEqual(
    deriveSlacking(policy, {
      activityState: "eligible_idle",
      eligibleSince: interval.eligibleSince,
      now: 45 * MINUTE,
      leaseExpiresAt: 2 * 60 * MINUTE,
    }),
    { idle_stage: "fresh", slacking_seconds: 0 },
  );

  for (const [breakEvent, resumeEvent] of [
    ["mount_deactivated", "mount_activated"],
    ["schedule_window_closed", "schedule_window_opened"],
    ["lease_expired", "lease_renewed"],
  ]) {
    assert.equal(interval.apply(breakEvent, 50 * MINUTE), null);
    assert.equal(interval.apply(resumeEvent, 60 * MINUTE), 60 * MINUTE);
  }
  assert.equal(interval.apply("schedule_version_changed", 70 * MINUTE), 70 * MINUTE);
});

test("presence and poster consent do not alter scoring continuity", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.deepEqual(policy.slacking.non_breaking_consent_changes, [
    "presence_visible",
    "poster_opt_in",
  ]);
  const interval = new EligibleIntervalModel();
  interval.apply("stats_opt_in", 0);
  interval.apply("eligible_activity", 0);
  assert.equal(interval.apply("presence_visible_changed", 10 * MINUTE), 0);
  assert.equal(interval.apply("poster_opt_in_changed", 20 * MINUTE), 0);
});
