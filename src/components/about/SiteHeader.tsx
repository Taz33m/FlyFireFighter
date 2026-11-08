import Link from "next/link";
import { WordmarkContent } from "@/components/mission/Wordmark";

const PAGES = [
  { href: "/", label: "Mission workspace" },
  { href: "/results", label: "Results and replay" },
  { href: "/about", label: "About and credits" },
] as const;

/** Header for the secondary pages: wordmark, page navigation and the persistent simulation label. */
export function SiteHeader({ current }: { readonly current: "/results" | "/about" }) {
  return <header className="topbar site-header">
    <Link href="/" className="wordmark" aria-label="FlyFireFighter mission workspace"><WordmarkContent /></Link>
    <nav className="site-nav" aria-label="Pages">
      {PAGES.map(p => <Link key={p.href} href={p.href} aria-current={p.href === current ? "page" : undefined}>{p.label}</Link>)}
    </nav>
    <span className="site-label">Digital-twin simulation · Troy training scene: real exterior reference, fictional interior and incident</span>
  </header>;
}
