export function planOfficeStream({
  lastEventId,
  afterRevision,
  currentRevision,
  minimumReplayCursor,
  retainedRevisions,
}) {
  if (
    lastEventId !== undefined &&
    afterRevision !== undefined &&
    lastEventId !== afterRevision
  ) {
    return { opened: false, problem: "invalid_request", events: [] };
  }
  const cursor = lastEventId ?? afterRevision ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return { opened: false, problem: "invalid_request", events: [] };
  }
  if (
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 0 ||
    !Number.isSafeInteger(minimumReplayCursor) ||
    minimumReplayCursor < 0 ||
    minimumReplayCursor > currentRevision
  ) {
    throw new TypeError("invalid server revision bounds");
  }
  if (cursor > currentRevision) {
    return { opened: false, problem: "invalid_request", events: [] };
  }
  if (cursor < minimumReplayCursor) {
    return { opened: false, problem: "revision_gap", events: [] };
  }

  const revisions = [...new Set(retainedRevisions)].sort((a, b) => a - b);
  const firstAfterCursor = revisions.find((revision) => revision > cursor);
  if (cursor < currentRevision && firstAfterCursor === undefined) {
    return { opened: false, problem: "revision_gap", events: [] };
  }

  const events = [];
  let expected = cursor + 1;
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError("retained revisions must be non-negative integers");
    }
    if (revision > currentRevision) {
      throw new TypeError("retained revision exceeds current revision");
    }
    if (revision <= cursor) continue;
    if (revision !== expected) {
      events.push({ event: "resync.required", reason: "revision_gap" });
      return { opened: true, closed: true, problem: null, events };
    }
    events.push({ event: "office.snapshot", id: revision });
    expected += 1;
  }
  return { opened: true, closed: false, problem: null, events };
}
