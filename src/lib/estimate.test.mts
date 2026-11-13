import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db.ts";
import { parseEventScope } from "./time.ts";
import { recordEntry, visitorSummary } from "./visitors.ts";
import { adjustmentRateBp, estimateDay, estimateSummary, windowDeduction, WINDOW_MS } from "./estimate.ts";
import { formatVisitors } from "./formatVisitors.ts";

const OPEN = parseEventScope(null, null);
const H = WINDOW_MS;

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

/** UTC epoch ms for an IST wall-clock time. */
function ist(y: number, mo: number, d: number, h: number, mi = 0, s = 0, ms = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - 330 * 60_000;
}

let seq = 0;
/** Inserts `n` entries evenly spread over [from, to) with deterministic timestamps. */
function fill(db: DatabaseSync, from: number, to: number, n: number, camera = "A") {
  const ins = db.prepare("INSERT INTO entries (id, occurred_at, track_id, received_at, camera) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const t = from + Math.floor((i * (to - from)) / n);
    ins.run(`evt-${String(seq++).padStart(10, "0")}`, t, i, t, camera);
  }
  db.exec("COMMIT");
}

const DAY = "2026-11-14";
const END_OF_DAY = ist(2026, 11, 15, 0, 0); // midnight IST after DAY
/** 1,000 threshold entries from 08:00 IST, one per second; the 1,000th is at 08:16:39. */
const T = ist(2026, 11, 14, 8, 16, 39);
function threshold(db: DatabaseSync) {
  fill(db, ist(2026, 11, 14, 8, 0), ist(2026, 11, 14, 8, 16, 40), 1000);
}

// ------------------------------------------------------------------ rule table

test("rate table and deductions (integer arithmetic, capped at 25%)", () => {
  const cases: [number, number, number][] = [
    [0, 0, 0], [1, 500, 0], [400, 500, 20], [499, 500, 24], [500, 500, 25], [999, 500, 49],
    [1000, 1000, 100], [1499, 1000, 149], [1500, 1500, 225], [1999, 1500, 299],
    [2000, 2000, 400], [2499, 2000, 499], [2500, 2500, 625], [3000, 2500, 750], [100000, 2500, 25000],
  ];
  for (const [n, bp, deduction] of cases) {
    assert.equal(adjustmentRateBp(n), bp, `rate for ${n}`);
    assert.equal(windowDeduction(n), deduction, `deduction for ${n}`);
  }
});

// ------------------------------------------------------------- daily threshold

test("1. no entries", () => {
  const d = estimateDay(memoryDb(), DAY, END_OF_DAY);
  assert.deepEqual([d.raw, d.estimated, d.activatedAt, d.windows.length], [0, 0, null, 0]);
});

test("2. 999 entries: below threshold, estimate equals raw", () => {
  const db = memoryDb();
  fill(db, ist(2026, 11, 14, 8, 0), ist(2026, 11, 14, 20, 0), 999);
  const d = estimateDay(db, DAY, END_OF_DAY);
  assert.deepEqual([d.raw, d.estimated, d.activatedAt], [999, 999, null]);
});

test("3. exactly 1,000 entries: activates at the 1,000th, nothing to adjust", () => {
  const db = memoryDb();
  threshold(db);
  const d = estimateDay(db, DAY, END_OF_DAY);
  assert.deepEqual([d.raw, d.estimated, d.activatedAt], [1000, 1000, T]);
  assert.equal(d.windows[0].start, T);
  assert.equal(d.windows[0].raw, 0);
});

test("4. 1,001 entries: one post-threshold entry, floor(1 x 5%) = 0", () => {
  const db = memoryDb();
  threshold(db);
  fill(db, T + 60_000, T + 60_001, 1);
  const d = estimateDay(db, DAY, END_OF_DAY);
  assert.deepEqual([d.raw, d.estimated, d.windows[0].raw, d.windows[0].deduction], [1001, 1001, 1, 0]);
});

test("entries sharing the activation millisecond are split correctly", () => {
  const db = memoryDb();
  fill(db, ist(2026, 11, 14, 8, 0), ist(2026, 11, 14, 8, 10), 998);
  fill(db, T, T + 1, 5); // 1,000th entry plus 3 more at the same instant
  const d = estimateDay(db, DAY, END_OF_DAY);
  assert.equal(d.activatedAt, T);
  assert.equal(d.windows[0].raw, 3);
  assert.equal(d.raw, 1003);
});

// --------------------------------------------------------- per-window amounts

for (const [n, deduction] of [[400, 20], [500, 25], [999, 49], [1000, 100], [1500, 225], [2500, 625], [3000, 750]]) {
  test(`window with ${n} entries deducts ${deduction}`, () => {
    const db = memoryDb();
    threshold(db);
    fill(db, T + 1, T + H, n);
    const d = estimateDay(db, DAY, END_OF_DAY);
    const w = d.windows[0];
    assert.deepEqual([w.raw, w.deduction, w.adjusted, w.complete], [n, deduction, n - deduction, true]);
    assert.equal(d.raw, 1000 + n);
    assert.equal(d.estimated, 1000 + n - deduction);
  });
}

