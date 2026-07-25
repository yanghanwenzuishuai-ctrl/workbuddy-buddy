import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveIdleStage,
  rankLeaderboardCandidates,
  scoreCandidate,
  type LeaderboardCandidate,
} from "../../src/modules/public-office/domain/scoring.js";

test("idle stages change at 15/25/35/60 minutes and the end is exclusive", () => {
  const openInterval = {
    startedAtMs: 0,
    endedAtMs: null,
  };

  assert.equal(deriveIdleStage(openInterval, 899_999), "none");
  assert.equal(deriveIdleStage(openInterval, 900_000), "fresh");
  assert.equal(deriveIdleStage(openInterval, 1_499_999), "fresh");
  assert.equal(deriveIdleStage(openInterval, 1_500_000), "salted");
  assert.equal(deriveIdleStage(openInterval, 2_099_999), "salted");
  assert.equal(deriveIdleStage(openInterval, 2_100_000), "costume");
  assert.equal(deriveIdleStage(openInterval, 3_599_999), "costume");
  assert.equal(deriveIdleStage(openInterval, 3_600_000), "fish");

  const completedInterval = {
    startedAtMs: 0,
    endedAtMs: 3_600_000,
  };
  assert.equal(deriveIdleStage(completedInterval, 3_599_999), "costume");
  assert.equal(deriveIdleStage(completedInterval, 3_600_000), "none");
  assert.equal(
    deriveIdleStage({ startedAtMs: 1_000, endedAtMs: null }, 999),
    "none",
  );
});

test("each eligibility segment independently pays the 900-second grace", () => {
  const segmented = scoreCandidate(
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000001",
      mountId: "mount-segmented",
      intervals: [
        { startedAtMs: 2_000_000, endedAtMs: 3_200_000 },
        { startedAtMs: 0, endedAtMs: 1_200_000 },
      ],
    },
    4_000_000,
  );
  assert.equal(segmented.slackingSeconds, 600);
  assert.equal(segmented.scoreReachedAtMs, 3_200_000);

  const continuous = scoreCandidate(
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000002",
      mountId: "mount-continuous",
      intervals: [{ startedAtMs: 0, endedAtMs: 2_400_000 }],
    },
    4_000_000,
  );
  assert.equal(continuous.slackingSeconds, 1_500);
  assert.equal(continuous.scoreReachedAtMs, 2_400_000);
});

test("adjacent half-open segments are accepted but overlapping segments are rejected", () => {
  const adjacent = scoreCandidate(
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000001",
      mountId: "mount-adjacent",
      intervals: [
        { startedAtMs: 0, endedAtMs: 1_200_000 },
        { startedAtMs: 1_200_000, endedAtMs: 2_400_000 },
      ],
    },
    3_000_000,
  );
  assert.equal(adjacent.slackingSeconds, 600);

  assert.throws(
    () =>
      scoreCandidate(
        {
          logicalAgentId: "00000000-0000-4000-8000-000000000002",
          mountId: "mount-overlap",
          intervals: [
            { startedAtMs: 0, endedAtMs: 1_200_001 },
            { startedAtMs: 1_200_000, endedAtMs: 2_400_000 },
          ],
        },
        3_000_000,
      ),
    /must not overlap/,
  );
});

test("ranking uses score desc, reachedAt asc, then logical-agent UUID asc", () => {
  const candidates: readonly LeaderboardCandidate[] = [
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000003",
      mountId: "mount-late",
      intervals: [{ startedAtMs: 100_000, endedAtMs: 1_300_000 }],
    },
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000002",
      mountId: "mount-uuid-second",
      intervals: [{ startedAtMs: 0, endedAtMs: 1_200_000 }],
    },
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000004",
      mountId: "mount-high-score",
      intervals: [{ startedAtMs: 0, endedAtMs: 2_100_000 }],
    },
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000001",
      mountId: "mount-uuid-first",
      intervals: [{ startedAtMs: 0, endedAtMs: 1_200_000 }],
    },
    {
      logicalAgentId: "00000000-0000-4000-8000-000000000005",
      mountId: "mount-zero",
      intervals: [{ startedAtMs: 0, endedAtMs: 900_000 }],
    },
  ];

  const ranked = rankLeaderboardCandidates(candidates, 3_000_000);

  assert.deepEqual(
    ranked.map((candidate) => ({
      rank: candidate.rank,
      logicalAgentId: candidate.logicalAgentId,
      score: candidate.slackingSeconds,
      reachedAtMs: candidate.scoreReachedAtMs,
    })),
    [
      {
        rank: 1,
        logicalAgentId: "00000000-0000-4000-8000-000000000004",
        score: 1_200,
        reachedAtMs: 2_100_000,
      },
      {
        rank: 2,
        logicalAgentId: "00000000-0000-4000-8000-000000000001",
        score: 300,
        reachedAtMs: 1_200_000,
      },
      {
        rank: 3,
        logicalAgentId: "00000000-0000-4000-8000-000000000002",
        score: 300,
        reachedAtMs: 1_200_000,
      },
      {
        rank: 4,
        logicalAgentId: "00000000-0000-4000-8000-000000000003",
        score: 300,
        reachedAtMs: 1_300_000,
      },
    ],
  );
});

test("scoring and ranking do not mutate candidates or nested intervals", () => {
  const first = Object.freeze({
    logicalAgentId: "00000000-0000-4000-8000-000000000002",
    mountId: "mount-two",
    intervals: Object.freeze([
      Object.freeze({ startedAtMs: 2_000_000, endedAtMs: 3_200_000 }),
      Object.freeze({ startedAtMs: 0, endedAtMs: 1_200_000 }),
    ]),
  });
  const second = Object.freeze({
    logicalAgentId: "00000000-0000-4000-8000-000000000001",
    mountId: "mount-one",
    intervals: Object.freeze([
      Object.freeze({ startedAtMs: 0, endedAtMs: 2_100_000 }),
    ]),
  });
  const candidates = Object.freeze([first, second]);
  const before = structuredClone(candidates);

  assert.doesNotThrow(() =>
    rankLeaderboardCandidates(candidates, 4_000_000),
  );
  assert.deepEqual(candidates, before);
});
