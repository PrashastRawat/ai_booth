import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";
import { eventScopeFromEnv, visitorSummary } from "@/lib/visitors";
import { estimateSummary } from "@/lib/estimate";

const WORKER_TIMEOUT_MS = 5000;

type Row = Record<string, number | bigint | string | null | Uint8Array>;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

export type CameraStats = {
  name: string;
  todayVisitors: number;
  totalVisitors: number;
  /** Same as totalVisitors; kept for older consumers. */
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
  // Because "today" is recomputed per request, the IST day rolls over at midnight
  // with no restart and no reset.
  await connection();

  let scope;
  try {
    scope = eventScopeFromEnv();
  } catch (err) {
    return NextResponse.json({ error: `Invalid event configuration: ${(err as Error).message}` }, { status: 500 });
  }

  const db = getDb();
  const now = Date.now();
  const summary = visitorSummary(db, now, scope);
  // Hourly-adjusted estimates (see src/lib/estimate.ts). Separate from the raw counts above.
  const estimate = estimateSummary(db, now, scope);

  const statusRows = db
    .prepare("SELECT name, connected, feed_ok, fps, session_entries, updated_at FROM camera_status ORDER BY name")
    .all() as Row[];

  const names = new Set<string>([...summary.perCamera.keys(), ...statusRows.map((r) => String(r.name))]);
  const cameras: CameraStats[] = [...names].sort().map((name) => {
    const s = statusRows.find((r) => String(r.name) === name);
    const counts = summary.perCamera.get(name);
    const online = s !== undefined && now - num(s.updated_at) < WORKER_TIMEOUT_MS;
    const connected = online && num(s?.connected) === 1;
    return {
      name,
      todayVisitors: counts?.today ?? 0,
      totalVisitors: counts?.total ?? 0,
      entries: counts?.total ?? 0,
      last5Minutes: counts?.last5Minutes ?? 0,
      online,
      connected,
      feedAvailable: connected && num(s?.feed_ok) === 1,
      fps: s ? num(s.fps) : 0,
      sessionEntries: s ? num(s.session_entries) : 0,
      lastSeenAt: s ? new Date(num(s.updated_at)).toISOString() : null,
    };
  });

  return NextResponse.json({
    todayVisitors: summary.todayVisitors,
    totalVisitors: summary.totalVisitors,
    // Estimates, not verified unique-person counts. Raw counts above are unchanged.
    estimatedTodayVisitors: estimate.estimatedTodayVisitors,
    estimatedTotalVisitors: estimate.estimatedTotalVisitors,
    timezone: summary.timezone,
    date: summary.date,
    event: { startDate: scope.startDate, endDate: scope.endDate },
    // Same as totalVisitors; kept for older consumers.
    total: summary.totalVisitors,
    last5Minutes: summary.last5Minutes,
    lastEntryAt: summary.lastEntryAt === null ? null : new Date(summary.lastEntryAt).toISOString(),
    serverTime: new Date(now).toISOString(),
    workerOnline: cameras.some((c) => c.online),
    cameras,
  });
}
