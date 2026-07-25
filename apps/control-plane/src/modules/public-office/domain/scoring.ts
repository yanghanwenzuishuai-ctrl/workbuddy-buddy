const MILLISECONDS_PER_SECOND = 1_000;

export const PER_SEGMENT_GRACE_SECONDS = 15 * 60;

export const IDLE_STAGE_THRESHOLDS_SECONDS = {
  fresh: 15 * 60,
  salted: 25 * 60,
  costume: 35 * 60,
  fish: 60 * 60,
} as const;

export type IdleStage = "none" | keyof typeof IDLE_STAGE_THRESHOLDS_SECONDS;

export interface EligibilityInterval {
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

export interface LeaderboardCandidate {
  readonly logicalAgentId: string;
  readonly mountId: string;
  readonly intervals: readonly EligibilityInterval[];
}

export interface IntervalScore {
  readonly slackingSeconds: number;
  readonly scoreReachedAtMs: number | null;
}

export interface CandidateScore extends IntervalScore {
  readonly logicalAgentId: string;
  readonly mountId: string;
}

export interface RankedCandidate extends CandidateScore {
  readonly rank: number;
}

/**
 * Returns the visual idle stage at an instant. Eligibility intervals use
 * [startedAtMs, endedAtMs), so a completed interval is inactive at its end.
 */
export function deriveIdleStage(
  interval: EligibilityInterval | null,
  asOfMs: number,
): IdleStage {
  assertTimestamp(asOfMs, "asOfMs");
  if (interval === null) {
    return "none";
  }

  assertInterval(interval);
  if (
    asOfMs < interval.startedAtMs ||
    (interval.endedAtMs !== null && asOfMs >= interval.endedAtMs)
  ) {
    return "none";
  }

  const elapsedSeconds = wholeSecondsBetween(interval.startedAtMs, asOfMs);
  if (elapsedSeconds >= IDLE_STAGE_THRESHOLDS_SECONDS.fish) {
    return "fish";
  }
  if (elapsedSeconds >= IDLE_STAGE_THRESHOLDS_SECONDS.costume) {
    return "costume";
  }
  if (elapsedSeconds >= IDLE_STAGE_THRESHOLDS_SECONDS.salted) {
    return "salted";
  }
  if (elapsedSeconds >= IDLE_STAGE_THRESHOLDS_SECONDS.fresh) {
    return "fresh";
  }
  return "none";
}

/**
 * Scores one eligibility interval as of a cutoff. Every interval independently
 * pays the 15-minute grace period.
 */
export function scoreEligibilityInterval(
  interval: EligibilityInterval,
  asOfMs: number,
): IntervalScore {
  assertTimestamp(asOfMs, "asOfMs");
  assertInterval(interval);

  const effectiveEndMs =
    interval.endedAtMs === null
      ? asOfMs
      : Math.min(interval.endedAtMs, asOfMs);
  if (effectiveEndMs <= interval.startedAtMs) {
    return {
      slackingSeconds: 0,
      scoreReachedAtMs: null,
    };
  }

  const elapsedSeconds = wholeSecondsBetween(
    interval.startedAtMs,
    effectiveEndMs,
  );
  const slackingSeconds = Math.max(
    0,
    elapsedSeconds - PER_SEGMENT_GRACE_SECONDS,
  );
  if (slackingSeconds === 0) {
    return {
      slackingSeconds,
      scoreReachedAtMs: null,
    };
  }

  const scoreReachedAtMs =
    interval.startedAtMs +
    (PER_SEGMENT_GRACE_SECONDS + slackingSeconds) *
      MILLISECONDS_PER_SECOND;
  if (!Number.isSafeInteger(scoreReachedAtMs)) {
    throw new RangeError("scoreReachedAtMs must be a safe integer");
  }

  return {
    slackingSeconds,
    scoreReachedAtMs,
  };
}

export function scoreCandidate(
  candidate: LeaderboardCandidate,
  asOfMs: number,
): CandidateScore {
  assertTimestamp(asOfMs, "asOfMs");
  assertIdentifier(candidate.logicalAgentId, "logicalAgentId");
  assertIdentifier(candidate.mountId, "mountId");

  const intervals = [...candidate.intervals];
  for (const interval of intervals) {
    assertInterval(interval);
  }
  intervals.sort(compareIntervals);
  assertNonOverlapping(intervals);

  let slackingSeconds = 0;
  let scoreReachedAtMs: number | null = null;
  for (const interval of intervals) {
    const intervalScore = scoreEligibilityInterval(interval, asOfMs);
    slackingSeconds += intervalScore.slackingSeconds;
    if (!Number.isSafeInteger(slackingSeconds)) {
      throw new RangeError("slackingSeconds must be a safe integer");
    }
    if (
      intervalScore.scoreReachedAtMs !== null &&
      (scoreReachedAtMs === null ||
        intervalScore.scoreReachedAtMs > scoreReachedAtMs)
    ) {
      scoreReachedAtMs = intervalScore.scoreReachedAtMs;
    }
  }

  return {
    logicalAgentId: candidate.logicalAgentId,
    mountId: candidate.mountId,
    slackingSeconds,
    scoreReachedAtMs,
  };
}

export function rankLeaderboardCandidates(
  candidates: readonly LeaderboardCandidate[],
  asOfMs: number,
): RankedCandidate[] {
  assertTimestamp(asOfMs, "asOfMs");

  const seenLogicalAgentIds = new Set<string>();
  const scores = candidates.map((candidate) => {
    const normalizedLogicalAgentId = candidate.logicalAgentId.toLowerCase();
    if (seenLogicalAgentIds.has(normalizedLogicalAgentId)) {
      throw new RangeError(
        `logicalAgentId must be unique: ${candidate.logicalAgentId}`,
      );
    }
    seenLogicalAgentIds.add(normalizedLogicalAgentId);
    return scoreCandidate(candidate, asOfMs);
  });

  return scores
    .filter((score) => score.slackingSeconds > 0)
    .sort(compareCandidateScores)
    .map((score, index) => ({
      ...score,
      rank: index + 1,
    }));
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new RangeError(`${name} must be a non-empty trimmed string`);
  }
}

