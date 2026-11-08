/**
 * Camera director ("Auto" camera) for the simulation view: pure and browser-safe.
 *
 * Inputs: the presentation phase and halt (derived from the truth-free MissionView, see ../mission/phases.ts),
 * framing targets taken from MissionView only (the pending or executing consequential proposal with its
 * harness-derived affected region, and the floor-plan prior's exit and assembly area), the run id and a
 * wall clock. It never reads RenderSnapshot: framing an occupant or a fire the drone has not observed would
 * show the audience simulator truth. Following the rendered drone ("follow" mode) is fine; that is the
 * aircraft itself, which the view already draws.
 *
 * Output: a camera mode, an optional focus (world-frame point + radius, applied by ViewCameras.setFocus) and a
 * plain-language reason.
 *
 * Rules:
 * - A cut needs the desired shot to be stable for SETTLE_MS and the current shot to have been held for
 *   MIN_DWELL_MS, or PRIORITY_DWELL_MS when an approval is waiting on the target (so the target is on screen
 *   before the action card's Approve arms). Inputs that oscillate faster than SETTLE_MS never cut.
 * - A halt (paused, aborted, contingency, ended) holds the current framing.
 * - A manual choice wins until Auto is re-enabled; re-enabling cuts straight to the desired shot.
 * - A new run cuts straight to its establishing shot.
 * - Deterministic: the same sequence of inputs always gives the same outputs. The clock is only compared,
 *   never read, and a clock that goes backwards never causes a cut.
 */
import type { ActionSpec, ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import type { FloorPlanPrior } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import { vec3 } from "../../lib/contracts/frames.ts";
import type { Region } from "../../lib/contracts/geometry.ts";
import { pointInPolygon, regionBounds } from "../../lib/contracts/geometry.ts";
import type { MissionView } from "../../lib/mission/protocol.ts";
import type { CameraFocus, CameraMode } from "../../lib/render/view-cameras.ts";
import type { MissionPhaseId, PhaseHalt } from "../mission/phases.ts";

/** A framing is held at least this long before Auto cuts to another. */
export const MIN_DWELL_MS = 4000;
/** When an approval is waiting on a target, Auto may cut to it after this long. */
export const PRIORITY_DWELL_MS = 1000;
/** A new desired shot must persist this long before Auto cuts to it. */
export const SETTLE_MS = 600;
export const MIN_FOCUS_RADIUS_M = 2.5;
export const MAX_FOCUS_RADIUS_M = 30;

/* Framing targets, from MissionView only. */

type InterventionKind = "breach_opening" | "spray" | "release_payload";

export interface ActionFocus {
  readonly proposalId: string;
  readonly kind: InterventionKind;
  readonly awaitingApproval: boolean;
  readonly mode: Exclude<CameraMode, "follow">;
  readonly focus: CameraFocus;
  /** False when the harness reported no affected region: only the target and standoff are framed. */
  readonly regionFramed: boolean;
}

/** Interventions keep their framing while approved or executing, so the audience sees the effect. */
const FRAMED_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["approved", "executing"]);

interface Points {
  readonly kind: InterventionKind;
  readonly target: Vec3;
  readonly standoff: Vec3 | null;
}

function interventionPoints(action: ActionSpec): Points | null {
  switch (action.kind) {
    case "breach_opening": return { kind: action.kind, target: action.strikePoint, standoff: action.standoff };
    case "spray": return { kind: action.kind, target: action.aimPoint, standoff: action.standoff };
    case "release_payload": return { kind: action.kind, target: action.releasePoint, standoff: null };
    default: return null;
  }
}

const finite = (p: Vec3) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
const mid = (a: Vec3, b: Vec3) => vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);

/** Smallest axis-aligned bounds of the points, as a centre and half-diagonal radius (clamped). */
function enclose(points: readonly Vec3[]): { readonly point: Vec3; readonly radiusM: number } | null {
  if (points.length === 0 || !points.every(finite)) return null;
  const min = vec3(Math.min(...points.map(p => p.x)), Math.min(...points.map(p => p.y)), Math.min(...points.map(p => p.z)));
  const max = vec3(Math.max(...points.map(p => p.x)), Math.max(...points.map(p => p.y)), Math.max(...points.map(p => p.z)));
  const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2;
  return { point: mid(min, max), radiusM: Math.min(MAX_FOCUS_RADIUS_M, Math.max(MIN_FOCUS_RADIUS_M, radius)) };
}

function horizontal(from: Vec3, to: Vec3): Vec3 | null {
  const d = vec3(to.x - from.x, to.y - from.y, 0);
  return Math.hypot(d.x, d.y) > 1e-3 ? d : null;
}

function insideRoom(prior: FloorPlanPrior, p: Vec3): boolean {
  return prior.rooms.some(r => p.z >= r.zMin && p.z <= r.zMax && pointInPolygon(p.x, p.y, r.polygon));
}

