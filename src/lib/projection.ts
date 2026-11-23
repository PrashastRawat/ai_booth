// Attendance PROJECTION: a synthetic figure added on top of the actual camera counts,
// never mixed with them. Nothing is written to the `entries` table.
//
// RATES ARE VERSIONED, FORWARD ONLY. Every activity segment stores the rate it was
// recorded at (rate_visitors per rate_seconds of active time). Changing CURRENT_RATE
// only affects activity recorded after the change; past segments keep their own rate.
// Segments stored before rates were recorded (both rate columns NULL) are valued at
// LEGACY_RATE. This assumes the installed pre-versioning build used 2,000/hour;
// verify that build and database compatibility before deployment.
//
//   additional visitors for a day =
//     floor( sum over rates r of  floor(active ms at r that day / 1000) x r.visitors / r.seconds )
//
// computed with exact integer fractions and floored once per IST day, accruing smoothly
// rather than in hourly jumps. A day made only of legacy segments gives exactly the same
// figure as before versioning: floor(activeSeconds x 2000 / 3600).
//
// Sessions are AUTOMATIC: the first dashboard poll or worker heartbeat opens one, and
// every later poll/heartbeat "touches" it. Active time is stored as segments in SQLite,
// so restarts neither reset nor double-count it. So that nothing accrues while the
// system is shut down (no open dashboard and no running worker), a session that was not
// touched for GAP_MS is treated as stopped at the last moment the system was seen
// alive; the next touch excludes the gap and resumes in a new segment.
import type { DatabaseSync } from "node:sqlite";
import { EVENT_TIMEZONE, addDays, dayRangeUtc, zonedDate, type EventScope } from "./time.ts";

/** Synthetic visitors per active seconds. Both integers, so the arithmetic stays exact. */
export type Rate = { visitors: number; seconds: number };

/** Rate for activity recorded from now on, from PACE_SWITCH_HOUR IST: 6,500 per active hour. */
export const CURRENT_RATE: Rate = { visitors: 6500, seconds: 3600 };

/** Slower rate for activity recorded each day before PACE_SWITCH_HOUR IST: 2,000 per active hour. */
export const EARLY_RATE: Rate = { visitors: 2000, seconds: 3600 };

/** IST hour of day at which new activity switches from EARLY_RATE to CURRENT_RATE (11:00). */
export const PACE_SWITCH_HOUR = 11;

const HOUR_MS = 3_600_000;

/** Rate the schedule assigns to activity at `t`: EARLY_RATE before 11:00 IST, else CURRENT_RATE. */
export function scheduledRate(t: number): Rate {
  return t < dayRangeUtc(zonedDate(t, EVENT_TIMEZONE), EVENT_TIMEZONE).start + PACE_SWITCH_HOUR * HOUR_MS ? EARLY_RATE : CURRENT_RATE;
}

/**
 * Where a segment recorded under the schedule must change rate in (startMs, endMs]:
 * at IST midnight (back to EARLY_RATE) and at 11:00 IST (to CURRENT_RATE).
 */
function scheduleSplits(startMs: number, rate: Rate, endMs: number): { at: number; rate: Rate }[] {
  const splits: { at: number; rate: Rate }[] = [];
  let running = rate;
  for (let date = zonedDate(startMs, EVENT_TIMEZONE); ; date = addDays(date, 1)) {
    const dayStart = dayRangeUtc(date, EVENT_TIMEZONE).start;
    if (dayStart > endMs) break;
    for (const [at, next] of [[dayStart, EARLY_RATE], [dayStart + PACE_SWITCH_HOUR * HOUR_MS, CURRENT_RATE]] as const) {
      if (at > startMs && at <= endMs && !sameRate(next, running)) {
        splits.push({ at, rate: next });
        running = next;
      }
    }
  }
  return splits;
}

/**
 * Assumed rate of segments stored before rates were recorded (rate columns NULL).
 * Historical totals are preserved if that build used 2,000/hour; the exhibition PC's
 * installed rate must be verified separately. Never change this value: it would rewrite history.
 */
