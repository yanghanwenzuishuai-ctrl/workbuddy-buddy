function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function projectByConsent(mounts, dailyAwardWinnerId = null) {
  const active = mounts.filter((mount) => mount.active);
  const statsVisible = active.filter((mount) => mount.stats_opt_in);
  return {
    agents: active
      .filter((mount) => mount.presence_visible)
      .map((mount) => mount.mount_id),
    leaderboard: statsVisible.map((mount) => mount.mount_id),
    daily_award:
      dailyAwardWinnerId !== null &&
      statsVisible.some((mount) => mount.mount_id === dailyAwardWinnerId)
        ? dailyAwardWinnerId
        : null,
    poster_live_scene: active
      .filter((mount) => mount.presence_visible && mount.poster_opt_in)
      .map((mount) => mount.mount_id),
    poster_statistics: active
      .filter((mount) => mount.stats_opt_in && mount.poster_opt_in)
      .map((mount) => mount.mount_id),
  };
}

export function withdrawConsent(snapshot, mountId, consentField) {
  if (
    !["presence_visible", "stats_opt_in", "poster_opt_in"].includes(
      consentField,
    )
  ) {
    throw new TypeError(`unknown consent field: ${consentField}`);
  }
  const next = copy(snapshot);
  const mount = next.mounts.find((candidate) => candidate.mount_id === mountId);
  if (!mount) throw new TypeError(`unknown mount: ${mountId}`);
  if (mount[consentField] === false) return next;

  mount[consentField] = false;
  next.office_revision += 1;
  next.projection = projectByConsent(
    next.mounts,
    next.daily_award_winner_id ?? null,
  );
  return next;
}
