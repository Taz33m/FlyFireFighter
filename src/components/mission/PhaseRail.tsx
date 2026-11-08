/**
 * Phase rail: where the mission is in the eight-beat demo loop, for a projector audience. Renders a
 * PhaseRailState from derivePhaseRail (truth-free MissionView plus this run's evaluator outcome). It is a
 * reading aid only: it never gates an action and never implies a room or house all-clear.
 */
import type { Contingency } from "@/lib/contracts/actions";
import type { GateState, PhaseHalt, PhaseRailState, PhaseStep, PhaseStepState } from "./phases";
import { PHASES } from "./phases";
import styles from "./PhaseRail.module.css";

export type PhaseRailSize = "compact" | "stage";

interface Props {
  readonly state: PhaseRailState;
  /** "stage" sets projector-sized type; "compact" fits the operator console. */
  readonly size?: PhaseRailSize;
  readonly className?: string;
}

const GATE_TEXT: Readonly<Record<Exclude<GateState, "none">, string>> = {
  awaiting_approval: "Needs your approval",
  approved: "Approved",
  executing: "In progress",
  completed: "Completed",
  rejected: "Rejected",
  invalidated: "Invalidated",
  expired: "Expired",
  aborted: "Stopped",
};

const STATE_TEXT: Readonly<Record<PhaseStepState, string>> = {
  done: "done",
  current: "current step",
  upcoming: "upcoming",
  skipped: "skipped",
};

const CONTINGENCY_TITLE: Readonly<Record<Contingency["kind"], string>> = {
  return: "returning",
  alternate_route: "returning by an alternate route",
  hold: "holding position",
  land: "landing",
  failure: "no supported manoeuvre",
};

function haltTitle(halt: PhaseHalt): string {
  switch (halt.kind) {
    case "paused": return "Paused";
    case "aborted": return "Mission aborted";
    case "contingency": return `Contingency: ${CONTINGENCY_TITLE[halt.contingency]}`;
    case "ended_incomplete": return "Run ended incomplete: human assistance needed";
  }
}

/** The harness's reason, minus its internal trigger code; the full text stays in the tooltip. */
function haltDetail(halt: PhaseHalt): { readonly text: string; readonly full: string } | null {
  const full = halt.kind === "paused" ? null : halt.reason;
  if (full === null || full.trim() === "") return null;
  return { text: full.replace(/\s*\(trigger: [a-z_]+\)/g, ""), full };
}

/** Gate steps always say they are gates; "none" reads as the gate itself until something is requested. */
function gateText(step: PhaseStep): { readonly text: string; readonly prefix: boolean } {
  if (step.gate !== "none") return { text: GATE_TEXT[step.gate], prefix: true };
  return step.state === "skipped" ? { text: "Not requested", prefix: true } : { text: "Approval gate", prefix: false };
}

function HaltBanner({ halt }: { readonly halt: PhaseHalt }) {
  const detail = haltDetail(halt);
  return <div className={styles.halt} data-kind={halt.kind} role={halt.kind === "paused" ? "status" : "alert"}>
    <span className={styles.haltIcon} aria-hidden="true">{halt.kind === "paused" ? <PauseGlyph /> : <StopGlyph />}</span>
    <strong className={styles.haltTitle}>{haltTitle(halt)}</strong>
    {detail !== null && <span className={styles.haltDetail} title={detail.full}>{detail.text}</span>}
  </div>;
}

function CheckGlyph() {
  return <svg viewBox="0 0 16 16" focusable="false"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SkipGlyph() {
  return <svg viewBox="0 0 16 16" focusable="false"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Approval gate: a shield with a key line, the commander's individual sign-off. */
function ShieldGlyph() {
  return <svg viewBox="0 0 16 16" focusable="false"><path d="M8 1.5l5.5 2v4.2c0 3.3-2.3 5.8-5.5 6.8-3.2-1-5.5-3.5-5.5-6.8V3.5z" fill="currentColor" /><path d="M5.6 8l1.7 1.7 3.2-3.4" fill="none" className={styles.cut} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function PauseGlyph() {
  return <svg viewBox="0 0 16 16" focusable="false"><path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>;
}

function StopGlyph() {
  return <svg viewBox="0 0 16 16" focusable="false"><path d="M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2z" fill="currentColor" /><path d="M8 4.5v4.2M8 11v.4" className={styles.cut} strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

function Marker({ step, index }: { readonly step: PhaseStep; readonly index: number }) {
  if (step.state === "done") return <CheckGlyph />;
  if (step.state === "skipped") return <SkipGlyph />;
  return <span className={styles.number}>{index + 1}</span>;
}

function Step({ step, index }: { readonly step: PhaseStep; readonly index: number }) {
  const phase = PHASES[step.id];
  const gate = gateText(step);
  return <li className={styles.step} data-state={step.state} data-gate={phase.gate ? step.gate : undefined} aria-current={step.state === "current" ? "step" : undefined}>
    <span className={styles.marker} aria-hidden="true">
      <Marker step={step} index={index} />
      {phase.gate && <span className={styles.shield}><ShieldGlyph /></span>}
    </span>
    <span className={styles.label}>
      {phase.label}
      <span className={styles.srOnly}>, {STATE_TEXT[step.state]}</span>
    </span>
    {phase.gate && <span className={styles.gate}>
      {gate.prefix && <span className={styles.srOnly}>Approval gate: </span>}
      {gate.text}
    </span>}
    {!phase.gate && step.state === "skipped" && <span className={styles.note} aria-hidden="true">Skipped</span>}
  </li>;
}

export function PhaseRail({ state, size = "compact", className }: Props) {
  const rootClass = className === undefined ? styles.rail : `${styles.rail} ${className}`;
  return <section className={rootClass} data-size={size} data-halt={state.halt?.kind} aria-label="Mission phases">
    {state.halt !== null && <HaltBanner halt={state.halt} />}
    <ol className={styles.steps}>
      {state.steps.map((step, index) => <Step key={step.id} step={step} index={index} />)}
    </ol>
    <p className={styles.caption} aria-live="polite">{state.caption}</p>
  </section>;
}

