import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Sent by the Python worker about once per second (camera status, FPS).
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cameraConnected = body?.cameraConnected === true;
  const feedAvailable = body?.feedAvailable === true;
  const fps = typeof body?.fps === "number" && Number.isFinite(body.fps) ? body.fps : 0;
  const sessionEntries =
    typeof body?.sessionEntries === "number" && Number.isInteger(body.sessionEntries)
      ? body.sessionEntries
      : 0;

  getDb()
    .prepare(
      `INSERT INTO worker_status (id, camera_connected, feed_ok, fps, session_entries, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         camera_connected = excluded.camera_connected,
         feed_ok          = excluded.feed_ok,
         fps              = excluded.fps,
         session_entries  = excluded.session_entries,
         updated_at       = excluded.updated_at`,
    )
    .run(cameraConnected ? 1 : 0, feedAvailable ? 1 : 0, fps, sessionEntries, Date.now());

  return NextResponse.json({ ok: true });
}
