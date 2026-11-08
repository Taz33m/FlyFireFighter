/**
 * Recorded replay model: rebuilds the truth-free command state at any replay frame from a validated run
 * bundle, so the phase rail, the captions, the timeline and the outcome follow the playhead.
 *
 * Product truth (AGENTS.md, phases.ts contract):
 * - Replay plays recorded data only. Nothing here runs the simulator, planner, harness, controller or any
 *   cloud call; proposals, routes, reports and tracks are rebuilt from events.jsonl as the harness and the
 *   evidence store logged them.
 * - The rail reads a PhaseView rebuilt from events up to the playhead tick and the frame's truth-free
 *   summary. It never reads frame.render (privileged simulation truth, including the TRUE drone position).
 *   The estimated pose is read from `summary.estimatedPosition` only if a bundle records it; until then it is
 *   null and the rail cannot place "search" from position (phases.ts handles a null pose).
 * - Track events carry no position, so rebuilt tracks have position null (never blamed for an invalidated
 *   spray) and status "possible" (merges and retractions are not logged as events today).
 * - The evaluator outcome is visible only once the playhead reaches the outcome.recorded event (or, when the
 *   bundle has a scored result but no such event, the last recorded frame), exactly as a live run receives it only at the end.
 *   The outcome is the bundle's validated scoredResult, never results.outcome.rescueLabel.
 *
 * Pure and browser-safe (relative .ts imports, so `node --test` runs it directly). Reconstruction is
 * incremental: events are sorted once, checkpoints are kept every CHECKPOINT_EVERY events, and moments are
 * memoized per frame index, so scrubbing 6000 frames over a few hundred events stays cheap.
 */
import type { ActionKind, Contingency, ProposalHistoryEntry, ProposalStatus, RiskClass } from "../../lib/contracts/actions.ts";
import { ACTION_KINDS } from "../../lib/contracts/actions.ts";
import type { MissionEvent } from "../../lib/contracts/events.ts";
import type { FloorPlanPrior, RouteAssessment } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import type { Region } from "../../lib/contracts/geometry.ts";
import type { MissionResult } from "../../lib/contracts/outcomes.ts";
import { riskClassOf } from "../../lib/harness/policy.ts";
import type { MissionStatus, ReplayFrame } from "../../lib/mission/protocol.ts";
import type { PhaseAction, PhaseProposal, PhaseRailState, PhaseTrack, PhaseView } from "../mission/phases.ts";
import { derivePhaseRail } from "../mission/phases.ts";
import type { Outcome, RunBundle } from "../results/bundle.ts";
import { outcomeOf, scoredResult } from "../results/bundle.ts";

/* Rebuilt state. */

/** A proposal rebuilt from its proposal.* events: the PhaseProposal fields plus the full recorded history. */
export interface ReplayProposal extends PhaseProposal {
  readonly proposal: { readonly id: string; readonly action: PhaseAction };
  readonly history: readonly ProposalHistoryEntry[];
}

type RouteState = Pick<RouteAssessment, "purpose" | "status">;
type ContingencyState = Pick<Contingency, "kind" | "reason">;

interface EventState {
  readonly authorized: boolean;
  readonly reports: readonly { readonly roomHint: string | null }[];
  /** Insertion order is first appearance, i.e. the harness's registration order. */
  readonly proposals: ReadonlyMap<string, ReplayProposal>;
  readonly regions: ReadonlyMap<string, Region>;
  readonly routes: ReadonlyMap<string, RouteState>;
  readonly tracks: ReadonlyMap<string, PhaseTrack>;
  /** The latest contingency.selected, with the contingency's own reason. */
  readonly contingency: ContingencyState | null;
}

const EMPTY_STATE: EventState = { authorized: false, reports: [], proposals: new Map(), regions: new Map(), routes: new Map(), tracks: new Map(), contingency: null };

/** The truth-free per-frame summary, read defensively (a hand-edited or older bundle may lack fields). */
export interface ReplaySummary {
  readonly status: MissionStatus;
  readonly controllerLabel: string | null;
  readonly deciderLabel: string | null;
  readonly waterRemainingL: number | null;
  readonly pendingApprovalId: string | null;
  readonly contingency: Contingency["kind"] | null;
  /**
   * The ESTIMATED position (belief.pose.position), if the bundle records `summary.estimatedPosition`.
   * Exports today do not, so this is null and the rail cannot place "search" from position.
   */
  readonly estimatedPosition: Vec3 | null;
}

