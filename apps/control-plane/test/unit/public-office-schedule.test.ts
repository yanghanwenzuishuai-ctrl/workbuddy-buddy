import assert from "node:assert/strict";
import test from "node:test";

import { occurrenceForRule } from "../../src/modules/public-office/domain/schedule.js";

test("cross-midnight occurrences belong to their local start date", () => {
  const occurrence = occurrenceForRule(
    "Asia/Shanghai",
    "2026-07-24",
    "22:00:00",
    "02:00:00",
    1,
  );
  assert.equal(occurrence.officeLocalDate, "2026-07-24");
  assert.equal(occurrence.startsAt.toISOString(), "2026-07-24T14:00:00.000Z");
  assert.equal(occurrence.endsAt.toISOString(), "2026-07-24T18:00:00.000Z");
});

test("DST spring-forward uses actual elapsed UTC seconds", () => {
  const occurrence = occurrenceForRule(
    "America/Los_Angeles",
    "2026-03-08",
    "01:30:00",
    "03:30:00",
    0,
  );
  assert.equal(
    occurrence.endsAt.getTime() - occurrence.startsAt.getTime(),
    60 * 60 * 1_000,
  );
});

test("ambiguous DST starts choose earlier and ends choose later", () => {
  const occurrence = occurrenceForRule(
    "America/Los_Angeles",
    "2026-11-01",
    "01:30:00",
    "01:45:00",
    0,
  );
  assert.equal(
    occurrence.endsAt.getTime() - occurrence.startsAt.getTime(),
    75 * 60 * 1_000,
  );
});

test("nonexistent local times move forward compatibly", () => {
  const occurrence = occurrenceForRule(
    "America/Los_Angeles",
    "2026-03-08",
    "02:30:00",
    "03:45:00",
    0,
  );
  assert.equal(
    occurrence.endsAt.getTime() - occurrence.startsAt.getTime(),
    15 * 60 * 1_000,
  );
});
