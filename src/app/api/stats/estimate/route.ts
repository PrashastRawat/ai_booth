import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { EVENT_TIMEZONE, isCalendarDate, zonedDate } from "@/lib/time";
import { DAILY_THRESHOLD, estimateDay } from "@/lib/estimate";

// Audit breakdown of the hourly-adjusted estimate for one IST day.
//   GET /api/stats/estimate                 -> today
//   GET /api/stats/estimate?date=2026-11-14
// Everything is recomputed from stored entries; nothing here is persisted.
export async function GET(request: NextRequest) {
  const now = Date.now();
  const date = request.nextUrl.searchParams.get("date") ?? zonedDate(now, EVENT_TIMEZONE);
  if (!isCalendarDate(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const day = estimateDay(getDb(), date, now, EVENT_TIMEZONE);
  const iso = (ms: number) => new Date(ms).toISOString();
  return NextResponse.json({
    note: "Estimated counts are an hourly-adjusted estimate, not verified unique visitors. Raw counts are unchanged.",
    timezone: EVENT_TIMEZONE,
    date: day.date,
    threshold: DAILY_THRESHOLD,
    rawVisitors: day.raw,
    estimatedVisitors: day.estimated,
    activatedAt: day.activatedAt === null ? null : iso(day.activatedAt),
    windows: day.windows.map((w) => ({
      start: iso(w.start),
      end: iso(w.end),
      complete: w.complete,
      rawEntries: w.raw,
      adjustmentPercent: w.rateBp / 100,
      deduction: w.deduction,
      adjustedEntries: w.adjusted,
    })),
  });
}
