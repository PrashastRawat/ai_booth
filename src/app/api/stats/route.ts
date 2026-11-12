import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";

const WORKER_TIMEOUT_MS = 5000;
const LAST_WINDOW_MS = 5 * 60 * 1000;

type Row = Record<string, number | bigint | string | null | Uint8Array>;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

export async function GET() {
  // Opt this handler out of prerendering so the numbers are read on every request.
  await connection();

  const db = getDb();
  const now = Date.now();

  const totals = (db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS last5,
              MAX(occurred_at) AS lastEntryAt
         FROM entries`,
    )
    .get(now - LAST_WINDOW_MS) ?? {}) as Row;

  const status = (db
    .prepare("SELECT camera_connected, feed_ok, fps, session_entries, updated_at FROM worker_status WHERE id = 1")
    .get() ?? null) as Row | null;

  const workerOnline = status !== null && now - num(status.updated_at) < WORKER_TIMEOUT_MS;

  return NextResponse.json({
    total: num(totals.total),
    last5Minutes: num(totals.last5),
    lastEntryAt: totals.lastEntryAt == null ? null : new Date(num(totals.lastEntryAt)).toISOString(),
    serverTime: new Date(now).toISOString(),
    worker: {
      online: workerOnline,
      cameraConnected: workerOnline && num(status?.camera_connected) === 1,
      feedAvailable: workerOnline && num(status?.camera_connected) === 1 && num(status?.feed_ok) === 1,
      fps: status ? num(status.fps) : 0,
      sessionEntries: status ? num(status.session_entries) : 0,
      lastSeenAt: status ? new Date(num(status.updated_at)).toISOString() : null,
    },
  });
}
