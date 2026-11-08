/**
 * Mission phases for presentation: the phase rail, the stage layout and the camera director.
 *
 * Contract (owned by the coordinator): phases are DERIVED from truth-free command state (PhaseView: the
 * fields of MissionView the rail reads, so a live MissionView is passed as is and a recorded replay rebuilds
 * one from events.jsonl) plus the evaluator's labeled MissionResult. They never read RenderSnapshot or
 * simulator state. A phase is a
 * reading aid for the audience, not an authority: it never gates an action and never implies an
 * all-clear. "outside" is reachable only from the simulation evaluator's reached_assembly_point outcome.
 *
 * derivePhaseRail is pure and browser-safe (relative .ts imports, so `node --test` runs it directly). The
 * rail position is the furthest phase that current evidence supports; it is not a remembered history:
 * - report → approach once a report exists (awaiting_authorization asks the commander to authorize).
 * - access once a consequential breach_opening proposal has reached the commander (any status but the
 *   transient proposed/validated). Only a COMPLETED breach is progress past the gate.
 * - search once the drone's ESTIMATED pose (belief.pose, never the true pose) lies inside the floor-plan
 *   prior: inside a room polygon of the floor at that height, or in an interior wall gap (doorway) between
 *   two rooms. A completed breach alone is not "inside": the drone must still be estimated past the inner
 *   wall face. Entry without a completed breach marks access "skipped". Without an estimated pose (a replay
 *   that did not record one) or a floor-plan prior, nothing is estimated inside, so the rail never reaches
 *   search from position alone.
 * - suppress once a consequential spray proposal has reached the commander; reassess only once the latest
 *   one COMPLETED. A rejected, invalidated, expired or aborted gate therefore holds the rail at that gate.
 *   Independent later evidence (entry through another opening; guidance on a separately supported route)
 *   can move the rail on, and then marks the refused gate "skipped", never "done".
 * - guide once a guide proposal is executing or completed. A possible-occupant track is progress inside
 *   search, never a step towards outside.
 * - outside is current only when the evaluator's outcome for THIS run reports an occupant with
 *   reached_assembly_point, and done only when isCompletedRescue(outcome) also holds.
 */
import type { ActionKind, Contingency, ProposalHistoryEntry, ProposalStatus, RiskClass } from "../../lib/contracts/actions.ts";
import type { CallerReport, FloorPlanPrior, OccupantTrack, RouteAssessment } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import type { Point2, Region } from "../../lib/contracts/geometry.ts";
import { distanceToRegion, pointInPolygon } from "../../lib/contracts/geometry.ts";
import type { MissionResult } from "../../lib/contracts/outcomes.ts";
import { isCompletedRescue, rescueLabel } from "../../lib/contracts/outcomes.ts";
import type { MissionStatus } from "../../lib/mission/protocol.ts";
import { rescueWords } from "./outcome-words.ts";

/** The demo loop's eight beats, in order (DemoLoop.md, PRD §3). */
export type MissionPhaseId = "report" | "approach" | "access" | "search" | "suppress" | "reassess" | "guide" | "outside";

export const PHASE_ORDER: readonly MissionPhaseId[] = ["report", "approach", "access", "search", "suppress", "reassess", "guide", "outside"];

export interface PhaseDefinition {
  readonly id: MissionPhaseId;
  /** One or two words for the rail. */
  readonly label: string;
  /** True for the two commander approval gates (glass, water). */
  readonly gate: boolean;
}

export const PHASES: Readonly<Record<MissionPhaseId, PhaseDefinition>> = {
  report: { id: "report", label: "Report", gate: false },
  approach: { id: "approach", label: "Approach", gate: false },
  access: { id: "access", label: "Window access", gate: true },
  search: { id: "search", label: "Search", gate: false },
  suppress: { id: "suppress", label: "Suppress fire", gate: true },
  reassess: { id: "reassess", label: "Reassess route", gate: false },
  guide: { id: "guide", label: "Guide out", gate: false },
  outside: { id: "outside", label: "Outside", gate: false },
};

/** Per-step state on the rail. "skipped" = later evidence shows the step was bypassed (e.g. an observed opening made breach unnecessary). */
export type PhaseStepState = "done" | "current" | "upcoming" | "skipped";

/** State of an approval gate step, from the latest consequential proposal of that kind. */
export type GateState = "none" | "awaiting_approval" | "approved" | "executing" | "completed" | "rejected" | "invalidated" | "expired" | "aborted";