test("11. multiple completed windows are adjusted separately, not on the cumulative count", () => {
  const db = memoryDb();
  threshold(db);
  fill(db, T, T + H, 400); // starts at T: shares the activation ms with the 1,000th entry
  fill(db, T + H, T + 2 * H, 1000);
  fill(db, T + 2 * H, T + 3 * H, 2000);
  const d = estimateDay(db, DAY, END_OF_DAY);
  assert.deepEqual(d.windows.slice(0, 3).map((w) => [w.raw, w.deduction]), [[400, 20], [1000, 100], [2000, 400]]);
  assert.equal(d.estimated, 1000 + 380 + 900 + 1600);
  assert.equal(d.raw, 4400);
  // Windows are consecutive and non-overlapping.
  for (let i = 1; i < d.windows.length; i++) assert.equal(d.windows[i].start, d.windows[i - 1].end);
});

test("12. incomplete window counts unadjusted, then deducts when it closes", () => {
  const db = memoryDb();
  threshold(db);
  fill(db, T + 1, T + H, 1000);
  fill(db, T + H, T + H + 30 * 60_000, 2000);

  const during = estimateDay(db, DAY, T + H + 30 * 60_000);
  assert.deepEqual(during.windows.map((w) => [w.raw, w.deduction, w.complete]), [[1000, 100, true], [2000, 0, false]]);
  assert.equal(during.estimated, 1000 + 900 + 2000);

  const after = estimateDay(db, DAY, T + 2 * H);
  assert.equal(after.windows[1].complete, true);
  assert.equal(after.estimated, 1000 + 900 + 1600); // decreased by the deduction of 400
});

test("13. IST midnight closes the final partial window and starts a new cycle", () => {
  const db = memoryDb();
  const t = ist(2026, 11, 14, 23, 30);
  fill(db, ist(2026, 11, 14, 22, 0), t + 1, 1000); // 1,000th entry at about 23:29:55
  fill(db, t + 1, END_OF_DAY, 400);
  fill(db, END_OF_DAY, END_OF_DAY + 10 * 60_000, 50); // early next-day entries

  const before = estimateSummary(db, ist(2026, 11, 14, 23, 50), OPEN);
  assert.equal(before.estimatedTodayVisitors, 1400);

  const d = estimateDay(db, DAY, END_OF_DAY + 60_000);
  assert.equal(d.windows.at(-1)!.end, END_OF_DAY); // clipped at midnight
  assert.deepEqual([d.windows.at(-1)!.raw, d.windows.at(-1)!.deduction], [400, 20]);

  const next = estimateSummary(db, END_OF_DAY + 11 * 60_000, OPEN);
  assert.equal(next.estimatedTodayVisitors, 50); // new day, below its own threshold
  assert.equal(next.estimatedTotalVisitors, 1380 + 50);
});

