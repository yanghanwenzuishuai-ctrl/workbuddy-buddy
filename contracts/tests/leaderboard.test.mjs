import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CONTRACTS_DIR, readJson } from "./contract-helpers.mjs";
import { rankLeaderboardCandidates } from "./leaderboard-model.mjs";

const POLICY_FILE = path.join(CONTRACTS_DIR, "protocol-policy.v1.json");

test("ranking is score descending, then earlier attainment, then stable Agent ID", async () => {
  const policy = await readJson(POLICY_FILE);
  assert.deepEqual(policy.leaderboard, {
    primary_order: {
      field: "slacking_seconds",
      direction: "descending",
    },
    tie_breakers: [
      {
        field: "score_reached_at",
        direction: "ascending",
      },
      {
        field: "stable_agent_id",
        direction: "ascending",
      },
    ],
    private_tie_break_fields_are_not_public: true,
  });

  const ranked = rankLeaderboardCandidates([
    {
      stable_agent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      slacking_seconds: 1800,
      score_reached_at: 200,
    },
    {
      stable_agent_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      slacking_seconds: 2799,
      score_reached_at: 400,
    },
    {
      stable_agent_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      slacking_seconds: 1800,
      score_reached_at: 100,
    },
    {
      stable_agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      slacking_seconds: 1800,
      score_reached_at: 200,
    },
  ]);

  assert.deepEqual(
    ranked.map(({ stable_agent_id: id, rank }) => [rank, id]),
    [
      [1, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      [2, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
      [3, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      [4, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ],
  );
});

test("ranking is deterministic and never mutates domain candidates", () => {
  const candidates = [
    {
      stable_agent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      slacking_seconds: 1,
      score_reached_at: 1,
    },
    {
      stable_agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      slacking_seconds: 1,
      score_reached_at: 1,
    },
  ];
  const before = structuredClone(candidates);
  assert.deepEqual(
    rankLeaderboardCandidates(candidates),
    rankLeaderboardCandidates(candidates),
  );
  assert.deepEqual(candidates, before);
});
