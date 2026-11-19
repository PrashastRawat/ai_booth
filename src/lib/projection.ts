// Hourly attendance PROJECTION: a synthetic figure added on top of the actual camera
// counts, never mixed with them.
//
//   additional visitors for a day = floor(activeSeconds that day x 2000 / 3600)
//
// i.e. 2,000 per hour of active projection session, accruing smoothly (about 33.3 per
// minute) rather than in hourly jumps. Nothing is written to the `entries` table.
//
// Sessions are AUTOMATIC: the first dashboard poll or worker heartbeat opens one, and
// every later poll/heartbeat "touches" it. Active time is stored as segments in SQLite,
// so restarts neither reset nor double-count it. So that nothing accrues while the
// system is shut down (no open dashboard and no running worker), a session that was not
// touched for GAP_MS is treated as stopped at the last moment the system was seen
// alive; the next touch excludes the gap and resumes in a new segment.
import type { DatabaseSync } from "node:sqlite";
import { EVENT_TIMEZONE, addDays, dayRangeUtc, zonedDate, type EventScope } from "./time.ts";

export const PER_HOUR = 2000;
/** Longer than this without any poll or heartbeat counts as "system stopped". */
export const GAP_MS = 2 * 60 * 1000;
/** last_seen_at is written at most this often (reads still use the real gap). */
const TOUCH_WRITE_MS = 10 * 1000;

export function initProjectionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_segments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,             -- epoch ms (UTC) the active period began
      ended_at   INTEGER                       -- epoch ms it ended; NULL while active
    );
    CREATE TABLE IF NOT EXISTS projection_state (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at INTEGER NOT NULL            -- last poll/heartbeat while a session was active
    );
  `);
}

/** Additional projected visitors for `activeMs` of active session time. */
export function projectedIncrement(activeMs: number): number {
  const seconds = Math.floor(Math.max(0, activeMs) / 1000);
  return Math.floor((seconds * PER_HOUR) / 3600);
}

type Segment = { id: number; start: number; end: number | null };

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

function openSegment(db: DatabaseSync): Segment | null {
  const r = db.prepare("SELECT id, started_at, ended_at FROM projection_segments WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as
    | { id: unknown; started_at: unknown; ended_at: unknown }
    | undefined;
  return r ? { id: num(r.id), start: num(r.started_at), end: null } : null;
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
 */
export function touchProjection(db: DatabaseSync, nowMs: number): void {
  const open = openSegment(db);
  // Most worker heartbeats need no write. Delayed requests must not move the
  // persisted activity timestamp backwards either.
  if (open && nowMs - (lastSeen(db) ?? open.start) < TOUCH_WRITE_MS) return;

  // Lock BEFORE checking for an open session: Next.js processes/connections can
  // race even though DatabaseSync calls within a single process are synchronous.
  // Re-read after acquiring the lock so a competing request cannot start a second
  // session, or resume the same stale session twice.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = openSegment(db);
    const seen = current ? lastSeen(db) ?? current.start : null;
    if (!current) {
      db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, NULL)").run(nowMs);
      setLastSeen(db, nowMs);
    } else if (seen !== null && nowMs - seen > GAP_MS) {
      db.prepare("UPDATE projection_segments SET ended_at = ? WHERE id = ?").run(Math.max(seen, current.start), current.id);
      db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, NULL)").run(nowMs);
      setLastSeen(db, nowMs);
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
  const rows = db.prepare("SELECT id, started_at, ended_at FROM projection_segments ORDER BY started_at").all() as {
    id: unknown;
    started_at: unknown;
    ended_at: unknown;
  }[];
  const seen = lastSeen(db);
  return rows.map((r) => {
    const start = num(r.started_at);
    let end: number;
    if (r.ended_at != null) end = num(r.ended_at);
    else end = nowMs - (seen ?? start) > GAP_MS ? Math.max(seen ?? start, start) : nowMs;
    return { id: num(r.id), start, end: Math.max(start, end) };
  });
}

/** Active session milliseconds per IST day, for time inside [fromMs, toMs). */
function activeMsByDay(segs: Segment[], fromMs: number, toMs: number, timeZone: string): Map<string, number> {
  // Clip to the range and merge overlaps so no instant is ever counted twice.
  const clipped = segs
    .map((s) => ({ start: Math.max(s.start, fromMs), end: Math.min(s.end ?? fromMs, toMs) }))
    .filter((s) => s.end > s.start)
    .sort((x, y) => x.start - y.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const byDay = new Map<string, number>();
  for (const s of merged) {
    const a = s.start;
    const b = s.end;
    for (let date = zonedDate(a, timeZone); ; date = addDays(date, 1)) {
      const day = dayRangeUtc(date, timeZone);
      const overlap = Math.min(b, day.end) - Math.max(a, day.start);
      if (overlap > 0) byDay.set(date, (byDay.get(date) ?? 0) + overlap);
      if (day.end >= b) break;
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

  const todayMs = activeMsByDay(segs, day.start, Math.min(day.end, nowMs), timeZone).get(today) ?? 0;
  let additionalTotal = 0;
  for (const ms of activeMsByDay(segs, scope.startMs, Math.min(scope.endMs, nowMs), timeZone).values()) {
    additionalTotal += projectedIncrement(ms);
  }
  return {
    active: open !== null && !stale,
    activeSince: open && !stale ? open.start : null,
    activeTodayMs: todayMs,
    additionalToday: projectedIncrement(todayMs),
    additionalTotal,
  };
}
