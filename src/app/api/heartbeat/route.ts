import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { touchProjection } from "@/lib/projection";

const CAMERA_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Sent by the Python worker about once per second with the health of every camera.
// Body: { cameras: { A: { connected, feedAvailable, fps, sessionEntries }, B: {...} } }
export async function POST(request: Request) {
  let body: { cameras?: Record<string, Record<string, unknown>> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const cameras = body?.cameras;
  if (!cameras || typeof cameras !== "object") {
    return NextResponse.json({ error: "cameras object required" }, { status: 400 });
  }

  const upsert = getDb().prepare(
    `INSERT INTO camera_status (name, connected, feed_ok, fps, session_entries, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       connected       = excluded.connected,
       feed_ok         = excluded.feed_ok,
       fps             = excluded.fps,
       session_entries = excluded.session_entries,
       updated_at      = excluded.updated_at`,
  );
  const now = Date.now();
  // A running worker keeps an active projection session alive (no camera data is changed).
  touchProjection(getDb(), now);
  let count = 0;
  for (const [name, s] of Object.entries(cameras)) {
    if (!CAMERA_PATTERN.test(name) || !s || typeof s !== "object") continue;
    const fps = typeof s.fps === "number" && Number.isFinite(s.fps) ? s.fps : 0;
    const sessionEntries = Number.isInteger(s.sessionEntries) ? (s.sessionEntries as number) : 0;
    upsert.run(name, s.connected === true ? 1 : 0, s.feedAvailable === true ? 1 : 0, fps, sessionEntries, now);
    count++;
  }
  return NextResponse.json({ ok: true, cameras: count });
}
