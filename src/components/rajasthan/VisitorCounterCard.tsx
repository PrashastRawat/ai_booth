import Image from "next/image";
import Odometer from "./Odometer";

// Exact value with Indian grouping (1,25,000), shown as a tooltip on the counter.
const exactFormatter = new Intl.NumberFormat("en-IN");

// Card size in layout units; must match .rj-card in RajasthanDashboard.css.
const CARD_H = 380;
// Inset the crown below the large title plaque, keeping the existing card body
// and camera row fixed. The shorter shoulders leave room for the visitor label.
const ARCH_TOP_INSET = 45;
const ARCH_TOP_SCALE = 0.6;

/**
 * Cusped Rajasthani arch outline in card units (521 wide): ogee apex, two lobes per
 * shoulder, straight sides and rounded bottom corners.
 */
function archPath(h: number): string {
  const y = (v: number) => Math.round((ARCH_TOP_INSET + 1.5 + (v - 1.5) * ARCH_TOP_SCALE) * 10) / 10;
  return (
    `M260.5 ${y(1.5)}C247 ${y(23)} 225 ${y(32)} 195 ${y(38)} 153 ${y(45)} 128 ${y(59)} 125 ${y(85)} ` +
    `84 ${y(85)} 50 ${y(108)} 50 ${y(137)} 30 ${y(137)} 1.5 ${y(167)} 1.5 ${y(192)}` +
    `V${h - 37.5}A36 36 0 0 0 37.5 ${h - 1.5}H483.5A36 36 0 0 0 519.5 ${h - 37.5}V${y(192)}` +
    `C519.5 ${y(167)} 491 ${y(137)} 471 ${y(137)} 471 ${y(108)} 437 ${y(85)} 396 ${y(85)} ` +
    `393 ${y(59)} 368 ${y(45)} 326 ${y(38)} 296 ${y(32)} 274 ${y(23)} 260.5 ${y(1.5)}Z`
  );
}
const ARCH_PATH = archPath(CARD_H);

type Props = {
  id: string;
  label: string;
  value: number | null;
  /** Small line under the counter, e.g. "Projected attendance". */
  caption?: string;
  /** Minimum wheels on the mechanical counter (leading zeros), like a real odometer. */
  minDigits?: number;
};

export default function VisitorCounterCard({ id, label, value, caption, minDigits = 6 }: Props) {
  const exact = value === null ? undefined : exactFormatter.format(value);
  const fillId = `rj-card-fill-${id}`;
  const clipId = `rj-card-clip-${id}`;

  return (
    <section className="rj-card" aria-labelledby={`rj-label-${id}`}>
      <svg className="rj-frame" viewBox={`-6 -6 533 ${CARD_H + 12}`} aria-hidden focusable="false">
        <defs>
          <linearGradient id={fillId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={CARD_H}>
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
        <path d={ARCH_PATH} fill="none" stroke="#9f1016" strokeWidth="3.2" />
      </svg>

      <Image className="rj-icon" src="/rajasthan/visitors-icon.svg" alt="" aria-hidden width={68} height={49} loading="eager" />
      <h2 id={`rj-label-${id}`} className="rj-label">
        {label}
      </h2>
      <Image className="rj-rule" src="/rajasthan/divider.svg" alt="" aria-hidden width={250} height={12} loading="eager" />
      <div className="rj-odo-wrap" title={exact}>
        {value === null ? <span className="rj-odo-empty">—</span> : <Odometer value={value} minDigits={minDigits} />}
      </div>
      {caption && <p className="rj-caption">{caption}</p>}
    </section>
  );
}
