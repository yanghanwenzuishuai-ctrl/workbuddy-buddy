export function rankLeaderboardCandidates(candidates) {
  return structuredClone(candidates)
    .sort(
      (left, right) =>
        right.slacking_seconds - left.slacking_seconds ||
        left.score_reached_at - right.score_reached_at ||
        left.stable_agent_id.localeCompare(right.stable_agent_id),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
