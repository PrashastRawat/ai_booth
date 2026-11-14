import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";
import { eventScopeFromEnv } from "@/lib/visitors";
import { projectionSummary } from "@/lib/projection";

// Projection status and audit for the admin dashboard.
//   GET /api/projection -> status and the stored session segments
// The session is AUTOMATIC: it starts with the first dashboard poll or worker heartbeat
// and pauses by itself when neither has been seen for a couple of minutes. There is no
// manual start/stop any more. The projection is synthetic and never touches `entries`.
export async function GET() {
  await connection();
  try {
    const db = getDb();
    const now = Date.now();
    const p = projectionSummary(db, now, eventScopeFromEnv());
    const segments = (
      db.prepare("SELECT started_at, ended_at FROM projection_segments ORDER BY started_at").all() as {
        started_at: number | bigint;
        ended_at: number | bigint | null;
      }[]
    ).map((s) => ({
      start: new Date(Number(s.started_at)).toISOString(),
      end: s.ended_at === null ? null : new Date(Number(s.ended_at)).toISOString(),
    }));
    return NextResponse.json({
      note: "Projected visitors are synthetic (1,000 per active hour), not camera-detected. The session is automatic: active while a dashboard or the worker is online.",
      automatic: true,
      active: p.active,
      activeSince: p.activeSince === null ? null : new Date(p.activeSince).toISOString(),
      activeTodaySeconds: Math.floor(p.activeTodayMs / 1000),
      additionalToday: p.additionalToday,
      additionalTotal: p.additionalTotal,
      segments,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
