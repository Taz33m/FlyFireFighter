/**
 * Credits with exact attribution texts (from docs/reference/provenance.md, assets/actors/THIRD_PARTY_NOTICES.md
 * and the scene metadata) and the simulation/limitations statements from the PRD.
 */

interface Credit {
  readonly name: string;
  readonly licence: string;
  readonly use: string;
  readonly text: string;
  readonly links: readonly { readonly href: string; readonly label: string }[];
}

const CREDITS: readonly Credit[] = [
  {
    name: "OpenStreetMap",
    licence: "ODbL 1.0",
    use: "Heffner Alumni House footprint (way 73141173) and nearby street, sidewalk and crossing centrelines, pinned in assets/blender/troy_osm_extract.json.",
    text: "Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.",
    links: [{ href: "https://www.openstreetmap.org/copyright", label: "openstreetmap.org/copyright" }, { href: "https://www.openstreetmap.org/way/73141173", label: "way 73141173" }],
  },
  {
    name: "Wikimedia Commons photographs",
    licence: "CC BY-SA 4.0 · reference only",
    use: "Building heights, wings and roof forms were estimated from these photographs. No image pixels are used, shipped or redistributed.",
    text: "Proportions estimated from “RPI Alumni House 01–19” by RPI2026F1 (Wikimedia Commons, CC BY-SA 4.0), consulted as reference only.",
    links: [{ href: "https://commons.wikimedia.org/wiki/Category:Heffner_Alumni_House", label: "Commons category" }, { href: "https://creativecommons.org/licenses/by-sa/4.0/", label: "CC BY-SA 4.0" }],
  },
  {
    name: "Scanned occupant character",
    licence: "CC BY 4.0 · modified",
    use: "The fictional occupant's body: a doob scan, optimised and rigged by High Fidelity, per the creator. Modified for FlyFireFighter: facial shape keys and the duplicate face removed, meshes merged, converted to metres and glTF, skin weights limited to four, animation retargeted.",
    text: "This work is based on “Rigged T-Pose Human Male w 50 Face Blendshapes” (https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) by Mike Alger (https://sketchfab.com/mikealger) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/). The creator does not endorse this project. The fictional occupant has no connection to him or to any real incident.",
    links: [{ href: "https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07", label: "Model page" }, { href: "https://creativecommons.org/licenses/by/4.0/", label: "CC BY 4.0" }],
  },
  {
    name: "Microsoft Rocketbox Avatar Library",
    licence: "MIT · modified",
    use: "Idle, crouch, cough, walk and follow clips (m_idle_breathe_01, m_crouch_idle, m_idle_cough_01, m_walk_neutral_01, m_walk_slow_01) at commit 0943055db6ec570bcef9f2c8b41c9e5467c808f9, retargeted onto the scanned skeleton with root motion removed.",
    text: "Animations from the Microsoft Rocketbox Avatar Library (https://github.com/microsoft/Microsoft-Rocketbox), Copyright (c) 2020 Microsoft, MIT License; retargeted, trimmed and modified for FlyFireFighter.",
    links: [{ href: "https://github.com/microsoft/Microsoft-Rocketbox", label: "Repository" }, { href: "https://doi.org/10.3389/frvir.2020.561558", label: "Gonzalez-Franco et al. 2020" }],
  },
  {
    name: "FlyVis",
    licence: "MIT (code) · weights licence unclear",
    use: "The connectome-constrained fly visual-system model and its pretrained checkpoint, run locally. Ten reference files are vendored unchanged in vendor/flyvis-reference.",
    text: "FlyVis, Copyright (c) 2023 Janne K. Lappalainen, Fabian D. Tschopp, Mason McGill, Jakob H. Macke, Srinivas C. Turaga, MIT License. Lappalainen et al., “Connectome-constrained networks predict neural activity across the fly visual system”, Nature 634, 1132–1140 (2024), doi:10.1038/s41586-024-07939-3.",
    links: [{ href: "https://github.com/TuragaLab/flyvis/tree/0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa", label: "Pinned commit" }, { href: "https://turagalab.github.io/flyvis/", label: "Documentation" }],
  },
  {
    name: "FlyBy",
    licence: "Design reference · no code copied",
    use: "The camera → fly model → looming readout → flight-controller presentation reference.",
    text: "Fly-reflex integration reference: FlyBy by monishramj (https://github.com/monishramj/flyby).",
    links: [{ href: "https://github.com/monishramj/flyby", label: "Repository" }],
  },
  {
    name: "Saranga",
    licence: "Research reference · no code copied",
    use: "Informed the degraded-visibility ultrasound requirement. Our ultrasound is a simulated range model.",
    text: "Ultrasound obstacle-avoidance research: Saranga (https://github.com/pearwpi/Saranga).",
    links: [{ href: "https://github.com/pearwpi/Saranga", label: "Repository" }],
  },
];

