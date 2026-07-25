export function deriveSlacking(policy, input) {
  if (
    input.activityState !== "eligible_idle" ||
    !Number.isSafeInteger(input.eligibleSince) ||
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.leaseExpiresAt) ||
    input.now < input.eligibleSince ||
    input.now >= input.leaseExpiresAt
  ) {
    return { idle_stage: "none", slacking_seconds: 0 };
  }

  const continuousEligibleSeconds = Math.floor(
    (input.now - input.eligibleSince) / 1000,
  );
  const thresholds = policy.slacking.stage_boundaries_seconds;
  let idleStage = "none";
  for (const stage of ["fresh", "salted", "costume", "fish"]) {
    if (continuousEligibleSeconds >= thresholds[stage]) idleStage = stage;
  }

  return {
    idle_stage: idleStage,
    slacking_seconds: Math.max(
      0,
      continuousEligibleSeconds - policy.slacking.grace_seconds,
    ),
  };
}

export class EligibleIntervalModel {
  constructor() {
    this.currentEligible = false;
    this.statsOptIn = false;
    this.mountActive = true;
    this.scheduleOpen = true;
    this.leaseActive = true;
    this.eligibleSince = null;
  }

  apply(kind, serverReceivedAt) {
    if (!Number.isSafeInteger(serverReceivedAt) || serverReceivedAt < 0) {
      throw new TypeError("serverReceivedAt must be a non-negative integer");
    }
    switch (kind) {
      case "eligible_activity":
        this.currentEligible = true;
        break;
      case "non_eligible_activity":
        this.currentEligible = false;
        break;
      case "stats_opt_in":
        this.statsOptIn = true;
        break;
      case "stats_opt_out":
        this.statsOptIn = false;
        break;
      case "mount_activated":
        this.mountActive = true;
        break;
      case "mount_deactivated":
        this.mountActive = false;
        break;
      case "schedule_window_opened":
        this.scheduleOpen = true;
        break;
      case "schedule_window_closed":
        this.scheduleOpen = false;
        break;
      case "lease_renewed":
        this.leaseActive = true;
        break;
      case "lease_expired":
        this.leaseActive = false;
        break;
      case "boot_replaced":
        this.leaseActive = false;
        break;
      case "schedule_version_changed":
        this.eligibleSince = null;
        break;
      case "presence_visible_changed":
      case "poster_opt_in_changed":
        return this.eligibleSince;
      default:
        throw new TypeError(`unknown interval event: ${kind}`);
    }

    if (
      this.currentEligible &&
      this.statsOptIn &&
      this.mountActive &&
      this.scheduleOpen &&
      this.leaseActive
    ) {
      this.eligibleSince ??= serverReceivedAt;
    } else {
      this.eligibleSince = null;
    }
    return this.eligibleSince;
  }
}
