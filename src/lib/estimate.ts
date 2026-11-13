// Hourly-adjusted visitor ESTIMATE, derived from the stored raw entries.
//
// Raw counts (todayVisitors / totalVisitors) remain the source of truth. This module
// never writes to the database: every number is recomputed from event timestamps on
// each call, so restarts, midnight and late events need no special state and a window
// can never be deducted twice.
//
// Per IST day:
//   1. Entries ranked 1..1,000 by timestamp are counted as-is.
//   2. The 1,000th entry's timestamp T activates the adjustment. From T, the rest of the
//      day is cut into consecutive one-hour windows [T, T+1h), [T+1h, T+2h), ... with the
//      last one ending at IST midnight.
//   3. Each COMPLETED window with N entries (excluding the first 1,000) contributes
//      N - floor(N * rate(N)); the window still in progress contributes N unadjusted
//      until it closes (so the estimate can drop by the deduction when a window closes).
// Total estimate = sum of the daily estimates over the event scope.
import type { DatabaseSync } from "node:sqlite";
import { EVENT_TIMEZONE, MAX_EVENT_AGE_MS, addDays, dayRangeUtc, zonedDate, type EventScope } from "./time.ts";

export const DAILY_THRESHOLD = 1000;
export const WINDOW_MS = 60 * 60 * 1000;

/** Adjustment rate for a window with `n` entries, in basis points (500 = 5%). Capped at 25%. */
export function adjustmentRateBp(n: number): number {
  if (n <= 0) return 0;
  if (n < 1000) return 500;
  if (n < 1500) return 1000;
  if (n < 2000) return 1500;
  if (n < 2500) return 2000;
  return 2500;
}

/** Deduction for a window with `n` entries: floor(n * rate), in exact integer arithmetic. */
export function windowDeduction(n: number): number {
  return Math.floor((n * adjustmentRateBp(n)) / 10_000);
}

export type AdjustmentWindow = {
  start: number;
  end: number;
  /** Raw entries in the window, excluding those among the day's first 1,000. */
  raw: number;
  rateBp: number;
  /** Applied only once the window has closed; 0 while it is in progress. */
  deduction: number;
  adjusted: number;
  complete: boolean;
};

export type DayEstimate = {
  date: string;
  raw: number;
  estimated: number;
  /** Timestamp of the day's 1,000th entry, or null if the threshold was not reached. */
  activatedAt: number | null;
  windows: AdjustmentWindow[];
};

const COUNT_SQL = "SELECT COUNT(*) AS n FROM entries WHERE occurred_at >= ? AND occurred_at < ?";
// Timestamp of the k-th entry of a range, walking idx_entries_occurred_at.
const NTH_SQL = "SELECT occurred_at AS t FROM entries WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at LIMIT 1 OFFSET ?";

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

function count(db: DatabaseSync, start: number, end: number): number {
  return num((db.prepare(COUNT_SQL).get(start, end) as { n: unknown }).n);
}

/** Raw count and adjusted estimate for one IST calendar day, as of `nowMs`. */
export function estimateDay(db: DatabaseSync, date: string, nowMs: number, timeZone: string = EVENT_TIMEZONE): DayEstimate {
  const day = dayRangeUtc(date, timeZone);
  const raw = count(db, day.start, day.end);
  if (raw < DAILY_THRESHOLD) return { date, raw, estimated: raw, activatedAt: null, windows: [] };

  const row = db.prepare(NTH_SQL).get(day.start, day.end, DAILY_THRESHOLD - 1) as { t: unknown };
  const activatedAt = num(row.t);
  // Several entries can share the activation millisecond; those ranked within the first
  // 1,000 are part of the threshold, the rest belong to the first window.
  const thresholdAtT = DAILY_THRESHOLD - count(db, day.start, activatedAt);

  const windows: AdjustmentWindow[] = [];
  let estimated = DAILY_THRESHOLD;
  for (let start = activatedAt, first = true; start < day.end; start += WINDOW_MS, first = false) {
    const end = Math.min(start + WINDOW_MS, day.end);
    const n = count(db, start, end) - (first ? thresholdAtT : 0);
    if (start > nowMs && n === 0) continue; // not started yet and empty: omit from the breakdown
    const complete = end <= nowMs;
    const rateBp = adjustmentRateBp(n);
    const deduction = complete ? windowDeduction(n) : 0;
    windows.push({ start, end, raw: n, rateBp, deduction, adjusted: n - deduction, complete });
    estimated += n - deduction;
  }
  return { date, raw, estimated, activatedAt, windows };
}

// Estimates of SEALED days, per database connection. A day is sealed once it ended more
// than MAX_EVENT_AGE_MS ago: the events API rejects anything older, so no entry can be
// added to it any more and all its windows are complete. This is only a speed-up; after
// a restart the cache is empty and the same values are recomputed from SQLite.
const sealedCache = new WeakMap<DatabaseSync, Map<string, number>>();

function dayEstimateCached(db: DatabaseSync, date: string, nowMs: number, timeZone: string): number {
  const sealed = dayRangeUtc(date, timeZone).end + MAX_EVENT_AGE_MS <= nowMs;
  if (!sealed) return estimateDay(db, date, nowMs, timeZone).estimated;
  let cache = sealedCache.get(db);
  if (!cache) sealedCache.set(db, (cache = new Map()));
  const key = `${timeZone}|${date}`;
  let value = cache.get(key);
  if (value === undefined) cache.set(key, (value = estimateDay(db, date, nowMs, timeZone).estimated));
  return value;
}

export type EstimateSummary = {
  estimatedTodayVisitors: number;
  estimatedTotalVisitors: number;
};

/**
 * Estimated visitors for the current IST day and summed over every IST day inside the
 * event scope (each day applies its own 1,000-entry threshold).
 */
export function estimateSummary(
  db: DatabaseSync,
  nowMs: number,
  scope: EventScope,
  timeZone: string = EVENT_TIMEZONE,
): EstimateSummary {
  const today = zonedDate(nowMs, timeZone);
  const estimatedTodayVisitors = estimateDay(db, today, nowMs, timeZone).estimated;

  // Separate MIN and MAX queries: each is a single index seek (combined, SQLite scans the range).
  const lo = (db.prepare("SELECT MIN(occurred_at) AS t FROM entries WHERE occurred_at >= ? AND occurred_at < ?").get(scope.startMs, scope.endMs) as { t: unknown }).t;
  const hi = (db.prepare("SELECT MAX(occurred_at) AS t FROM entries WHERE occurred_at >= ? AND occurred_at < ?").get(scope.startMs, scope.endMs) as { t: unknown }).t;
  let estimatedTotalVisitors = 0;
  if (lo != null && hi != null) {
    const last = zonedDate(num(hi), timeZone);
    for (let date = zonedDate(num(lo), timeZone); date <= last; date = addDays(date, 1)) {
      estimatedTotalVisitors += date === today ? estimatedTodayVisitors : dayEstimateCached(db, date, nowMs, timeZone);
    }
  }
  return { estimatedTodayVisitors, estimatedTotalVisitors };
}
