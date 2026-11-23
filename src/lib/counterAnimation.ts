// Display-only animation of the public counters. GET /api/stats stays the single source
// of truth; this only decides which number the odometers SHOW on the way to the latest
// authoritative snapshot. It never creates records, never changes API totals and never
// shows a number above the latest target.
//
// Policy:
//  - First value (page load / refresh): shown directly, never replayed from zero.
//  - Increase: advanced in consecutive +1 steps, paced to finish before the next poll,
//    with natural timing variation, occasional short pauses and occasional bursts of
//    2-4 rapid +1 steps. A step never skips an integer.
//  - A newer snapshot during an animation only moves the target; the running cadence
//    continues from the number on screen, so a delta is never added twice.
//  - Decrease (IST midnight reset of Today's Visitors, or a correction): shown directly,
//    never animated backwards.
//  - Backlog too large to animate within one poll interval (outage, restart, long-hidden
//    tab), or the tab is hidden: synchronised directly to the latest target.
//  - Today and Total advance together in the same step, so both stay on one snapshot.

export type Counts = { today: number; total: number };

// Tuned for 6,500 projected visitors per hour: about 54 per 30 s poll (1.81 a second),
// so a normal poll is spread as ~0.5 s steps over most of the interval and finishes just
// before the next one: the counter keeps moving without stop-go pauses and no backlog
// builds up. One missed poll (~108) is still animated, as rapid +1 steps (21.6 s at the
// fastest pace); a longer gap synchronises.
export const ANIMATION = {
  /** Spread a backlog over this much of the 30 s poll interval. */
  budgetMs: 28_000,
  /** Fastest +1 step; wheel rolls must finish inside this interval. */
  minStepMs: 200,
  /** Slowest normal +1 step (only reached when very little arrives, e.g. camera-only counts). */
  maxStepMs: 7_000,
  /** Largest backlog animated step by step (140); above it the display synchronises. */
  maxAnimatedBacklog: Math.floor(28_000 / 200),
  /** Chance that a step starts a burst of 2-4 rapid steps (needs backlog >= 3). */
  burstChance: 0.1,
  /** Chance of a short extra pause before an ordinary step. */
  pauseChance: 0.08,
} as const;

const same = (a: Counts | null, b: Counts | null) => a !== null && b !== null && a.today === b.today && a.total === b.total;

/** Steps still to show before the display reaches the target. */
export function backlog(display: Counts, target: Counts): number {
  return Math.max(0, target.today - display.today, target.total - display.total);
}

/**
 * Where the display should be the moment a new target arrives: unchanged when it can be
 * animated, otherwise synchronised (first value, decrease, or a backlog too large).
 */
export function reconcile(display: Counts | null, target: Counts): Counts {
  if (display === null) return { ...target };
  const next = { today: Math.min(display.today, target.today), total: Math.min(display.total, target.total) };
  return backlog(next, target) > ANIMATION.maxAnimatedBacklog ? { ...target } : next;
}

/** One visual step: +1 on every counter that is below its target. Never overshoots. */
export function stepOnce(display: Counts, target: Counts): Counts {
  return {
    today: display.today < target.today ? display.today + 1 : display.today,
    total: display.total < target.total ? display.total + 1 : display.total,
  };
}

export type Pacer = { burstLeft: number };

/**
 * Delay before the next +1 step, given how many steps remain and how much time is left
 * before the pacing deadline (the next poll). Recomputed every step, so a long pause is
 * made up afterwards; when the time per step gets close to the minimum it switches to
 * plain rapid +1 steps so the backlog always finishes on time.
 */
export function nextDelay(remaining: number, timeLeftMs: number, rng: () => number, pacer: Pacer): number {
  const { minStepMs, maxStepMs, burstChance, pauseChance } = ANIMATION;
  const perStep = timeLeftMs / Math.max(1, remaining);
  if (perStep <= minStepMs * 1.5) {
    pacer.burstLeft = 0;
    return minStepMs; // catching up: consecutive +1 steps at the fastest pace
  }
  const quick = () => Math.round(minStepMs * (1 + 0.3 * rng()));
  if (pacer.burstLeft > 0) {
    pacer.burstLeft--;
    return quick();
  }
  if (remaining >= 3 && rng() < burstChance) {
    pacer.burstLeft = 1 + Math.floor(rng() * 3); // this step plus 1-3 more: a burst of 2-4
    return quick();
  }
  const base = Math.min(maxStepMs, perStep);
  let delay = base * (0.65 + 0.7 * rng());
  if (rng() < pauseChance) delay *= 1.6;
  // A pause, especially on the last step, must not spill into the next poll.
  // Reserve enough time for every remaining +1 even at the fastest cadence.
  const latest = Math.max(minStepMs, timeLeftMs - (remaining - 1) * minStepMs);
  return Math.floor(Math.min(latest, maxStepMs * 1.6, Math.max(minStepMs, delay)));
}

export type Scheduler = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void; now(): number };

export class CounterAnimator {
  private display: Counts | null = null;
  private target: Counts | null = null;
  private timer: unknown = null;
  /** The backlog shown so far should be finished by this time (the next poll). */
  private deadline = 0;
  private readonly pacer: Pacer = { burstLeft: 0 };
  private readonly onChange: (display: Counts) => void;
  private readonly scheduler: Scheduler;
  private readonly isHidden: () => boolean;
  private readonly rng: () => number;

  constructor(
    onChange: (display: Counts) => void,
    scheduler: Scheduler,
    isHidden: () => boolean = () => false,
    rng: () => number = Math.random,
  ) {
    this.onChange = onChange;
    this.scheduler = scheduler;
    this.isHidden = isHidden;
    this.rng = rng;
  }

  get value(): Counts | null {
    return this.display;
  }

  /** A new authoritative snapshot. Repeated identical snapshots change nothing. */
  setTarget(target: Counts): void {
    if (same(this.target, target)) return;
    this.target = { ...target };
    this.deadline = this.scheduler.now() + ANIMATION.budgetMs;
    this.show(this.isHidden() ? { ...target } : reconcile(this.display, target));
    this.schedule();
  }

  /** Call on `visibilitychange`: a tab that was away jumps to the latest snapshot. */
  visibilityChanged(): void {
    if (this.target === null) return;
    this.cancel();
    this.show({ ...this.target });
  }

  dispose(): void {
    this.cancel();
  }

  private show(next: Counts): void {
    if (same(this.display, next)) return;
    this.display = next;
    this.onChange(next);
  }

  private cancel(): void {
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = null;
  }

  /** Keeps a running cadence; each tick reads the latest target. */
  private schedule(): void {
    if (this.timer !== null || this.display === null || this.target === null) return;
    const remaining = backlog(this.display, this.target);
    if (remaining === 0) return;
    const timeLeft = this.deadline - this.scheduler.now();
    this.timer = this.scheduler.set(this.tick, nextDelay(remaining, timeLeft, this.rng, this.pacer));
  }

  private tick = (): void => {
    this.timer = null;
    if (this.display === null || this.target === null) return;
    if (this.isHidden()) {
      this.show({ ...this.target });
      return;
    }
    this.show(stepOnce(this.display, this.target));
    this.schedule();
  };
}
