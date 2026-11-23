// Offline deployment tools. Live databases are opened read-only; only verify-copy
// runs application migrations, and only on a newly created external scratch file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { initSchema } from "../src/lib/db.ts";
import { CURRENT_RATE, GAP_MS, initProjectionSchema, projectionSummary, touchProjection } from "../src/lib/projection.ts";
import { addDays, dayRangeUtc, parseEventScope, zonedDate, type EventScope } from "../src/lib/time.ts";

const LIB = fileURLToPath(new URL("../src/lib/", import.meta.url));
/** Projected visitors per active hour that the code in this repository records. */
const HOURLY = (CURRENT_RATE.visitors * 3600) / CURRENT_RATE.seconds;
// Exact audited pre-versioning implementation, normalized to LF. Unknown builds
// are blocked, even if a comment or a similarly named constant says "2000".
const LEGACY_HASHES: Record<string, string> = {
  "projection.ts": "d20e021ddff127e25aaaa85cd20ff4893c3f05ef82ea30e4df3ccb7b35b5ca68",
  "time.ts": "9185012bbab765942ea158996baab21c17b04b845610ad57e49f625ad356d58c",
  "db.ts": "4f1a56dc1852918357d7aa33d9d529eaa6bb17647c099c353147a74f04199ed0",
  "visitors.ts": "3cc1e61c0643ffb6ff66d1fd86e29dd4632b10faffe07045a1102e4ee837bec3",
};
type Row = Record<string, string | number | bigint | null | Uint8Array>;
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const readJson = <T,>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const scalar = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => Number(Object.values(db.prepare(sql).get(...args) ?? {})[0] ?? 0);
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]).map(c => c.name);
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trimEnd();

export function sourceHashes(lib: string): Record<string, string> {
  return Object.fromEntries(Object.keys(LEGACY_HASHES).map(name => [name, sha(fs.readFileSync(path.join(lib, name), "utf8").replaceAll("\r\n", "\n"))]));
}

function same(a: unknown, b: unknown): boolean { return json(a) === json(b); }
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
export function externalOutput(root: string, file: string): string {
  const absolute = path.resolve(file);
  // Resolve existing ancestors, including junctions, before accepting an output.
  let ancestor = path.dirname(absolute);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
  assert.ok(!inside(fs.realpathSync(root), resolved), "Output must be outside the checkout (including junctions)");
  assert.ok(!fs.existsSync(absolute), `Refusing to overwrite existing output: ${absolute}`);
  return absolute;
}
function saveNew(root: string, file: string, value: unknown): void {
  const output = externalOutput(root, file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function runtimePath(name: string): boolean {
  return /(^|\/)(data|backups?)(\/|$)|\.(db|sqlite\d*)([.\-]|$)|\.(bak|backup)([.\-]|$)|-(wal|shm|journal)$/i.test(name);
}
export function auditGit(root: string, ref?: string) {
  const top = fs.realpathSync(git(root, "rev-parse", "--show-toplevel"));
  assert.equal(fs.realpathSync(root), top, "Use the repository root, not a parent or subdirectory");
  const tracked = (ref ? git(root, "ls-tree", "-rz", "--name-only", ref) : git(root, "ls-files", "-z")).split("\0").filter(Boolean);
  const forbidden = tracked.filter(runtimePath);
  assert.ok(tracked.every(name => !/[\r\n]/.test(name)), "Unusual Git filenames require manual review");
  // One batch avoids spawning a process for every file on Windows. Inspect staged
  // blobs (or the reviewed target tree), not just the working directory's files.
  const blobs = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
    input: tracked.map(name => ref ? `${ref}:${name}` : `:${name}`).join("\n") + "\n", maxBuffer: 64 * 1024 * 1024,
  });
  let offset = 0;
  for (const name of tracked) {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString();
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
    assert.ok(match, `Cannot inspect Git blob: ${name}`);
    offset = end + 1;
    if (blobs.subarray(offset, offset + 16).equals(Buffer.from("SQLite format 3\0")) && !forbidden.includes(name)) forbidden.push(name);
    offset += Number(match[1]) + 1;
  }
  assert.equal(forbidden.length, 0, `STOP: tracked runtime database/backup files: ${forbidden.join(", ")}. Do not untrack blindly: a later pull can delete the PC's tracked file.`);
  const ignoreText = ref ? git(root, "show", `${ref}:.gitignore`) : fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.ok(/^\/data\/\s*$/m.test(ignoreText), "The target must ignore /data/");
  if (!ref) {
    for (const name of ["data/entries.db", "data/entries.db-wal", "data/entries.db-shm"]) {
      assert.ok(git(root, "check-ignore", "--no-index", name), `Runtime path is not ignored: ${name}`);
    }
  }
  return { commit: git(root, "rev-parse", ref ?? "HEAD"), trackedFiles: tracked.length, trackedRuntimeFiles: forbidden, status: git(root, "status", "--porcelain=v1", "--untracked-files=all") };
}

