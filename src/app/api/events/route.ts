import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { recordEntry } from "@/lib/visitors";

// Called by the Python worker for every confirmed entry.
// Idempotent: the same event ID is stored once, so retries are safe.
// Timestamp rules (explicit UTC offset, at most 60 s ahead of the server clock,
// at most 24 h old) are described in the README under "Timestamps and clock skew".
export async function POST(request: Request) {
  const receivedMs = Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = recordEntry(getDb(), body, receivedMs);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { id: result.id, inserted: result.inserted, date: result.date },
    { status: result.inserted ? 201 : 200 },
  );
}
