import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const CAMERA_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Called by the Python worker for every confirmed entry.
// Idempotent: the same event ID is stored once, so retries are safe.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { id, occurredAt, trackId } = body ?? {};
  const camera = body?.camera ?? "A";

  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return NextResponse.json({ error: "id must be a UUID-like string" }, { status: 400 });
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    return NextResponse.json({ error: "occurredAt must be an ISO timestamp" }, { status: 400 });
  }
  if (typeof camera !== "string" || !CAMERA_PATTERN.test(camera)) {
    return NextResponse.json({ error: "camera must be a short name" }, { status: 400 });
  }
  if (trackId !== undefined && trackId !== null && !Number.isInteger(trackId)) {
    return NextResponse.json({ error: "trackId must be an integer" }, { status: 400 });
  }

  const result = getDb()
    .prepare(
      "INSERT OR IGNORE INTO entries (id, occurred_at, track_id, received_at, camera) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      id,
      Date.parse(occurredAt),
      typeof trackId === "number" ? trackId : null,
      Date.now(),
      camera,
    );

  const inserted = Number(result.changes) === 1;
  return NextResponse.json({ id, inserted }, { status: inserted ? 201 : 200 });
}