export interface PhaseStep {
  readonly id: MissionPhaseId;
  readonly state: PhaseStepState;
  /** Only meaningful when PHASES[id].gate; "none" otherwise. */
  readonly gate: GateState;
}

/** Why the mission is not advancing, shown over the rail. null while it advances normally. */
export type PhaseHalt =
  | { readonly kind: "paused" }
  | { readonly kind: "aborted"; readonly reason: string | null }
  | { readonly kind: "contingency"; readonly contingency: "return" | "alternate_route" | "hold" | "land" | "failure"; readonly reason: string }
  | { readonly kind: "ended_incomplete"; readonly reason: string };

export interface PhaseRailState {
  readonly current: MissionPhaseId;
  readonly steps: readonly PhaseStep[];
  readonly halt: PhaseHalt | null;
  /** Short plain-language line for the presenter, e.g. "Waiting for your approval to break the rear-bedroom window". */
  readonly caption: string;
}

/* Input: the truth-free state the rail reads. */

/** The parts of a proposed action the rail reads. Every ActionSpec is one. */
export interface PhaseAction {
  readonly kind: ActionKind;
  /** breach_opening only: the opening to break, for the caption. */
  readonly openingId?: string;
}

/** The parts of a ProposalRecord the rail reads. A harness ProposalRecord is one. */
export interface PhaseProposal {
  readonly proposal: { readonly id: string; readonly action: PhaseAction };
  readonly risk: RiskClass;
  readonly status: ProposalStatus;
  readonly history: readonly Pick<ProposalHistoryEntry, "status">[];
}

/**
 * The parts of an OccupantTrack the rail reads. `position` is null when it is not known (a replay rebuilds
 * tracks from track events, which carry no position); such a track never counts as near a spray region.
 */
export interface PhaseTrack extends Pick<OccupantTrack, "status" | "roomId" | "uncertaintyM"> {
  readonly position: Vec3 | null;
}

/**
 * The truth-free state the rail reads: a narrowed MissionView. A live MissionView is assignable to it
 * unchanged. A replay rebuilds it from events.jsonl and the truth-free replay summary: there the floor-plan
 * prior may be unavailable (null: reduced captions) and the estimated pose may be unrecorded (null: no
 * inside estimate).
 */
export interface PhaseView {
  readonly runId: string;
  readonly status: MissionStatus;
  /** Only presence is read: null until the commander authorizes the mission. */
  readonly envelope: object | null;
  readonly belief: {
    readonly reports: readonly Pick<CallerReport, "roomHint">[];
    readonly mapPrior: FloorPlanPrior | null;
    /** The ESTIMATED pose (never the true pose); null when it is not known. */
    readonly pose: { readonly position: Vec3 } | null;
    readonly routes: readonly Pick<RouteAssessment, "purpose" | "status">[];
    readonly tracks: readonly PhaseTrack[];
  };
  readonly proposals: readonly PhaseProposal[];
  readonly pendingApproval: PhaseProposal | null;
  readonly affectedRegions: readonly { readonly proposalId: string; readonly region: Region }[];
  readonly contingency: Pick<Contingency, "kind" | "reason"> | null;
}

/* Derivation. */

export interface PhaseRailInput {
  readonly view: PhaseView | null;
  /** The simulation evaluator's result; ignored unless it belongs to the view's run. */
  readonly outcome: MissionResult | null;
}

/** Tolerance when matching an estimated height to a floor (metres). */
export const FLOOR_TOLERANCE_M = 0.05;
/** A point within this distance of two different rooms' outlines is in the interior wall or doorway between them. */
export const INTERIOR_GAP_M = 0.2;

type GateKind = "breach_opening" | "spray";

const GATE_KINDS: ReadonlySet<string> = new Set<GateKind>(["breach_opening", "spray"]);
/** A consequential proposal in these statuses has not reached the commander yet; a routine one has not started. */
const TRANSIENT: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["proposed", "validated"]);
const STOPPED: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["rejected", "invalidated", "expired", "aborted"]);

const GATE_BY_STATUS: Readonly<Record<ProposalStatus, GateState>> = {
  proposed: "none",
  validated: "none",
  awaiting_approval: "awaiting_approval",
  approved: "approved",
  executing: "executing",
  completed: "completed",
  rejected: "rejected",
  invalidated: "invalidated",
  expired: "expired",
  aborted: "aborted",
};

