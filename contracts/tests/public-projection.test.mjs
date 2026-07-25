import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import {
  projectByConsent,
  withdrawConsent,
} from "./public-projection-model.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const SNAPSHOT_FIXTURE_FILE = path.join(
  CONTRACTS_DIR,
  "fixtures",
  "public-office-snapshot.valid.json",
);

const PRESENCE_ONLY = "11111111-1111-4111-8111-111111111111";
const STATS_ONLY = "22222222-2222-4222-8222-222222222222";
const ALL_CONSENTS = "33333333-3333-4333-8333-333333333333";
const POSTER_ONLY = "44444444-4444-4444-8444-444444444444";
const INACTIVE = "55555555-5555-4555-8555-555555555555";

function mount(mountId, overrides = {}) {
  return {
    mount_id: mountId,
    active: true,
    presence_visible: false,
    stats_opt_in: false,
    poster_opt_in: false,
    ...overrides,
  };
}

test("three consent flags independently filter each public surface", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.deepEqual(policy.public_projection.consent_rules, {
    agents: ["presence_visible"],
    leaderboard: ["stats_opt_in"],
    daily_award: ["stats_opt_in"],
    poster_live_scene: ["presence_visible", "poster_opt_in"],
    poster_statistics: ["stats_opt_in", "poster_opt_in"],
  });

  const projection = projectByConsent(
    [
      mount(PRESENCE_ONLY, { presence_visible: true }),
      mount(STATS_ONLY, { stats_opt_in: true }),
      mount(ALL_CONSENTS, {
        presence_visible: true,
        stats_opt_in: true,
        poster_opt_in: true,
      }),
      mount(POSTER_ONLY, { poster_opt_in: true }),
      mount(INACTIVE, {
        active: false,
        presence_visible: true,
        stats_opt_in: true,
        poster_opt_in: true,
      }),
    ],
    ALL_CONSENTS,
  );

  assert.deepEqual(projection, {
    agents: [PRESENCE_ONLY, ALL_CONSENTS],
    leaderboard: [STATS_ONLY, ALL_CONSENTS],
    daily_award: ALL_CONSENTS,
    poster_live_scene: [ALL_CONSENTS],
    poster_statistics: [ALL_CONSENTS],
  });
});

test("withdrawal increments revision and removes only the affected projection immediately", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.equal(
    policy.public_projection.withdrawal_effect,
    "increment_revision_and_filter_next_snapshot_sse_and_new_poster",
  );
  const initial = {
    office_revision: 10,
    daily_award_winner_id: ALL_CONSENTS,
    mounts: [
      mount(ALL_CONSENTS, {
        presence_visible: true,
        stats_opt_in: true,
        poster_opt_in: true,
      }),
    ],
  };
  initial.projection = projectByConsent(
    initial.mounts,
    initial.daily_award_winner_id,
  );

  const withoutPresence = withdrawConsent(
    initial,
    ALL_CONSENTS,
    "presence_visible",
  );
  assert.equal(withoutPresence.office_revision, 11);
  assert.deepEqual(withoutPresence.projection.agents, []);
  assert.deepEqual(withoutPresence.projection.leaderboard, [ALL_CONSENTS]);
  assert.deepEqual(withoutPresence.projection.poster_live_scene, []);
  assert.deepEqual(withoutPresence.projection.poster_statistics, [
    ALL_CONSENTS,
  ]);

  const withoutStats = withdrawConsent(
    withoutPresence,
    ALL_CONSENTS,
    "stats_opt_in",
  );
  assert.equal(withoutStats.office_revision, 12);
  assert.deepEqual(withoutStats.projection.leaderboard, []);
  assert.equal(
    withoutStats.projection.daily_award,
    null,
    "an immutable stored Award is hidden, not reassigned, after winner opt-out",
  );
  assert.deepEqual(withoutStats.projection.poster_statistics, []);

  const withoutPoster = withdrawConsent(
    withoutStats,
    ALL_CONSENTS,
    "poster_opt_in",
  );
  assert.equal(withoutPoster.office_revision, 13);
  assert.deepEqual(withoutPoster.projection.poster_live_scene, []);
  assert.deepEqual(withoutPoster.projection.poster_statistics, []);
});

test("leaderboard office day is explicit and matches the snapshot scoring day", async () => {
  const policy = await readJson(POLICY_FILE);
  const snapshot = await readJson(SNAPSHOT_FIXTURE_FILE);

  assert.equal(
    policy.public_projection.office_day_assignment,
    "schedule_window_start_local_date",
  );
  assert.equal(
    snapshot.leaderboard.office_local_date,
    snapshot.office.local_date,
  );
});