/** Breach targets sit on the glass plane, so use the opening's rooms; other targets use the floor plan. */
function shotMode(points: Points, action: ActionSpec, prior: FloorPlanPrior): ActionFocus["mode"] {
  if (action.kind === "breach_opening") {
    const opening = prior.openings.find(o => o.id === action.openingId);
    return opening !== undefined && !opening.rooms.includes("exterior") ? "cutaway" : "exterior";
  }
  return insideRoom(prior, points.target) ? "cutaway" : "exterior";
}

function regionCorners(region: Region | null): Vec3[] {
  if (region === null) return [];
  const b = regionBounds(region);
  return [b.min, b.max];
}

/**
 * The intervention to frame: the decision waiting for the commander, else the latest consequential proposal
 * that is approved or executing. Its target, standoff and harness-derived affected region set the framing.
 * Routine actions (move, scan, guide…) never become a focus.
 */
export function actionFocus(view: Pick<MissionView, "pendingApproval" | "proposals" | "affectedRegions" | "belief">): ActionFocus | null {
  const record: ProposalRecord | null = view.pendingApproval
    ?? [...view.proposals].reverse().find(r => r.risk === "consequential" && FRAMED_STATUSES.has(r.status))
    ?? null;
  if (record === null) return null;
  const action = record.proposal.action;
  const points = interventionPoints(action);
  if (points === null) return null;
  const region = view.affectedRegions.find(r => r.proposalId === record.proposal.id)?.region ?? null;
  const box = enclose([points.target, ...(points.standoff === null ? [] : [points.standoff]), ...regionCorners(region)]);
  if (box === null) return null;
  return {
    proposalId: record.proposal.id,
    kind: points.kind,
    awaitingApproval: record.status === "awaiting_approval",
    mode: shotMode(points, action, view.belief.mapPrior),
    focus: { ...box, viewFrom: points.standoff === null ? null : horizontal(points.target, points.standoff) },
    regionFramed: region !== null,
  };
}

/**
 * The exit nearest the assembly area and the assembly area itself, seen from beyond the assembly area looking
 * back at the exit. Null when the floor plan has no usable assembly area (a zero-size placeholder).
 */
export function assemblyFocus(prior: FloorPlanPrior): CameraFocus | null {
  const b = regionBounds(prior.assemblyPoint);
  if (!finite(b.min) || !finite(b.max) || Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) < 1e-6) return null;
  const centre = mid(b.min, b.max);
  const exits = prior.exits.flatMap(e => prior.openings.filter(o => o.id === e.openingId).map(o => o.center)).filter(finite);
  const dist = (p: Vec3) => Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z);
  const exit = exits.length === 0 ? null : exits.reduce((best, p) => (dist(p) < dist(best) ? p : best));
  const box = enclose(exit === null ? [b.min, b.max] : [b.min, b.max, exit]);
  return box === null ? null : { ...box, viewFrom: exit === null ? null : horizontal(exit, centre) };
}

/* Shots. */

export interface Shot {
  readonly mode: CameraMode;
  readonly focus: CameraFocus | null;
  readonly reason: string;
  /** Framing identity: shots with the same key are the same framing (no cut, no dwell reset). */
  readonly key: string;
  /** An approval is waiting on this target: Auto may cut after PRIORITY_DWELL_MS. */
  readonly priority: boolean;
}

export interface DirectorInput {
  readonly runId: string | null;
  readonly phase: MissionPhaseId;
  readonly halt: PhaseHalt | null;
  /** actionFocus(view): the pending or executing intervention. */
  readonly action: ActionFocus | null;
  /** assemblyFocus(view.belief.mapPrior). */
  readonly assembly: CameraFocus | null;
  /** Monotonic wall clock, ms (performance.now()). */
  readonly nowMs: number;
}

/** Builds the director input from a MissionView (truth-free) and the derived phase and halt. */
export function directorInput(view: MissionView | null, phase: MissionPhaseId, halt: PhaseHalt | null, nowMs: number): DirectorInput {
  return {
    runId: view?.runId ?? null,
    phase,
    halt,
    action: view === null ? null : actionFocus(view),
    assembly: view === null ? null : assemblyFocus(view.belief.mapPrior),
    nowMs,
  };
}

const ESTABLISH: Shot = { mode: "exterior", focus: null, key: "establish", priority: false, reason: "Exterior establishing view of the house while the report comes in" };
const CHASE: Shot = { mode: "follow", focus: null, key: "chase", priority: false, reason: "Following the drone on its exterior approach" };
const INTERIOR: Shot = { mode: "cutaway", focus: null, key: "interior", priority: false, reason: "Cutaway of the drone's floor for the interior search and route checks" };
const EXTERIOR_WIDE: Shot = { mode: "exterior", focus: null, key: "exterior-wide", priority: false, reason: "Exterior view for the guided exit (the floor plan has no assembly area to frame)" };

const ACTION_WORDS: Readonly<Record<InterventionKind, string>> = {
  breach_opening: "the window the drone asks to break, with its debris region",
  spray: "the spray target and the jet's affected region",
  release_payload: "the payload release point and its region",
};

