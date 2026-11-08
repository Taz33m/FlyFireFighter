/**
 * What the Free-WiLi console shows: a screen state machine over the truth-free mission view. Pure and
 * browser-safe. render.ts draws a ScreenSpec at 320 × 240 for the on-screen mirror (and for firmware that can show
 * full images); overlayText() reduces it to the one short line OG firmware v024 can put on the device itself.
 *
 * Priority: no run → mission aborted → a decision waiting (review hold until armed, then pending) → a decision
 * resolved in the last CONFIRM_TICKS (approved / rejected) → standing by (before authorization) → the phase rail.
 * Nothing here decides anything: the screen reports harness state, it never gates an action.
 */
import type { ActionSpec, ProposalRecord } from "../../../lib/contracts/actions.ts";
import { secondsFromTicks } from "../../../lib/contracts/clock.ts";
import type { FloorPlanPrior } from "../../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../../lib/contracts/frames.ts";
import type { MissionView } from "../../../lib/mission/protocol.ts";
import type { MissionPhaseId, PhaseRailState, PhaseStepState } from "../phases.ts";
import { PHASE_ORDER, PHASES } from "../phases.ts";
import { CONSOLE_SOURCE_LABEL } from "./decide.ts";

export type GateAction = "breach_opening" | "spray" | "release_payload";

/** A resolved decision stays on the console this long (mission ticks; 3 s at 100 Hz). */
export const CONFIRM_TICKS = 300;
/** The countdown ring moves in this many steps. */
export const RING_STEPS = 12;
/** OG firmware v024's text overlay showed 8 characters of a longer line on the 320 × 240 panel. */
export const MAX_OVERLAY_CHARS = 8;

export type ScreenSpec =
  | { readonly kind: "no_run" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "standby"; readonly caption: string }
  | {
    readonly kind: "phase";
    readonly phase: MissionPhaseId;
    /** 1-based position on the rail. */
    readonly index: number;
    readonly label: string;
    readonly caption: string;
    readonly steps: readonly PhaseStepState[];
    /** Why the mission is not advancing ("PAUSED", "HOLD", "ENDED"…), or null. */
    readonly halt: string | null;
  }
  | {
    readonly kind: "pending";
    readonly action: GateAction;
    readonly title: string;
    readonly target: string;
    /** Harness coverage of the debris region, 0..1, or null when the harness reported none. */
    readonly coverage: number | null;
    /** One short line: the first unseen place, or what the harness says instead. */
    readonly note: string;
    readonly secondsLeft: number;
    /** Remaining fraction of the proposal's window, quantised to RING_STEPS. */
    readonly ring: number;
    readonly digestPrefix: string;
    /** False during the review delay: approve is held. */
    readonly armed: boolean;
    /** The device template for this kind of decision: no per-proposal target, coverage, countdown or digest. */
    readonly template?: boolean;
  }
  | { readonly kind: "approved" | "rejected"; readonly action: GateAction; readonly title: string; readonly by: string; readonly viaConsole: boolean }
  | { readonly kind: "aborted"; readonly caption: string };

export type ScreenView = Pick<MissionView, "runId" | "status" | "tick" | "pendingApproval" | "proposals"> & { readonly belief: { readonly mapPrior: FloorPlanPrior | null } };

const TITLES: Readonly<Record<GateAction, string>> = { breach_opening: "BREAK GLASS", spray: "SPRAY WATER", release_payload: "RELEASE PAYLOAD" };
const SHORT: Readonly<Record<GateAction, string>> = { breach_opening: "GLASS", spray: "SPRAY", release_payload: "DROP" };
const PHASE_SHORT: Readonly<Record<MissionPhaseId, string>> = {
  report: "REPORT", approach: "APPROACH", access: "WINDOW", search: "SEARCH", suppress: "SUPPRESS", reassess: "REASSESS", guide: "GUIDE", outside: "OUTSIDE",
};

function isGate(kind: string): kind is GateAction {
  return kind === "breach_opening" || kind === "spray" || kind === "release_payload";
}

function vec(v: Vec3): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}

function openingLabel(prior: FloorPlanPrior | null, openingId: string): string {
  const opening = prior?.openings.find(o => o.id === openingId);
  if (opening === undefined) return openingId;
  const room = prior?.rooms.find(r => r.id === opening.rooms[0])?.name ?? opening.rooms[0] ?? "";
  return `${room} ${opening.kind}`.trim();
}