export const LEGACY_RATE: Rate = { visitors: 2000, seconds: 3600 };
/** Longer than this without any poll or heartbeat counts as "system stopped". */
export const GAP_MS = 2 * 60 * 1000;
/** last_seen_at is written at most this often (reads still use the real gap). */
const TOUCH_WRITE_MS = 10 * 1000;

export function initProjectionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_segments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    INTEGER NOT NULL,          -- epoch ms (UTC) the active period began
      ended_at      INTEGER,                   -- epoch ms it ended; NULL while active
      rate_visitors INTEGER,                   -- synthetic visitors per rate_seconds; NULL = LEGACY_RATE
      rate_seconds  INTEGER
    );
    CREATE TABLE IF NOT EXISTS projection_state (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at INTEGER NOT NULL            -- last poll/heartbeat while a session was active
    );
  `);
  // Additive migration for databases created before rates were versioned. Existing rows
  // keep NULL (= LEGACY_RATE); nothing is rewritten. Another process may add the column
  // at the same moment, so "duplicate column" is not an error.
  const columns = db.prepare("PRAGMA table_info(projection_segments)").all() as { name: string }[];
  for (const column of ["rate_visitors", "rate_seconds"]) {
    if (columns.some((c) => c.name === column)) continue;
    try {
      db.exec(`ALTER TABLE projection_segments ADD COLUMN ${column} INTEGER`);
    } catch (err) {
      if (!/duplicate column/i.test(String((err as Error).message))) throw err;
    }
  }
}

/** Additional projected visitors for `activeMs` of active session time at one rate. */
export function projectedIncrement(activeMs: number, rate: Rate = CURRENT_RATE): number {
  return dayIncrement([{ rate, ms: activeMs }]);
}

const ZERO = BigInt(0);
const ONE = BigInt(1);

function gcd(a: bigint, b: bigint): bigint {
  while (b !== ZERO) [a, b] = [b, a % b];
  return a < ZERO ? -a : a;
}

/** floor(sum of floor(ms / 1000) x visitors / seconds), using exact integer fractions. */
function dayIncrement(parts: { rate: Rate; ms: number }[]): number {
  let num = ZERO;
  let den = ONE;
  for (const { rate, ms } of parts) {
    const seconds = BigInt(Math.floor(Math.max(0, ms) / 1000));
    const b = BigInt(rate.seconds);
    num = num * b + seconds * BigInt(rate.visitors) * den;
    den = den * b;
    const g = gcd(num, den) || ONE;
    num /= g;
    den /= g;
  }
  return Number(num / den);
}

const rateKey = (r: Rate) => `${r.visitors}/${r.seconds}`;
const sameRate = (a: Rate, b: Rate) => a.visitors === b.visitors && a.seconds === b.seconds;

/** The stored rate of a segment; NULL (rows from before versioning) means LEGACY_RATE. */
function rateOf(visitors: unknown, seconds: unknown): Rate {
  if (visitors == null || seconds == null) return LEGACY_RATE;
  const v = num(visitors);
  const s = num(seconds);
  return v >= 0 && s > 0 ? { visitors: v, seconds: s } : LEGACY_RATE;
}

/**
 * `scheduled`: recorded by this schedule (explicit EARLY_RATE or CURRENT_RATE), so it follows
 * the 11:00 / midnight switches. Unversioned rows and other stored rates never do.
 */
type Segment = { id: number; start: number; end: number | null; rate: Rate; scheduled: boolean };

function segmentOf(r: SegmentRow, end: number | null): Segment {
  const rate = rateOf(r.rate_visitors, r.rate_seconds);
  const versioned = r.rate_visitors != null && r.rate_seconds != null;
  const scheduled = versioned && (sameRate(rate, EARLY_RATE) || sameRate(rate, CURRENT_RATE));
  return { id: num(r.id), start: num(r.started_at), end, rate, scheduled };
}
type SegmentRow = { id: unknown; started_at: unknown; ended_at: unknown; rate_visitors: unknown; rate_seconds: unknown };
const SEGMENT_COLUMNS = "id, started_at, ended_at, rate_visitors, rate_seconds";

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

function openSegment(db: DatabaseSync): Segment | null {
  const r = db
    .prepare(`SELECT ${SEGMENT_COLUMNS} FROM projection_segments WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get() as SegmentRow | undefined;
  return r ? segmentOf(r, null) : null;
}

