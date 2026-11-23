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
import { CURRENT_RATE, GAP_MS, LEGACY_RATE, projectedIncrement, projectionSummary, touchProjection } from "./projection.ts";

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

/** Current rate, computed independently: 6,500 per 3,600 active seconds. */
const cur = (seconds: number) => Math.floor((seconds * 6500) / 3600);
/** Pre-versioning rate, exactly as it was displayed: 2,000 per 3,600 active seconds. */
const legacy = (seconds: number) => Math.floor((seconds * 2000) / 3600);

const T0 = ist(2026, 11, 14, 10, 0);
const additionalToday = (db: DatabaseSync, now: number) => projectionSummary(db, now, OPEN).additionalToday;
const segmentRows = (db: DatabaseSync) =>
  db.prepare("SELECT id, started_at, ended_at, rate_visitors, rate_seconds FROM projection_segments ORDER BY id").all() as {
    started_at: number;
    ended_at: number | null;
    rate_visitors: number | null;
    rate_seconds: number | null;
  }[];

/** A database exactly as the pre-versioning code created it (no rate columns). */
function legacySchemaDb(file = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE projection_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE projection_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen_at INTEGER NOT NULL);
  `);
  return db;
}

test("rates: 6,500 per active hour for new activity; legacy rows keep 2,000 per hour", () => {
  assert.deepEqual(CURRENT_RATE, { visitors: 6500, seconds: 3600 });
  assert.deepEqual(LEGACY_RATE, { visitors: 2000, seconds: 3600 });
});

test("formula: floor(active seconds x 6,500 / 3,600), cumulative", () => {
  const cases: [number, number][] = [[0, 0], [1, 108], [10, 1083], [20, 2166], [30, 3250], [45, 4875], [60, 6500], [120, 13000], [300, 32500], [540, 58500]];
  for (const [minutes, extra] of cases) {
    assert.equal(projectedIncrement(minutes * MIN), extra, `${minutes} min`);
    assert.equal(extra, cur(minutes * 60), `${minutes} min independent`);
  }
  assert.equal(projectedIncrement(3600 * 1000), 6500); // exactly 3,600 active seconds
  assert.equal(projectedIncrement(999), 0); // whole seconds: 0 s -> 0
  assert.equal(projectedIncrement(1_000), 1); // 1 s -> 1.53 -> 1
  assert.equal(projectedIncrement(2_000), 3); // 2 s -> 3.06 -> 3
  assert.equal(projectedIncrement(-5000), 0);
  // Legacy formula unchanged.
  for (const [minutes, extra] of [[1, 33], [10, 333], [30, 1000], [60, 2000], [540, 18000]]) {
    assert.equal(projectedIncrement(minutes * MIN, LEGACY_RATE), extra);
  }
});

test("never touched: nothing is projected", () => {
  const s = projectionSummary(memoryDb(), T0 + H, OPEN);
  assert.deepEqual([s.active, s.additionalToday, s.additionalTotal], [false, 0, 0]);
});

test("auto-start: the first poll opens the session at the current rate, no manual start needed", () => {
  const db = memoryDb();
  touchProjection(db, T0);
  const s = projectionSummary(db, T0, OPEN);
  assert.deepEqual([s.active, s.activeSince, s.additionalToday], [true, T0, 0]);
  // A second touch does not open another session.
  touchProjection(db, T0 + 30_000);
  const rows = segmentRows(db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].rate_visitors, rows[0].rate_seconds], [6500, 3600]);
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
  assert.equal(additionalToday(db, T0 + H), 1083);
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
    assert.equal(additionalToday(db, T0 + 2 * H), 3250);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entries").get()?.n, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("simultaneous processes split a legacy session at the rate boundary only once", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projection-split-"));
  const file = path.join(dir, "entries.db");
  const db = legacySchemaDb(file);
  try {
    db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, NULL)").run(T0);
    db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(T0 + H - MIN);
    initSchema(db);
    await concurrentTouches(file, T0 + H);
    const rows = segmentRows(db);
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].ended_at, rows[0].rate_visitors], [T0 + H, null]);
    assert.deepEqual([rows[1].started_at, rows[1].ended_at, rows[1].rate_visitors], [T0 + H, null, 6500]);
    assert.equal(additionalToday(db, T0 + H), 2000);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("increases gradually: 6,500 after one active hour, 32,500 after 5, 58,500 after 9", () => {
  const db = memoryDb();
  const seen: number[] = [];
  for (const m of [1, 10, 20, 30, 45, 60, 90, 120, 300, 540]) {
    runAlive(db, T0, T0 + m * MIN);
    seen.push(additionalToday(db, T0 + m * MIN));
  }
  assert.deepEqual(seen, [108, 1083, 2166, 3250, 4875, 6500, 9750, 13000, 32500, 58500]);
  // Never a jump: between consecutive 30 s polls it grows by at most 55 (30 s x 6,500/3,600 = 54.2).
  const db2 = memoryDb();
  let prev = 0;
  for (let t = T0; t <= T0 + H; t += 30_000) {
    touchProjection(db2, t);
    const v = additionalToday(db2, t);
    assert.ok(v - prev >= 0 && v - prev <= 55, `step ${v - prev}`);
    prev = v;
  }
  assert.equal(prev, 6500);
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
    assert.deepEqual([before.additionalToday, after.additionalToday, after.active], [3250, 3250, true]);
    runAlive(db, T0 + 31 * MIN, T0 + 60 * MIN);
    assert.equal(additionalToday(db, T0 + 60 * MIN), 6500);
    // Recomputing again never adds more, and still exactly one open segment exists.
    assert.equal(additionalToday(db, T0 + 60 * MIN), 6500);
    // Repeated restarts with no new activity change nothing and add no sessions.
    for (let i = 0; i < 10; i++) {
      db.close();
      db = new DatabaseSync(file);
      initSchema(db);
      touchProjection(db, T0 + 60 * MIN);
      assert.equal(additionalToday(db, T0 + 60 * MIN), 6500);
    }
    const open = (db.prepare("SELECT COUNT(*) AS n FROM projection_segments WHERE ended_at IS NULL").get() as { n: number | bigint }).n;
    assert.equal(Number(open), 1);
    assert.equal(segmentRows(db).length, 1);
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
  assert.deepEqual([down.additionalToday, down.active], [3250, false]);
  // Back up: accrues again from the restart, the gap is excluded (not added retroactively).
  runAlive(db, T0 + 2 * H + 30 * MIN, T0 + 3 * H);
  assert.equal(additionalToday(db, T0 + 3 * H), 6500);
  assert.ok(GAP_MS <= 2 * MIN);
});

test("overnight shutdown contributes zero at the new rate", () => {
  const db = memoryDb();
  const day1 = ist(2026, 11, 22, 9);
  runAlive(db, day1, day1 + 9 * H); // 09:00-18:00
  for (const t of [day1 + 9 * H + 3 * MIN, ist(2026, 11, 23, 0), ist(2026, 11, 23, 8, 59)]) {
    assert.equal(projectionSummary(db, t, OPEN).additionalTotal, 58500);
  }
  const day2 = ist(2026, 11, 23, 9);
  touchProjection(db, day2);
  const s = projectionSummary(db, day2, OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal, segmentRows(db).length], [0, 58500, 2]);
});

test("activity continues past nine hours without a timer or cap", () => {
  const db = memoryDb();
  runAlive(db, T0, T0 + 12 * H);
  const s = projectionSummary(db, T0 + 12 * H, OPEN);
  assert.deepEqual([s.active, s.additionalToday, s.additionalTotal], [true, 78000, 78000]); // 12 h x 6,500
  assert.equal(segmentRows(db).length, 1);
});

test("IST midnight resets today's projection; total keeps both days", () => {
  const db = memoryDb();
  const start = ist(2026, 11, 14, 23, 30);
  runAlive(db, start, start + H); // 23:30 -> 00:30 IST
  const s = projectionSummary(db, start + H, OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal], [3250, 6500]); // each day floored separately
  const before = projectionSummary(db, start + 29 * MIN, OPEN);
  assert.equal(before.additionalToday, cur(29 * 60));
  const midnight = projectionSummary(db, start + 30 * MIN, OPEN);
  assert.deepEqual([midnight.additionalToday, midnight.additionalTotal], [0, 3250]);
});

test("total accumulates across days and respects the event scope", () => {
  const db = memoryDb();
  for (const d of [13, 14, 15]) {
    const s = ist(2026, 11, d, 10, 0);
    runAlive(db, s, s + 2 * H); // each day: 2 h alive, then silence until the next day
  }
  const now = ist(2026, 11, 15, 18, 0);
  assert.equal(projectionSummary(db, now, OPEN).additionalTotal, 3 * 13000);
  assert.equal(projectionSummary(db, now, OPEN).additionalToday, 13000);
  assert.equal(projectionSummary(db, now, parseEventScope("2026-11-14", null)).additionalTotal, 2 * 13000);
});

test("overlapping legacy segments are merged, never counted twice (legacy rate unchanged)", () => {
  const db = memoryDb();
  // Simulate a corrupt/duplicated state: two overlapping closed segments.
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, ?)");
  ins.run(T0, T0 + 60 * MIN);
  ins.run(T0 + 20 * MIN, T0 + 80 * MIN); // overlaps the first by 40 min
  // Union is [T0, T0+80min] = 80 active minutes, not 120, at the legacy 2,000/h.
  assert.equal(additionalToday(db, T0 + 2 * H), Math.floor((80 * 60 * 2000) / 3600));
});

test("overlapping segments at different rates: each instant counted once", () => {
  const db = memoryDb();
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at, rate_visitors, rate_seconds) VALUES (?, ?, ?, ?)");
  ins.run(T0, T0 + H, null, null); // legacy 10:00-11:00
  ins.run(T0 + 30 * MIN, T0 + 2 * H, 5500, 3600); // overlaps 30 min
  // Earliest wins: 60 min legacy + 60 min current.
  assert.equal(additionalToday(db, T0 + 3 * H), 2000 + 5500);
});

test("actual camera counts are untouched: no rows written to entries", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO entries (id, occurred_at, track_id, received_at, camera) VALUES (?, ?, ?, ?, ?)").run("real-entry-0001", T0, 1, T0, "A");
  runAlive(db, T0, T0 + 2 * H);
  const actual = visitorSummary(db, T0 + 2 * H, OPEN);
  assert.deepEqual([actual.todayVisitors, actual.totalVisitors], [1, 1]);
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
  assert.equal(rows, 1);
  assert.equal(additionalToday(db, T0 + 2 * H), 13000);
});

// ---- Rate versioning: history is never recalculated ----

test("migration: an old-schema database gains rate columns; no row is rewritten; totals identical", () => {
  const db = legacySchemaDb();
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, ?)");
  ins.run(ist(2026, 11, 14, 9), ist(2026, 11, 14, 17, 7)); // 8 h 7 min
  ins.run(ist(2026, 11, 15, 10), ist(2026, 11, 15, 13, 41)); // 3 h 41 min
  ins.run(ist(2026, 11, 15, 23, 50), ist(2026, 11, 16, 0, 20)); // crosses midnight
  db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(ist(2026, 11, 16, 0, 20));
  const before = db.prepare("SELECT id, started_at, ended_at FROM projection_segments ORDER BY id").all();

  initSchema(db);
  initSchema(db); // idempotent
  const cols = (db.prepare("PRAGMA table_info(projection_segments)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("rate_visitors") && cols.includes("rate_seconds"));
  assert.deepEqual(db.prepare("SELECT id, started_at, ended_at FROM projection_segments ORDER BY id").all(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projection_segments WHERE rate_visitors IS NOT NULL").get()?.n, 0);

  // Exactly what the 2,000/h code displayed, computed independently per IST day.
  const expected = legacy(8 * 3600 + 7 * 60) + legacy(3 * 3600 + 41 * 60 + 10 * 60) + legacy(20 * 60);
  const now = ist(2026, 11, 22, 8);
  assert.equal(projectionSummary(db, now, OPEN).additionalTotal, expected);
});

test("activation while a legacy session is live: split at the boundary, history unchanged", () => {
  const db = legacySchemaDb();
  const start = ist(2026, 11, 22, 9);
  db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, NULL)").run(start);
  db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(start + H - MIN); // old code last seen 09:59
  initSchema(db); // new code starts (restart took under 2 minutes)

  const boundary = start + H; // first touch by the new code at 10:00
  touchProjection(db, boundary);
  const rows = segmentRows(db);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].ended_at, rows[0].rate_visitors, rows[0].rate_seconds], [boundary, null, null]);
  assert.deepEqual([rows[1].started_at, rows[1].ended_at, rows[1].rate_visitors, rows[1].rate_seconds], [boundary, null, 6500, 3600]);
  assert.equal(additionalToday(db, boundary), 2000, "the legacy hour keeps its 2,000");

  runAlive(db, boundary, boundary + 9 * H);
  const s = projectionSummary(db, boundary + 9 * H, OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal], [2000 + 58500, 2000 + 58500]);
  assert.equal(segmentRows(db).length, 2, "no further splits once on the current rate");
});

test("activation after an overnight stop: the stale legacy session closes at its last sign of life", () => {
  const db = legacySchemaDb();
  const start = ist(2026, 11, 21, 9);
  db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, NULL)").run(start);
  db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(start + 9 * H); // 18:00
  initSchema(db);
  const history = projectionSummary(db, ist(2026, 11, 22, 8), OPEN).additionalTotal;
  assert.equal(history, 18000);
  touchProjection(db, ist(2026, 11, 22, 9));
  const rows = segmentRows(db);
  assert.deepEqual([rows[0].ended_at, rows[1].started_at, rows[1].rate_visitors], [start + 9 * H, ist(2026, 11, 22, 9), 6500]);
  runAlive(db, ist(2026, 11, 22, 9), ist(2026, 11, 22, 13, 30));
  const s = projectionSummary(db, ist(2026, 11, 22, 13, 30), OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal], [29250, 18000 + 29250]); // 4.5 h at 6,500/h
});

test("a delayed request cannot move already-recorded legacy time to the new rate", () => {
  const db = legacySchemaDb();
  db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, NULL)").run(T0);
  db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(T0 + H);
  initSchema(db);
  touchProjection(db, T0 + 30 * MIN); // an old request arriving late
  const rows = segmentRows(db);
  assert.equal(rows[0].ended_at, T0 + H, "boundary never earlier than recorded activity");
  assert.equal(additionalToday(db, T0 + H), 2000);
});

test("stored rates are honoured: a later rate never revalues earlier segments", () => {
  const db = memoryDb();
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at, rate_visitors, rate_seconds) VALUES (?, ?, ?, ?)");
  ins.run(ist(2026, 11, 12, 10), ist(2026, 11, 12, 11), 1000, 3600); // some earlier version at 1,000/h
  ins.run(ist(2026, 11, 13, 10), ist(2026, 11, 13, 11), null, null); // unversioned: 2,000/h
  ins.run(ist(2026, 11, 14, 9), ist(2026, 11, 14, 18), 5500, 32400); // earlier 5,500/9h version stays historical
  ins.run(ist(2026, 11, 15, 9), ist(2026, 11, 15, 10), 5500, 3600); // earlier 5,500/h version stays historical
  ins.run(ist(2026, 11, 16, 9), ist(2026, 11, 16, 10), 6500, 3600); // current
  const s = projectionSummary(db, ist(2026, 11, 17, 8), OPEN);
  assert.equal(s.additionalTotal, 1000 + 2000 + 5500 + 5500 + 6500);
});

test("correcting a live versioned 5,500/9h session splits it without revaluing earlier activity", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO projection_segments (started_at, rate_visitors, rate_seconds) VALUES (?, 5500, 32400)").run(T0);
  db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(T0 + H - MIN);
  const boundary = T0 + H;
  const before = projectionSummary(db, boundary, OPEN).additionalTotal;
  assert.equal(before, 611);
  touchProjection(db, boundary);
  const history = segmentRows(db)[0];
  assert.deepEqual([history.ended_at, history.rate_visitors, history.rate_seconds], [boundary, 5500, 32400]);
  assert.equal(projectionSummary(db, boundary, OPEN).additionalTotal, before);
  runAlive(db, boundary, boundary + H);
  assert.deepEqual(segmentRows(db)[0], history, "closed history is never rewritten");
  const s = projectionSummary(db, boundary + H, OPEN);
  assert.deepEqual([s.additionalToday, s.additionalTotal], [611 + 6500, 611 + 6500]);
  assert.equal(segmentRows(db).length, 2);
});

test("upgrading a live 5,500/hour session to 6,500/hour: split at the boundary, 5,500 history kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projection-6500-"));
  const file = path.join(dir, "entries.db");
  try {
    let db = new DatabaseSync(file);
    initSchema(db);
    // Earlier history: unversioned 2,000/h day, then a 5,500/h hour recorded by the previous build.
    const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at, rate_visitors, rate_seconds) VALUES (?, ?, ?, ?)");
    ins.run(ist(2026, 11, 21, 9), ist(2026, 11, 21, 18), null, null); // 9 h legacy = 18,000
    // Live session of the 5,500/h build since 09:00 today, last seen 09:59.
    const start = ist(2026, 11, 22, 9);
    db.prepare("INSERT INTO projection_segments (started_at, rate_visitors, rate_seconds) VALUES (?, 5500, 3600)").run(start);
    db.prepare("INSERT INTO projection_state (id, last_seen_at) VALUES (1, ?)").run(start + H - MIN);
    const boundary = start + H;
    const before = projectionSummary(db, boundary, OPEN);
    assert.deepEqual([before.additionalToday, before.additionalTotal], [5500, 18000 + 5500]);
    db.close();

    // Restart with the 6,500/h build (under the 2-minute cutoff).
    db = new DatabaseSync(file);
    initSchema(db);
    touchProjection(db, boundary);
    const rows = segmentRows(db);
    assert.equal(rows.length, 3);
    assert.deepEqual([rows[1].ended_at, rows[1].rate_visitors, rows[1].rate_seconds], [boundary, 5500, 3600], "5,500/h hour closed, rate kept");
    assert.deepEqual([rows[2].started_at, rows[2].rate_visitors, rows[2].rate_seconds], [boundary, 6500, 3600]);
    const at = projectionSummary(db, boundary, OPEN);
    assert.deepEqual([at.additionalToday, at.additionalTotal], [5500, 18000 + 5500], "no jump at the upgrade");

    runAlive(db, boundary, boundary + 2 * H);
    const s = projectionSummary(db, boundary + 2 * H, OPEN);
    assert.deepEqual([s.additionalToday, s.additionalTotal], [5500 + 13000, 18000 + 5500 + 13000]);
    for (let i = 0; i < 5; i++) {
      db.close();
      db = new DatabaseSync(file);
      initSchema(db);
      assert.equal(projectionSummary(db, boundary + 2 * H, OPEN).additionalTotal, 18000 + 5500 + 13000, "restarts change nothing");
    }
    assert.equal(segmentRows(db).length, 3, "no duplicate sessions");
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a day with two rates is floored once, from exact fractions", () => {
  const db = memoryDb();
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at, rate_visitors, rate_seconds) VALUES (?, ?, ?, ?)");
  ins.run(T0, T0 + 61_000, null, null); // 61 s legacy = 33.89
  ins.run(T0 + 2 * MIN, T0 + 2 * MIN + 67_000, 5500, 3600); // 67 s at an earlier 5,500/h = 102.36
  assert.equal(additionalToday(db, T0 + H), 136); // floor(136.25), not 33 + 102
});
