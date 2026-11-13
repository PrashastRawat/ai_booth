import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db.ts";
import { parseEventScope } from "./time.ts";
import { dailyCounts, recordEntry, visitorSummary } from "./visitors.ts";

const OPEN_SCOPE = parseEventScope(null, null);

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

/** UTC epoch ms for a wall-clock time in IST (UTC+5:30). */
function ist(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s) - 330 * 60_000;
}

function add(db: DatabaseSync, occurredMs: number, opts: { camera?: string; id?: string; receivedMs?: number } = {}) {
  const res = recordEntry(
    db,
    { id: opts.id ?? randomUUID(), occurredAt: new Date(occurredMs).toISOString(), camera: opts.camera ?? "A", trackId: 1 },
    opts.receivedMs ?? occurredMs,
  );
  assert.ok(res.ok, JSON.stringify(res));
  return res;
}

test("empty database gives zeros, not errors", () => {
  const s = visitorSummary(memoryDb(), ist(2026, 11, 13, 12, 0), OPEN_SCOPE);
  assert.equal(s.todayVisitors, 0);
  assert.equal(s.totalVisitors, 0);
  assert.equal(s.lastEntryAt, null);
  assert.equal(s.date, "2026-11-13");
  assert.equal(s.timezone, "Asia/Kolkata");
});

test("today counts only the current IST day; total counts every day", () => {
  const db = memoryDb();
  for (let i = 0; i < 25; i++) add(db, ist(2026, 11, 13, 10, i), { camera: i % 2 ? "A" : "B" });
  for (let i = 0; i < 30; i++) add(db, ist(2026, 11, 14, 10, i), { camera: i % 2 ? "A" : "B" });

  const s = visitorSummary(db, ist(2026, 11, 14, 15, 0), OPEN_SCOPE);
  assert.equal(s.date, "2026-11-14");
  assert.equal(s.todayVisitors, 30);
  assert.equal(s.totalVisitors, 55);
  assert.deepEqual(s.perCamera.get("A"), { today: 15, total: 27, last5Minutes: 0 });
  assert.deepEqual(s.perCamera.get("B"), { today: 15, total: 28, last5Minutes: 0 });
});

test("scenario A: today drops to 0 after IST midnight, total is unchanged", () => {
  const db = memoryDb();
  for (let i = 0; i < 20; i++) add(db, ist(2026, 11, 13, 23, 30, i));
  for (let i = 0; i < 30; i++) add(db, ist(2026, 11, 12, 12, 0, i));

  const before = visitorSummary(db, ist(2026, 11, 13, 23, 59), OPEN_SCOPE);
  assert.deepEqual([before.date, before.todayVisitors, before.totalVisitors], ["2026-11-13", 20, 50]);

  const after = visitorSummary(db, ist(2026, 11, 14, 0, 1), OPEN_SCOPE);
  assert.deepEqual([after.date, after.todayVisitors, after.totalVisitors], ["2026-11-14", 0, 50]);
});

test("boundary: 23:59:59.999 IST belongs to that day, 00:00:00.000 to the next", () => {
  const db = memoryDb();
  const midnight = ist(2026, 11, 14, 0, 0);
  add(db, midnight - 1);
  add(db, midnight);
  const days = dailyCounts(db, "2026-11-13", "2026-11-14");
  assert.deepEqual(days.map((d) => d.visitors), [1, 1]);
});

test("scenario B: counts survive closing and reopening the database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visitors-test-"));
  const file = path.join(dir, "entries.db");
  const now = ist(2026, 11, 14, 15, 0);
  try {
    let db = new DatabaseSync(file);
    initSchema(db);
    for (let i = 0; i < 12; i++) add(db, ist(2026, 11, 14, 9, i));
    for (let i = 0; i < 60; i++) add(db, ist(2026, 11, 13, 9, i));
    const before = visitorSummary(db, now, OPEN_SCOPE);
    db.close();

    db = new DatabaseSync(file);
    initSchema(db); // runs again on every start; must not touch existing rows
    const after = visitorSummary(db, now, OPEN_SCOPE);
    db.close();

    assert.deepEqual([before.todayVisitors, before.totalVisitors], [12, 72]);
    assert.deepEqual([after.todayVisitors, after.totalVisitors], [12, 72]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scenario C: the same event ID counts once", () => {
  const db = memoryDb();
  const t = ist(2026, 11, 13, 12, 0);
  const id = randomUUID();
  assert.equal(add(db, t, { id }).inserted, true);
  assert.equal(add(db, t, { id }).inserted, false);
  assert.equal(add(db, t + 5000, { id, receivedMs: t + 5000 }).inserted, false);
  assert.equal(visitorSummary(db, t, OPEN_SCOPE).totalVisitors, 1);
});

