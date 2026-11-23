import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";
import { eventScopeFromEnv } from "@/lib/visitors";
import { CURRENT_RATE, EARLY_RATE, LEGACY_RATE, PACE_SWITCH_HOUR, projectionSummary } from "@/lib/projection";

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
      db.prepare("SELECT started_at, ended_at, rate_visitors, rate_seconds FROM projection_segments ORDER BY started_at").all() as {
        started_at: number | bigint;
        ended_at: number | bigint | null;
        rate_visitors: number | bigint | null;
        rate_seconds: number | bigint | null;
      }[]
    ).map((s) => ({
      start: new Date(Number(s.started_at)).toISOString(),
      end: s.ended_at === null ? null : new Date(Number(s.ended_at)).toISOString(),
      // null = recorded before rates were versioned, valued at the legacy rate.
      rate: s.rate_visitors === null || s.rate_seconds === null ? null : { visitors: Number(s.rate_visitors), activeSeconds: Number(s.rate_seconds) },
    }));
    return NextResponse.json({
      note: `Projected visitors are synthetic, not camera-detected: ${((CURRENT_RATE.visitors * 3600) / CURRENT_RATE.seconds).toLocaleString("en-IN")} per active hour for new activity from ${PACE_SWITCH_HOUR}:00 IST (${((EARLY_RATE.visitors * 3600) / EARLY_RATE.seconds).toLocaleString("en-IN")} per active hour before); earlier activity keeps its recorded rate (unversioned sessions: ${LEGACY_RATE.visitors.toLocaleString("en-IN")} per hour). The session is automatic: active while a dashboard or the worker is online.`,
      currentRate: { visitors: CURRENT_RATE.visitors, activeSeconds: CURRENT_RATE.seconds },
      legacyRate: { visitors: LEGACY_RATE.visitors, activeSeconds: LEGACY_RATE.seconds },
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
