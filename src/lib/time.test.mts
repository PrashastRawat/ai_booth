import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  checkEventTime,
  dayRangeUtc,
  isCalendarDate,
  parseEventScope,
  parseIsoTimestamp,
  zonedDate,
  zonedDayStartUtc,
  MAX_TIME_MS,
  MIN_TIME_MS,
} from "./time.ts";

const IST = "Asia/Kolkata";

test("IST midnight is 18:30 UTC on the previous day", () => {
  assert.equal(zonedDayStartUtc("2026-11-13", IST), Date.UTC(2026, 10, 12, 18, 30));
});

test("day range is half-open and 24h long", () => {
  const { start, end } = dayRangeUtc("2026-11-13", IST);
  assert.equal(start, Date.UTC(2026, 10, 12, 18, 30));
  assert.equal(end, Date.UTC(2026, 10, 13, 18, 30));
});

test("zonedDate uses IST, not the machine timezone", () => {
  // 18:29:59.999 UTC on Nov 13 is 23:59:59.999 IST Nov 13; one ms later is Nov 14 IST.
  assert.equal(zonedDate(Date.UTC(2026, 10, 13, 18, 29, 59, 999), IST), "2026-11-13");
  assert.equal(zonedDate(Date.UTC(2026, 10, 13, 18, 30), IST), "2026-11-14");
  assert.equal(zonedDate(Date.UTC(2026, 10, 13, 5, 0), IST), "2026-11-13");
});

test("DST zone boundaries still resolve to local midnight", () => {
  // New York switched to EDT on 2026-03-08 at 02:00, so midnight that day is still EST (UTC-5).
  assert.equal(zonedDayStartUtc("2026-03-08", "America/New_York"), Date.UTC(2026, 2, 8, 5));
  assert.equal(zonedDayStartUtc("2026-03-09", "America/New_York"), Date.UTC(2026, 2, 9, 4));
});

test("calendar dates are validated", () => {
  assert.ok(isCalendarDate("2026-11-13"));
  assert.ok(isCalendarDate("2028-02-29"));
  assert.ok(!isCalendarDate("2026-02-29"));
  assert.ok(!isCalendarDate("2026-13-01"));
  assert.ok(!isCalendarDate("2026-1-1"));
  assert.ok(!isCalendarDate(20261113));
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("timestamps need an explicit offset and a real date/time", () => {
  assert.equal(parseIsoTimestamp("2026-11-13T18:29:59.123Z"), Date.UTC(2026, 10, 13, 18, 29, 59, 123));
  assert.equal(parseIsoTimestamp("2026-11-13T18:29:59.123+00:00"), Date.UTC(2026, 10, 13, 18, 29, 59, 123));
  assert.equal(parseIsoTimestamp("2026-11-13T23:59:59+05:30"), Date.UTC(2026, 10, 13, 18, 29, 59));
  assert.equal(parseIsoTimestamp("2026-11-13T18:29:59.123456Z"), Date.UTC(2026, 10, 13, 18, 29, 59, 123));
  // No offset: would be read in the server's local timezone, so rejected.
  assert.equal(parseIsoTimestamp("2026-11-13T18:29:59"), null);
  assert.equal(parseIsoTimestamp("2026-11-13"), null);
  assert.equal(parseIsoTimestamp("2026-02-30T10:00:00Z"), null);
  assert.equal(parseIsoTimestamp("2026-11-13T24:00:00Z"), null);
  assert.equal(parseIsoTimestamp("2026-11-13T10:00:00+15:00"), null);
  assert.equal(parseIsoTimestamp("Fri, 13 Nov 2026 10:00:00 GMT"), null);
  assert.equal(parseIsoTimestamp(1_700_000_000_000), null);
});

test("clock-skew policy", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  assert.equal(checkEventTime(now, now), null);
  assert.equal(checkEventTime(now + 60_000, now), null);
  assert.match(checkEventTime(now + 60_001, now) ?? "", /ahead/);
  assert.equal(checkEventTime(now - 24 * 3_600_000, now), null);
  assert.match(checkEventTime(now - 24 * 3_600_000 - 1, now) ?? "", /older/);
});

test("event scope", () => {
  const open = parseEventScope(undefined, "", IST);
  assert.deepEqual([open.startDate, open.endDate, open.startMs, open.endMs], [null, null, MIN_TIME_MS, MAX_TIME_MS]);

  const s = parseEventScope("2026-11-14", "2026-11-25", IST);
  assert.equal(s.startMs, Date.UTC(2026, 10, 13, 18, 30));
  assert.equal(s.endMs, Date.UTC(2026, 10, 25, 18, 30)); // start of Nov 26 IST, exclusive

  assert.throws(() => parseEventScope("14-11-2026", null, IST), /EVENT_START_DATE/);
  assert.throws(() => parseEventScope("2026-11-25", "2026-11-14", IST), /before/);
});
