// Position math for one odometer wheel (src/components/rajasthan/Odometer.tsx).
// The wheel's strip holds 0-9 twice (positions 0-19), so every change rolls UPWARD,
// including a 9 -> 0 carry.

/** Number of positions on the strip (0-9 twice). */
export const STRIP_LENGTH = 20;

export type WheelMove = {
  /** Position to jump to first without a transition (same digit), when the strip would run out. */
  snapFrom: number | null;
  /** Position to animate to; shows `digit`. */
  to: number;
};

/** How a wheel at strip position `pos` moves to show `digit`; null when it already does. */
export function rollWheel(pos: number, digit: number): WheelMove | null {
  if (digit === pos % 10) return null;
  const delta = (digit - (pos % 10) + 10) % 10; // always roll upward
  if (pos + delta > STRIP_LENGTH - 1) return { snapFrom: pos - 10, to: pos - 10 + delta };
  return { snapFrom: null, to: pos + delta };
}

/** Digits shown for `value`, padded with leading zeros to `minDigits` wheels. */
export function odometerDigits(value: number, minDigits: number): number[] {
  return String(Math.max(0, Math.trunc(value))).padStart(minDigits, "0").split("").map(Number);
}
