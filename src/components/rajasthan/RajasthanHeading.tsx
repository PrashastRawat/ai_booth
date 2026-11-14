import Image from "next/image";

// Symmetric stepped cartouche, in a 660 × 160 design space.
const PLAQUE_PATH = "M130 6H530C544 6 553 11 560 22H572C594 22 608 32 610 48H620C635 48 644 63 647 78L658 104 647 118C643 134 630 146 606 146H370C361 154 351 156 343 150L330 159 317 150C309 156 299 154 290 146H54C30 146 17 134 13 118L2 104 13 78C16 63 25 48 40 48H50C52 32 66 22 88 22H100C107 11 116 6 130 6Z";

/** Decorative sandstone skyline with jharokhas and domed chhatris. */
function PalaceSkyline() {
  return (
    <svg className="rj-plaque-skyline" viewBox="0 0 440 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="rj-fort-stone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8ad24" />
          <stop offset="1" stopColor="#ce5b08" />
        </linearGradient>
        <linearGradient id="rj-fort-roof" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#df630a" />
          <stop offset="1" stopColor="#a93206" />
        </linearGradient>
        <g id="rj-fort-window" fill="#9d3809">
          <path d="M0 10V4a3 4 0 0 1 6 0v6Z" />
          <path d="M-1 11H7" stroke="#ffd16b" strokeWidth="1" />
        </g>
        <g id="rj-fort-tower">
          <path d="M2 58V23H25V58" fill="url(#rj-fort-stone)" stroke="#da710e" />
          <path d="M19 23H25V58H19Z" fill="#c55a0b" />
          <path d="M-1 23H28L25 18H2Z" fill="#ef920e" />
          <path d="M2 18C2 9 9 10 13.5 4 18 10 25 9 25 18Z" fill="url(#rj-fort-roof)" />
          <path d="M13.5 4V0" stroke="#c65a08" strokeWidth="1.5" />
          <path d="M1 25H26M1 42H26M0 57H27" stroke="#ffc35c" strokeWidth="2" />
          <use href="#rj-fort-window" x="6" y="28" />
          <use href="#rj-fort-window" x="15" y="28" />
          <use href="#rj-fort-window" x="6" y="46" />
          <use href="#rj-fort-window" x="15" y="46" />
        </g>
        <g id="rj-fort-wing">
          <path d="M0 58V32H44V58Z" fill="url(#rj-fort-stone)" stroke="#ce620a" />
          <path d="M-2 32H46L40 27H4Z" fill="#c84d08" />
          <path d="M0 46H44M-1 58H45" stroke="#ffc15d" strokeWidth="2" />
          {[5, 15, 25, 35].map((x) => <use key={x} href="#rj-fort-window" x={x} y="35" />)}
          {[6, 16, 26, 36].map((x) => <path key={x} d={"M" + x + " 58V51h4v7"} fill="#a14008" />)}
        </g>
      </defs>
      <path d="M7 61V46H433V61Z" fill="#dd7a10" />
      <use href="#rj-fort-wing" transform="translate(17 13) scale(.72)" />
      <use href="#rj-fort-tower" transform="translate(37 10) scale(.8)" />
      <use href="#rj-fort-wing" x="59" />
      <use href="#rj-fort-tower" x="96" y="1" />
      <use href="#rj-fort-wing" x="121" />
      <use href="#rj-fort-tower" transform="translate(156 9) scale(.86)" />
      <use href="#rj-fort-wing" x="180" />
      <use href="#rj-fort-tower" transform="translate(203 -3) scale(1.12)" />
      <use href="#rj-fort-wing" x="235" />
      <use href="#rj-fort-tower" transform="translate(269 9) scale(.86)" />
      <use href="#rj-fort-wing" x="291" />
      <use href="#rj-fort-tower" x="328" y="1" />
      <use href="#rj-fort-wing" x="353" />
      <use href="#rj-fort-tower" transform="translate(385 10) scale(.8)" />
      <use href="#rj-fort-wing" transform="translate(399 13) scale(.72)" />
      <path d="M9 60H431" stroke="#ffbb43" strokeWidth="3" />
    </svg>
  );
}

export default function RajasthanHeading() {
  return (
    <div className="rj-heading">
      <Image className="rj-heading-camel rj-heading-camel-left" src="/rajasthan/camel.svg" alt="" aria-hidden width={200} height={177} loading="eager" />
      <div className="rj-plaque">
        <PalaceSkyline />
        <svg className="rj-plaque-bg" viewBox="0 0 660 160" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="rj-plq-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#96121b" />
              <stop offset="0.52" stopColor="#8a0c15" />
              <stop offset="1" stopColor="#760810" />
            </linearGradient>
            <linearGradient id="rj-plq-gold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffe29a" />
              <stop offset="0.3" stopColor="#efb43e" />
              <stop offset="0.7" stopColor="#d99020" />
              <stop offset="1" stopColor="#f8c259" />
            </linearGradient>
          </defs>
          <path d={PLAQUE_PATH} fill="url(#rj-plq-g)" stroke="#c77c20" strokeWidth="8" strokeLinejoin="round" />
          <path d={PLAQUE_PATH} fill="none" stroke="url(#rj-plq-gold)" strokeWidth="4.5" strokeLinejoin="round" />
          <path d={PLAQUE_PATH} fill="none" stroke="#ffde8b" strokeWidth="1" transform="translate(5.3 2) scale(.984 .97)" />
          <g fill="none" stroke="url(#rj-plq-gold)" strokeWidth="2" strokeLinecap="round">
            <path d="M279 146q14 10 27 2l10-6 14 10 14-10 10 6q13 8 27-2" />
            <path d="M319 146q-1-12 11-13 12 1 11 13M330 137v17" />
          </g>
          <path d="m330 132 5 6-5 7-5-7Z" fill="#eeb145" />
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
