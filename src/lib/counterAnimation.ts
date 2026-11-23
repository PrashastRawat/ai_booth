// Display-only animation of the public counters. GET /api/stats stays the single source
// of truth; this only decides which number the odometers SHOW on the way to the latest
// authoritative snapshot. It never creates records, never changes API totals and never
// shows a number above the latest target.
//
// Policy:
//  - First value (page load / refresh): shown directly, never replayed from zero.
//  - Increase: the counters change once every 3-5 seconds (random), each time by a
//    varying amount, like people arriving in small groups. The amounts are paced so the
//    whole increase is shown by the next poll: the display keeps up and never drifts.
//  - Camera activity sets the rhythm: when the cameras detect fewer people than usual the
//    display slows down and pauses (trailing the API by a bounded amount); when they
//    detect more it changes faster and catches up. The API figures, and so the hourly
//    total, are unaffected: the display only ever moves toward them.
//  - A newer snapshot during an animation only moves the target; the running cadence
//    continues from the number on screen, so a delta is never added twice.
//  - Decrease (IST midnight reset of Today's Visitors, or a correction): shown directly,
//    never animated backwards.
//  - Backlog too large to animate within one poll interval (outage, restart, long-hidden
//    tab), or the tab is hidden: synchronised directly to the latest target.
//  - Today and Total change together, by the same amount, so both stay on one snapshot.

export type Counts = { today: number; total: number };

// At 6,500 projected visitors per hour about 54 arrive per 30 s poll: 6-8 changes of
// roughly 4-10 each. Before 11:00 (2,000/hour, ~17 per poll) changes are 1-4. A missed
// poll is still animated with somewhat larger changes; a longer gap synchronises.
export const ANIMATION = {
  /** Show each increase within this long after its snapshot (the poll interval). */
  budgetMs: 30_000,
  /** Shortest pause between two changes of the counters. */
  minTickMs: 3_000,
  /** Longest pause between two changes while there is something to show. */
  maxTickMs: 5_000,
  /** Largest backlog animated; above it the display synchronises (~2 min at 6,500/h). */
  maxAnimatedBacklog: 250,
  /** Pace range driven by camera activity: quiet slows the display, busy speeds it up. */
  minPace: 0.4,
  maxPace: 1.6,
  /** At the quietest pace, about this share of changes become pauses. */
  quietPauseShare: 0.5,
  /** Quiet spells may let the display trail the API by at most this much (~1 min at 6,500/h). */
  maxTrail: 120,
} as const;

/**
 * Display pace from real camera detections: entries in the last 5 minutes compared with
 * their recent average. 1 = usual, below 1 = quieter (slower, more pauses), above 1 =
 * busier (faster). Only the rhythm changes; the counters still follow the API exactly.
 */
export function paceFromActivity(recent: number, baseline: number): number {
  const ratio = (Math.max(0, recent) + 1) / (Math.max(0, baseline) + 1);
  return Math.min(ANIMATION.maxPace, Math.max(ANIMATION.minPace, ratio));
}

const same = (a: Counts | null, b: Counts | null) => a !== null && b !== null && a.today === b.today && a.total === b.total;

/** Increase still to show before the display reaches the target. */
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

/** Moves each counter up by `amount`, never past its target. */
export function advanceBy(display: Counts, target: Counts, amount: number): Counts {
  return {
    today: Math.min(target.today, display.today + Math.max(0, amount)),
    total: Math.min(target.total, display.total + Math.max(0, amount)),
  };
}

/** Random pause before the next change: 3-5 seconds. */
export function nextTickDelay(rng: () => number): number {
  const { minTickMs, maxTickMs } = ANIMATION;
  return Math.round(minTickMs + (maxTickMs - minTickMs) * rng());
}

/**
 * How much to show at this change, given what remains and the time left before the
 * pacing deadline. Spread over the changes that still fit, with natural variation;
 * when no further change fits before the deadline, everything remaining is shown.
 */
