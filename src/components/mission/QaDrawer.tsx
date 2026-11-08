"use client";

import { useEffect, useRef } from "react";

/** A panel in the workspace that an answer can point to (each has this id and tabIndex -1). */
type Target = "action-card" | "fly-reflex" | "thermal-view" | "rescue-record" | "mission-timeline" | "status-strip";

const TARGET_LABEL: Readonly<Record<Target, string>> = {
  "action-card": "Action card",
  "fly-reflex": "Fly reflex panel",
  "thermal-view": "Thermal view",
  "rescue-record": "Rescue record",
  "mission-timeline": "Mission timeline",
  "status-strip": "Status strip",
};

interface Answer {
  readonly question: string;
  readonly answer: string;
  readonly show: readonly Target[];
  readonly links: readonly { readonly href: string; readonly label: string }[];
}

/** Short spoken answers. Each states what the build does, not what it might do. */
const ANSWERS: readonly Answer[] = [
  {
    question: "What came from the fly?",
    answer: "Rendered drone-camera frames go into the pretrained FlyVis connectome-constrained model of the fly visual system. A readout turns its motion responses into brake and turn requests, and the harness bounds them before any motion executes. The panel names the active readout and any classical fallback. FlyVis and FlyBy are credited; the readouts, mission planning and rescue rules are ours.",
    show: ["fly-reflex"],
    links: [{ href: "/about#fly", label: "What came from the fly" }, { href: "/about#credits", label: "Credits" }],
  },
  {
    question: "What is real about the scene?",
    answer: "The exterior is a real reference: Peoples Avenue by RPI's Heffner Alumni House, modelled in Blender from OpenStreetMap and photographs. The interior, the incident and the occupant are fictional; the occupant is drawn with a licensed scanned adult. Everything that moves, burns or is sensed is simulated.",
    show: [],
    links: [{ href: "/about#real", label: "Real, simulated and fictional" }, { href: "/about#credits", label: "Credits" }],
  },
  {
    question: "What do OpenAI and Gemini do?",
    answer: "When configured, OpenAI Decisions or Gemini chooses one of the mission candidates the application already generated, such as the next viewpoint. In consensus mode both are asked, and their choice is used only when they pick the same candidate. No model can move the aircraft, approve an intervention or declare an outcome. Local reflexes handle motion; the commander and the harness govern interventions. The status strip names a model only when its choice was used, and says “Local planner” otherwise.",
    show: ["status-strip"],
    links: [{ href: "/about#deciders", label: "What the cloud deciders do and what is sent" }],
  },
  {
    question: "Does it see through smoke or walls?",
    answer: "No. Sensor quality and the position estimate are tracked separately, and obscured rooms stay unknown. Smoke reaches the controller's camera input, not just the display. Thermal and range readings are simulated with documented limits; walls and glass block the thermal view.",
    show: ["thermal-view", "rescue-record"],
    links: [{ href: "/about#real", label: "Sensors" }, { href: "/about#limits", label: "Limitations" }],
  },
  {
    question: "Why break that window? What does each action cost?",
    answer: "Every glass, spray or payload-release action needs its own approval, bound to the exact proposal and revalidated against current evidence before and during execution. The card shows the target, evidence age, modeled effect and payload cost. Water is finite, broken glass stays broken, and Abort stops remaining actuation but cannot undo completed effects.",
    show: ["action-card"],
    links: [{ href: "/about#limits", label: "Limitations" }],
  },
  {
    question: "What if someone enters the spray?",
    answer: "Press Judge challenge while a spray is pending or approved. It places a simulated person inside the spray's affected region through the normal experiment path; nothing tells the harness. If the sensors detect them, the harness invalidates or stops the spray and shows the rule. The old approval cannot be reused.",
    show: ["action-card", "mission-timeline"],
    links: [],
  },
  {
    question: "Is it only finding people?",
    answer: "A detection is not an evacuation. Success means the independent simulation evaluator saw the simulated occupant reach the exterior assembly point. A possible occupant is a detection, not a confirmed person.",
    show: ["rescue-record"],
    links: [{ href: "/about#limits", label: "Limitations" }],
  },
  {
    question: "Does it know everyone is out?",
    answer: "No automatic all-clear. One evacuation never clears a room or the house; unobserved rooms stay unknown and reports stay unresolved.",
    show: ["rescue-record"],
    links: [{ href: "/about#limits", label: "Limitations" }],
  },
  {
    question: "Is the improvement real?",
    answer: "Results show paired runs with completion and failure counts and their denominators. Simulation results do not establish field performance.",
    show: [],
    links: [{ href: "/results", label: "Results and replay" }],
  },
];

function showPanel(target: Target) {
  const element = document.getElementById(target);
  if (element === null) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Land below the sticky head, whose height varies with banners and presenter view.
  const head = document.querySelector(".sticky-head")?.getBoundingClientRect().height ?? 0;
  window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - head - 8, behavior: reduced ? "auto" : "smooth" });
  element.focus({ preventScroll: true });
}

/** Q&A drawer: a modal dialog (focus contained, Escape closes). Links open in a new tab so the live run keeps going. */
export function QaDrawer({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const goTo = (target: Target) => {
    onClose();
    // After the dialog closes (and returns focus to its opener), move focus to the panel.
    requestAnimationFrame(() => showPanel(target));
  };

  return <dialog ref={ref} className="qa-drawer" aria-labelledby="qa-title" onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="qa-body">
      <div className="qa-head">
        <h2 id="qa-title">Questions and answers</h2>
        <button type="button" onClick={onClose} autoFocus>Close</button>
      </div>
      <p className="muted">Short answers for the judges. Pages open in a new tab, so the mission keeps running here.</p>
      <ol className="qa-list">
        {ANSWERS.map(a => <li key={a.question}>
          <h3>{a.question}</h3>
          <p>{a.answer}</p>
          {(a.show.length > 0 || a.links.length > 0) && <div className="qa-actions">
            {a.show.map(t => <button key={t} type="button" className="small-button" onClick={() => goTo(t)}>Show {TARGET_LABEL[t].toLowerCase()}</button>)}
            {a.links.map(l => <a key={l.href} href={l.href} target="_blank" rel="noopener">{l.label}<span className="sr-only"> (opens in a new tab)</span></a>)}
          </div>}
        </li>)}
      </ol>
    </div>
  </dialog>;
}
