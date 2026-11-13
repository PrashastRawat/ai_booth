import Image from "next/image";
import type { CSSProperties } from "react";

const formatter = new Intl.NumberFormat("en-IN"); // Indian grouping: 1,25,000

// Cusped Rajasthani arch outline in card units (card is 521 x 563): ogee apex,
// two lobes per shoulder, straight sides and rounded bottom corners.
const ARCH_PATH =
  "M260.5 1.5C247 23 225 32 195 38 153 45 128 59 125 85 84 85 50 108 50 137 30 137 1.5 167 1.5 192" +
  "V525A36 36 0 0 0 37.5 561.5H483.5A36 36 0 0 0 519.5 525V192" +
  "C519.5 167 491 137 471 137 471 108 437 85 396 85 393 59 368 45 326 38 296 32 274 23 260.5 1.5Z";

// Advance widths (em) of Playfair Display ExtraBold, measured in the browser.
const ADVANCE_EM: Record<string, number> = {
  "0": 0.701, "1": 0.49, "2": 0.627, "3": 0.625, "4": 0.649,
  "5": 0.599, "6": 0.648, "7": 0.554, "8": 0.676, "9": 0.648, ",": 0.328,
};
// The glyphs' outer side bearings (about 0.45 em in total) are blank space.
const OUTER_BEARINGS_EM = 0.45;
// Ink width available inside the card at full size: 461 of the card's 521 units at 156 units/em.
const MAX_INK_EM = 461 / 156;

/** Shrinks the number only when its ink would be wider than the card (e.g. 1,25,000). */
function fitScale(text: string): number {
  let advance = 0;
  for (const ch of text) advance += ADVANCE_EM[ch] ?? 0.6;
  return Math.min(1, MAX_INK_EM / Math.max(advance - OUTER_BEARINGS_EM, 0.01));
}

type Props = { id: string; label: string; value: number | null };

export default function VisitorCounterCard({ id, label, value }: Props) {
  const text = value === null ? "—" : formatter.format(value);
  const fillId = `rj-card-fill-${id}`;
  const clipId = `rj-card-clip-${id}`;

  return (
    <section className="rj-card" aria-labelledby={`rj-label-${id}`}>
      <svg className="rj-frame" viewBox="-6 -6 533 575" aria-hidden focusable="false">
        <defs>
          <linearGradient id={fillId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="563">
            <stop offset="0" stopColor="#fff2df" />
            <stop offset="0.5" stopColor="#fdefd9" />
            <stop offset="1" stopColor="#fdead0" />
          </linearGradient>
          <clipPath id={clipId}>
            <path d={ARCH_PATH} />
          </clipPath>
        </defs>
        <path d={ARCH_PATH} fill={`url(#${fillId})`} />
        {/* Inner hairline and ivory highlight just inside the red border. */}
        <g clipPath={`url(#${clipId})`} fill="none">
          <path d={ARCH_PATH} stroke="#efd2b0" strokeWidth="17.5" />
          <path d={ARCH_PATH} stroke={`url(#${fillId})`} strokeWidth="15" />
          <path d={ARCH_PATH} stroke="#fff8ec" strokeWidth="10" />
        </g>
        <path d={ARCH_PATH} fill="none" stroke="#ab352c" strokeWidth="3.2" />
      </svg>

      <Image className="rj-ornament" src="/rajasthan/lotus-ornament.svg" alt="" aria-hidden width={56} height={40} loading="eager" />
      <Image className="rj-icon" src="/rajasthan/visitors-icon.svg" alt="" aria-hidden width={68} height={49} loading="eager" />
      <h2 id={`rj-label-${id}`} className="rj-label">
        {label}
      </h2>
      <Image className="rj-rule" src="/rajasthan/divider.svg" alt="" aria-hidden width={250} height={12} loading="eager" />
      <p className="rj-value" style={{ "--fit": fitScale(text) } as CSSProperties}>
        {text}
      </p>
      <Image className="rj-pavilion" src="/rajasthan/pavilion.svg" alt="" aria-hidden width={390} height={112} loading="eager" />
    </section>
  );
}
