// Calendar-day and timestamp helpers for visitor counting.
//
// All instants are epoch milliseconds (UTC). Calendar days are always worked out
// in an explicit IANA timezone (the event runs on India Standard Time), never in
// the timezone of the Windows machine the server happens to run on.
//
// This file has no Next.js or database imports so it can be unit tested with
// `node --test`.

export const EVENT_TIMEZONE = "Asia/Kolkata";

/** Newest an event may be relative to the server clock (see README: clock-skew policy). */
export const MAX_FUTURE_SKEW_MS = 60_000;
/** Oldest an event may be when it reaches the API (covers the worker's retry queue). */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

// Widest range a JavaScript Date can represent; used as "no limit" in range queries.
export const MIN_TIME_MS = -8.64e15;
export const MAX_TIME_MS = 8.64e15;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// ISO 8601 with an explicit UTC offset. A timestamp without "Z" or "+hh:mm" would be
// read in the server's local timezone, so it is rejected instead of guessed.
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** True for a real calendar date written as "YYYY-MM-DD" (rejects e.g. 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  return m !== null && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

function ymd(date: string): [number, number, number] {
  if (!isCalendarDate(date)) throw new Error(`Invalid date ${JSON.stringify(date)}; expected YYYY-MM-DD`);
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

/** "YYYY-MM-DD" shifted by `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedFields(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  const out: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds (IST is +5:30 = 19,800,000). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const f = zonedFields(ms, timeZone);
  const wallClockAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return wallClockAsUtc - Math.floor(ms / 1000) * 1000;
}

/** Calendar date ("YYYY-MM-DD") that instant `ms` falls on in `timeZone`. */
export function zonedDate(ms: number, timeZone: string = EVENT_TIMEZONE): string {
  const f = zonedFields(ms, timeZone);
  return `${String(f.year).padStart(4, "0")}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
}

/** UTC instant (epoch ms) of 00:00 on `date` in `timeZone`. */
export function zonedDayStartUtc(date: string, timeZone: string = EVENT_TIMEZONE): number {
  const [y, m, d] = ymd(date);
  const midnightAsUtc = Date.UTC(y, m - 1, d);
  // Two passes so zones whose offset changes around midnight (DST) land on the right
  // instant. Asia/Kolkata has a fixed offset, so both passes agree there.
  const guess = midnightAsUtc - zoneOffsetMs(midnightAsUtc, timeZone);
  return midnightAsUtc - zoneOffsetMs(guess, timeZone);
}

/** Half-open UTC range [start, end) covering calendar day `date` in `timeZone`. */
export function dayRangeUtc(date: string, timeZone: string = EVENT_TIMEZONE): { start: number; end: number } {
  return { start: zonedDayStartUtc(date, timeZone), end: zonedDayStartUtc(addDays(date, 1), timeZone) };
}

/**
 * Strictly parses an ISO 8601 timestamp that carries an explicit offset
 * ("2026-11-13T18:29:59.123Z" or "...+05:30"). Returns epoch ms, or null when the
 * text is not such a timestamp or names an impossible date/time.
 */
export function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (!isValidYmd(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  const millis = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;

  let offsetMinutes = 0;
  if (m[8] !== "Z") {
    const sign = m[8][0] === "-" ? -1 : 1;
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 14 || om > 59) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, millis) - offsetMinutes * 60_000;
}

/**
 * Clock-skew policy for an entry timestamp reported by the worker. Returns null when
 * acceptable, otherwise the reason it is rejected.
 */
export function checkEventTime(occurredMs: number, receivedMs: number): string | null {
  if (occurredMs > receivedMs + MAX_FUTURE_SKEW_MS) {
    return `occurredAt is ${Math.round((occurredMs - receivedMs) / 1000)}s ahead of the server clock (limit ${MAX_FUTURE_SKEW_MS / 1000}s)`;
  }
  if (occurredMs < receivedMs - MAX_EVENT_AGE_MS) {
    return `occurredAt is older than ${MAX_EVENT_AGE_MS / 3_600_000}h`;
  }
  return null;
}

export type EventScope = {
  /** First event day (inclusive), or null for no lower limit. */
  startDate: string | null;
  /** Last event day (inclusive), or null for no upper limit. */
  endDate: string | null;
  /** Half-open UTC range [startMs, endMs) that Total Visitors counts. */
  startMs: number;
  endMs: number;
};

/**
 * Event period used for Total Visitors, from optional "YYYY-MM-DD" day strings in the
 * event timezone. Throws on malformed input so a typo cannot silently change totals.
 */
export function parseEventScope(
  startDate: string | undefined | null,
  endDate: string | undefined | null,
  timeZone: string = EVENT_TIMEZONE,
): EventScope {
  const start = startDate?.trim() || null;
  const end = endDate?.trim() || null;
  if (start !== null && !isCalendarDate(start)) throw new Error(`EVENT_START_DATE must be YYYY-MM-DD, got ${JSON.stringify(start)}`);
  if (end !== null && !isCalendarDate(end)) throw new Error(`EVENT_END_DATE must be YYYY-MM-DD, got ${JSON.stringify(end)}`);
  if (start !== null && end !== null && end < start) throw new Error("EVENT_END_DATE is before EVENT_START_DATE");
  return {
    startDate: start,
    endDate: end,
    startMs: start === null ? MIN_TIME_MS : zonedDayStartUtc(start, timeZone),
    endMs: end === null ? MAX_TIME_MS : zonedDayStartUtc(addDays(end, 1), timeZone),
  };
}
