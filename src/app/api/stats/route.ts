import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";

const WORKER_TIMEOUT_MS = 5000;
const LAST_WINDOW_MS = 5 * 60 * 1000;

type Row = Record<string, number | bigint | string | null | Uint8Array>;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

export type CameraStats = {
  name: string;
  entries: number;
  last5Minutes: number;
  online: boolean;
  connected: boolean;
  feedAvailable: boolean;
  fps: number;
  sessionEntries: number;
  lastSeenAt: string | null;
};

export async function GET() {
  // Opt this handler out of prerendering so the numbers are read on every request.
  await connection();

  const db = getDb();
  const now = Date.now();
  const since = now - LAST_WINDOW_MS;

  const totals = (db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS last5,
              MAX(occurred_at) AS lastEntryAt
         FROM entries`,
    )
    .get(since) ?? {}) as Row;

  const perCamera = new Map<string, { entries: number; last5: number }>();
  for (const r of db
    .prepare(
      `SELECT camera, COUNT(*) AS entries, SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS last5
         FROM entries GROUP BY camera`,
    )
    .all(since) as Row[]) {
    perCamera.set(String(r.camera), { entries: num(r.entries), last5: num(r.last5) });
  }

  const statusRows = db
    .prepare("SELECT name, connected, feed_ok, fps, session_entries, updated_at FROM camera_status ORDER BY name")
    .all() as Row[];

  const names = new Set<string>([...perCamera.keys(), ...statusRows.map((r) => String(r.name))]);
  const cameras: CameraStats[] = [...names].sort().map((name) => {
    const s = statusRows.find((r) => String(r.name) === name);
    const online = s !== undefined && now - num(s.updated_at) < WORKER_TIMEOUT_MS;
    const connected = online && num(s?.connected) === 1;
    return {
      name,
      entries: perCamera.get(name)?.entries ?? 0,
      last5Minutes: perCamera.get(name)?.last5 ?? 0,
      online,
      connected,
      feedAvailable: connected && num(s?.feed_ok) === 1,
      fps: s ? num(s.fps) : 0,
      sessionEntries: s ? num(s.session_entries) : 0,
      lastSeenAt: s ? new Date(num(s.updated_at)).toISOString() : null,
    };
  });

  return NextResponse.json({
    total: num(totals.total),
    last5Minutes: num(totals.last5),
    lastEntryAt: totals.lastEntryAt == null ? null : new Date(num(totals.lastEntryAt)).toISOString(),
    serverTime: new Date(now).toISOString(),
    workerOnline: cameras.some((c) => c.online),
    cameras,
  });
}
