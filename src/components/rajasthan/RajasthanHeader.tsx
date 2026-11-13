import Image from "next/image";

// Official logos as supplied in public/logos (both are JPEGs with white backgrounds;
// the CSS blends the white into the header colour).
const IITF_LOGO = { src: "/logos/IITF.jpg", width: 384, height: 290 };
const RAJASTHAN_LOGO = { src: "/logos/rajasthan _gov..png", width: 300, height: 187 };

export default function RajasthanHeader() {
  return (
    <header className="rj-header">
      <Image className="rj-corner-left" src="/rajasthan/header-corner.svg" alt="" aria-hidden width={136} height={121} loading="eager" />
      <Image className="rj-corner-right" src="/rajasthan/header-corner.svg" alt="" aria-hidden width={136} height={121} loading="eager" />
      <div className="rj-logos">
        <Image className="rj-logo-iitf" alt="IITF" loading="eager" {...IITF_LOGO} />
        <span className="rj-logo-divider" aria-hidden />
        <Image className="rj-logo-rajasthan" alt="Government of Rajasthan" loading="eager" {...RAJASTHAN_LOGO} />
      </div>
    </header>
  );
}
