import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";
import { eventScopeFromEnv } from "@/lib/visitors";
import { projectionSummary, startProjection, stopProjection, touchProjection } from "@/lib/projection";

// Projection session control for the admin dashboard.
//   GET  /api/projection                      -> status and the stored session segments (audit)
//   POST /api/projection {"action":"start"}   -> start a session (no-op if already active)
//   POST /api/projection {"action":"stop"}    -> stop it; accrued projection is kept
// The projection is synthetic and never touches the `entries` table.

function status() {
  const db = getDb();
  const now = Date.now();
  touchProjection(db, now);
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
  return {
    note: "Projected visitors are synthetic (1,000 per active hour), not camera-detected.",
    active: p.active,
    activeSince: p.activeSince === null ? null : new Date(p.activeSince).toISOString(),
    activeTodaySeconds: Math.floor(p.activeTodayMs / 1000),
    additionalToday: p.additionalToday,
    additionalTotal: p.additionalTotal,
    segments,
  };
}

export async function GET() {
  await connection();
  try {
    return NextResponse.json(status());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const now = Date.now();
  if (body?.action === "start") startProjection(getDb(), now);
  else if (body?.action === "stop") stopProjection(getDb(), now);
  else return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  try {
    return NextResponse.json(status());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
