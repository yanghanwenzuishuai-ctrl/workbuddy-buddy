import { randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import type { QueryResultRow } from "pg";

import type { DatabaseClient } from "../../../platform/db/pool.js";

interface OfficeTimezoneRow extends QueryResultRow {
  timezone: string;
}

interface ScheduleVersionRow extends QueryResultRow {
  id: string;
  timezone: string;
}

interface ScheduleRuleRow extends QueryResultRow {
  id: string;
  start_local_time: string;
  end_local_time: string;
  end_day_offset: number;
}

export interface MaterializedOccurrence {
  officeLocalDate: string;
  startsAt: Date;
  endsAt: Date;
}

export function occurrenceForRule(
  timezone: string,
  officeLocalDate: string,
  startLocalTime: string,
  endLocalTime: string,
  endDayOffset: 0 | 1,
): MaterializedOccurrence {
  const date = Temporal.PlainDate.from(officeLocalDate);
  const start = resolveLocalBoundary(
    timezone,
    date,
    Temporal.PlainTime.from(startLocalTime),
    "start",
  );
  const end = resolveLocalBoundary(
    timezone,
    date.add({ days: endDayOffset }),
    Temporal.PlainTime.from(endLocalTime),
    "end",
  );
  if (Temporal.ZonedDateTime.compare(end, start) <= 0) {
    throw new Error("A schedule occurrence must have a positive duration");
  }
  return {
    officeLocalDate: date.toString(),
    startsAt: new Date(Number(start.epochMilliseconds)),
    endsAt: new Date(Number(end.epochMilliseconds)),
  };
}

export async function ensureScheduleOccurrencesAround(
  client: DatabaseClient,
  officeId: string,
  at: Date,
): Promise<void> {
  const officeResult = await client.query<OfficeTimezoneRow>(
    `SELECT timezone
       FROM control_plane.offices
      WHERE id = $1`,
    [officeId],
  );
  const timezone = officeResult.rows[0]?.timezone;
  if (timezone === undefined) {
    throw new Error("Office disappeared while materializing its schedule");
  }
  const localNow = Temporal.Instant.from(at.toISOString()).toZonedDateTimeISO(
    timezone,
  );
  const localDates = [
    localNow.toPlainDate().subtract({ days: 1 }),
    localNow.toPlainDate(),
  ];

  for (const localDate of localDates) {
    const dateText = localDate.toString();
    const versionResult = await client.query<ScheduleVersionRow>(
      `SELECT id, timezone
         FROM control_plane.office_schedule_versions
        WHERE office_id = $1
          AND effective_from_local_date <= $2::date
        ORDER BY effective_from_local_date DESC, version DESC
        LIMIT 1`,
      [officeId, dateText],
    );
    const version = versionResult.rows[0];
    if (version === undefined) continue;

    const rules = await client.query<ScheduleRuleRow>(
      `SELECT id, start_local_time::text, end_local_time::text,
              end_day_offset
         FROM control_plane.office_schedule_rules
        WHERE office_id = $1
          AND schedule_version_id = $2
          AND iso_weekday = $3
        ORDER BY start_local_time, id`,
      [officeId, version.id, localDate.dayOfWeek],
    );
    for (const rule of rules.rows) {
      const offset = rule.end_day_offset;
      if (offset !== 0 && offset !== 1) {
        throw new Error("Invalid persisted schedule day offset");
      }
      const occurrence = occurrenceForRule(
        version.timezone,
        dateText,
        rule.start_local_time,
        rule.end_local_time,
        offset,
      );
      await client.query(
        `INSERT INTO control_plane.office_schedule_occurrences (
           id, office_id, schedule_version_id, schedule_rule_id,
           office_local_date, starts_at, ends_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (schedule_rule_id, office_local_date) DO NOTHING`,
        [
          randomUUID(),
          officeId,
          version.id,
          rule.id,
          occurrence.officeLocalDate,
          occurrence.startsAt,
          occurrence.endsAt,
        ],
      );
    }
  }
}

function resolveLocalBoundary(
  timezone: string,
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  boundary: "start" | "end",
): Temporal.ZonedDateTime {
  const fields = {
    timeZone: timezone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
    millisecond: time.millisecond,
    microsecond: time.microsecond,
    nanosecond: time.nanosecond,
  };
  const requested = date.toPlainDateTime(time);
  const earlier = Temporal.ZonedDateTime.from(fields, {
    disambiguation: "earlier",
  });
  const later = Temporal.ZonedDateTime.from(fields, {
    disambiguation: "later",
  });
  const isAmbiguous =
    earlier.epochNanoseconds !== later.epochNanoseconds &&
    earlier.toPlainDateTime().equals(requested) &&
    later.toPlainDateTime().equals(requested);
  if (isAmbiguous) return boundary === "start" ? earlier : later;
  return Temporal.ZonedDateTime.from(fields, {
    disambiguation: "compatible",
  });
}
