import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db.ts";
import { parseEventScope } from "./time.ts";
import { visitorSummary } from "./visitors.ts";
import { GAP_MS, projectedIncrement, projectionSummary, startProjection, stopProjection, touchProjection } from "./projection.ts";

const OPEN = parseEventScope(null, null);
const MIN = 60_000;
const H = 60 * MIN;

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

/** UTC epoch ms for an IST wall-clock time. */
function ist(y: number, mo: number, d: number, h: number, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi) - 330 * MIN;
}

/** Simulates the system running from `from` to `to`: a dashboard poll every 30 s. */
function runAlive(db: DatabaseSync, from: number, to: number) {
  for (let t = from; t <= to; t += 30_000) touchProjection(db, t);
  touchProjection(db, to);
}

const T0 = ist(2026, 11, 14, 10, 0);
const additionalToday = (db: DatabaseSync, now: number) => projectionSummary(db, now, OPEN).additionalToday;

test("formula: floor(elapsed x 1000 / 60 min), cumulative", () => {
  const cases: [number, number][] = [[0, 0], [1, 16], [10, 166], [20, 333], [30, 500], [45, 750], [60, 1000], [120, 2000], [540, 9000]];
  for (const [minutes, extra] of cases) assert.equal(projectedIncrement(minutes * MIN), extra, `${minutes} min`);
  assert.equal(projectedIncrement(3_999), 0); // whole seconds: 3 s -> 0.83 -> 0
  assert.equal(projectedIncrement(4_000), 1); // first projected visitor after 4 s
  assert.equal(projectedIncrement(-5000), 0);
});

test("no session: nothing is projected", () => {
  const db = memoryDb();
  runAlive(db, T0, T0 + H);
  const s = projectionSummary(db, T0 + H, OPEN);
  assert.deepEqual([s.active, s.additionalToday, s.additionalTotal], [false, 0, 0]);
});

test("increases gradually, 1,000 after one active hour and 2,000 after two", () => {
  const db = memoryDb();
  startProjection(db, T0);
  const seen: number[] = [];
  for (const m of [1, 10, 20, 30, 45, 60, 90, 120]) {
    runAlive(db, T0 + (m === 1 ? 0 : 0), T0 + m * MIN);
    seen.push(additionalToday(db, T0 + m * MIN));
  }
  assert.deepEqual(seen, [16, 166, 333, 500, 750, 1000, 1500, 2000]);
  // Never a jump: between consecutive 30 s polls it grows by at most 9.
  const db2 = memoryDb();
  startProjection(db2, T0);
  let prev = 0;
  for (let t = T0; t <= T0 + H; t += 30_000) {
    touchProjection(db2, t);
    const v = additionalToday(db2, t);
    assert.ok(v - prev >= 0 && v - prev <= 9, `step ${v - prev}`);
    prev = v;
  }
  assert.equal(prev, 1000);
});

test("start is idempotent; stop keeps what accrued and stops accruing", () => {
  const db = memoryDb();
  startProjection(db, T0);
  runAlive(db, T0, T0 + 30 * MIN);
  startProjection(db, T0 + 30 * MIN); // already active: no new session, no reset
  assert.equal(additionalToday(db, T0 + 30 * MIN), 500);
  stopProjection(db, T0 + 30 * MIN);
  runAlive(db, T0 + 30 * MIN, T0 + 3 * H);
  const s = projectionSummary(db, T0 + 3 * H, OPEN);
  assert.deepEqual([s.active, s.additionalToday], [false, 500]);
  stopProjection(db, T0 + 3 * H); // no-op
  startProjection(db, T0 + 3 * H);
  runAlive(db, T0 + 3 * H, T0 + 3 * H + 30 * MIN);
  assert.equal(additionalToday(db, T0 + 3 * H + 30 * MIN), 1000);
});

test("restart does not reset or double-count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projection-test-"));
  const file = path.join(dir, "entries.db");
  try {
    let db = new DatabaseSync(file);
    initSchema(db);
    startProjection(db, T0);
    runAlive(db, T0, T0 + 30 * MIN);
    const before = projectionSummary(db, T0 + 30 * MIN, OPEN);
    db.close();

    // Restart within a minute: the session continues where it was.
    db = new DatabaseSync(file);
    initSchema(db);
    const after = projectionSummary(db, T0 + 30 * MIN, OPEN);
    assert.deepEqual([before.additionalToday, after.additionalToday, after.active], [500, 500, true]);
    runAlive(db, T0 + 31 * MIN, T0 + 60 * MIN);
    assert.equal(additionalToday(db, T0 + 60 * MIN), 1000);
    // Recomputing again never adds more.
    assert.equal(additionalToday(db, T0 + 60 * MIN), 1000);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projection does not increase while the system is stopped", () => {
  const db = memoryDb();
  startProjection(db, T0);
  runAlive(db, T0, T0 + 30 * MIN); // running 30 min
  // System down for 2 hours: no polls, no heartbeats.
  const down = projectionSummary(db, T0 + 2 * H, OPEN);
  assert.deepEqual([down.additionalToday, down.active], [500, false]);
  // Back up: accrues again from the restart, the gap is excluded.
  runAlive(db, T0 + 2 * H + 30 * MIN, T0 + 3 * H);
  assert.equal(additionalToday(db, T0 + 3 * H), 1000);
  assert.ok(GAP_MS <= 2 * MIN);
});

test("IST midnight resets today's projection; total keeps both days", () => {
  const db = memoryDb();
  const start = ist(2026, 11, 14, 23, 30);
  startProjection(db, start);
  runAlive(db, start, start + H); // 23:30 -> 00:30 IST
  const s = projectionSummary(db, start + H, OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal], [500, 1000]);
  const before = projectionSummary(db, start + 29 * MIN, OPEN);
  assert.equal(before.additionalToday, 483);
});

test("total accumulates across days and respects the event scope", () => {
  const db = memoryDb();
  for (const d of [13, 14, 15]) {
    const s = ist(2026, 11, d, 10, 0);
    startProjection(db, s);
    runAlive(db, s, s + 2 * H);
    stopProjection(db, s + 2 * H);
  }
  const now = ist(2026, 11, 15, 18, 0);
  assert.equal(projectionSummary(db, now, OPEN).additionalTotal, 6000);
  assert.equal(projectionSummary(db, now, OPEN).additionalToday, 2000);
  assert.equal(projectionSummary(db, now, parseEventScope("2026-11-14", null)).additionalTotal, 4000);
});

test("actual camera counts are untouched: no rows written to entries", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO entries (id, occurred_at, track_id, received_at, camera) VALUES (?, ?, ?, ?, ?)").run("real-entry-0001", T0, 1, T0, "A");
  startProjection(db, T0);
  runAlive(db, T0, T0 + 2 * H);
  const actual = visitorSummary(db, T0 + 2 * H, OPEN);
  assert.deepEqual([actual.todayVisitors, actual.totalVisitors], [1, 1]);
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  assert.equal(rows, 1);
  assert.equal(additionalToday(db, T0 + 2 * H), 2000);
});