/** Replay summary as a future export may write it: protocol ReplayFrame["summary"] plus the estimated position. */
type SummaryExtension = ReplayFrame["summary"] & { readonly estimatedPosition?: unknown };

/** Everything the panels need at one replay frame. Deliberately excludes frame.render (simulation truth). */
export interface ReplayMoment {
  readonly index: number;
  readonly tick: number;
  readonly summary: ReplaySummary;
  /** Events with tick ≤ the playhead tick (a prefix of model.events). */
  readonly eventCount: number;
  readonly view: PhaseView;
  readonly proposals: readonly ReplayProposal[];
  /** The evaluator result, only once the playhead has reached it; otherwise null. */
  readonly outcome: MissionResult | null;
  /** The playhead has reached the recorded outcome (even if the stored result was unusable). */
  readonly outcomeReached: boolean;
  readonly rail: PhaseRailState;
}

export interface ReplayModel {
  readonly runId: string;
  /** This run's events, sorted by tick then seq. Events from another run are left out (buildBundle reports them). */
  readonly events: readonly MissionEvent[];
  readonly frameTicks: readonly number[];
  readonly frames: readonly ReplayFrame[];
  /** The validated evaluator result (scoredResult), regardless of the playhead. */
  readonly result: MissionResult | null;
  /** The bundle's final outcome words (outcomeOf), for the separately labelled "this run ends with" note. */
  readonly finalOutcome: Outcome;
  /** The tick from which the outcome is visible; null when the recording never reaches one. */
  readonly outcomeTick: number | null;
  /** True when outcomeTick comes from the outcome.recorded event; false when it falls back to the last frame. */
  readonly outcomeRecorded: boolean;
  /** Frame indices of approval-gate events (consequential proposals at or past the commander), ascending, unique. */
  readonly gateFrames: readonly number[];
  readonly excludedEvents: number;
}

/* Small readers for recorded JSON. */

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>(["proposed", "validated", "awaiting_approval", "approved", "executing", "completed", "rejected", "expired", "invalidated", "aborted"]);
const MISSION_STATUSES: ReadonlySet<string> = new Set<MissionStatus>(["awaiting_report", "awaiting_authorization", "running", "paused", "aborted", "ended"]);
const CONTINGENCY_KINDS: ReadonlySet<string> = new Set<Contingency["kind"]>(["return", "alternate_route", "hold", "land", "failure"]);
const ROUTE_PURPOSES: ReadonlySet<string> = new Set<RouteState["purpose"]>(["return", "alternate_return", "evacuation"]);
const ROUTE_STATUSES: ReadonlySet<string> = new Set<RouteState["status"]>(["supported", "unsupported", "unknown"]);
const KINDS: ReadonlySet<string> = new Set<string>(ACTION_KINDS);
/** Not yet at the commander (consequential) or not yet started (routine): not a gate moment. */
const PRE_GATE: ReadonlySet<string> = new Set(["proposed", "validated"]);

function isVec3(v: unknown): v is Vec3 {
  return isObject(v) && finite(v.x) !== null && finite(v.y) !== null && finite(v.z) !== null;
}

function isRegion(v: unknown): v is Region {
  return isObject(v) && typeof v.kind === "string";
}

/** The contingency's own reason from the harness's "Contingency <kind> started (trigger: …): <reason>" line. */
export function contingencyReason(eventReason: string): string {
  const match = /\(trigger: [a-z_]+\):\s*([\s\S]*)$/.exec(eventReason);
  return (match === null ? eventReason : match[1]).trim();
}

export function summaryOf(frame: ReplayFrame | undefined): ReplaySummary {
  const s: Partial<SummaryExtension> = isObject(frame?.summary) ? frame.summary : {};
  const contingency = str(s.contingency);
  return {
    status: MISSION_STATUSES.has(String(s.status)) ? (s.status as MissionStatus) : "running",
    controllerLabel: str(s.controllerLabel),
    deciderLabel: str(s.deciderLabel),
    waterRemainingL: finite(s.waterRemainingL),
    pendingApprovalId: str(s.pendingApprovalId),
    contingency: contingency !== null && CONTINGENCY_KINDS.has(contingency) ? (contingency as Contingency["kind"]) : null,
    estimatedPosition: isVec3(s.estimatedPosition) ? { x: s.estimatedPosition.x, y: s.estimatedPosition.y, z: s.estimatedPosition.z } : null,
  };
}

