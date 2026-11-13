import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { EVENT_TIMEZONE, addDays, isCalendarDate, zonedDate } from "@/lib/time";
import { dailyCounts, eventScopeFromEnv } from "@/lib/visitors";

const MAX_DAYS = 366;

// Visitors per IST calendar day, split by camera.
//   GET /api/stats/daily                          -> event period (EVENT_START_DATE..EVENT_END_DATE), else today
//   GET /api/stats/daily?date=2026-11-13          -> one day
//   GET /api/stats/daily?from=2026-11-13&to=2026-11-24
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  let scope;
  try {
    scope = eventScopeFromEnv();
  } catch (err) {
    return NextResponse.json({ error: `Invalid event configuration: ${(err as Error).message}` }, { status: 500 });
  }

  const today = zonedDate(Date.now(), EVENT_TIMEZONE);
  const single = params.get("date");
  const from = single ?? params.get("from") ?? scope.startDate ?? today;
  const to = single ?? params.get("to") ?? scope.endDate ?? today;

  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    return NextResponse.json({ error: "date, from and to must be YYYY-MM-DD" }, { status: 400 });
  }
  if (to < from) {
    return NextResponse.json({ error: "to must not be before from" }, { status: 400 });
  }
  if (addDays(from, MAX_DAYS - 1) < to) {
    return NextResponse.json({ error: `at most ${MAX_DAYS} days per request` }, { status: 400 });
  }

  const days = dailyCounts(getDb(), from, to, EVENT_TIMEZONE);
  return NextResponse.json({
    timezone: EVENT_TIMEZONE,
    from,
    to,
    visitors: days.reduce((n, d) => n + d.visitors, 0),
    days,
  });
}
