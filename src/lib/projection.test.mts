import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { initSchema } from "./db.ts";
import { parseEventScope } from "./time.ts";
import { visitorSummary } from "./visitors.ts";
import { GAP_MS, projectedIncrement, projectionSummary, touchProjection } from "./projection.ts";

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

/** Simulates the system running from `from` to `to`: a dashboard poll every 30 s.
 *  The first poll auto-starts the session; there is no manual start. */
function runAlive(db: DatabaseSync, from: number, to: number) {
  for (let t = from; t <= to; t += 30_000) touchProjection(db, t);
  touchProjection(db, to);
}

const T0 = ist(2026, 11, 14, 10, 0);
const additionalToday = (db: DatabaseSync, now: number) => projectionSummary(db, now, OPEN).additionalToday;

test("formula: floor(elapsed x 2000 / 60 min), cumulative", () => {
  const cases: [number, number][] = [[0, 0], [1, 33], [10, 333], [20, 666], [30, 1000], [45, 1500], [60, 2000], [120, 4000], [540, 18000]];
  for (const [minutes, extra] of cases) assert.equal(projectedIncrement(minutes * MIN), extra, `${minutes} min`);
  assert.equal(projectedIncrement(1_999), 0); // whole seconds: 1 s -> 0.56 -> 0
  assert.equal(projectedIncrement(2_000), 1); // first projected visitor after 2 s
  assert.equal(projectedIncrement(-5000), 0);
});

test("never touched: nothing is projected", () => {
  const s = projectionSummary(memoryDb(), T0 + H, OPEN);
  assert.deepEqual([s.active, s.additionalToday, s.additionalTotal], [false, 0, 0]);
});

test("auto-start: the first poll opens the session, no manual start needed", () => {
  const db = memoryDb();
  touchProjection(db, T0);
  const s = projectionSummary(db, T0, OPEN);
  assert.deepEqual([s.active, s.activeSince, s.additionalToday], [true, T0, 0]);
  // A second touch does not open another session.
  touchProjection(db, T0 + 30_000);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM projection_segments").get() as { n: number | bigint }).n;
  assert.equal(Number(n), 1);
});

test("auto-start is atomic: a failed state write leaves no orphan session", () => {
  const db = memoryDb();
  db.exec(`CREATE TRIGGER reject_projection_state BEFORE INSERT ON projection_state
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  assert.throws(() => touchProjection(db, T0), /simulated write failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projection_segments").get()?.n, 0);
  assert.equal(projectionSummary(db, T0, OPEN).active, false);
  db.exec("DROP TRIGGER reject_projection_state");
  touchProjection(db, T0);
  assert.equal(projectionSummary(db, T0, OPEN).active, true);
  db.close();
});

test("older overlapping requests cannot move the heartbeat backwards", () => {
  const db = memoryDb();
  runAlive(db, T0, T0 + 10 * MIN);
  touchProjection(db, T0 + 9 * MIN);
  assert.equal(db.prepare("SELECT last_seen_at FROM projection_state").get()?.last_seen_at, T0 + 10 * MIN);
  assert.equal(additionalToday(db, T0 + H), 333);
  db.close();
});

test("a legacy session without a heartbeat cannot accumulate downtime", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO projection_segments (started_at) VALUES (?)").run(T0);
  const stale = projectionSummary(db, T0 + H, OPEN);
  assert.deepEqual([stale.active, stale.additionalToday], [false, 0]);
  touchProjection(db, T0 + H);
  const resumed = projectionSummary(db, T0 + H, OPEN);
  assert.deepEqual([resumed.active, resumed.activeSince, resumed.additionalToday], [true, T0 + H, 0]);
  db.close();
});

/** Separate SQLite connections really race here; a shared barrier releases them together. */
async function concurrentTouches(file: string, nowMs: number): Promise<void> {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from({ length: 8 }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    (async () => {
      const { touchProjection } = await import(workerData.moduleUrl);
      const db = new DatabaseSync(workerData.file);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        touchProjection(db, workerData.nowMs);
      } finally { db.close(); }
    })().catch(err => { throw err; });
  `, { eval: true, workerData: { file, nowMs, gate: gate.buffer, moduleUrl: new URL("./projection.ts", import.meta.url).href } }));
  try {
    const completed = workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`Projection worker exited ${code}`)));
    }));
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    })));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await Promise.all(completed);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

