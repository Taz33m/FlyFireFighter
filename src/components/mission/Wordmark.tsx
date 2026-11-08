import Image from "next/image";
import logo from "../../../assets/brand/flyfirefighter-logo-glow.png";

export function WordmarkContent() {
  return <span className="wordmark-art">
    <Image src={logo} alt="FlyFireFighter" sizes="(max-width: 560px) 180px, 232px" loading="eager" />
  </span>;
}