/** Opens a new active segment at the rate the schedule assigns to `startMs` (or `rate`). */
function insertSegment(db: DatabaseSync, startMs: number, rate: Rate = scheduledRate(startMs)): number {
  const res = db
    .prepare("INSERT INTO projection_segments (started_at, ended_at, rate_visitors, rate_seconds) VALUES (?, NULL, ?, ?)")
    .run(startMs, rate.visitors, rate.seconds);
  return Number(res.lastInsertRowid);
}

/** True when the open segment must change rate at a schedule switch at or before `nowMs`. */
function needsScheduleSplit(open: Segment, nowMs: number): boolean {
  return open.scheduled && scheduleSplits(open.start, open.rate, nowMs).length > 0;
}

function lastSeen(db: DatabaseSync): number | null {
  const r = db.prepare("SELECT last_seen_at FROM projection_state WHERE id = 1").get() as { last_seen_at: unknown } | undefined;
  return r ? num(r.last_seen_at) : null;
}

function setLastSeen(db: DatabaseSync, t: number): void {
  db.prepare(
    "INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
  ).run(t);
}

/**
 * Records that the system is alive at `nowMs`. If the active session was not seen for
 * longer than GAP_MS (system was down), the gap is excluded from active time.
 *
 * A running segment recorded under the schedule is split exactly at 11:00 IST (to
 * CURRENT_RATE) and at IST midnight (back to EARLY_RATE). A running segment recorded
 * at any other rate (unversioned history, or an earlier version's rate: the code was
 * updated while a session was running) is closed here and continues at the scheduled
 * rate, so its own rate applies exactly up to this boundary.
 */
