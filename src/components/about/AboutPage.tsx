import { AtlasDisclosure, DecisionsDisclosure, FlyModel, RealVsSimulated } from "./AboutSections";
import { Credits, Limitations } from "./Credits";
import { SiteHeader } from "./SiteHeader";

const SECTIONS = [
  { id: "real", label: "Real, simulated, fictional" },
  { id: "fly", label: "The fly model" },
  { id: "deciders", label: "Cloud deciders" },
  { id: "atlas", label: "Atlas persistence" },
  { id: "credits", label: "Credits" },
  { id: "limits", label: "Limitations" },
] as const;

/** About and credits: provenance, the fly model, cloud decider and persistence disclosures, attribution and limitations. */
export function AboutPage() {
  return <div className="workspace about-page">
    <SiteHeader current="/about" />
    <main className="page-body doc">
      <div className="page-intro">
        <h1>About FlyFireFighter</h1>
        <p className="tagline">A rescue drone with a fly&apos;s reflexes and a firefighter in command.</p>
        <p className="muted">A software harness and digital-twin research prototype. A drone searches outside and inside a burning home, proposes rescue interventions and executes them only under a commander&apos;s authority. This page states what is real, what is simulated and what each component is, without claims beyond the implemented code.</p>
      </div>
      <nav className="doc-toc" aria-label="On this page">
        {SECTIONS.map(s => <a key={s.id} href={`#${s.id}`}>{s.label}</a>)}
      </nav>
      <RealVsSimulated />
      <FlyModel />
      <DecisionsDisclosure />
      <AtlasDisclosure />
      <Credits />
      <Limitations />
    </main>
  </div>;
}
