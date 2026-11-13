// Recording and counting visitor entries. Every count is a query over the stored
// rows in `entries`; nothing is ever reset or deleted, so a new IST day simply
// selects a different time range and restarts cannot change any number.
import type { DatabaseSync } from "node:sqlite";
import {
  EVENT_TIMEZONE,
  MAX_TIME_MS,
  checkEventTime,
  dayRangeUtc,
  addDays,
  parseEventScope,
  parseIsoTimestamp,
  zonedDate,
  type EventScope,
} from "./time.ts";

/**
 * Event period from EVENT_START_DATE / EVENT_END_DATE ("YYYY-MM-DD", IST, inclusive).
 * Either may be unset. Throws if a value is malformed.
 */
export function eventScopeFromEnv(env: Record<string, string | undefined> = process.env): EventScope {
  return parseEventScope(env.EVENT_START_DATE, env.EVENT_END_DATE, EVENT_TIMEZONE);
}

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const CAMERA_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const LAST_WINDOW_MS = 5 * 60 * 1000;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

export type RecordResult =
  | { ok: true; id: string; inserted: boolean; occurredAt: number; date: string }
  | { ok: false; status: 400 | 422; error: string };

/**
 * Validates and stores one entry event from the worker. Idempotent on `id`: a retry
 * of an event that is already stored returns `inserted: false` and changes nothing.
 */
export function recordEntry(
  db: DatabaseSync,
  body: unknown,
  receivedMs: number,
  timeZone: string = EVENT_TIMEZONE,
): RecordResult {
  const b = (body !== null && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const { id, occurredAt, trackId } = b;
  const camera = b.camera ?? "A";

  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return { ok: false, status: 400, error: "id must be a UUID-like string" };
  }
  if (typeof camera !== "string" || !CAMERA_PATTERN.test(camera)) {
    return { ok: false, status: 400, error: "camera must be a short name" };
  }
  if (trackId !== undefined && trackId !== null && !Number.isInteger(trackId)) {
    return { ok: false, status: 400, error: "trackId must be an integer" };
  }
  const occurredMs = parseIsoTimestamp(occurredAt);
  if (occurredMs === null) {
    return {
      ok: false,
      status: 400,
      error: "occurredAt must be an ISO 8601 timestamp with a UTC offset, e.g. 2026-11-13T18:29:59.123Z",
    };
  }

  // A retry of an event we already have is answered before the skew check, so a
  // late retry is acknowledged as a duplicate rather than reported as rejected.
  const existing = db.prepare("SELECT occurred_at FROM entries WHERE id = ?").get(id) as
    | { occurred_at: number | bigint }
    | undefined;
  if (existing) {
    const storedMs = num(existing.occurred_at);
    return { ok: true, id, inserted: false, occurredAt: storedMs, date: zonedDate(storedMs, timeZone) };
  }

  const skewProblem = checkEventTime(occurredMs, receivedMs);
  if (skewProblem) return { ok: false, status: 422, error: skewProblem };

  const result = db
    .prepare("INSERT OR IGNORE INTO entries (id, occurred_at, track_id, received_at, camera) VALUES (?, ?, ?, ?, ?)")
    .run(id, occurredMs, typeof trackId === "number" ? trackId : null, receivedMs, camera);

  return { ok: true, id, inserted: Number(result.changes) === 1, occurredAt: occurredMs, date: zonedDate(occurredMs, timeZone) };
}

// Distinct camera names via a skip-scan of idx_entries_camera_occurred: one index
// seek per camera instead of reading every row.
const CAMERA_NAMES_SQL = `
  WITH RECURSIVE c(name) AS (
    SELECT MIN(camera) FROM entries
    UNION ALL
    SELECT (SELECT MIN(camera) FROM entries WHERE camera > c.name) FROM c WHERE c.name IS NOT NULL
  )
  SELECT name FROM c WHERE name IS NOT NULL`;

const COUNT_SQL = "SELECT COUNT(*) AS n FROM entries WHERE camera = ? AND occurred_at >= ? AND occurred_at < ?";

/** Entries per camera with startMs <= occurred_at < endMs (cameras with none are omitted). */
export function countByCamera(db: DatabaseSync, startMs: number, endMs: number): Map<string, number> {
  const names = db.prepare(CAMERA_NAMES_SQL).all() as { name: string }[];
  const count = db.prepare(COUNT_SQL);
  const counts = new Map<string, number>();
  for (const { name } of names) {
    const n = num((count.get(name, startMs, endMs) as { n: number | bigint }).n);
    if (n > 0) counts.set(String(name), n);
  }
  return counts;
}

function sum(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

export type VisitorSummary = {
  timezone: string;
  /** Current calendar date in `timezone`, "YYYY-MM-DD". */
  date: string;
  todayVisitors: number;
  totalVisitors: number;
  last5Minutes: number;
  lastEntryAt: number | null;
  perCamera: Map<string, { today: number; total: number; last5Minutes: number }>;
};

/**
 * Today's Visitors: entries on the current calendar day in `timeZone`
 * ([00:00, next 00:00) converted to UTC). Total Visitors: entries inside the event scope.
 */
export function visitorSummary(
  db: DatabaseSync,
  nowMs: number,
  scope: EventScope,
  timeZone: string = EVENT_TIMEZONE,
): VisitorSummary {
  const date = zonedDate(nowMs, timeZone);
  const day = dayRangeUtc(date, timeZone);

  const today = countByCamera(db, day.start, day.end);
  const total = countByCamera(db, scope.startMs, scope.endMs);
  const recent = countByCamera(db, nowMs - LAST_WINDOW_MS, MAX_TIME_MS);
  const last = db.prepare("SELECT MAX(occurred_at) AS t FROM entries").get() as { t: number | bigint | null } | undefined;

  const perCamera: VisitorSummary["perCamera"] = new Map();
  for (const name of new Set([...today.keys(), ...total.keys(), ...recent.keys()])) {
    perCamera.set(name, { today: today.get(name) ?? 0, total: total.get(name) ?? 0, last5Minutes: recent.get(name) ?? 0 });
  }

  return {
    timezone: timeZone,
    date,
    todayVisitors: sum(today),
    totalVisitors: sum(total),
    last5Minutes: sum(recent),
    lastEntryAt: last?.t == null ? null : num(last.t),
    perCamera,
  };
}

export type DailyCount = { date: string; visitors: number; cameras: Record<string, number> };

/** Visitors per calendar day (in `timeZone`) for every day from `fromDate` to `toDate` inclusive. */
export function dailyCounts(
  db: DatabaseSync,
  fromDate: string,
  toDate: string,
  timeZone: string = EVENT_TIMEZONE,
): DailyCount[] {
  const days: DailyCount[] = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const { start, end } = dayRangeUtc(date, timeZone);
    const counts = countByCamera(db, start, end);
    days.push({ date, visitors: sum(counts), cameras: Object.fromEntries(counts) });
  }
  return days;
}