/* Applying events. */

class Builder {
  authorized: boolean;
  reports: { readonly roomHint: string | null }[];
  proposals: Map<string, ReplayProposal>;
  regions: Map<string, Region>;
  routes: Map<string, RouteState>;
  tracks: Map<string, PhaseTrack>;
  contingency: ContingencyState | null;

  constructor(from: EventState) {
    this.authorized = from.authorized;
    this.reports = [...from.reports];
    this.proposals = new Map(from.proposals);
    this.regions = new Map(from.regions);
    this.routes = new Map(from.routes);
    this.tracks = new Map(from.tracks);
    this.contingency = from.contingency;
  }

  snapshot(): EventState {
    return { authorized: this.authorized, reports: [...this.reports], proposals: new Map(this.proposals), regions: new Map(this.regions), routes: new Map(this.routes), tracks: new Map(this.tracks), contingency: this.contingency };
  }

  apply(event: MissionEvent): void {
    const data = isObject(event.data) ? event.data : {};
    if (event.kind.startsWith("proposal.")) this.proposal(event, data);
    else if (event.kind === "mission.authorized") this.authorized = true;
    else if (event.kind === "report.received") this.reports.push({ roomHint: str(data.roomHint) });
    else if (event.kind === "route.status_changed") this.route(data);
    else if (event.kind === "track.created" || event.kind === "track.updated") this.track(event, data);
    else if (event.kind === "contingency.selected") this.contingencySelected(event, data);
  }

  private proposal(event: MissionEvent, data: Record<string, unknown>): void {
    const status = event.kind.slice("proposal.".length);
    const id = str(data.proposalId) ?? event.subject;
    if (!STATUSES.has(status) || id === null) return;
    const existing = this.proposals.get(id);
    const full = isObject(data.proposal) ? actionOf(data.proposal.action) : null;
    const action = full ?? existing?.proposal.action ?? actionOf({ kind: data.actionKind });
    if (action === null) return;
    const risk = riskOf(data.risk, existing?.risk ?? null, action.kind);
    const entry: ProposalHistoryEntry = { tick: event.tick, status: status as ProposalStatus, reason: event.reason, ruleIds: [...(event.ruleIds ?? [])] };
    this.proposals.set(id, { proposal: { id, action }, risk, status: status as ProposalStatus, history: [...(existing?.history ?? []), entry] });
    if (isRegion(data.affectedRegion)) this.regions.set(id, data.affectedRegion);
  }

  private route(data: Record<string, unknown>): void {
    const id = str(data.routeId);
    const purpose = str(data.purpose);
    const status = str(data.status);
    if (id === null || purpose === null || status === null || !ROUTE_PURPOSES.has(purpose) || !ROUTE_STATUSES.has(status)) return;
    this.routes.set(id, { purpose: purpose as RouteState["purpose"], status: status as RouteState["status"] });
  }

  private track(event: MissionEvent, data: Record<string, unknown>): void {
    const id = str(data.trackId) ?? event.subject;
    if (id === null) return;
    const previous = this.tracks.get(id);
    this.tracks.set(id, { status: "possible", roomId: str(data.roomId), uncertaintyM: finite(data.uncertaintyM) ?? previous?.uncertaintyM ?? 0, position: null });
  }

  private contingencySelected(event: MissionEvent, data: Record<string, unknown>): void {
    const kind = str(data.kind);
    if (kind === null || !CONTINGENCY_KINDS.has(kind)) return;
    this.contingency = { kind: kind as Contingency["kind"], reason: contingencyReason(event.reason) };
  }
}

/** The recorded risk class; only a malformed event falls back to the policy's class for the action kind. */
function riskOf(recorded: unknown, previous: RiskClass | null, kind: ActionKind): RiskClass {
  if (recorded === "routine" || recorded === "consequential") return recorded;
  return previous ?? riskClassOf(kind);
}

