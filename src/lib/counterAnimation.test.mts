import { test } from "node:test";
import assert from "node:assert/strict";
import { ANIMATION, CounterAnimator, advanceBy, nextTickDelay, paceFromActivity, reconcile, tickAmount, type Counts } from "./counterAnimation.ts";
import { odometerDigits, rollWheel, STRIP_LENGTH } from "./odometerWheel.ts";

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed = 7): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fake clock + scheduler; records every displayed value with its time. */
function harness(seed = 7) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let hidden = false;
  const shown: { at: number; v: Counts }[] = [];
  const anim = new CounterAnimator(
    (v) => shown.push({ at: now, v }),
    {
      set: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (h) => void timers.delete(h as number),
      now: () => now,
    },
    () => hidden,
    rng(seed),
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return {
    anim,
    shown,
    advance,
    pending: () => timers.size,
    setHidden: (h: boolean) => {
      hidden = h;
      anim.visibilityChanged();
    },
  };
}

const C = (today: number, total: number): Counts => ({ today, total });

/** Gaps between consecutive displayed changes after the first (ms). */
const gaps = (shown: { at: number }[]) => shown.slice(1).map((s, i) => s.at - shown[i].at);

/** Feeds one poll every 30 s at `perHour` and checks the display after each interval. */
function runPolls(seed: number, perHour: number, polls: number) {
  const h = harness(seed);
  h.anim.setTarget(C(12_400, 50_000));
  let previous = 0;
  const jumps: number[] = [];
  for (let poll = 1; poll <= polls; poll++) {
    const projected = Math.floor((poll * 30 * perHour) / 3600);
    const target = C(12_400 + projected, 50_000 + projected);
    const from = h.shown.length;
    h.anim.setTarget(target);
    assert.equal(h.shown.length, from, "a new snapshot never changes the display at once");
    h.advance(30_000);
    assert.deepEqual(h.anim.value, target, `seed ${seed}, poll ${poll}: increase fully shown before the next poll`);
    let last = h.shown[from - 1].v;
    for (const { v } of h.shown.slice(from)) {
      assert.ok(v.today <= target.today && v.total <= target.total, "never above this poll's target");
      assert.equal(v.total - v.today, 37_600, "both counters change together");
      jumps.push(v.today - last.today);
      last = v;
    }
    previous = projected;
  }
  return { h, previous, jumps };
}

test("first value (page load / refresh) is shown directly, not replayed from zero", () => {
  const h = harness();
  h.anim.setTarget(C(12_400, 101_220));
  assert.deepEqual(h.shown.map((s) => s.v), [C(12_400, 101_220)]);
  assert.equal(h.pending(), 0);
});

test("6,500/hour: numbers change every 3-5 s, in varying small amounts, and keep up for an hour", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { h, previous, jumps } = runPolls(seed, 6500, 120);
    assert.equal(previous, 6500);
    for (const g of gaps(h.shown)) assert.ok(g >= 3_000 && g <= 5_000, `seed ${seed}: change after ${g} ms`);
    assert.ok(jumps.every((j) => j >= 1 && j <= 20), `seed ${seed}: changes stay small (max ${Math.max(...jumps)})`);
    assert.ok(new Set(jumps).size >= 5, "amounts vary naturally");
    assert.ok(new Set(gaps(h.shown)).size > 50, "timing varies naturally");
  }
});

test("2,000/hour (before 11:00): small changes of a few visitors every 3-5 s", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { h, previous, jumps } = runPolls(seed, 2000, 60);
    assert.equal(previous, 1000);
    for (const g of gaps(h.shown)) assert.ok(g >= 3_000, `change after ${g} ms`);
    assert.ok(jumps.every((j) => j >= 1 && j <= 8), `max ${Math.max(...jumps)}`);
  }
});

test("a small increase is shown as several small changes, never faster than every 3 s", () => {
  const h = harness();
  h.anim.setTarget(C(10, 20));
  h.anim.setTarget(C(14, 24));
  for (let i = 0; i < 50; i++) h.anim.setTarget(C(14, 24)); // repeated identical polls change nothing
  h.advance(60_000);
  assert.deepEqual(h.anim.value, C(14, 24));
  assert.ok(h.shown.length >= 3, "spread over several changes");
  for (const g of gaps(h.shown)) assert.ok(g >= 3_000);
});

test("an API update during an animation moves the target; no restart, no duplicate delta", () => {
  const h = harness();
  h.anim.setTarget(C(100, 1000));
  h.anim.setTarget(C(150, 1050));
  h.advance(12_000); // part-way
  const mid = h.anim.value!;
  assert.ok(mid.today > 100 && mid.today < 150);
  h.anim.setTarget(C(160, 1060)); // newer snapshot arrives mid-animation
  assert.deepEqual(h.anim.value, mid, "no jump on update");
  h.advance(60_000);
  assert.deepEqual(h.anim.value, C(160, 1060), "stops at the latest target, never above it");
  for (const g of gaps(h.shown)) assert.ok(g >= 3_000);
});