export function tickAmount(remaining: number, timeLeftMs: number, rng: () => number): number {
  if (remaining <= 0) return 0;
  const ticksLeft = Math.floor(timeLeftMs / ANIMATION.maxTickMs); // further changes that surely fit
  if (ticksLeft <= 0) return remaining;
  const share = remaining / (ticksLeft + 1);
  // Leave at least one for each later change, so the rhythm continues up to the deadline.
  const most = Math.max(1, remaining - ticksLeft);
  return Math.max(1, Math.min(most, Math.round(share * (0.6 + 0.8 * rng()))));
}

export type Scheduler = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void; now(): number };

export class CounterAnimator {
  private display: Counts | null = null;
  private target: Counts | null = null;
  private timer: unknown = null;
  /** The increase should be fully shown by this time (the next poll). */
  private deadline = 0;
  /** When the display last changed or paused; the next change comes 3-5 s after it. */
  private lastTick = -Infinity;
  /** Current display pace from camera activity (1 = usual). */
  private pace = 1;
  /** Running average of recent camera detections, for comparison. */
  private baseline: number | null = null;
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

  /**
   * Real camera entries in the last 5 minutes, sent with each poll. Fewer than usual
   * slows the display down with pauses; more than usual speeds it up to catch up.
   */
  setActivity(recentEntries: number | null): void {
    if (recentEntries === null || !Number.isFinite(recentEntries)) return;
    this.baseline = this.baseline === null ? recentEntries : this.baseline * 0.9 + recentEntries * 0.1;
    this.pace = paceFromActivity(recentEntries, this.baseline);
  }

  get currentPace(): number {
    return this.pace;
  }

  /** The camera pace, except that a display trailing by more than maxTrail is not slowed. */
  private effectivePace(): number {
    const behind = this.display && this.target ? backlog(this.display, this.target) : 0;
    return behind > ANIMATION.maxTrail ? Math.max(1, this.pace) : this.pace;
  }

  /** A new authoritative snapshot. Repeated identical snapshots change nothing. */
  setTarget(target: Counts): void {
    if (same(this.target, target)) return;
    this.target = { ...target };
    this.show(this.isHidden() ? { ...target } : reconcile(this.display, target));
    // Quiet: show this increase more slowly (it may trail a little); busy: catch up sooner.
    // Once trailing by more than maxTrail, quiet no longer slows it down.
    this.deadline = this.scheduler.now() + ANIMATION.budgetMs / this.effectivePace();
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
    this.lastTick = this.scheduler.now();
    this.onChange(next);
  }

  private cancel(): void {
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = null;
  }

  /** Keeps a running cadence; each tick reads the latest target. */
  private schedule(): void {
    if (this.timer !== null || this.display === null || this.target === null) return;
    if (backlog(this.display, this.target) === 0) return;
    // Keep the 3-5 s rhythm across polls: time the next change from the previous one.
    const due = this.lastTick + nextTickDelay(this.rng);
    this.timer = this.scheduler.set(this.tick, Math.max(0, due - this.scheduler.now()));
  }

  private tick = (): void => {
    this.timer = null;
    if (this.display === null || this.target === null) return;
    if (this.isHidden()) {
      this.show({ ...this.target });
      return;
    }
    const remaining = backlog(this.display, this.target);
    const timeLeft = this.deadline - this.scheduler.now();
    // Fewer people detected: some changes become pauses (only while there is time to spare).
    const pace = this.effectivePace();
    const pauseChance = pace < 1 ? ((1 - pace) / (1 - ANIMATION.minPace)) * ANIMATION.quietPauseShare : 0;
    if (timeLeft > 2 * ANIMATION.maxTickMs && this.rng() < pauseChance) {
      this.lastTick = this.scheduler.now();
      this.schedule();
      return;
    }
    this.show(advanceBy(this.display, this.target, tickAmount(remaining, timeLeft, this.rng)));
    this.schedule();
  };
}