function assertInterval(interval: EligibilityInterval): void {
  assertTimestamp(interval.startedAtMs, "interval.startedAtMs");
  if (interval.endedAtMs === null) {
    return;
  }
  assertTimestamp(interval.endedAtMs, "interval.endedAtMs");
  if (interval.endedAtMs < interval.startedAtMs) {
    throw new RangeError(
      "interval.endedAtMs must not precede interval.startedAtMs",
    );
  }
}

function wholeSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.floor((endedAtMs - startedAtMs) / MILLISECONDS_PER_SECOND);
}

function compareIntervals(
  left: EligibilityInterval,
  right: EligibilityInterval,
): number {
  if (left.startedAtMs !== right.startedAtMs) {
    return left.startedAtMs - right.startedAtMs;
  }
  return intervalEndForComparison(left) - intervalEndForComparison(right);
}

function intervalEndForComparison(interval: EligibilityInterval): number {
  return interval.endedAtMs ?? Number.POSITIVE_INFINITY;
}

function assertNonOverlapping(
  sortedIntervals: readonly EligibilityInterval[],
): void {
  let previousEndMs: number | null = null;
  for (const interval of sortedIntervals) {
    if (
      interval.endedAtMs !== null &&
      interval.endedAtMs === interval.startedAtMs
    ) {
      continue;
    }
    if (
      previousEndMs !== null &&
      interval.startedAtMs < previousEndMs
    ) {
      throw new RangeError("eligibility intervals must not overlap");
    }
    previousEndMs =
      interval.endedAtMs ?? Number.POSITIVE_INFINITY;
  }
}

function compareCandidateScores(
  left: CandidateScore,
  right: CandidateScore,
): number {
  if (left.slackingSeconds !== right.slackingSeconds) {
    return right.slackingSeconds - left.slackingSeconds;
  }

  const leftReachedAt =
    left.scoreReachedAtMs ?? Number.POSITIVE_INFINITY;
  const rightReachedAt =
    right.scoreReachedAtMs ?? Number.POSITIVE_INFINITY;
  if (leftReachedAt !== rightReachedAt) {
    return leftReachedAt - rightReachedAt;
  }

  const leftLogicalAgentId = left.logicalAgentId.toLowerCase();
  const rightLogicalAgentId = right.logicalAgentId.toLowerCase();
  if (leftLogicalAgentId < rightLogicalAgentId) {
    return -1;
  }
  if (leftLogicalAgentId > rightLogicalAgentId) {
    return 1;
  }
  return 0;
}