export function openReadOnly(file: string): DatabaseSync {
  assert.ok(fs.statSync(file).isFile(), `Existing database required: ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN");
  return db;
}
export function integrity(db: DatabaseSync): void {
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(r => Object.values(r)[0]), ["ok"], "SQLite integrity check failed");
}
function tableDigest(db: DatabaseSync, table: string, names: string[]): string {
  const h = createHash("sha256");
  for (const row of db.prepare(`SELECT ${names.map(q).join(",")} FROM ${q(table)} ORDER BY id`).iterate()) h.update(json(row) + "\n");
  return h.digest("hex");
}
export function inventory(db: DatabaseSync, original?: Inventory): Inventory {
  const entryColumns = original?.entryColumns ?? columns(db, "entries");
  const segmentColumns = original?.segmentColumns ?? columns(db, "projection_segments");
  assert.ok(entryColumns.includes("id") && segmentColumns.includes("id") && columns(db, "projection_state").includes("last_seen_at"), "Missing exhibition tables; refusing fresh-install initialization");
  return {
    entryColumns, segmentColumns,
    rawEntryCount: scalar(db, "SELECT COUNT(*) FROM entries"),
    sessionCount: scalar(db, "SELECT COUNT(*) FROM projection_segments"),
    eventIdsHash: tableDigest(db, "entries", ["id"]),
    eventsHash: tableDigest(db, "entries", entryColumns),
    sessionsHash: tableDigest(db, "projection_segments", segmentColumns),
    stateHash: tableDigest(db, "projection_state", ["id", "last_seen_at"]),
  };
}
type Inventory = { entryColumns: string[]; segmentColumns: string[]; rawEntryCount: number; sessionCount: number; eventIdsHash: string; eventsHash: string; sessionsHash: string; stateHash: string };

// Independent oracle for the exact audited legacy build: merge active intervals,
// split by IST day, floor whole seconds once per day, at 2,000/hour.
export function legacyProjection(db: DatabaseSync, at: number, scope: EventScope) {
  const seenRow = db.prepare("SELECT last_seen_at FROM projection_state WHERE id=1").get();
  const seen = seenRow ? Number(seenRow.last_seen_at) : null;
  const intervals = (db.prepare("SELECT started_at, ended_at FROM projection_segments ORDER BY started_at, id").all() as Row[]).map(r => {
    const start = Number(r.started_at);
    const end = r.ended_at === null ? (at - (seen ?? start) > GAP_MS ? Math.max(seen ?? start, start) : at) : Number(r.ended_at);
    return { start, end: Math.max(start, end) };
  });
  const sum = (from: number, to: number) => {
    const days = new Map<string, number>();
    let covered = -Infinity;
    for (const s of intervals) {
      const start = Math.max(from, s.start, covered), end = Math.min(to, s.end);
      covered = Math.max(covered, end);
      if (end <= start) continue;
      for (let date = zonedDate(start); ; date = addDays(date, 1)) {
        const day = dayRangeUtc(date);
        days.set(date, (days.get(date) ?? 0) + Math.max(0, Math.min(end, day.end) - Math.max(start, day.start)));
        if (day.end >= end) break;
      }
    }
    return [...days.values()].reduce((n, ms) => n + Math.floor(Math.floor(ms / 1000) * 2000 / 3600), 0);
  };
  const day = dayRangeUtc(zonedDate(at));
  return { additionalToday: sum(day.start, Math.min(day.end, at)), additionalTotal: sum(scope.startMs, Math.min(scope.endMs, at)) };
}

// For read-only checks on an unmigrated database, adapt projection rows IN MEMORY.
// Never call initSchema/getDb on the source exhibition file.
function versionedProjection(db: DatabaseSync, at: number, scope: EventScope) {
  if (columns(db, "projection_segments").includes("rate_seconds")) return projectionSummary(db, at, scope);
  const mem = new DatabaseSync(":memory:");
  try {
    initProjectionSchema(mem);
    const insert = mem.prepare("INSERT INTO projection_segments (id, started_at, ended_at) VALUES (?, ?, ?)");
    for (const r of db.prepare("SELECT id, started_at, ended_at FROM projection_segments").iterate()) insert.run(r.id, r.started_at, r.ended_at);
    for (const r of db.prepare("SELECT id, last_seen_at FROM projection_state").iterate()) mem.prepare("INSERT INTO projection_state VALUES (?, ?)").run(r.id, r.last_seen_at);
    return projectionSummary(mem, at, scope);
  } finally { mem.close(); }
}
export function counts(db: DatabaseSync, at: number, scope: EventScope, mode: "legacy" | "versioned") {
  const day = dayRangeUtc(zonedDate(at));
  const rawToday = scalar(db, "SELECT COUNT(*) FROM entries WHERE occurred_at >= ? AND occurred_at < ?", day.start, day.end);
  const rawTotal = scalar(db, "SELECT COUNT(*) FROM entries WHERE occurred_at >= ? AND occurred_at < ?", scope.startMs, scope.endMs);
  const p = mode === "legacy" ? legacyProjection(db, at, scope) : versionedProjection(db, at, scope);
  return { rawToday, rawTotal, additionalToday: p.additionalToday, additionalTotal: p.additionalTotal, projectedToday: rawToday + p.additionalToday, projectedTotal: rawTotal + p.additionalTotal };
}
type Counts = ReturnType<typeof counts>;
export type Baseline = {
  format: 1; status: "BLOCKED" | "READY_FOR_COPY_TEST"; blockers: string[]; root: string; dbPath: string; at: number;
  runtime: string; scope: EventScope; installedRate: number | null; mode: "legacy" | "versioned";
  productionBuildId: string | null; runtimeSourceConfirmed: boolean; confirmedLegacyRate: number | null;
  git: ReturnType<typeof auditGit>; installedSources: Record<string, string>; inventory: Inventory; counts: Counts;
};
export function preflight(root: string, scope: EventScope, options: { runtime: string; confirmedRate?: number; legacyRate?: number; runtimeConfirmed?: boolean; at?: number }): Baseline {
  root = fs.realpathSync(root);
  const dbPath = fs.realpathSync(path.join(root, "data", "entries.db"));
  assert.equal(dbPath.toLowerCase(), path.join(root, "data", "entries.db").toLowerCase(), "Unexpected database junction/path; verify the actual installation manually");
  const g = auditGit(root);
  const installedSources = sourceHashes(path.join(root, "src", "lib"));
  const legacy = same(installedSources, LEGACY_HASHES);
  const current = same(installedSources, sourceHashes(LIB));
  const installedRate = legacy ? 2000 : current ? HOURLY : null;
  const at = options.at ?? Date.now();
  const blockers: string[] = [];
  if (g.status) blockers.push("Local changes or untracked files: resolve them before pulling; never discard them automatically.");
  if (installedRate === null) blockers.push("Unknown installed counting implementation. Have a developer audit its rate/history semantics; a number in a comment is insufficient.");
  if (options.confirmedRate !== installedRate || installedRate === null) blockers.push("Installed rate has not been confirmed on this PC.");
  if (!options.runtimeConfirmed || !["development", "production"].includes(options.runtime)) blockers.push("Confirm the stopped runtime used these exact sources. Production BUILD_ID alone does not establish source/build correspondence.");
  if (options.legacyRate !== 2000) blockers.push("Confirm all unversioned history used 2,000/hour; current source alone cannot prove past deployed rates.");
  const buildFile = path.join(root, ".next", "BUILD_ID");
  const productionBuildId = options.runtime === "production" && fs.existsSync(buildFile) ? fs.readFileSync(buildFile, "utf8").trim() : null;
  if (options.runtime === "production" && !productionBuildId) blockers.push("Production build identity is missing; verify the installed artifact before upgrading.");
  const db = openReadOnly(dbPath);
  try {
    integrity(db);
    const inv = inventory(db);
    const cols = columns(db, "projection_segments");
    if (cols.includes("rate_visitors") !== cols.includes("rate_seconds")) blockers.push("Partial rate-column migration; manual review required.");
    if (cols.includes("rate_seconds")) {
      const invalid = scalar(db, "SELECT COUNT(*) FROM projection_segments WHERE (rate_visitors IS NULL) != (rate_seconds IS NULL) OR rate_visitors < 0 OR rate_seconds <= 0 OR typeof(rate_visitors) NOT IN ('null','integer') OR typeof(rate_seconds) NOT IN ('null','integer')");
      if (invalid) blockers.push("Invalid stored rates; do not fall back silently.");
      if (legacy && scalar(db, "SELECT COUNT(*) FROM projection_segments WHERE rate_visitors IS NOT NULL AND rate_visitors * 3600 != 2000 * rate_seconds")) blockers.push("Legacy code is ignoring stored rates other than 2,000/hour; historical compatibility is not established.");
    }
    if (scalar(db, "SELECT COUNT(*) FROM projection_segments WHERE started_at > ? OR ended_at > ? OR ended_at < started_at", at, at)) blockers.push("Future or reversed session timestamps require review.");
    const open = scalar(db, "SELECT COUNT(*) FROM projection_segments WHERE ended_at IS NULL");
    const seenRow = db.prepare("SELECT last_seen_at FROM projection_state WHERE id=1").get();
    const seen = seenRow ? Number(seenRow.last_seen_at) : scalar(db, "SELECT COALESCE(MAX(started_at),0) FROM projection_segments WHERE ended_at IS NULL");
    if (seen > at) blockers.push("Heartbeat timestamp is in the future; verify the PC clock and database.");
    if (open > 1) blockers.push("Multiple open sessions require review.");
    if (open && at - seen <= GAP_MS) blockers.push("Stop both services and all dashboards, then wait over two minutes for the final heartbeat cutoff before recording a baseline.");
    return { format: 1, status: blockers.length ? "BLOCKED" : "READY_FOR_COPY_TEST", blockers, root, dbPath, at, runtime: options.runtime, scope, installedRate, mode: legacy ? "legacy" : "versioned", productionBuildId, runtimeSourceConfirmed: options.runtimeConfirmed === true, confirmedLegacyRate: options.legacyRate ?? null, git: g, installedSources, inventory: inv, counts: counts(db, at, scope, legacy || !cols.includes("rate_seconds") ? "legacy" : "versioned") };
  } finally { db.close(); }
}

function ready(b: Baseline): void {
  assert.equal(b.format, 1);
  assert.equal(b.status, "READY_FOR_COPY_TEST", `Deployment BLOCKED: ${b.blockers.join(" ")}`);
}
export async function consistentBackup(source: string, destination: string, root: string): Promise<void> {
  const out = externalOutput(root, destination);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Reserve a new name exclusively. Never overwrite a backup or a live file.
  fs.closeSync(fs.openSync(out, "wx"));
  const db = openReadOnly(source);
  try { await backup(db, out); } finally { db.close(); }
  const check = openReadOnly(out);
  try { integrity(check); } finally { check.close(); }
}
export async function backupBaseline(b: Baseline, out: string): Promise<void> {
  ready(b);
  assert.deepEqual(sourceHashes(path.join(b.root, "src/lib")), b.installedSources, "Installed source changed after baseline");
  const source = openReadOnly(b.dbPath);
  try { assert.deepEqual(inventory(source), b.inventory, "Database changed after baseline; stop services and take a new baseline"); } finally { source.close(); }
  await consistentBackup(b.dbPath, out, b.root);
  const db = openReadOnly(out);
  try {
    assert.deepEqual(inventory(db), b.inventory);
    assert.deepEqual(counts(db, b.at, b.scope, b.mode), b.counts);
  } finally { db.close(); }
  saveNew(b.root, out + ".manifest.json", { baselineHash: sha(json(b)), databaseHash: sha(fs.readFileSync(out)) });
}
function validateBackup(b: Baseline, file: string): void {
  ready(b);
  assert.notEqual(fs.realpathSync(file), fs.realpathSync(b.dbPath), "A separate backup is required");
  const manifest = readJson<{ baselineHash: string; databaseHash: string }>(file + ".manifest.json");
  assert.equal(manifest.baselineHash, sha(json(b)), "Backup belongs to another baseline");
  assert.equal(manifest.databaseHash, sha(fs.readFileSync(file)), "Backup changed since creation");
}
export async function verifyCopy(b: Baseline, backupFile: string, outputDir: string) {
  validateBackup(b, backupFile);
  const output = externalOutput(b.root, outputDir);
  fs.mkdirSync(output, { recursive: true });
  const scratch = path.join(output, "migration-test.sqlite");
  await consistentBackup(backupFile, scratch, b.root);
  const db = new DatabaseSync(scratch);
  try {
    assert.deepEqual(inventory(db), b.inventory, "Copy does not match baseline");
    assert.deepEqual(counts(db, b.at, b.scope, b.mode), b.counts);
    const recordedRates = db.prepare("SELECT * FROM projection_segments ORDER BY id").all().map(r => ({ id: r.id, rate_visitors: r.rate_visitors ?? null, rate_seconds: r.rate_seconds ?? null }));
    initSchema(db);
    initSchema(db);
    assert.deepEqual(inventory(db, b.inventory), b.inventory, "Migration rewrote existing records");
    assert.deepEqual(counts(db, b.at, b.scope, "versioned"), b.counts, "STOP: cumulative total changed at frozen timestamp");
    const oldRows = db.prepare("SELECT id, rate_visitors, rate_seconds FROM projection_segments ORDER BY id").all().map(r => ({ ...r }));
    assert.deepEqual(oldRows, recordedRates, "Migration assigned a new rate to historical sessions");
    // Run future activity on a fresh IST day, using an open event scope so an old
    // configured EVENT_END_DATE cannot mask whether the new rate actually works.
    const boundary = dayRangeUtc(addDays(zonedDate(b.at), 1)).start + 9 * 3_600_000;
    const all = parseEventScope(null, null);
    const before = counts(db, boundary, all, "versioned");
    for (let t = boundary; t <= boundary + 3_600_000; t += 30_000) touchProjection(db, t);
    const after = counts(db, boundary + 3_600_000, all, "versioned");
    assert.equal(after.additionalToday, HOURLY);
    assert.equal(after.additionalTotal - before.additionalTotal, HOURLY);
    assert.equal(after.projectedTotal - before.projectedTotal, HOURLY);
    assert.equal(after.projectedToday, after.rawToday + HOURLY);
    assert.equal(tableDigest(db, "entries", b.inventory.entryColumns), b.inventory.eventsHash);
    assert.deepEqual(db.prepare("SELECT id, rate_visitors, rate_seconds FROM projection_segments ORDER BY id LIMIT ?").all(oldRows.length).map(r => ({ ...r })), oldRows, "Historical rates changed");
    const original = openReadOnly(backupFile);
    try {
      preservedRows(original, db, "projection_segments", b.inventory.segmentColumns, scalar(original, "SELECT COALESCE(MAX(last_seen_at),0) FROM projection_state"));
    } finally { original.close(); }
    const fresh = db.prepare("SELECT started_at, rate_visitors, rate_seconds FROM projection_segments ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(fresh && [Number(fresh.started_at), Number(fresh.rate_visitors), Number(fresh.rate_seconds)], [boundary, CURRENT_RATE.visitors, CURRENT_RATE.seconds]);
    const frozen = counts(db, b.at, b.scope, "versioned");
    assert.deepEqual(frozen, b.counts, "Future activity affected frozen history");
    integrity(db);
    const report = { status: "PASS", baselineHash: sha(json(b)), targetSources: sourceHashes(LIB), frozenBefore: b.counts, frozenAfter: frozen, originalSessions: b.inventory.sessionCount, eventIdsHash: b.inventory.eventIdsHash, futureHourIncrement: HOURLY, scratch };
    saveNew(b.root, path.join(output, "result.json"), report);
    return report;
  } finally { db.close(); }
}

// Stream the original rows against the newer database, allowing additional rows
// while detecting missing IDs or changed event payloads without loading all IDs.
function preservedRows(old: DatabaseSync, live: DatabaseSync, table: string, names: string[], seen: number): void {
  const select = `SELECT ${names.map(q).join(",")} FROM ${q(table)} ORDER BY id`;
  const iterator = live.prepare(select).iterate();
  let next = iterator.next();
  for (const row of old.prepare(select).iterate()) {
    while (!next.done && (typeof row.id === "number" ? Number(next.value.id) < row.id : String(next.value.id) < String(row.id))) next = iterator.next();
    assert.ok(!next.done && next.value.id === row.id, `Missing historical ${table} ID: ${row.id}`);
    const expected = { ...row };
    if (table === "projection_segments" && row.ended_at === null && next.value.ended_at !== null) expected.ended_at = Math.max(seen, Number(row.started_at));
    assert.deepEqual({ ...next.value }, expected, `Historical ${table} row changed: ${row.id}`);
  }
}
export function verifyLive(b: Baseline, backupFile: string, resultFile: string, scope: EventScope, at = Date.now()) {
  validateBackup(b, backupFile);
  assert.deepEqual(scope, b.scope, "Event period changed; this would change cumulative totals");
  const result = readJson<{ status: string; baselineHash: string; targetSources: Record<string, string> }>(resultFile);
  assert.equal(result.status, "PASS");
  assert.equal(result.baselineHash, sha(json(b)));
  assert.deepEqual(sourceHashes(path.join(b.root, "src/lib")), result.targetSources, "Pulled code differs from the code tested on the copy");
  assert.deepEqual(sourceHashes(LIB), result.targetSources, "Verification tool does not match tested source");
  const old = openReadOnly(backupFile), live = openReadOnly(b.dbPath);
  try {
    integrity(live);
    const seen = scalar(old, "SELECT COALESCE(MAX(last_seen_at),0) FROM projection_state");
    preservedRows(old, live, "entries", b.inventory.entryColumns, seen);
    preservedRows(old, live, "projection_segments", b.inventory.segmentColumns, seen);
    if (columns(live, "projection_segments").includes("rate_seconds")) {
      for (const r of old.prepare("SELECT * FROM projection_segments ORDER BY id").iterate()) {
        const newer = live.prepare("SELECT rate_visitors, rate_seconds FROM projection_segments WHERE id=?").get(r.id)!;
        assert.deepEqual([newer.rate_visitors, newer.rate_seconds], [r.rate_visitors ?? null, r.rate_seconds ?? null], "Old session was assigned a new rate");
      }
      const maxId = scalar(old, "SELECT COALESCE(MAX(id),0) FROM projection_segments");
      assert.equal(scalar(live, "SELECT COUNT(*) FROM projection_segments WHERE id > ? AND (started_at < ? OR rate_visitors IS NOT ? OR rate_seconds IS NOT ?)", maxId, b.at, CURRENT_RATE.visitors, CURRENT_RATE.seconds), 0, "Unexpected new activity rate/boundary");
    }
    const frozen = counts(live, b.at, b.scope, "versioned");
    // New late camera events may belong to an earlier date. All old events are
    // already checked above; account for each extra raw event, never mask a loss.
    assert.equal(frozen.additionalTotal, b.counts.additionalTotal, "Historical projection changed");
    assert.equal(frozen.additionalToday, b.counts.additionalToday, "Historical today's projection changed");
    const current = counts(live, at, b.scope, "versioned");
    const measuredNewRaw = current.rawTotal - b.counts.rawTotal;
    const measuredNewProjection = current.additionalTotal - b.counts.additionalTotal;
    assert.ok(measuredNewRaw >= 0 && measuredNewProjection >= 0, "Cumulative count decreased");
    assert.equal(current.projectedTotal, b.counts.projectedTotal + measuredNewRaw + measuredNewProjection);
    return { status: "PASS", at: new Date(at).toISOString(), frozenHistoricalProjection: frozen.additionalTotal, originalProjectedTotal: b.counts.projectedTotal, measuredNewRaw, measuredNewProjection, current, originalEventsPreserved: b.inventory.rawEntryCount, originalSessionsPreserved: b.inventory.sessionCount };
  } finally { old.close(); live.close(); }
}

function loadScope(root: string, runtime: string): EventScope {
  assert.ok(["development", "production"].includes(runtime), "--runtime must be development or production");
  const require = createRequire(path.join(root, "package.json"));
  const { loadEnvConfig } = require("@next/env") as { loadEnvConfig(root: string, dev: boolean): void };
  loadEnvConfig(root, runtime === "development");
  return parseEventScope(process.env.EVENT_START_DATE, process.env.EVENT_END_DATE);
}
async function main() {
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: {
    repo: { type: "string" }, ref: { type: "string" }, runtime: { type: "string" }, out: { type: "string" },
    baseline: { type: "string" }, backup: { type: "string" }, result: { type: "string" },
    "installed-rate": { type: "string" }, "legacy-rate": { type: "string" },
    "confirm-runtime-source": { type: "boolean" }, "services-stopped": { type: "boolean" }, "require-clean": { type: "boolean" },
  } });
  const root = fs.realpathSync(v.repo ?? process.cwd());
  const need = (name: "out" | "baseline" | "backup" | "result") => { assert.ok(v[name], `--${name} required`); return path.resolve(v[name]); };
  let report: unknown;
  switch (positionals[0]) {
    case "git-check": {
      const audit = auditGit(root, v.ref);
      if (v["require-clean"]) assert.equal(audit.status, "", "Local changes/untracked files block pull");
      report = audit;
      break;
    }
    case "preflight": {
      const runtime = v.runtime ?? "production";
      const b = preflight(root, loadScope(root, runtime), { runtime, confirmedRate: Number(v["installed-rate"]), legacyRate: Number(v["legacy-rate"]), runtimeConfirmed: v["confirm-runtime-source"] });
      saveNew(root, need("out"), b);
      report = b;
      if (b.status === "BLOCKED") process.exitCode = 2;
      break;
    }
    case "backup": {
      assert.ok(v["services-stopped"], "Stop both services/dashboards first; --services-stopped records your confirmation");
      const b = readJson<Baseline>(need("baseline"));
      assert.equal(root, b.root);
      await backupBaseline(b, need("out"));
      report = { status: "PASS", backup: v.out, integrity: "ok", baseline: b.counts };
      break;
    }
    case "verify-copy": {
      const b = readJson<Baseline>(need("baseline"));
      assert.equal(root, b.root);
      report = await verifyCopy(b, need("backup"), need("out"));
      break;
    }
    case "verify-live": {
      const b = readJson<Baseline>(need("baseline"));
      assert.equal(root, b.root);
      report = verifyLive(b, need("backup"), need("result"), loadScope(root, v.runtime ?? b.runtime));
      break;
    }
    default: throw new Error("Use git-check, preflight, backup, verify-copy, or verify-live; see DEPLOYMENT.md");
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`BLOCKED: ${(error as Error).message}\n`); process.exitCode = 2; });
}
