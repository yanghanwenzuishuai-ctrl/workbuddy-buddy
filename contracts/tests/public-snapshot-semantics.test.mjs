import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import { validatePublicSnapshotSemantics } from "./public-snapshot-semantics.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");
const SNAPSHOT_FILE = path.join(
  CONTRACTS_DIR,
  "fixtures",
  "public-office-snapshot.valid.json",
);

test("public snapshot semantic validator accepts the canonical fixture", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.deepEqual(policy.public_projection.semantic_invariants, [
    "leaderboard_office_day_equals_office_local_date",
    "room_ids_are_unique",
    "agent_mount_ids_are_unique",
    "agent_rooms_exist",
    "occupied_scene_slots_are_unique_and_within_room_capacity",
    "leaderboard_ranks_are_unique_and_contiguous",
    "leaderboard_mount_ids_are_unique",
    "leaderboard_scores_are_non_increasing",
  ]);
  assert.equal(
    validatePublicSnapshotSemantics(await readJson(SNAPSHOT_FILE)),
    null,
  );
});

test("wrong Office day, duplicate rank and unknown room are rejected", async () => {
  const fixture = await readJson(SNAPSHOT_FILE);

  const wrongDay = structuredClone(fixture);
  wrongDay.leaderboard.office_local_date = "2026-07-23";
  assert.equal(validatePublicSnapshotSemantics(wrongDay), "office_day_mismatch");

  const duplicateRank = structuredClone(fixture);
  duplicateRank.leaderboard.entries.push({
    ...duplicateRank.leaderboard.entries[0],
    mount_id: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(validatePublicSnapshotSemantics(duplicateRank), "duplicate_rank");

  const unknownRoom = structuredClone(fixture);
  unknownRoom.agents[0].room_id =
    "88888888-8888-4888-8888-888888888888";
  assert.equal(validatePublicSnapshotSemantics(unknownRoom), "unknown_room");
});

test("a lower rank can never have a higher slacking score", async () => {
  const fixture = await readJson(SNAPSHOT_FILE);
  fixture.leaderboard.entries.push({
    rank: 2,
    mount_id: "77777777-7777-4777-8777-777777777777",
    alias: "Later",
    pet_id: "pixel-penguin",
    slacking_seconds: fixture.leaderboard.entries[0].slacking_seconds + 999,
  });
  assert.equal(
    validatePublicSnapshotSemantics(fixture),
    "leaderboard_score_order",
  );
});

test("scene occupancy respects uniqueness and each Room's declared capacity", async () => {
  const fixture = await readJson(SNAPSHOT_FILE);
  const duplicateSlot = structuredClone(fixture);
  duplicateSlot.agents.push({
    ...duplicateSlot.agents[0],
    mount_id: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(
    validatePublicSnapshotSemantics(duplicateSlot),
    "duplicate_scene_slot",
  );

  const outsideCapacity = structuredClone(fixture);
  outsideCapacity.rooms[0].scene_capacity = 1;
  outsideCapacity.agents[0].scene_slot = 1;
  assert.equal(
    validatePublicSnapshotSemantics(outsideCapacity),
    "scene_slot_out_of_capacity",
  );
});