test("one missed poll and extra camera entries still catch up by the next poll", () => {
  const h = harness();
  h.anim.setTarget(C(100, 1000));
  let target = C(100, 1000);
  for (const increment of [54, 108, 55, 61, 54]) {
    target = C(target.today + increment, target.total + increment);
    h.anim.setTarget(target);
    h.advance(30_000);
    assert.deepEqual(h.anim.value, target);
  }
});

test("large backlog (outage / restart) synchronises directly instead of replaying", () => {
  const h = harness();
  h.anim.setTarget(C(500, 5000));
  const far = ANIMATION.maxAnimatedBacklog + 1;
  h.anim.setTarget(C(500 + far, 5000 + far));
  assert.deepEqual(h.anim.value, C(500 + far, 5000 + far));
  assert.equal(h.pending(), 0);
  // The largest animated backlog still finishes within one poll interval.
  const h2 = harness();
  h2.anim.setTarget(C(0, 0));
  h2.anim.setTarget(C(ANIMATION.maxAnimatedBacklog, ANIMATION.maxAnimatedBacklog));
  h2.advance(30_000);
  assert.equal(h2.anim.value!.today, ANIMATION.maxAnimatedBacklog);
});

test("hidden tab: no replay; on return it shows the latest snapshot at once", () => {
  const h = harness();
  h.anim.setTarget(C(100, 1000));
  h.setHidden(true);
  h.anim.setTarget(C(140, 1040));
  h.anim.setTarget(C(180, 1080));
  assert.equal(h.pending(), 0, "no timers while hidden");
  h.setHidden(false);
  assert.deepEqual(h.anim.value, C(180, 1080));
  h.anim.setTarget(C(190, 1090));
  h.advance(30_000);
  assert.deepEqual(h.anim.value, C(190, 1090));
});

test("hidden mid-animation: the pending change syncs instead of continuing to replay", () => {
  const h = harness();
  h.anim.setTarget(C(0, 0));
  h.anim.setTarget(C(20, 20));
  h.advance(4_000);
  h.setHidden(true);
  assert.deepEqual(h.anim.value, C(20, 20));
  assert.equal(h.pending(), 0);
});

test("IST midnight: today resets directly while total keeps increasing", () => {
  const h = harness();
  h.anim.setTarget(C(18_541, 101_220));
  h.anim.setTarget(C(3, 101_226)); // first poll after midnight
  const first = h.anim.value!;
  assert.equal(first.today, 3, "today drops at once, never animated backwards");
  assert.equal(first.total, 101_220, "total does not jump");
  h.advance(30_000);
  assert.deepEqual(h.anim.value, C(3, 101_226));
  assert.ok(h.shown.every((s) => s.v.total >= 101_220), "total never decreases");
});

test("reconcile, advanceBy and tickAmount never overshoot", () => {
  assert.deepEqual(reconcile(null, C(5, 9)), C(5, 9));
  assert.deepEqual(reconcile(C(10, 10), C(4, 12)), C(4, 10));
  assert.deepEqual(advanceBy(C(4, 10), C(4, 12), 7), C(4, 12));
  assert.deepEqual(advanceBy(C(4, 10), C(9, 30), 3), C(7, 13));
  const r = rng(5);
  for (let i = 0; i < 1000; i++) {
    const remaining = 1 + Math.floor(r() * 200);
    const a = tickAmount(remaining, r() * 30_000, r);
    assert.ok(a >= 1 && a <= remaining);
  }
  assert.equal(tickAmount(17, 4_999, r), 17, "last change before the deadline shows the rest");
  for (let i = 0; i < 1000; i++) {
    const d = nextTickDelay(r);
    assert.ok(d >= 3_000 && d <= 5_000);
  }
});

// ---- Camera activity sets the rhythm; the hourly total stays 6,500 ----

/** One hour of 30 s polls at 6,500/h with the given camera activity per poll. */
function runWithActivity(seed: number, activity: (poll: number) => number, polls = 120) {
  const h = harness(seed);
  h.anim.setActivity(activity(0));
  h.anim.setTarget(C(10_000, 80_000));
  const lag: number[] = [];
  let target = C(10_000, 80_000);
  for (let poll = 1; poll <= polls; poll++) {
    const projected = Math.floor((poll * 30 * 6500) / 3600);
    target = C(10_000 + projected, 80_000 + projected);
    h.anim.setActivity(activity(poll));
    h.anim.setTarget(target);
    h.advance(30_000);
    const v = h.anim.value!;
    assert.ok(v.today <= target.today && v.total <= target.total, "never above the API");
    assert.equal(v.total - v.today, 70_000, "both counters together");
    lag.push(target.today - v.today);
  }
  return { h, lag, target };
}

