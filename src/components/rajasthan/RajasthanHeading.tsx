import Image from "next/image";

/**
 * "Rajasthan AI Visitor Counter" heritage plaque, shown below the (unchanged) header:
 * a maroon cartouche with a gold cusped-arch border, a small fort skyline above the
 * apex, and the existing camel artwork flanking it.
 */
export default function RajasthanHeading() {
  return (
    <div className="rj-heading">
      <Image className="rj-heading-camel rj-heading-camel-left" src="/rajasthan/camel.svg" alt="" aria-hidden width={200} height={177} loading="eager" />
      <div className="rj-plaque">
        <svg className="rj-plaque-skyline" viewBox="0 0 420 34" aria-hidden focusable="false">
          <defs>
            <linearGradient id="rj-sky-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#e18c2f" />
              <stop offset="1" stopColor="#b4541a" />
            </linearGradient>
          </defs>
          {/* Fort silhouette: walls with crenellations, three domes, flag poles. */}
          <path
            fill="url(#rj-sky-g)"
            d="M0 34V26h10v-4h6v4h10v-4h6v4h14v-7c0-6 5-10 11-10s11 4 11 10v7h14v-4h6v4h10v-4h6v4h14v-5h8V15c0-8 7-13 15-13V0h2v2c8 0 15 5 15 13v6h8v-4h6v4h12v-4h6v4h14v-9c0-7 6-12 13-12s13 5 13 12v9h14v-4h6v4h12v-4h6v4h8v-6c0-8 7-13 15-13V0h2v2c8 0 15 5 15 13v6h8v5h14v-4h6v4h10v-4h6v4h14v-7c0-6 5-10 11-10s11 4 11 10v7h14v-4h6v4h10v-4h6v4h10v8z"
          />
        </svg>
        <svg className="rj-plaque-bg" viewBox="0 0 760 118" preserveAspectRatio="none" aria-hidden focusable="false">
          <defs>
            <linearGradient id="rj-plq-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#a5181f" />
              <stop offset="0.55" stopColor="#8d1016" />
              <stop offset="1" stopColor="#780b11" />
            </linearGradient>
          </defs>
          <path
            d="M34 32C112 27 196 23 282 21 322 13 352 7 380 2.5 408 7 438 13 478 21 564 23 648 27 726 32 744 34 756 45 756 60V86C756 103 743 115 724 115H36C17 115 4 103 4 86V60C4 45 16 34 34 32Z"
            fill="url(#rj-plq-g)"
            stroke="#e3a347"
            strokeWidth="4.5"
          />
          <path
            d="M34 32C112 27 196 23 282 21 322 13 352 7 380 2.5 408 7 438 13 478 21 564 23 648 27 726 32 744 34 756 45 756 60V86C756 103 743 115 724 115H36C17 115 4 103 4 86V60C4 45 16 34 34 32Z"
            fill="none"
            stroke="#f6cf8b"
            strokeWidth="1.4"
            transform="translate(5.7 6.2) scale(0.985)"
          />
        </svg>
        <h1 className="rj-plaque-text">
          <span className="rj-plaque-line1">Rajasthan</span>
          <span className="rj-plaque-line2">AI Visitor Counter</span>
        </h1>
      </div>
      <Image className="rj-heading-camel rj-heading-camel-right" src="/rajasthan/camel.svg" alt="" aria-hidden width={200} height={177} loading="eager" />
    </div>
  );
}