function actionShot(a: ActionFocus): Shot {
  const state = a.awaitingApproval ? " (awaiting your approval)" : " (approved; executing under harness checks)";
  const region = a.regionFramed ? "" : "; the harness reported no affected region, so only the target and standoff are framed";
  return { mode: a.mode, focus: a.focus, key: `action:${a.proposalId}`, priority: a.awaitingApproval, reason: `Framing ${ACTION_WORDS[a.kind]}${state}${region}` };
}

/** What Auto would show for these inputs, ignoring dwell, halts and manual override. */
export function desiredShot(input: DirectorInput): Shot {
  if (input.action !== null) return actionShot(input.action);
  switch (input.phase) {
    case "report": return ESTABLISH;
    case "approach":
    case "access": return CHASE;
    case "search":
    case "suppress":
    case "reassess": return INTERIOR;
    case "guide":
    case "outside":
      if (input.assembly === null) return EXTERIOR_WIDE;
      return { mode: "exterior", focus: input.assembly, key: "assembly", priority: false, reason: input.phase === "guide" ? "Exterior: the exit and the assembly area the occupant is being guided toward" : "Exterior: the exit and the assembly area" };
  }
}

/* State machine. */

export interface DirectorState {
  readonly auto: boolean;
  readonly runId: string | null;
  readonly shot: Shot;
  /** When the current shot began. */
  readonly sinceMs: number;
  /** A different desired shot and when it was first seen. */
  readonly candidate: { readonly key: string; readonly sinceMs: number } | null;
  /** Why a halt is holding the framing, else null. */
  readonly holding: string | null;
}

export interface DirectorOutput {
  readonly mode: CameraMode;
  readonly focus: CameraFocus | null;
  readonly reason: string;
  readonly auto: boolean;
  readonly key: string;
}

export function initialDirector(nowMs: number): DirectorState {
  return { auto: true, runId: null, shot: ESTABLISH, sinceMs: nowMs, candidate: null, holding: null };
}

function haltReason(halt: PhaseHalt): string {
  switch (halt.kind) {
    case "paused": return "Holding the framing: the run is paused";
    case "aborted": return "Holding the framing: the mission was aborted";
    case "contingency": return `Holding the framing during the ${halt.contingency.replace("_", " ")} contingency`;
    case "ended_incomplete": return "Holding the framing: the run ended";
  }
}

function cut(state: DirectorState, shot: Shot, input: DirectorInput): DirectorState {
  return { ...state, runId: input.runId, shot, sinceMs: input.nowMs, candidate: null, holding: null };
}

/** Advance Auto by one UI update. Call on every view update and on a short timer (cuts depend on wall time). */
export function stepDirector(state: DirectorState, input: DirectorInput): DirectorState {
  const newRun = input.runId !== state.runId;
  if (!state.auto) return newRun ? { ...state, runId: input.runId } : state;
  const desired = desiredShot(input);
  if (newRun) return cut(state, desired, input);
  if (input.halt !== null) return { ...state, candidate: null, holding: haltReason(input.halt) };
  // Same framing: refresh its focus and wording without counting a cut.
  if (desired.key === state.shot.key) return { ...state, shot: desired, candidate: null, holding: null };
  const candidate = state.candidate?.key === desired.key ? state.candidate : { key: desired.key, sinceMs: input.nowMs };
  const settled = input.nowMs - candidate.sinceMs >= SETTLE_MS;
  const dwelled = input.nowMs - state.sinceMs >= (desired.priority ? PRIORITY_DWELL_MS : MIN_DWELL_MS);
  return settled && dwelled ? cut(state, desired, input) : { ...state, candidate, holding: null };
}

const MODE_WORDS: Readonly<Record<CameraMode, string>> = { exterior: "Exterior", follow: "Follow drone", cutaway: "Cutaway" };

/** The presenter picked a camera: Auto stays off (and the framing fixed) until enableAuto. */
export function chooseManual(state: DirectorState, mode: CameraMode, nowMs: number): DirectorState {
  const shot: Shot = { mode, focus: null, key: `manual:${mode}`, priority: false, reason: `Manual camera: ${MODE_WORDS[mode]}. Auto is off until you turn it back on.` };
  return { ...state, auto: false, shot, sinceMs: nowMs, candidate: null, holding: null };
}

/** Turn Auto back on: cut straight to the desired shot, or keep the framing while a halt holds it. */
export function enableAuto(state: DirectorState, input: DirectorInput): DirectorState {
  const on: DirectorState = { ...state, auto: true };
  if (input.halt !== null) return { ...on, runId: input.runId, sinceMs: input.nowMs, candidate: null, holding: haltReason(input.halt) };
  return cut(on, desiredShot(input), input);
}

export function directorOutput(state: DirectorState): DirectorOutput {
  return { mode: state.shot.mode, focus: state.shot.focus, reason: state.holding ?? state.shot.reason, auto: state.auto, key: state.shot.key };
}
