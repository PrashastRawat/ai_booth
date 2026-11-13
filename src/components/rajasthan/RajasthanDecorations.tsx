import Image from "next/image";

/** Purely decorative scenery behind the counters; hidden from assistive technology. */
export default function RajasthanDecorations() {
  return (
    <div aria-hidden>
      <Image className="rj-spandrel-left" src="/rajasthan/arch-spandrel.svg" alt="" width={340} height={272} loading="eager" />
      <Image className="rj-spandrel-right" src="/rajasthan/arch-spandrel.svg" alt="" width={340} height={272} loading="eager" />
      <Image className="rj-cloud-left" src="/rajasthan/cloud.svg" alt="" width={200} height={64} loading="eager" />
      <Image className="rj-cloud-right" src="/rajasthan/cloud.svg" alt="" width={200} height={64} loading="eager" />
      <Image className="rj-palace" src="/rajasthan/palace.svg" alt="" width={300} height={195} loading="eager" />
      <Image className="rj-dunes" src="/rajasthan/dunes.svg" alt="" width={1710} height={190} loading="eager" />
      <Image className="rj-camel" src="/rajasthan/camel.svg" alt="" width={200} height={177} loading="eager" />
      <div className="rj-border" />
    </div>
  );
}
