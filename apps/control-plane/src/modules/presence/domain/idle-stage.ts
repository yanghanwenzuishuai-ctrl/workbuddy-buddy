export type IdleStage = "none" | "fresh" | "salted" | "costume" | "fish";

export function deriveIdleStage(
  eligibleSince: Date | null,
  at: Date,
): IdleStage {
  if (eligibleSince === null) return "none";
  const seconds = Math.max(
    0,
    Math.floor((at.getTime() - eligibleSince.getTime()) / 1_000),
  );
  if (seconds >= 3_600) return "fish";
  if (seconds >= 2_100) return "costume";
  if (seconds >= 1_500) return "salted";
  if (seconds >= 900) return "fresh";
  return "none";
}