test("scenario D: an event from 23:59 IST arriving at 00:01 counts for the previous day", () => {
  const db = memoryDb();
  const occurred = ist(2026, 11, 13, 23, 59);
  const received = ist(2026, 11, 14, 0, 1);
  const res = add(db, occurred, { receivedMs: received });
  assert.ok(res.ok && res.inserted);
  assert.equal(res.date, "2026-11-13");

  const s = visitorSummary(db, received, OPEN_SCOPE);
  assert.deepEqual([s.date, s.todayVisitors, s.totalVisitors], ["2026-11-14", 0, 1]);
  assert.deepEqual(dailyCounts(db, "2026-11-13", "2026-11-14").map((d) => d.visitors), [1, 0]);
});

test("timestamps outside the skew policy are rejected; retries of stored events are not", () => {
  const db = memoryDb();
  const now = ist(2026, 11, 13, 12, 0);
  const body = (occurredAt: string, id = randomUUID()) => ({ id, occurredAt, camera: "A" });

  const future = recordEntry(db, body(new Date(now + 61_000).toISOString()), now);
  assert.deepEqual([future.ok, !future.ok && future.status], [false, 422]);

  const stale = recordEntry(db, body(new Date(now - 25 * 3_600_000).toISOString()), now);
  assert.deepEqual([stale.ok, !stale.ok && stale.status], [false, 422]);

  const naive = recordEntry(db, body("2026-11-13T12:00:00"), now);
  assert.deepEqual([naive.ok, !naive.ok && naive.status], [false, 400]);

  // Stored yesterday, retried 30 h later: acknowledged as a duplicate, not rejected.
  const id = randomUUID();
  add(db, now, { id });
  const late = recordEntry(db, body(new Date(now).toISOString(), id), now + 30 * 3_600_000);
  assert.ok(late.ok && !late.inserted);

  assert.equal(visitorSummary(db, now, OPEN_SCOPE).totalVisitors, 1);
});

test("malformed bodies are rejected", () => {
  const db = memoryDb();
  const now = ist(2026, 11, 13, 12, 0);
  const ts = new Date(now).toISOString();
  for (const body of [null, [], "x", { occurredAt: ts }, { id: "short", occurredAt: ts }, { id: randomUUID(), occurredAt: ts, camera: "A B" }, { id: randomUUID(), occurredAt: ts, trackId: 1.5 }]) {
    const res = recordEntry(db, body, now);
    assert.equal(res.ok, false, JSON.stringify(body));
  }
});

test("total respects the configured event scope; today does not", () => {
  const db = memoryDb();
  for (let i = 0; i < 5; i++) add(db, ist(2026, 11, 12, 18, i)); // setup-day test walks
  for (let i = 0; i < 7; i++) add(db, ist(2026, 11, 14, 10, i));
  for (let i = 0; i < 3; i++) add(db, ist(2026, 11, 26, 0, i)); // day after the event

  const scope = parseEventScope("2026-11-14", "2026-11-25");
  assert.equal(visitorSummary(db, ist(2026, 11, 14, 12, 0), scope).totalVisitors, 7);
  assert.equal(visitorSummary(db, ist(2026, 11, 12, 20, 0), scope).todayVisitors, 5);
});

test("existing databases without the new index are upgraded in place", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, track_id INTEGER, received_at INTEGER NOT NULL);
           INSERT INTO entries VALUES ('legacy-entry-1', ${ist(2026, 11, 13, 10, 0)}, 3, ${ist(2026, 11, 13, 10, 0)});`);
  initSchema(db);
  const indexes = (db.prepare("PRAGMA index_list(entries)").all() as { name: string }[]).map((r) => r.name);
  assert.ok(indexes.includes("idx_entries_camera_occurred"));
  const s = visitorSummary(db, ist(2026, 11, 13, 12, 0), OPEN_SCOPE);
  assert.deepEqual([s.todayVisitors, s.perCamera.get("A")?.total], [1, 1]);
});
