import { test } from "node:test";
import assert from "node:assert/strict";
import { ANIMATION, CounterAnimator, nextDelay, reconcile, stepOnce, type Counts } from "./counterAnimation.ts";
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

/** Every displayed transition after the first is +0/+1 per counter (or an allowed snap). */
function assertUnitSteps(shown: { v: Counts }[], from = 1) {
  for (let i = Math.max(1, from); i < shown.length; i++) {
    const a = shown[i - 1].v;
    const b = shown[i].v;
    assert.ok(b.today - a.today >= 0 && b.today - a.today <= 1, `today ${a.today} -> ${b.today}`);
    assert.ok(b.total - a.total >= 0 && b.total - a.total <= 1, `total ${a.total} -> ${b.total}`);
  }
}

test("first value (page load / refresh) is shown directly, not replayed from zero", () => {
  const h = harness();
  h.anim.setTarget(C(12_400, 101_220));
  assert.deepEqual(h.shown.map((s) => s.v), [C(12_400, 101_220)]);
  assert.equal(h.pending(), 0);
});

test("12,400 -> 12,450 passes through every integer, both counters together, within one poll", () => {
  const h = harness();
  h.anim.setTarget(C(12_400, 50_000));
  h.anim.setTarget(C(12_450, 50_050));
  h.advance(30_000);
  const todays = h.shown.map((s) => s.v.today);
  assert.deepEqual(todays, Array.from({ length: 51 }, (_, i) => 12_400 + i));
  for (const s of h.shown) assert.equal(s.v.total - s.v.today, 37_600, "same snapshot, same step");
  assert.ok(h.shown[h.shown.length - 1].at <= 30_000, "finishes before the next poll");
});

test("small camera-only deltas spread steps out with variation, never above target", () => {
  const h = harness(3);
  h.anim.setTarget(C(1000, 9000));
  let target = C(1000, 9000);
  for (let poll = 0; poll < 40; poll++) {
    target = C(target.today + 5, target.total + 5);
    h.anim.setTarget(target);
    h.advance(30_000);
    for (const s of h.shown) assert.ok(s.v.today <= target.today && s.v.total <= target.total);
  }
  assert.deepEqual(h.shown[h.shown.length - 1].v, target);
  assertUnitSteps(h.shown);
  const gaps = h.shown.slice(1).map((s, i) => s.at - h.shown[i].at).filter((g) => g < 30_000);
  assert.ok(new Set(gaps).size > 20, "timing varies");
  assert.ok(gaps.some((g) => g < ANIMATION.minStepMs * 1.31), "occasional quick bursts");
  assert.ok(gaps.some((g) => g > 4_000), "unhurried steps at live pace");
});

test("6,500/hour: both counters sustain 54-55 consecutive increments every 30 s for an hour", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const h = harness(seed);
    h.anim.setTarget(C(12_400, 50_000));
    let previous = 0;
    for (let poll = 1; poll <= 120; poll++) {
      const projected = Math.floor((poll * 30 * 6500) / 3600);
      const target = C(12_400 + projected, 50_000 + projected);
      const from = h.shown.length;
      h.anim.setTarget(target);
      h.advance(30_000);
      const steps = h.shown.slice(from);
      assert.equal(steps.length, projected - previous, `seed ${seed}, poll ${poll}: no skipped integers`);
      assert.deepEqual(h.anim.value, target, `seed ${seed}, poll ${poll}: no growing backlog`);
      assert.equal(h.pending(), 0, "caught up before the next poll");
      for (const { v } of steps) {
        assert.ok(v.today <= target.today && v.total <= target.total, "never above this poll's target");
        assert.equal(v.total - v.today, 37_600, "both odometers advance together");
      }
      previous = projected;
    }
    assert.equal(previous, 6500);
    assertUnitSteps(h.shown);
  }
});

test("one missed poll and extra camera entries catch up through +1 steps before the next poll", () => {
  const h = harness();
  h.anim.setTarget(C(100, 1000));
  let target = C(100, 1000);
  for (const increment of [54, 108, 55, 61, 54]) {
    target = C(target.today + increment, target.total + increment);
    const from = h.shown.length;
    h.anim.setTarget(target);
    h.advance(30_000);
    assert.deepEqual(h.anim.value, target);
    assert.equal(h.shown.length - from, increment);
    assert.ok(h.shown.slice(from).every(({ v }) => v.today <= target.today && v.total <= target.total));
  }
  assertUnitSteps(h.shown);
});

test("bursts are 2-4 rapid +1 steps, never a jump", () => {
  for (let seed = 1; seed < 30; seed++) {
    const pacer = { burstLeft: 0 };
    const r = rng(seed);
    let run = 0;
    for (let i = 0; i < 2000; i++) {
      const d = nextDelay(50, 25_000, r, pacer);
      assert.ok(d >= ANIMATION.minStepMs, "never faster than the minimum step");
      if (d <= ANIMATION.minStepMs * 1.3) run++;
      else run = 0;
    }
    assert.ok(run < 50);
  }
});