test("paceFromActivity: fewer detections than usual slow down, more speed up, bounded", () => {
  assert.equal(paceFromActivity(40, 40), 1);
  assert.ok(paceFromActivity(5, 40) < 0.5);
  assert.ok(paceFromActivity(120, 40) > 1.5);
  assert.equal(paceFromActivity(0, 1000), ANIMATION.minPace);
  assert.equal(paceFromActivity(5000, 10), ANIMATION.maxPace);
  assert.equal(paceFromActivity(0, 0), 1, "no camera data: usual pace");
});

test("quiet cameras: longer pauses and the display trails; busy cameras: it catches up", () => {
  for (let seed = 1; seed <= 8; seed++) {
    // 20 min usual, 20 min quiet, 20 min busy (camera entries in the last 5 minutes).
    const act = (p: number) => (p <= 40 ? 40 : p <= 80 ? 4 : 120);
    const { h, lag } = runWithActivity(seed, act);
    const gapsIn = (from: number, to: number) => {
      const s = h.shown.filter((x) => x.at > from * 30_000 && x.at <= to * 30_000);
      return gaps(s);
    };
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const usual = gapsIn(5, 40);
    const quiet = gapsIn(45, 80);
    assert.ok(avg(quiet) > avg(usual) * 1.2, `seed ${seed}: quieter means slower (${avg(usual)} -> ${avg(quiet)})`);
    assert.ok(quiet.some((g) => g > 5_000), "pauses while quiet");
    assert.ok(Math.max(...lag.slice(45, 80)) > Math.max(...lag.slice(5, 40)), "display trails while quiet");
    assert.ok(Math.max(...lag) < ANIMATION.maxAnimatedBacklog, "bounded: never so far behind that it has to jump");
    assert.equal(lag[lag.length - 1], 0, "caught up once busy");
    for (const g of gaps(h.shown)) assert.ok(g >= 3_000, "never faster than every 3 s");
  }
});

test("over the hour the display reaches exactly the API's 6,500, whatever the activity", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = rng(seed * 101);
    let level = 40;
    const act = () => (level = Math.max(0, Math.min(150, level + Math.round((r() - 0.5) * 30))));
    const { h, target } = runWithActivity(seed, act);
    // Let the last increase play out at usual activity (no new API data).
    h.anim.setActivity(40);
    h.advance(120_000);
    assert.deepEqual(h.anim.value, target);
    assert.equal(target.today - 10_000, 6500, "exactly 6,500 in the hour");
    let prev = h.shown[0].v.today;
    for (const { v } of h.shown.slice(1)) {
      assert.ok(v.today - prev <= 70, `no big jumps (${v.today - prev})`);
      prev = v.today;
    }
  }
});

// ---- Odometer wheels: +1 steps through carries ----

/** Drives one wheel per place value through `values`, like Odometer.tsx does. */
function driveWheels(values: number[], minDigits = 6) {
  let digits = odometerDigits(values[0], minDigits);
  let pos = digits.map((d) => d); // initial strip position = digit
  for (const v of values.slice(1)) {
    const next = odometerDigits(v, minDigits);
    assert.equal(next.length, digits.length);
    pos = pos.map((p, i) => {
      const move = rollWheel(p, next[i]);
      if (!move) return p;
      const from = move.snapFrom ?? p;
      assert.equal(from % 10, p % 10, "a snap never changes the visible digit");
      assert.equal(move.to - from, (next[i] - digits[i] + 10) % 10, "rolls upward only");
      assert.ok(move.to >= 0 && move.to < STRIP_LENGTH);
      assert.equal(move.to % 10, next[i]);
      return move.to;
    });
    digits = next;
    assert.equal(Number(pos.map((p) => p % 10).join("")), v);
  }
}

test("carries animate correctly: 9 -> 10, 99 -> 100, 9,999 -> 10,000, 99,999 -> 100,000", () => {
  for (const [a, b] of [[0, 30], [90, 120], [9_990, 10_020], [99_990, 100_010]]) {
    driveWheels(Array.from({ length: b - a + 1 }, (_, i) => a + i));
  }
  assert.deepEqual(odometerDigits(9_999, 6), [0, 0, 9, 9, 9, 9]);
  assert.deepEqual(odometerDigits(10_000, 6), [0, 1, 0, 0, 0, 0]);
  // Each wheel moves exactly one place per +1 step at a carry.
  assert.deepEqual(rollWheel(9, 0), { snapFrom: null, to: 10 });
  assert.deepEqual(rollWheel(19, 0), { snapFrom: 9, to: 10 });
});

test("a long +1 run keeps every wheel on the strip", () => {
  driveWheels(Array.from({ length: 3000 }, (_, i) => 8_500 + i));
});