export function Credits() {
  return <section className="doc-section" id="credits" aria-labelledby="credits-title">
    <h2 id="credits-title">Credits and attribution</h2>
    <p>Exact attribution texts. Machine-readable provenance, with hashes and full licence texts, is in <code>public/actors/occupant.provenance.json</code>, <code>assets/actors/THIRD_PARTY_NOTICES.md</code>, <code>public/scenes/troy-training/scene.meta.json</code> and <code>docs/reference/provenance.md</code>.</p>
    <ul className="credit-list">
      {CREDITS.map(c => <li key={c.name} className="credit">
        <div className="credit-head"><h3>{c.name}</h3><span className="tag">{c.licence}</span></div>
        <p className="muted">{c.use}</p>
        <blockquote>{c.text}</blockquote>
        <p className="credit-links">{c.links.map(l => <a key={l.href} href={l.href} rel="noreferrer">{l.label}</a>)}</p>
      </li>)}
    </ul>
    <p className="muted small">Software: Next.js, React and Three.js (MIT), and the MongoDB Node.js driver (Apache 2.0) for optional run persistence. Standard Response (voice and confirmation patterns) and Headcount (attributed person evidence) are separate reference projects; none of their code is included.</p>
  </section>;
}

export function Limitations() {
  return <section className="doc-section" id="limits" aria-labelledby="limits-title">
    <h2 id="limits-title">Simulation and limitations</h2>
    <ul className="limit-list">
      <li><strong>Everything happens in a digital twin.</strong> Flight, fire, sensors, interventions and evacuation are simulated. Accelerated playback is simulation time, not real-world response time.</li>
      <li><strong>A detection is not an evacuation.</strong> “Simulated evacuation completed” appears only when the independent evaluator verifies that the simulated occupant reached the exterior assembly point within budget with no scored violation. Every other outcome reads “Incomplete — human assistance needed”. A safe abort is a safety outcome, not a rescue.</li>
      <li><strong>No automatic all-clear.</strong> One evacuation never clears a room or the house; unobserved rooms stay unknown.</li>
      <li><strong>The commander approves each intervention.</strong> Glass-breaking, spraying and payload release each need an individual approval bound to an exact proposal, revalidated against current evidence before and during execution. Abort cannot undo completed physical effects.</li>
      <li><strong>Simplified physics.</strong> The fire, smoke, ventilation and suppression models are documented simplifications, not validated fire dynamics. The thermal view is a display of simulated temperatures, not a radiometric sensor.</li>
      <li><strong>One house.</strong> Results come from a single simulated house and its seeds. They do not establish performance in unseen homes or real burning buildings.</li>
      <li><strong>Fictional aircraft.</strong> Software cannot confer heat tolerance, payload capacity or flight performance an aircraft lacks; hardware adapters are future work.</li>
      <li><strong>Motivation is not evidence.</strong> A student&apos;s account of a Troy fire motivates the work. It is not evidence that this drone would have changed that outcome.</li>
    </ul>
  </section>;
}