export function touchProjection(db: DatabaseSync, nowMs: number): void {
  const open = openSegment(db);
  // Most worker heartbeats need no write. Delayed requests must not move the
  // persisted activity timestamp backwards either.
  if (open && open.scheduled && !needsScheduleSplit(open, nowMs) && nowMs - (lastSeen(db) ?? open.start) < TOUCH_WRITE_MS) return;

  // Lock BEFORE checking for an open session: Next.js processes/connections can
  // race even though DatabaseSync calls within a single process are synchronous.
  // Re-read after acquiring the lock so a competing request cannot start a second
  // session, or resume the same stale session twice.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = openSegment(db);
    const seen = current ? lastSeen(db) ?? current.start : null;
    if (!current) {
      insertSegment(db, nowMs);
      setLastSeen(db, nowMs);
    } else if (seen !== null && nowMs - seen > GAP_MS) {
      db.prepare("UPDATE projection_segments SET ended_at = ? WHERE id = ?").run(Math.max(seen, current.start), current.id);
      insertSegment(db, nowMs);
      setLastSeen(db, nowMs);
    } else if (needsScheduleSplit(current, nowMs)) {
      // 11:00 or midnight passed during a live session: split exactly at each switch.
      let id = current.id;
      for (const split of scheduleSplits(current.start, current.rate, nowMs)) {
        db.prepare("UPDATE projection_segments SET ended_at = ? WHERE id = ?").run(split.at, id);
        id = insertSegment(db, split.at, split.rate);
      }
      if (seen === null || nowMs > seen) setLastSeen(db, nowMs);
    } else if (!current.scheduled) {
      // Rate boundary inside a live session; never earlier than what is already
      // recorded, so a delayed request cannot move past time to the new rate.
      const boundary = Math.max(nowMs, seen ?? current.start, current.start);
      db.prepare("UPDATE projection_segments SET ended_at = ? WHERE id = ?").run(boundary, current.id);
      insertSegment(db, boundary);
      setLastSeen(db, boundary);
    } else if (seen !== null && nowMs - seen >= TOUCH_WRITE_MS) {
      setLastSeen(db, nowMs);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** All segments with the open one ending at `nowMs`, or at the last time seen if stale. */
function segments(db: DatabaseSync, nowMs: number): Segment[] {
  const rows = db.prepare(`SELECT ${SEGMENT_COLUMNS} FROM projection_segments ORDER BY started_at, id`).all() as SegmentRow[];
  const seen = lastSeen(db);
  return rows.flatMap((r) => {
    const start = num(r.started_at);
    let end: number;
    if (r.ended_at != null) end = num(r.ended_at);
    else end = nowMs - (seen ?? start) > GAP_MS ? Math.max(seen ?? start, start) : nowMs;
    const seg = segmentOf(r, Math.max(start, end));
    if (!seg.scheduled) return [seg];
    // A live segment past 11:00 or midnight is valued as split even before the next
    // touch stores the split (closed segments were already split when stored).
    const pieces: Segment[] = [];
    let piece = seg;
    for (const split of scheduleSplits(seg.start, seg.rate, seg.end ?? seg.start)) {
      pieces.push({ ...piece, end: split.at });
      piece = { ...piece, start: split.at, rate: split.rate };
    }
    pieces.push(piece);
    return pieces;
  });
}

type RatePart = { rate: Rate; ms: number };

/**
 * Active session milliseconds per IST day and per rate, for time inside [fromMs, toMs).
 * Overlapping segments (only possible in corrupted data) are resolved earliest-first, so
 * no instant is ever counted twice, at any rate.
 */
function activeByDay(segs: Segment[], fromMs: number, toMs: number, timeZone: string): Map<string, Map<string, RatePart>> {
  const clipped = segs
    .map((s) => ({ start: Math.max(s.start, fromMs), end: Math.min(s.end ?? fromMs, toMs), rate: s.rate }))
    .filter((s) => s.end > s.start)
    .sort((x, y) => x.start - y.start);
  const pieces: { start: number; end: number; rate: Rate }[] = [];
  let covered = -Infinity;
  for (const s of clipped) {
    const start = Math.max(s.start, covered);
    if (s.end > start) pieces.push({ start, end: s.end, rate: s.rate });
    covered = Math.max(covered, s.end);
  }
  const byDay = new Map<string, Map<string, RatePart>>();
  for (const p of pieces) {
    for (let date = zonedDate(p.start, timeZone); ; date = addDays(date, 1)) {
      const day = dayRangeUtc(date, timeZone);
      const overlap = Math.min(p.end, day.end) - Math.max(p.start, day.start);
      if (overlap > 0) {
        const rates = byDay.get(date) ?? new Map<string, RatePart>();
        const part = rates.get(rateKey(p.rate)) ?? { rate: p.rate, ms: 0 };
        part.ms += overlap;
        rates.set(rateKey(p.rate), part);
        byDay.set(date, rates);
      }
      if (day.end >= p.end) break;
    }
  }
  return byDay;
}

export type ProjectionSummary = {
  active: boolean;
  /** Start of the current active segment, or null when no session is active. */
  activeSince: number | null;
  /** Active session time today (IST), in ms. */
  activeTodayMs: number;
  additionalToday: number;
  additionalTotal: number;
};

/**
 * Additional projected visitors for today and for the event scope. Each IST day is
 * floored separately, so the total is exactly the sum of the daily figures.
 */
export function projectionSummary(
  db: DatabaseSync,
  nowMs: number,
  scope: EventScope,
  timeZone: string = EVENT_TIMEZONE,
): ProjectionSummary {
  const segs = segments(db, nowMs);
  const open = openSegment(db);
  const stale = open !== null && nowMs - (lastSeen(db) ?? open.start) > GAP_MS;
  const today = zonedDate(nowMs, timeZone);
  const day = dayRangeUtc(today, timeZone);

  const todayParts = [...(activeByDay(segs, day.start, Math.min(day.end, nowMs), timeZone).get(today)?.values() ?? [])];
  const todayMs = todayParts.reduce((sum, p) => sum + p.ms, 0);
  let additionalTotal = 0;
  for (const parts of activeByDay(segs, scope.startMs, Math.min(scope.endMs, nowMs), timeZone).values()) {
    additionalTotal += dayIncrement([...parts.values()]);
  }
  return {
    active: open !== null && !stale,
    activeSince: open && !stale ? open.start : null,
    activeTodayMs: todayMs,
    additionalToday: dayIncrement(todayParts),
    additionalTotal,
  };
}