/** The parts of a recorded action the rail reads (proposal.proposed's full action, or a bare { kind }). */
function actionOf(action: unknown): PhaseAction | null {
  if (!isObject(action)) return null;
  const kind = str(action.kind);
  if (kind === null || !KINDS.has(kind)) return null;
  const openingId = str(action.openingId);
  return openingId === null ? { kind: kind as ActionKind } : { kind: kind as ActionKind, openingId };
}

/* Searching sorted arrays. */

/** Number of items ≤ value (index of the first item > value). */
export function upperBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first item ≥ value. */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* The model. */

export const CHECKPOINT_EVERY = 64;
const MOMENT_CACHE_LIMIT = 2048;
const AUTHORIZED: object = Object.freeze({ recorded: "mission.authorized" });

interface Internals {
  readonly eventTicks: readonly number[];
  readonly checkpoints: readonly EventState[];
  readonly states: Map<number, EventState>;
  readonly moments: Map<number, ReplayMoment>;
  prior: FloorPlanPrior | null;
}

const internals = new WeakMap<ReplayModel, Internals>();

function wellFormed(e: unknown): e is MissionEvent {
  return isObject(e) && typeof e.kind === "string" && finite(e.tick) !== null;
}

function runIdOf(bundle: RunBundle): string {
  return bundle.results?.runId ?? bundle.events.find(wellFormed)?.runId ?? "unknown run";
}

function gateFramesOf(events: readonly MissionEvent[], frameTicks: readonly number[]): number[] {
  const frames = new Set<number>();
  for (const e of events) {
    if (!e.kind.startsWith("proposal.") || PRE_GATE.has(e.kind.slice("proposal.".length))) continue;
    const data = isObject(e.data) ? e.data : {};
    const kind = str(data.actionKind);
    const consequential = data.risk === "consequential" || (data.risk === undefined && kind !== null && KINDS.has(kind) && riskClassOf(kind as ActionKind) === "consequential");
    if (consequential && frameTicks.length > 0) frames.add(frameIndexOf(frameTicks, e.tick));
  }
  return [...frames].sort((a, b) => a - b);
}

function frameIndexOf(frameTicks: readonly number[], tick: number): number {
  return Math.min(frameTicks.length - 1, lowerBound(frameTicks, tick));
}

/** Build the replay model for a bundle that went through buildBundle (validated results, sorted frames). */
export function createReplayModel(bundle: RunBundle): ReplayModel {
  const runId = runIdOf(bundle);
  const wellFormedEvents = bundle.events.filter(wellFormed);
  const events = wellFormedEvents.filter(e => bundle.results === null || e.runId === runId)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tick - b.e.tick || (a.e.seq ?? a.i) - (b.e.seq ?? b.i) || a.i - b.i)
    .map(x => x.e);
  const frames = bundle.replay.filter(f => isObject(f) && finite(f.tick) !== null);
  const frameTicks = frames.map(f => f.tick);
  const recordedAt = events.find(e => e.kind === "outcome.recorded")?.tick ?? null;
  const lastTick = frameTicks.length === 0 ? null : frameTicks[frameTicks.length - 1];
  const result = scoredResult(bundle.results);
  const model: ReplayModel = {
    runId,
    events,
    frameTicks,
    frames,
    result,
    finalOutcome: outcomeOf(bundle),
    outcomeTick: recordedAt ?? (result === null ? null : lastTick),
    outcomeRecorded: recordedAt !== null,
    gateFrames: gateFramesOf(events, frameTicks),
    excludedEvents: bundle.events.length - events.length,
  };
  const checkpoints: EventState[] = [EMPTY_STATE];
  const builder = new Builder(EMPTY_STATE);
  events.forEach((e, i) => {
    builder.apply(e);
    if ((i + 1) % CHECKPOINT_EVERY === 0) checkpoints.push(builder.snapshot());
  });
  internals.set(model, { eventTicks: events.map(e => e.tick), checkpoints, states: new Map(), moments: new Map(), prior: null });
  return model;
}

function internalsOf(model: ReplayModel): Internals {
  const found = internals.get(model);
  if (found === undefined) throw new Error("Replay model was not built by createReplayModel");
  return found;
}