/** The most recent consequential proposal of this kind that has reached a gate decision point (or been refused). */
export function latestGateProposal<T extends PhaseProposal>(proposals: readonly T[], kind: GateKind): T | null {
  for (let i = proposals.length - 1; i >= 0; i--) {
    const record = proposals[i];
    if (record.proposal.action.kind === kind && record.risk === "consequential" && !TRANSIENT.has(record.status)) return record;
  }
  return null;
}

export function gateStateOf(record: PhaseProposal | null): GateState {
  return record === null ? "none" : GATE_BY_STATUS[record.status];
}

/** True when the commander was asked; false for a proposal the harness refused at submission. */
function reachedCommander(record: PhaseProposal): boolean {
  return record.history.some(h => h.status === "awaiting_approval");
}

/* Inside the house, from the estimated pose and the floor-plan prior. */

type Floor = FloorPlanPrior["floors"][number];

function floorAt(prior: FloorPlanPrior, z: number): Floor | null {
  let best: Floor | null = null;
  for (const floor of prior.floors) if (floor.elevationM <= z + FLOOR_TOLERANCE_M && (best === null || floor.elevationM > best.elevationM)) best = floor;
  return best;
}

function segmentDistance(x: number, y: number, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function distanceToOutline(x: number, y: number, polygon: readonly Point2[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i++) best = Math.min(best, segmentDistance(x, y, polygon[i], polygon[(i + 1) % polygon.length]));
  return best;
}

export interface InsideEstimate {
  /** The prior's room containing the estimate; null when it lies in an interior wall gap (a doorway) between rooms. */
  readonly roomId: string | null;
}

/**
 * Whether an ESTIMATED position lies inside the house by the floor-plan prior: on the highest floor at or below
 * its height (the slab and stairwell between floors count as the floor below; above the top floor's ceiling
 * does not count), inside one of that floor's room outlines or within INTERIOR_GAP_M of two of them. A point
 * by a single room's outline (an exterior wall, a window standoff) is outside. null means outside.
 */
export function estimatedInside(prior: FloorPlanPrior | null, position: Vec3 | null): InsideEstimate | null {
  if (prior === null || position === null) return null;
  const floor = floorAt(prior, position.z);
  if (floor === null) return null;
  const topFloor = !prior.floors.some(f => f.elevationM > floor.elevationM);
  if (topFloor && position.z > floor.ceilingM + FLOOR_TOLERANCE_M) return null;
  const rooms = prior.rooms.filter(r => r.floor === floor.index);
  const room = rooms.find(r => pointInPolygon(position.x, position.y, r.polygon));
  if (room !== undefined) return { roomId: room.id };
  const near = rooms.filter(r => distanceToOutline(position.x, position.y, r.polygon) <= INTERIOR_GAP_M);
  return near.length >= 2 ? { roomId: null } : null;
}

/* Evidence gathered once from the view and outcome. */

interface Arrivals {
  readonly arrived: number;
  readonly total: number;
  /** Arrived and isCompletedRescue(result): the only condition that marks "outside" done. */
  readonly completed: boolean;
  readonly result: MissionResult;
}

interface Evidence {
  readonly view: PhaseView;
  readonly reported: boolean;
  readonly breach: PhaseProposal | null;
  readonly breachCompleted: boolean;
  readonly inside: InsideEstimate | null;
  readonly spray: PhaseProposal | null;
  readonly sprayCompleted: boolean;
  /** Most recent guide proposal of any status. */
  readonly guide: PhaseProposal | null;
  readonly guiding: boolean;
  readonly guided: boolean;
  readonly routeSupported: boolean;
  /** Possible-occupant tracks (merged and retracted tracks excluded). */
  readonly tracks: readonly PhaseTrack[];
  readonly arrivals: Arrivals | null;
}

function arrivalsOf(view: PhaseView, outcome: MissionResult | null): Arrivals | null {
  if (outcome === null || outcome.runId !== view.runId) return null;
  // "outside_not_at_assembly_point" is not an arrival.
  const arrived = outcome.occupants.filter(o => o.outcome === "reached_assembly_point").length;
  return { arrived, total: outcome.occupants.length, completed: arrived > 0 && isCompletedRescue(outcome), result: outcome };
}

function hasStatus(proposals: readonly PhaseProposal[], kind: string, statuses: readonly ProposalStatus[]): boolean {
  return proposals.some(r => r.proposal.action.kind === kind && statuses.includes(r.status));
}

function gatherEvidence(view: PhaseView, outcome: MissionResult | null): Evidence {
  const proposals = view.proposals;
  const guides = proposals.filter(r => r.proposal.action.kind === "guide");
  return {
    view,
    reported: view.status !== "awaiting_report" || view.belief.reports.length > 0,
    breach: latestGateProposal(proposals, "breach_opening"),
    breachCompleted: hasStatus(proposals, "breach_opening", ["completed"]),
    inside: estimatedInside(view.belief.mapPrior, view.belief.pose?.position ?? null),
    spray: latestGateProposal(proposals, "spray"),
    sprayCompleted: hasStatus(proposals, "spray", ["completed"]),
    guide: guides.length === 0 ? null : guides[guides.length - 1],
    guiding: hasStatus(guides, "guide", ["executing"]),
    guided: hasStatus(guides, "guide", ["executing", "completed"]),
    routeSupported: view.belief.routes.some(r => r.purpose === "evacuation" && r.status === "supported"),
    tracks: view.belief.tracks.filter(t => t.status === "possible"),
    arrivals: arrivalsOf(view, outcome),
  };
}

/* Position and step states. */

/** The furthest phase current evidence supports. Only completion moves the rail past a gate. */
function reachedPhase(e: Evidence): MissionPhaseId {
  if (e.arrivals !== null && e.arrivals.arrived > 0) return "outside";
  if (e.guided) return "guide";
  if (e.spray !== null) return e.spray.status === "completed" ? "reassess" : "suppress";
  if (e.inside !== null) return "search";
  if (e.breach !== null) return "access";
  return e.reported ? "approach" : "report";
}

/** A step behind the rail: done when its own evidence exists, otherwise bypassed ("skipped"). */
function passedState(id: MissionPhaseId, e: Evidence): PhaseStepState {
  if (id === "access") return e.breachCompleted ? "done" : "skipped";
  if (id === "suppress") return e.sprayCompleted ? "done" : "skipped";
  if (id === "guide") return e.guided ? "done" : "skipped";
  if (id === "reassess") return e.guided || e.routeSupported ? "done" : "skipped";
  return "done";
}

function buildSteps(current: MissionPhaseId, e: Evidence): PhaseStep[] {
  const at = PHASE_ORDER.indexOf(current);
  const completed = e.arrivals !== null && e.arrivals.completed;
  return PHASE_ORDER.map((id, i): PhaseStep => {
    const state: PhaseStepState = i > at ? "upcoming" : i < at ? passedState(id, e) : completed ? "done" : "current";
    const gate = id === "access" ? gateStateOf(e.breach) : id === "suppress" ? gateStateOf(e.spray) : "none";
    return { id, state, gate };
  });
}

/* Halts. */

function occupantCount(a: Arrivals): string {
  if (a.arrived === 0) return "No simulated occupant";
  return `${a.arrived} of ${a.total} simulated ${a.total === 1 ? "occupant" : "occupants"}`;
}

function incompleteReason(a: Arrivals): string {
  const violations = a.result.violations.length;
  const scored = violations > 0
    ? `; ${violations} scored constraint ${violations === 1 ? "violation" : "violations"}`
    : a.arrived > 0 && a.arrived === a.total ? "; the evaluator scored the run incomplete" : "";
  return `${occupantCount(a)} reached the assembly point${scored}.`;
}

function deriveHalt(view: PhaseView, arrivals: Arrivals | null): PhaseHalt | null {
  if (view.status === "paused") return { kind: "paused" };
  if (view.status === "aborted") return { kind: "aborted", reason: view.contingency?.reason ?? null };
  if (view.status === "ended") {
    // Without this run's outcome we cannot say whether the run is complete; the caption says so.
    if (arrivals === null || arrivals.completed) return null;
    return { kind: "ended_incomplete", reason: incompleteReason(arrivals) };
  }
  if (view.contingency !== null) return { kind: "contingency", contingency: view.contingency.kind, reason: view.contingency.reason };
  return null;
}

/* Captions: one short plain sentence, no rule ids, digests or proposal ids. */

const CONTINGENCY_PHRASE: Readonly<Record<Contingency["kind"], string>> = {
  return: "the drone is returning",
  alternate_route: "the drone is returning by an alternate route",
  hold: "the drone is holding position",
  land: "the drone is landing",
  failure: "no supported manoeuvre remains, so the drone brakes and descends",
};

/** The cause at the head of a harness reason ("Localization stopped supporting movement (trigger: …). …"), if plain. */
function leadClause(reason: string): string | null {
  const head = reason.split(/\s\(trigger:|\.\s|;\s/)[0].trim().replace(/\.$/, "");
  if (head.length === 0 || head.length > 90 || /\b[A-Z]\d{1,2}\b/.test(head)) return null;
  return head;
}

function roomLabel(prior: FloorPlanPrior | null, roomId: string | null): string | null {
  if (prior === null || roomId === null) return null;
  const name = prior.rooms.find(r => r.id === roomId)?.name;
  return name === undefined ? null : name.toLowerCase();
}

function openingPhrase(prior: FloorPlanPrior | null, openingId: string | undefined): string {
  const opening = prior?.openings.find(o => o.id === openingId);
  if (opening === undefined) return "the window";
  const room = roomLabel(prior, opening.rooms[0]);
  return room === null ? `the ${opening.kind}` : `the ${room} ${opening.kind}`;
}

function reportedRoom(view: PhaseView): string | null {
  const reports = view.belief.reports;
  for (let i = reports.length - 1; i >= 0; i--) {
    const room = roomLabel(view.belief.mapPrior, reports[i].roomHint);
    if (room !== null) return room;
  }
  return null;
}

/** "the rear bedroom window" → "The rear bedroom window". */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ACCESS_CAPTIONS: Readonly<Record<GateState, (target: string) => string>> = {
  none: () => "Looking for a way in.",
  awaiting_approval: t => `Waiting for your approval to break ${t}.`,
  approved: t => `Approved: the harness rechecks current evidence before breaking ${t}.`,
  executing: t => `Breaking ${t} as approved.`,
  completed: t => `${capitalized(t)} is open; the drone is moving inside.`,
  rejected: t => `Breaking ${t} was rejected; the drone needs another way in.`,
  invalidated: t => `New evidence cancelled breaking ${t}; any new request needs a new approval.`,
  expired: t => `The request to break ${t} expired; any new request needs a new approval.`,
  aborted: t => `Breaking ${t} was stopped; any new request needs a new approval.`,
};

const SUPPRESS_CAPTIONS: Readonly<Record<GateState, string>> = {
  none: "Assessing the fire blocking the route.",
  awaiting_approval: "Waiting for your approval to spray water on the fire blocking the route.",
  approved: "Spray approved: the harness rechecks current evidence before any water flows.",
  executing: "Spraying water as approved; new evidence can still stop it.",
  completed: "Water applied; the route must be checked again.",
  rejected: "The water spray was rejected; the route stays blocked.",
  invalidated: "New evidence cancelled the approved spray; any new spray needs a new approval.",
  expired: "The spray request expired before any water flowed; any new spray needs a new approval.",
  aborted: "The water spray was stopped; any new spray needs a new approval.",
};

function approachCaption(e: Evidence): string {
  if (e.view.envelope === null) return "Report received: authorize the mission to start the approach.";
  const room = reportedRoom(e.view);
  return room === null ? "Approaching the house from outside." : `Approaching the reported ${room} from outside.`;
}

function accessCaption(e: Evidence): string {
  const record = e.breach;
  if (record === null) return ACCESS_CAPTIONS.none("");
  const target = openingPhrase(e.view.belief.mapPrior, record.proposal.action.openingId);
  if (record.status === "rejected") {
    return reachedCommander(record) ? `You rejected breaking ${target}; the drone needs another way in.` : `Safety checks refused breaking ${target} before it reached you.`;
  }
  return ACCESS_CAPTIONS[gateStateOf(record)](target);
}

function searchCaption(e: Evidence): string {
  const prior = e.view.belief.mapPrior;
  if (e.tracks.length > 1) return `${e.tracks.length} possible occupants observed; a detection is not an evacuation.`;
  if (e.tracks.length === 1) {
    const room = roomLabel(prior, e.tracks[0].roomId);
    return `Possible occupant observed${room === null ? "" : ` in the ${room}`}; a detection is not an evacuation.`;
  }
  const here = roomLabel(prior, e.inside?.roomId ?? null);
  return here === null ? "Searching inside the house." : `Searching the ${here}.`;
}

/** A possible occupant whose position (within its uncertainty) touches the harness-derived spray region. */
function personNearSpray(e: Evidence, record: PhaseProposal): boolean {
  const region = e.view.affectedRegions.find(r => r.proposalId === record.proposal.id)?.region;
  if (region === undefined) return false;
  return e.tracks.some(t => t.position !== null && distanceToRegion(region, t.position) <= Math.max(0, t.uncertaintyM));
}

function suppressCaption(e: Evidence): string {
  const record = e.spray;
  if (record === null) return SUPPRESS_CAPTIONS.none;
  if (record.status === "rejected") {
    return reachedCommander(record) ? "You rejected the water spray; the route stays blocked." : "Safety checks refused the water spray before it reached you.";
  }
  if (record.status === "invalidated" && personNearSpray(e, record)) return "Spray cancelled: a possible person was observed in the spray area; any new spray needs a new approval.";
  return SUPPRESS_CAPTIONS[gateStateOf(record)];
}

function reassessCaption(e: Evidence): string {
  if (e.guide !== null && STOPPED.has(e.guide.status)) return "Guidance stopped; checking the exit route again.";
  if (e.guide !== null && e.guide.status === "validated") return "Guidance accepted; it is about to start.";
  return "Water applied; checking the exit route again with fresh observations.";
}

function guideCaption(e: Evidence): string {
  if (e.guiding) return "Guiding the possible occupant out with light and voice cues.";
  if (e.guide !== null && STOPPED.has(e.guide.status)) return "Guidance stopped; arrival outside is not confirmed.";
  return "Guidance finished; arrival outside is not confirmed yet.";
}

function outsideCaption(e: Evidence): string {
  const a = e.arrivals;
  if (a === null) return "Waiting for the simulation evaluator's outcome.";
  if (a.completed) {
    const count = a.total > 1 ? `: ${occupantCount(a)} at the assembly point` : "";
    return `${rescueWords(rescueLabel(a.result))}${count}; other rooms remain unresolved.`;
  }
  return `${occupantCount(a)} at the assembly point; other rooms remain unresolved.`;
}

const PHASE_CAPTIONS: Readonly<Record<MissionPhaseId, (e: Evidence) => string>> = {
  report: () => "Waiting for the caller's report.",
  approach: approachCaption,
  access: accessCaption,
  search: searchCaption,
  suppress: suppressCaption,
  reassess: reassessCaption,
  guide: guideCaption,
  outside: outsideCaption,
};

function endedCaption(a: Arrivals | null): string {
  if (a === null) return "The run ended; waiting for the simulation evaluator's outcome.";
  return `${occupantCount(a)} ${a.arrived === 0 ? "reached" : "at"} the assembly point; the run ended incomplete and needs human assistance.`;
}

function haltCaption(halt: PhaseHalt, e: Evidence, current: MissionPhaseId): string {
  switch (halt.kind) {
    case "paused": return `Paused during ${PHASES[current].label.toLowerCase()}; the simulated clock is frozen.`;
    case "aborted": return e.view.contingency === null ? "Mission aborted by the commander." : `Mission aborted by the commander; ${CONTINGENCY_PHRASE[e.view.contingency.kind]}.`;
    case "contingency": return `${leadClause(halt.reason) ?? "A safety contingency is in effect"}; ${CONTINGENCY_PHRASE[halt.contingency]}.`;
    case "ended_incomplete": return endedCaption(e.arrivals);
  }
}

function railCaption(e: Evidence, current: MissionPhaseId, halt: PhaseHalt | null): string {
  if (halt !== null) return haltCaption(halt, e, current);
  if (e.view.status === "ended" && e.arrivals === null) return endedCaption(null);
  const pending = e.view.pendingApproval;
  if (pending !== null && !GATE_KINDS.has(pending.proposal.action.kind)) return "A decision is waiting for your approval on the action card.";
  return PHASE_CAPTIONS[current](e);
}

function idleRail(): PhaseRailState {
  return {
    current: "report",
    steps: PHASE_ORDER.map((id, i): PhaseStep => ({ id, state: i === 0 ? "current" : "upcoming", gate: "none" })),
    halt: null,
    caption: "No run yet: start a run, then enter the caller's report.",
  };
}

/** The phase rail for the current view and this run's evaluator outcome. Pure; reads no simulator truth. */
export function derivePhaseRail({ view, outcome }: PhaseRailInput): PhaseRailState {
  if (view === null) return idleRail();
  const e = gatherEvidence(view, outcome);
  const current = reachedPhase(e);
  const halt = deriveHalt(view, e.arrivals);
  return { current, steps: buildSteps(current, e), halt, caption: railCaption(e, current, halt) };
}