test("14. restart during an active window: same result, never deducted twice", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "estimate-test-"));
  const file = path.join(dir, "entries.db");
  try {
    let db = new DatabaseSync(file);
    initSchema(db);
    threshold(db);
    fill(db, T + 1, T + H, 1000);
    fill(db, T + H, T + H + 10 * 60_000, 600);
    const mid = T + H + 20 * 60_000;
    const before = estimateDay(db, DAY, mid).estimated;
    db.close();

    db = new DatabaseSync(file);
    initSchema(db);
    assert.equal(estimateDay(db, DAY, mid).estimated, before);
    assert.equal(before, 1000 + 900 + 600);
    const closed = T + 2 * H;
    const once = estimateDay(db, DAY, closed).estimated;
    assert.equal(estimateDay(db, DAY, closed).estimated, once);
    assert.equal(once, 1000 + 900 + 570);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("15. duplicate event IDs count once in raw and estimated figures", () => {
  const db = memoryDb();
  threshold(db);
  const at = T + 5 * 60_000;
  const body = { id: "dup-event-0001", occurredAt: new Date(at).toISOString(), camera: "B" };
  assert.ok(recordEntry(db, body, at).ok);
  assert.ok(recordEntry(db, body, at + 1000).ok);
  const d = estimateDay(db, DAY, END_OF_DAY);
  assert.deepEqual([d.raw, d.windows[0].raw], [1001, 1]);
});

test("16. a late event lands in its own (completed) window and is recomputed", () => {
  const db = memoryDb();
  threshold(db);
  fill(db, T + 1, T + H, 1000);
  const now = T + 3 * H;
  assert.equal(estimateDay(db, DAY, now).estimated, 1900);

  const late = T + 30 * 60_000; // occurred in window 1, arrives two hours later
  const res = recordEntry(db, { id: "late-event-0001", occurredAt: new Date(late).toISOString(), camera: "A" }, now);
  assert.ok(res.ok && res.inserted && res.date === DAY);
  const d = estimateDay(db, DAY, now);
  assert.deepEqual([d.windows[0].raw, d.windows[0].deduction], [1001, 100]);
  assert.equal(d.estimated, 1000 + 901);
});

test("17. each day applies its own threshold; total sums daily estimates", () => {
  const db = memoryDb();
  // Day 1: 1,500 entries, 500 after the threshold in one completed window (deduct 25).
  fill(db, ist(2026, 11, 13, 9, 0), ist(2026, 11, 13, 9, 30), 1000);
  fill(db, ist(2026, 11, 13, 9, 30), ist(2026, 11, 13, 10, 0), 500);
  // Day 2: 999 entries, below threshold even though the lifetime total is far above it.
  fill(db, ist(2026, 11, 14, 9, 0), ist(2026, 11, 14, 18, 0), 999);
  const now = ist(2026, 11, 14, 19, 0);

  const s = estimateSummary(db, now, OPEN);
  assert.equal(s.estimatedTodayVisitors, 999);
  assert.equal(s.estimatedTotalVisitors, 1475 + 999);

  // Event scope applies to the total exactly like the raw total.
  assert.equal(estimateSummary(db, now, parseEventScope("2026-11-14", null)).estimatedTotalVisitors, 999);
});

test("19. raw statistics are unchanged and the estimate never writes to the database", () => {
  const db = memoryDb();
  threshold(db);
  fill(db, T + 1, T + H, 3000);
  const now = END_OF_DAY - 1;
  const raw = visitorSummary(db, now, OPEN);
  const changesBefore = num(db.prepare("SELECT total_changes() AS c").get());
  const est = estimateSummary(db, now, OPEN);
  assert.equal(num(db.prepare("SELECT total_changes() AS c").get()), changesBefore);
  assert.deepEqual([raw.todayVisitors, raw.totalVisitors], [4000, 4000]);
  assert.deepEqual([est.estimatedTodayVisitors, est.estimatedTotalVisitors], [3250, 3250]);
  assert.deepEqual(
    [visitorSummary(db, now, OPEN).todayVisitors, visitorSummary(db, now, OPEN).totalVisitors],
    [4000, 4000],
  );
});

function num(row: unknown): number {
  const c = (row as { c: number | bigint }).c;
  return typeof c === "bigint" ? Number(c) : c;
}

// ------------------------------------------------------------------ formatting

test("18. abbreviated visitor formatting truncates, never rounds up", () => {
  const cases: [number, string][] = [
    [0, "0"], [97, "97"], [999, "999"], [1000, "1K"], [1099, "1K"], [1100, "1.1K"], [1250, "1.2K"],
    [1999, "1.9K"], [2600, "2.6K"], [12486, "12.4K"], [99999, "99.9K"], [125000, "125K"],
    [999999, "999.9K"], [1000000, "1M"], [1009999, "1M"], [1250000, "1.25M"], [1299999, "1.29M"], [1200000, "1.2M"],
  ];
  for (const [n, s] of cases) assert.equal(formatVisitors(n), s, `formatVisitors(${n})`);
});

// ----------------------------------------------------------------- performance

test("20. 500,000 stored events: estimate computed quickly with indexed range counts", () => {
  const db = memoryDb();
  // 12 IST days x ~41,667 entries, 10:00-19:00 IST each day.
  for (let d = 0; d < 12; d++) {
    const base = ist(2026, 11, 14 + d, 10, 0);
    fill(db, base, base + 9 * H, d < 8 ? 41_667 : 41_666);
  }
  assert.equal(visitorSummary(db, 0, OPEN).totalVisitors, 500_000);
  const now = ist(2026, 11, 25, 15, 0);
  // Cold: every day computed from SQLite (first request after a restart).
  const c0 = performance.now();
  const cold = estimateSummary(db, now, OPEN);
  console.log(`  estimateSummary over 500,000 entries, cold: ${(performance.now() - c0).toFixed(1)} ms`);
  // Uncached result must equal the sum of independently computed days.
  let direct = 0;
  for (let d = 0; d < 12; d++) direct += estimateDay(db, `2026-11-${14 + d}`, now).estimated;
  assert.equal(cold.estimatedTotalVisitors, direct);
  const runs = 5;
  const t0 = performance.now();
  let s = estimateSummary(db, now, OPEN);
  for (let i = 1; i < runs; i++) s = estimateSummary(db, now, OPEN);
  const ms = (performance.now() - t0) / runs;
  console.log(`  estimateSummary over 500,000 entries, warm (sealed days cached): ${ms.toFixed(1)} ms`);
  assert.equal(s.estimatedTotalVisitors, cold.estimatedTotalVisitors);
  assert.ok(s.estimatedTotalVisitors < 500_000 && s.estimatedTotalVisitors > 375_000);
  assert.ok(ms < 1000, `too slow: ${ms} ms`);
});