/** Number of this run's events with tick ≤ `tick`. */
export function eventCountAt(model: ReplayModel, tick: number): number {
  return upperBound(internalsOf(model).eventTicks, tick);
}

/** The first frame at or after `tick` (the last frame when the tick is past the recording). */
export function frameIndexAt(model: ReplayModel, tick: number): number {
  return model.frameTicks.length === 0 ? 0 : frameIndexOf(model.frameTicks, tick);
}

/** The evaluator result visible at `tick`: only from the outcome tick on. */
export function outcomeAt(model: ReplayModel, tick: number): MissionResult | null {
  return outcomeReachedAt(model, tick) ? model.result : null;
}

function outcomeReachedAt(model: ReplayModel, tick: number): boolean {
  return model.outcomeTick !== null && tick >= model.outcomeTick;
}

/** The nearest approval-gate frame after (+1) or before (-1) `index`, or null. */
export function gateFrameFrom(model: ReplayModel, index: number, direction: 1 | -1): number | null {
  const frames = model.gateFrames;
  if (direction === 1) return frames.find(f => f > index) ?? null;
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i] < index) return frames[i];
  return null;
}

function stateAt(model: ReplayModel, count: number): EventState {
  const inner = internalsOf(model);
  const cached = inner.states.get(count);
  if (cached !== undefined) return cached;
  const base = Math.floor(count / CHECKPOINT_EVERY);
  const builder = new Builder(inner.checkpoints[base]);
  for (let i = base * CHECKPOINT_EVERY; i < count; i++) builder.apply(model.events[i]);
  const state = builder.snapshot();
  if (inner.states.size >= MOMENT_CACHE_LIMIT) inner.states.clear();
  inner.states.set(count, state);
  return state;
}

function phaseViewOf(model: ReplayModel, state: EventState, summary: ReplaySummary, prior: FloorPlanPrior | null, ended: boolean): PhaseView {
  const contingency = summary.contingency === null ? null : { kind: summary.contingency, reason: state.contingency?.kind === summary.contingency ? state.contingency.reason : "" };
  return {
    runId: model.runId,
    // As in the runtime, a recorded outcome means the run has ended.
    status: ended ? "ended" : summary.status,
    envelope: state.authorized ? AUTHORIZED : null,
    belief: {
      reports: state.reports,
      mapPrior: prior,
      pose: summary.estimatedPosition === null ? null : { position: summary.estimatedPosition },
      routes: [...state.routes.values()],
      tracks: [...state.tracks.values()],
    },
    proposals: [...state.proposals.values()],
    pendingApproval: summary.pendingApprovalId === null ? null : state.proposals.get(summary.pendingApprovalId) ?? null,
    affectedRegions: [...state.regions].map(([proposalId, region]) => ({ proposalId, region })),
    contingency,
  };
}

/**
 * Everything the panels show at frame `index`, from events up to that frame's tick, its truth-free summary
 * and the floor-plan prior (null: reduced captions). Memoized per index for the given prior.
 */
export function momentAt(model: ReplayModel, index: number, prior: FloorPlanPrior | null): ReplayMoment {
  const inner = internalsOf(model);
  if (inner.prior !== prior) {
    inner.prior = prior;
    inner.moments.clear();
  }
  const i = model.frames.length === 0 ? 0 : Math.min(model.frames.length - 1, Math.max(0, Math.trunc(index)));
  const cached = inner.moments.get(i);
  if (cached !== undefined) return cached;
  const frame = model.frames[i];
  const tick = frame?.tick ?? (model.events.length === 0 ? 0 : model.events[model.events.length - 1].tick);
  const summary = summaryOf(frame);
  const eventCount = eventCountAt(model, tick);
  const state = stateAt(model, eventCount);
  const outcomeReached = outcomeReachedAt(model, tick);
  const outcome = outcomeReached ? model.result : null;
  const view = phaseViewOf(model, state, summary, prior, outcomeReached);
  const moment: ReplayMoment = { index: i, tick, summary, eventCount, view, proposals: [...state.proposals.values()], outcome, outcomeReached, rail: derivePhaseRail({ view, outcome }) };
  if (inner.moments.size >= MOMENT_CACHE_LIMIT) inner.moments.clear();
  inner.moments.set(i, moment);
  return moment;
}