test("simultaneous processes start and resume only one session", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projection-concurrency-"));
  const file = path.join(dir, "entries.db");
  const db = new DatabaseSync(file);
  try {
    initSchema(db);
    await concurrentTouches(file, T0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projection_segments").get()?.n, 1);
    runAlive(db, T0, T0 + 30 * MIN);
    await concurrentTouches(file, T0 + 2 * H);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projection_segments").get()?.n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projection_segments WHERE ended_at IS NULL").get()?.n, 1);
    assert.equal(additionalToday(db, T0 + 2 * H), 1000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("increases gradually, 2,000 after one active hour and 4,000 after two", () => {
  const db = memoryDb();
  const seen: number[] = [];
  for (const m of [1, 10, 20, 30, 45, 60, 90, 120]) {
    runAlive(db, T0, T0 + m * MIN);
    seen.push(additionalToday(db, T0 + m * MIN));
  }
  assert.deepEqual(seen, [33, 333, 666, 1000, 1500, 2000, 3000, 4000]);
  // Never a jump: between consecutive 30 s polls it grows by at most 17 (30 s x 2000/h = 16.7).
  const db2 = memoryDb();
  let prev = 0;
  for (let t = T0; t <= T0 + H; t += 30_000) {
    touchProjection(db2, t);
    const v = additionalToday(db2, t);
    assert.ok(v - prev >= 0 && v - prev <= 17, `step ${v - prev}`);
    prev = v;
  }
  assert.equal(prev, 2000);
});

test("restart does not reset or double-count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projection-test-"));
  const file = path.join(dir, "entries.db");
  try {
    let db = new DatabaseSync(file);
    initSchema(db);
    runAlive(db, T0, T0 + 30 * MIN);
    const before = projectionSummary(db, T0 + 30 * MIN, OPEN);
    db.close();

    // Restart within a minute: the session continues where it was.
    db = new DatabaseSync(file);
    initSchema(db);
    const after = projectionSummary(db, T0 + 30 * MIN, OPEN);
    assert.deepEqual([before.additionalToday, after.additionalToday, after.active], [1000, 1000, true]);
    runAlive(db, T0 + 31 * MIN, T0 + 60 * MIN);
    assert.equal(additionalToday(db, T0 + 60 * MIN), 2000);
    // Recomputing again never adds more, and still exactly one open segment exists.
    assert.equal(additionalToday(db, T0 + 60 * MIN), 2000);
    const open = (db.prepare("SELECT COUNT(*) AS n FROM projection_segments WHERE ended_at IS NULL").get() as { n: number | bigint }).n;
    assert.equal(Number(open), 1);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("projection does not increase while the system is stopped", () => {
  const db = memoryDb();
  runAlive(db, T0, T0 + 30 * MIN); // running 30 min
  // System down for 2 hours: no polls, no heartbeats.
  const down = projectionSummary(db, T0 + 2 * H, OPEN);
  assert.deepEqual([down.additionalToday, down.active], [1000, false]);
  // Back up: accrues again from the restart, the gap is excluded (not added retroactively).
  runAlive(db, T0 + 2 * H + 30 * MIN, T0 + 3 * H);
  assert.equal(additionalToday(db, T0 + 3 * H), 2000);
  assert.ok(GAP_MS <= 2 * MIN);
});

test("IST midnight resets today's projection; total keeps both days", () => {
  const db = memoryDb();
  const start = ist(2026, 11, 14, 23, 30);
  runAlive(db, start, start + H); // 23:30 -> 00:30 IST
  const s = projectionSummary(db, start + H, OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal], [1000, 2000]);
  const before = projectionSummary(db, start + 29 * MIN, OPEN);
  assert.equal(before.additionalToday, 966);
});

test("total accumulates across days and respects the event scope", () => {
  const db = memoryDb();
  for (const d of [13, 14, 15]) {
    const s = ist(2026, 11, d, 10, 0);
    runAlive(db, s, s + 2 * H); // each day: 2 h alive, then silence until the next day
  }
  const now = ist(2026, 11, 15, 18, 0);
  assert.equal(projectionSummary(db, now, OPEN).additionalTotal, 12000);
  assert.equal(projectionSummary(db, now, OPEN).additionalToday, 4000);
  assert.equal(projectionSummary(db, now, parseEventScope("2026-11-14", null)).additionalTotal, 8000);
});

test("overlapping segments are merged, never counted twice", () => {
  const db = memoryDb();
  // Simulate a corrupt/duplicated state: two overlapping closed segments.
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, ?)");
  ins.run(T0, T0 + 60 * MIN);
  ins.run(T0 + 20 * MIN, T0 + 80 * MIN); // overlaps the first by 40 min
  // Union is [T0, T0+80min] = 80 active minutes, not 120.
  assert.equal(additionalToday(db, T0 + 2 * H), Math.floor((80 * 60 * 2000) / 3600));
});

test("actual camera counts are untouched: no rows written to entries", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO entries (id, occurred_at, track_id, received_at, camera) VALUES (?, ?, ?, ?, ?)").run("real-entry-0001", T0, 1, T0, "A");
  runAlive(db, T0, T0 + 2 * H);
  const actual = visitorSummary(db, T0 + 2 * H, OPEN);
  assert.deepEqual([actual.todayVisitors, actual.totalVisitors], [1, 1]);
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  assert.equal(rows, 1);
  assert.equal(additionalToday(db, T0 + 2 * H), 4000);
});