/** The action's target in a few words. */
export function targetText(action: ActionSpec, prior: FloorPlanPrior | null): string {
  switch (action.kind) {
    case "breach_opening": return openingLabel(prior, action.openingId);
    case "spray": return `${(action.flowLps * secondsFromTicks(action.durationTicks)).toFixed(2)} L at ${vec(action.aimPoint)}`;
    case "release_payload": return `${action.payloadId} at ${vec(action.releasePoint)}`;
    default: return "";
  }
}

const VALIDATED_PREFIX = /^Validated: this consequential action awaits the commander's individual approval\.\s*/;

/** The harness disclosure from the proposal's awaiting-approval history entry: coverage and the first unseen place. */
export function disclosure(record: ProposalRecord): { readonly coverage: number | null; readonly note: string } {
  const entry = [...record.history].reverse().find(h => h.status === "awaiting_approval");
  const text = (entry?.reason ?? "").replace(VALIDATED_PREFIX, "").trim();
  const coverage = /coverage: ([\d.]+)% of \d+ required samples/i.exec(text);
  const fraction = coverage === null ? null : Math.min(1, Math.max(0, Number(coverage[1]) / 100));
  const unseen = /Unseen: ([^,(.]+?)\s*(?:\(\d+\))?(?:,|\.|$)/.exec(text);
  if (unseen !== null) return { coverage: fraction, note: `Unseen: ${unseen[1].trim()}` };
  if (/No required part is unseen/.test(text)) return { coverage: fraction, note: "Nothing required unseen" };
  if (record.findings.length > 0) return { coverage: fraction, note: record.findings[0].reason };
  return { coverage: fraction, note: "Harness rechecks before and during execution" };
}

function pendingScreen(view: ScreenView, record: ProposalRecord, armed: boolean): ScreenSpec | null {
  const action = record.proposal.action;
  if (!isGate(action.kind)) return null;
  const left = Math.max(0, record.proposal.expiresTick - view.tick);
  const window = Math.max(1, record.proposal.expiresTick - record.proposal.createdTick);
  const { coverage, note } = disclosure(record);
  return {
    kind: "pending", action: action.kind, title: TITLES[action.kind], target: targetText(action, view.belief.mapPrior), coverage, note,
    secondsLeft: Math.ceil(secondsFromTicks(left)), ring: Math.ceil(Math.min(1, left / window) * RING_STEPS) / RING_STEPS,
    digestPrefix: record.proposal.digest.slice(0, 8), armed,
  };
}

type Decided = { readonly tick: number; readonly spec: ScreenSpec };

/** This record's approval or rejection, if it happened within CONFIRM_TICKS of the view. */
function decisionOf(record: ProposalRecord, tick: number): Decided | null {
  const action = record.proposal.action.kind;
  if (record.risk !== "consequential" || !isGate(action)) return null;
  const entry = record.history.findLast(h => (h.status === "approved" || h.status === "rejected") && h.tick <= tick && tick - h.tick <= CONFIRM_TICKS);
  if (entry === undefined) return null;
  const kind = entry.status === "approved" ? "approved" : "rejected";
  const by = kind === "approved" ? record.approval?.commanderId ?? "commander" : /^Rejected by (.+?): /.exec(entry.reason)?.[1] ?? "harness";
  return { tick: entry.tick, spec: { kind, action, title: TITLES[action], by, viaConsole: by.endsWith(`(${CONSOLE_SOURCE_LABEL})`) } };
}

/** The most recent approval or rejection within CONFIRM_TICKS, if any. */
function recentDecision(view: ScreenView): ScreenSpec | null {
  let best: Decided | null = null;
  for (const record of view.proposals) {
    const decided = decisionOf(record, view.tick);
    if (decided !== null && (best === null || decided.tick >= best.tick)) best = decided;
  }
  return best?.spec ?? null;
}

const HALT_WORDS = { paused: "PAUSED", aborted: "ABORTED", ended_incomplete: "ENDED", return: "RETURN", alternate_route: "REROUTE", hold: "HOLD", land: "LAND", failure: "FAILED" } as const;

function haltText(rail: PhaseRailState): string | null {
  const halt = rail.halt;
  if (halt === null) return null;
  return halt.kind === "contingency" ? HALT_WORDS[halt.contingency] : HALT_WORDS[halt.kind];
}

function phaseScreen(rail: PhaseRailState): ScreenSpec {
  return {
    kind: "phase", phase: rail.current, index: PHASE_ORDER.indexOf(rail.current) + 1, label: PHASES[rail.current].label.toUpperCase(),
    caption: rail.caption, steps: rail.steps.map(s => s.state), halt: haltText(rail),
  };
}

export interface ScreenInput {
  readonly view: ScreenView | null;
  readonly rail: PhaseRailState | null;
  /** The pending decision's review delay has passed (approval.ts approvalArmed for the digest on screen). */
  readonly armed: boolean;
}

const ABORTED_CAPTION = "Remaining actuation stops; the harness selects a contingency.";
const AWAITING_REPORT = "Waiting for the caller's report";
const AWAITING_AUTHORIZATION = "Waiting for mission authorization";


export function deriveScreen({ view, rail, armed }: ScreenInput): ScreenSpec {
  if (view === null) return { kind: "no_run" };
  if (view.status === "aborted") return { kind: "aborted", caption: ABORTED_CAPTION };
  const pending = view.pendingApproval === null ? null : pendingScreen(view, view.pendingApproval, armed);
  if (pending !== null) return pending;
  const decided = recentDecision(view);
  if (decided !== null) return decided;
  if (view.status === "awaiting_report") return { kind: "standby", caption: AWAITING_REPORT };
  if (view.status === "awaiting_authorization") return { kind: "standby", caption: AWAITING_AUTHORIZATION };
  return rail === null ? { kind: "standby", caption: "" } : phaseScreen(rail);
}

/** The proposal digest a screen shows, if any (for display confirmation). */
export function screenDigest(spec: ScreenSpec, view: ScreenView | null): string | null {
  return spec.kind === "pending" ? view?.pendingApproval?.proposal.digest ?? null : null;
}

/** The device's one short line under OG firmware v024: at most MAX_OVERLAY_CHARS printable ASCII characters. */
export function overlayText(spec: ScreenSpec): string {
  const text = ((): string => {
    switch (spec.kind) {
      case "no_run": return "NO RUN";
      case "disconnected": return "OFFLINE";
      case "standby": return "STANDBY";
      case "phase": return spec.halt ?? PHASE_SHORT[spec.phase];
      case "pending": return spec.armed ? `${SHORT[spec.action]} ${Math.min(99, spec.secondsLeft)}` : `${SHORT[spec.action]} ..`;
      case "approved": return "APPROVED";
      case "rejected": return "REJECTED";
      case "aborted": return "ABORTED";
    }
  })();
  return text.slice(0, MAX_OVERLAY_CHARS);
}

/**
 * Screens for image firmware (legacy v54), where each new image takes about 4.5 s to upload: the device shows a
 * fixed vocabulary that is installed at connect, so nothing is uploaded while a decision is waiting.
 * - A waiting decision shows its kind's template (no per-proposal target, coverage or countdown; the action card
 *   carries those), shown within one image command of the proposal appearing.
 * - Approved / rejected / standby / phase screens drop their per-run wording (commander, caption).
 * The mirror in the app keeps the full screen.
 */
export function deviceSpec(spec: ScreenSpec): ScreenSpec {
  switch (spec.kind) {
    case "pending": return templateFor(spec.action);
    case "approved":
    case "rejected": return { kind: spec.kind, action: "breach_opening", title: "", by: "", viaConsole: false };
    case "standby": return { kind: "standby", caption: "" };
    case "phase": return { ...spec, caption: "" };
    default: return spec;
  }
}

export function templateFor(action: GateAction): ScreenSpec {
  return { kind: "pending", action, title: TITLES[action], target: "", coverage: null, note: "", secondsLeft: 0, ring: 0, digestPrefix: "", armed: true, template: true };
}

/** What image firmware installs at connect, in order; verify marks the ones read back byte for byte. */
export const DEVICE_PRELOAD: readonly { readonly spec: ScreenSpec; readonly verify: boolean }[] = [
  ...(["breach_opening", "spray", "release_payload"] as const).map(action => ({ spec: templateFor(action), verify: true })),
  ...[{ kind: "standby", caption: "" } as const, { kind: "approved", action: "breach_opening", title: "", by: "", viaConsole: false } as const,
    { kind: "rejected", action: "breach_opening", title: "", by: "", viaConsole: false } as const, { kind: "aborted", caption: ABORTED_CAPTION } as const, { kind: "no_run" } as const]
    .map(spec => ({ spec: spec as ScreenSpec, verify: false })),
  ...PHASE_ORDER.map((phase, i) => ({
    spec: { kind: "phase", phase, index: i + 1, label: PHASES[phase].label.toUpperCase(), caption: "", steps: PHASE_ORDER.map((_, j) => (j < i ? "done" : j === i ? "current" : "upcoming")), halt: null } as ScreenSpec,
    verify: false,
  })),
];