test("a random pause reserves enough time for every remaining step before the deadline", () => {
  for (const remaining of [1, 2, 54, ANIMATION.maxAnimatedBacklog]) {
    const timeLeft = remaining * ANIMATION.minStepMs + 500;
    // No burst, maximum ordinary variation, then an extra pause.
    const values = [1, 1, 0];
    const delay = nextDelay(remaining, timeLeft, () => values.shift() ?? 0, { burstLeft: 0 });
    assert.ok(delay + (remaining - 1) * ANIMATION.minStepMs <= timeLeft);
  }
});

test("an API update during an animation moves the target; no restart, no duplicate delta", () => {
  const h = harness();
  h.anim.setTarget(C(100, 1000));
  h.anim.setTarget(C(110, 1010));
  h.advance(8_000); // part-way
  const mid = h.shown[h.shown.length - 1].v;
  assert.ok(mid.today > 100 && mid.today < 110);
  h.anim.setTarget(C(115, 1015)); // newer snapshot arrives mid-animation
  assert.deepEqual(h.shown[h.shown.length - 1].v, mid, "no jump on update");
  h.advance(60_000);
  assert.deepEqual(h.shown[h.shown.length - 1].v, C(115, 1015), "stops at the latest target, never 125");
  assertUnitSteps(h.shown);
});

test("multiple rapid identical polls change nothing", () => {
  const h = harness();
  h.anim.setTarget(C(10, 20));
  h.anim.setTarget(C(14, 24));
  for (let i = 0; i < 50; i++) h.anim.setTarget(C(14, 24));
  h.advance(60_000);
  assert.deepEqual(h.shown.map((s) => s.v.today), [10, 11, 12, 13, 14]);
});

test("large backlog (outage / restart) synchronises directly instead of replaying", () => {
  const h = harness();
  h.anim.setTarget(C(500, 5000));
  h.anim.setTarget(C(500 + ANIMATION.maxAnimatedBacklog + 1, 5000 + ANIMATION.maxAnimatedBacklog + 1));
  assert.deepEqual(h.shown[h.shown.length - 1].v, C(500 + ANIMATION.maxAnimatedBacklog + 1, 5000 + ANIMATION.maxAnimatedBacklog + 1));
  assert.equal(h.pending(), 0);
  // The largest animated backlog still finishes within one poll interval.
  const h2 = harness();
  h2.anim.setTarget(C(0, 0));
  h2.anim.setTarget(C(ANIMATION.maxAnimatedBacklog, ANIMATION.maxAnimatedBacklog));
  h2.advance(30_000);
  assert.equal(h2.shown[h2.shown.length - 1].v.today, ANIMATION.maxAnimatedBacklog);
  assertUnitSteps(h2.shown);
});

test("hidden tab: no replay; on return it shows the latest snapshot at once", () => {
  const h = harness();
  h.anim.setTarget(C(100, 1000));
  h.setHidden(true);
  h.anim.setTarget(C(140, 1040));
  h.anim.setTarget(C(180, 1080));
  assert.equal(h.pending(), 0, "no timers while hidden");
  h.setHidden(false);
  assert.deepEqual(h.shown[h.shown.length - 1].v, C(180, 1080));
  h.anim.setTarget(C(183, 1083));
  h.advance(30_000);
  assert.deepEqual(h.shown.slice(-3).map((s) => s.v.today), [181, 182, 183]);
});

test("hidden mid-animation: the pending step syncs instead of continuing to replay", () => {
  const h = harness();
  h.anim.setTarget(C(0, 0));
  h.anim.setTarget(C(20, 20));
  h.advance(3_000);
  h.setHidden(true);
  assert.deepEqual(h.shown[h.shown.length - 1].v, C(20, 20));
  assert.equal(h.pending(), 0);
});

test("IST midnight: today resets directly while total keeps increasing by +1", () => {
  const h = harness();
  h.anim.setTarget(C(18_541, 101_220));
  h.anim.setTarget(C(3, 101_226)); // first poll after midnight
  const first = h.shown[h.shown.length - 1].v;
  assert.equal(first.today, 3, "today drops at once, never animated backwards");
  assert.equal(first.total, 101_220, "total does not jump");
  h.advance(30_000);
  assert.deepEqual(h.shown[h.shown.length - 1].v, C(3, 101_226));
  assertUnitSteps(h.shown, 2);
  assert.ok(h.shown.every((s) => s.v.total >= 101_220), "total never decreases");
});

test("reconcile and stepOnce never overshoot", () => {
  assert.deepEqual(reconcile(null, C(5, 9)), C(5, 9));
  assert.deepEqual(reconcile(C(10, 10), C(4, 12)), C(4, 10));
  assert.deepEqual(stepOnce(C(4, 10), C(4, 12)), C(4, 11));
  assert.deepEqual(stepOnce(C(4, 12), C(4, 12)), C(4, 12));
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
