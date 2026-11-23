import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { auditGit, backupBaseline, consistentBackup, counts, externalOutput, inventory, legacyProjection, openReadOnly, preflight, verifyCopy, verifyLive } from "../../scripts/deployment-safety.mts";
import { initSchema } from "./db.ts";
import { CURRENT_RATE, touchProjection } from "./projection.ts";
import { dayRangeUtc, parseEventScope } from "./time.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const OPEN = parseEventScope(null, null);
const H = 3_600_000;
const AT = dayRangeUtc("2026-11-22").start + 12 * H;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-booth-deployment-tests-"));
after(() => {
  const resolved = fs.realpathSync(temp);
  assert.ok(path.relative(fs.realpathSync(os.tmpdir()), resolved).startsWith("ai-booth-deployment-tests-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});
let serial = 0;
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(entries = 10) {
  const dir = path.join(temp, String(++serial));
  const root = path.join(dir, "project");
  fs.mkdirSync(dir);
  // Local-only clone: no network, no commits, no operations on the user's index.
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--", REPO, root]);
  fs.mkdirSync(path.join(root, "data"));
  const file = path.join(root, "data", "entries.db");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE entries (id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, track_id INTEGER, received_at INTEGER NOT NULL, camera TEXT NOT NULL DEFAULT 'A');
    CREATE TABLE projection_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE projection_state (id INTEGER PRIMARY KEY CHECK(id=1), last_seen_at INTEGER NOT NULL);
  `);
  const ins = db.prepare("INSERT INTO projection_segments (started_at, ended_at) VALUES (?, ?)");
  for (let d = 17; d <= 21; d++) {
    const start = dayRangeUtc(`2026-11-${d}`).start + H;
    ins.run(start, d === 21 ? null : start + 10 * H);
  }
  const seen = dayRangeUtc("2026-11-21").start + 11 * H;
  db.prepare("INSERT INTO projection_state VALUES (1, ?)").run(seen);
  const eventAt = dayRangeUtc("2026-11-19").start + 6 * H;
  db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO entries SELECT printf('event-%08d',x), ?, x, ?, 'A' FROM n`).run(entries, eventAt, eventAt);
  db.close();
  const oldSource = fs.readFileSync(path.join(root, "src/lib/projection.ts"), "utf8");
  const installedRate = /export const PER_HOUR = 2000/.test(oldSource) ? 2000 : (CURRENT_RATE.visitors * 3600) / CURRENT_RATE.seconds;
  const options = { runtime: "development", confirmedRate: installedRate, legacyRate: 2000, runtimeConfirmed: true, at: AT };
  const baseline = preflight(root, OPEN, options);
  assert.equal(baseline.status, "READY_FOR_COPY_TEST", baseline.blockers.join(" "));
  return { dir, root, file, baseline, options };
}

test("read-only preflight records a 200,000 total without migrating or changing the database", () => {
  const f = fixture(100_000);
  assert.equal(f.baseline.counts.projectedTotal, 200_000);
  assert.equal(f.baseline.inventory.rawEntryCount, 100_000);
  assert.equal(f.baseline.inventory.sessionCount, 5);
  const before = hash(f.file);
  const b = preflight(f.root, OPEN, f.options);
  assert.equal(hash(f.file), before);
  const db = openReadOnly(f.file);
  try {
    assert.deepEqual(db.prepare("PRAGMA table_info(projection_segments)").all().map(r => r.name), ["id", "started_at", "ended_at"]);
    assert.throws(() => db.exec("DELETE FROM entries"), /readonly|read.only/i);
    assert.deepEqual(legacyProjection(db, AT, OPEN), { additionalToday: 0, additionalTotal: 100_000 });
    assert.equal(b.counts.projectedTotal, 200_000);
  } finally { db.close(); }
});

test("deployment blocks on missing rate/runtime confirmation, a dirty tree, or unknown installed code", () => {
  const f = fixture();
  assert.equal(preflight(f.root, OPEN, { runtime: "development", at: AT }).status, "BLOCKED");
  assert.ok(preflight(f.root, OPEN, { ...f.options, runtime: "production" }).blockers.some(x => /build identity is missing/.test(x)));
  fs.writeFileSync(path.join(f.root, "operator-notes.txt"), "keep this local file");
  assert.ok(preflight(f.root, OPEN, f.options).blockers.some(x => /Local changes/.test(x)));
  fs.appendFileSync(path.join(f.root, "src/lib/projection.ts"), "\n// unreviewed installed variant\n");
  assert.ok(preflight(f.root, OPEN, f.options).blockers.some(x => /Unknown installed/.test(x)));
});

test("a still-active heartbeat blocks baseline capture until the inactivity cutoff", () => {
  const f = fixture();
  const db = new DatabaseSync(f.file);
  db.prepare("UPDATE projection_state SET last_seen_at=?").run(AT - 1000);
  db.close();
  assert.ok(preflight(f.root, OPEN, f.options).blockers.some(x => /wait over two minutes/.test(x)));
});

test("Git checks detect tracked databases outside data and extensionless SQLite files", () => {
  const f = fixture();
  assert.deepEqual(auditGit(f.root).trackedRuntimeFiles, []);
  fs.copyFileSync(f.file, path.join(f.root, "forgotten.sqlite"));
  execFileSync("git", ["-C", f.root, "add", "-f", "forgotten.sqlite"]);
  assert.throws(() => auditGit(f.root), /tracked runtime/);
  execFileSync("git", ["-C", f.root, "rm", "--cached", "forgotten.sqlite"]);
  fs.copyFileSync(f.file, path.join(f.root, "mystery-file"));
  execFileSync("git", ["-C", f.root, "add", "mystery-file"]);
  assert.throws(() => auditGit(f.root), /mystery-file/);
});

test("backup captures uncheckpointed WAL records, refuses overwrites and in-checkout destinations", async () => {
  const f = fixture();
  const writer = new DatabaseSync(f.file);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  writer.prepare("INSERT INTO entries VALUES ('wal-event', ?, 0, ?, 'B')").run(AT, AT);
  const copy = path.join(f.dir, "wal-backup.sqlite");
  try {
    assert.ok(fs.statSync(f.file + "-wal").size > 0);
    await consistentBackup(f.file, copy, f.root);
    const db = openReadOnly(copy);
    try { assert.equal(inventory(db).rawEntryCount, 11); } finally { db.close(); }
    await assert.rejects(consistentBackup(f.file, copy, f.root), /overwrite/);
    assert.throws(() => externalOutput(f.root, path.join(f.root, "data", "oops.sqlite")), /outside/);
    await assert.rejects(backupBaseline(f.baseline, path.join(f.dir, "stale-baseline.sqlite")), /changed after baseline/);
  } finally { writer.close(); }
});

test("copy-only migration preserves 200,000, all IDs/sessions and old rates; future hour adds exactly 6,500", async () => {
  const f = fixture(100_000);
  const original = hash(f.file);
  const backupFile = path.join(f.dir, "exhibition-backup.sqlite");
  await backupBaseline(f.baseline, backupFile);
  const backupHash = hash(backupFile);
  const resultDir = path.join(f.dir, "copy-test");
  const result = await verifyCopy(f.baseline, backupFile, resultDir);
  assert.equal(result.status, "PASS");
  assert.equal(result.frozenBefore.projectedTotal, 200_000);
  assert.deepEqual(result.frozenAfter, result.frozenBefore);
  assert.equal(result.futureHourIncrement, 6500);
  assert.equal(hash(f.file), original);
  assert.equal(hash(backupFile), backupHash);

  // Simulate pulling the tested code and starting it, on this scratch fixture only.
  for (const name of ["projection.ts", "time.ts", "db.ts", "visitors.ts"]) fs.copyFileSync(path.join(REPO, "src/lib", name), path.join(f.root, "src/lib", name));
  const live = new DatabaseSync(f.file);
  initSchema(live);
  const start = AT + 10_000;
  for (let t = start; t <= start + H; t += 30_000) touchProjection(live, t);
  const insert = live.prepare("INSERT INTO entries VALUES (?, ?, 0, ?, 'B')");
  insert.run("new-camera-event", start, start);
  insert.run("late-camera-event", AT - 24 * H, start);
  live.close();
  const checked = verifyLive(f.baseline, backupFile, path.join(resultDir, "result.json"), OPEN, start + H);
  assert.equal(checked.current.projectedTotal, 206_502);
  assert.equal(checked.measuredNewRaw, 2);
  assert.equal(checked.measuredNewProjection, 6500);
  assert.equal(checked.originalEventsPreserved, 100_000);
  assert.equal(hash(backupFile), backupHash);
  assert.throws(() => verifyLive(f.baseline, backupFile, path.join(resultDir, "result.json"), parseEventScope("2026-11-20", null), start + H), /Event period changed/);
  const corrupt = new DatabaseSync(f.file);
  corrupt.prepare("UPDATE entries SET track_id=999 WHERE id='event-00000001'").run();
  assert.throws(() => verifyLive(f.baseline, backupFile, path.join(resultDir, "result.json"), OPEN, start + H), /Historical entries row changed/);
  corrupt.prepare("UPDATE entries SET track_id=1 WHERE id='event-00000001'").run();
  corrupt.prepare("UPDATE projection_segments SET rate_visitors=5500, rate_seconds=3600 WHERE id=1").run();
  corrupt.close();
  assert.throws(() => verifyLive(f.baseline, backupFile, path.join(resultDir, "result.json"), OPEN, start + H), /Old session was assigned/);
});

test("copy verification stops when legacy code was ignoring a previously stored nonlegacy rate", async () => {
  const f = fixture();
  const db = new DatabaseSync(f.file);
  initSchema(db);
  db.exec("UPDATE projection_segments SET rate_visitors=5500, rate_seconds=32400 WHERE id=1");
  // Deliberately incompatible old build: its legacy oracle ignores the stored rate.
  const b = { ...f.baseline, mode: "legacy" as const, inventory: inventory(db), counts: counts(db, AT, OPEN, "legacy") };
  db.close();
  const copy = path.join(f.dir, "incompatible.sqlite");
  await backupBaseline(b, copy);
  await assert.rejects(verifyCopy(b, copy, path.join(f.dir, "incompatible-test")), /cumulative total changed/);
});
