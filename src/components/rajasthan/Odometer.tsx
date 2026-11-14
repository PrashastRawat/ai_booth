"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

// Mechanical odometer display. Purely visual: it renders exactly the number it is
// given and never changes any stored count.
//
// Each digit sits on a vertical strip holding 0-9 twice, so every increase - including
// a 9 -> 0 carry - rolls upward like a real counter wheel. When the position would run
// off the strip it is first snapped back ten places without a transition (invisible,
// same digit showing), then animated. Decreases (the IST midnight reset) remount the
// wheels so they snap to the new value instead of rolling backwards for a long time.

const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const shift = (pos: number) => `translateY(calc(${-pos} * var(--odo-h)))`;

function DigitWheel({ digit }: { digit: number }) {
  // The strip position is driven imperatively after mount; the style prop only sets the
  // starting position and never changes, so React re-renders leave the DOM alone.
  const [initial] = useState(digit);
  const stripRef = useRef<HTMLSpanElement>(null);
  const posRef = useRef(digit);

  useEffect(() => {
    const el = stripRef.current;
    const cur = posRef.current;
    if (!el || digit === cur % 10) return;
    const delta = (digit - (cur % 10) + 10) % 10; // always roll upward
    let from = cur;
    if (cur + delta > STRIP.length - 1) {
      // Snap to the equivalent lower position without a transition; the forced reflow
      // commits it so the subsequent change still animates (FLIP technique).
      from = cur - 10;
      el.style.transition = "none";
      el.style.transform = shift(from);
      void el.offsetHeight;
    }
    posRef.current = from + delta;
    el.style.transition = ""; // back to the stylesheet transition
    el.style.transform = shift(from + delta);
  }, [digit]);

  return (
    <span className="rj-odo-cell">
      <span ref={stripRef} className="rj-odo-strip" style={{ transform: shift(initial) }}>
        {STRIP.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </span>
    </span>
  );
}

type Props = {
  value: number;
  /** Pad with leading zeros up to this many wheels (more appear if the value needs them). */
  minDigits?: number;
};

export default function Odometer({ value, minDigits = 6 }: Props) {
  // A drop in value (the IST midnight reset) bumps the epoch, remounting the wheels at
  // the new value with no reverse animation. This is React's documented
  // "adjust state while rendering" pattern for reacting to a prop change.
  const [prev, setPrev] = useState(value);
  const [epoch, setEpoch] = useState(0);
  if (value !== prev) {
    setPrev(value);
    if (value < prev) setEpoch(epoch + 1);
  }

  const digits = String(Math.max(0, Math.trunc(value)))
    .padStart(minDigits, "0")
    .split("")
    .map(Number);

  return (
    <span className="rj-odo" role="img" aria-label={value.toLocaleString("en-IN")} style={{ "--odo-n": digits.length } as CSSProperties}>
      <span className="rj-odo-wheels" aria-hidden="true">
        {digits.map((d, i) => (
          // Keyed by place value (from the right) so a new leading wheel mounts in place
          // while the existing wheels keep their state and roll naturally.
          <DigitWheel key={`${epoch}:${digits.length - i}`} digit={d} />
        ))}
      </span>
    </span>
  );
}
