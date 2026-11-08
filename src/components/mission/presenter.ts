/**
 * Presenter logic for the mission workspace: pure and browser-safe. Inputs come only from the truth-free
 * MissionView (and the hook's run source), never from RenderSnapshot or simulator state.
 *
 * - pacingLabel: the persistent "simulated vs wall time" badge. Accelerated time is not real-world response time.
 * - challengeTarget: where the judge challenge places a simulated person. It reads the spray proposal and the
 *   harness-derived affected region from MissionView, picks a floor point in a known room whose standing body
 *   overlaps that region, and the UI sends the ordinary add_occupant experiment. Nothing here tells the harness
 *   to refuse: command learns of the person only if its sensors detect them.
 * - Track and decision wording for the rescue record and action card.
 */
import type { ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import type { FloorPlanPrior } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import { vec3 } from "../../lib/contracts/frames.ts";
import type { Region } from "../../lib/contracts/geometry.ts";
import { pointInPolygon, regionContains, samplePoints } from "../../lib/contracts/geometry.ts";
import type { DetectionMethod, ObservationProvenance } from "../../lib/contracts/observation.ts";
import type { MissionStatus, MissionView } from "../../lib/mission/protocol.ts";

/* Simulation pacing. */

export type PacingTone = "accelerated" | "slow" | "real" | "stopped" | "unknown";

export interface PacingLabel {
  readonly text: string;
  readonly tone: PacingTone;
  /** Longer explanation for a tooltip or screen reader. */
  readonly detail: string;
}

/** Measured ratios within this fraction of 1 read as "about real time". */
export const REAL_TIME_TOLERANCE = 0.05;

const ACCELERATED_NOTE = "Accelerated time is not real-world response time.";

function ratioText(ratio: number): string {
  if (ratio >= 10) return ratio.toFixed(0);
  if (ratio >= 1) return ratio.toFixed(1);
  return ratio.toFixed(2);
}

export interface PacingInput {
  readonly source: "starting" | "worker" | "fixture";
  readonly status: MissionStatus | null;
  /** Requested pacing (RunConfig.speed); null before a run. */
  readonly setSpeed: number | null;
  /** MissionView.simToWallRatio: measured simulated seconds per wall second, null until measured. */
  readonly ratio: number | null;
}

export function pacingLabel({ source, status, setSpeed, ratio }: PacingInput): PacingLabel {
  if (source === "fixture") return { text: "UI fixture: no simulation clock", tone: "unknown", detail: "The mission worker is not running, so no simulated time passes. Times shown are hand-authored fixture values." };
  if (status === null) return { text: "Simulated time", tone: "unknown", detail: "Every mission time is simulated time. The pace is measured once a run starts." };
  if (status === "paused") return { text: "Simulated clock paused", tone: "stopped", detail: "The mission clock is frozen until the run resumes." };
  if (status === "ended") return { text: "Simulated clock stopped", tone: "stopped", detail: "The run is over; no further simulated time passes." };
  const pace = measuredPace(setSpeed, ratio);
  // After an abort the harness's contingency still flies the drone home: simulated time passes until the run ends.
  return status === "aborted" ? { ...pace, detail: `Mission aborted: simulated time continues while the contingency returns the drone. ${pace.detail}` } : pace;
}

function measuredPace(setSpeed: number | null, ratio: number | null): PacingLabel {
  const set = setSpeed === null ? "" : ` Requested pace ${setSpeed}×.`;
  if (ratio === null || !Number.isFinite(ratio)) return { text: "Simulated time, measuring pace", tone: "unknown", detail: `The ratio of simulated to wall time has not been measured yet.${set}` };
  if (ratio <= 0) return { text: "Simulated clock not advancing", tone: "stopped", detail: `No simulated time passed over the last wall second.${set}` };
  if (ratio > 1 + REAL_TIME_TOLERANCE) return { text: `Simulated ×${ratioText(ratio)}`, tone: "accelerated", detail: `Simulated time is running ${ratioText(ratio)} times faster than the wall clock. ${ACCELERATED_NOTE}${set}` };
  if (ratio < 1 - REAL_TIME_TOLERANCE) return { text: `Simulated, slower than real time (×${ratioText(ratio)})`, tone: "slow", detail: `Simulated time is running at ${ratioText(ratio)} of wall-clock speed; mission times are simulated seconds.${set}` };
  return { text: `Simulated, about real time (×${ratioText(ratio)})`, tone: "real", detail: `Simulated time is keeping pace with the wall clock. It is still a simulation, not a real response.${set}` };
}

/* Judge challenge: a simulated person steps into the pending spray. */

/** Spray proposals a person can still step in front of: waiting, approved but not started, or discharging. */
export const CHALLENGE_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["awaiting_approval", "approved", "executing"]);
/** Heights above the floor sampled along a standing adult's body. */
export const BODY_HEIGHTS_M: readonly number[] = [0.3, 0.6, 0.9, 1.2, 1.5, 1.7];
/** Points along the standoff → aim line tried first, middle outwards. */
const LINE_FRACTIONS: readonly number[] = [0.5, 0.6, 0.4, 0.7, 0.3, 0.8, 0.2, 0.9];
/** Horizontal clearance from the room outline so the person does not start inside a wall. */
export const WALL_CLEARANCE_M = 0.2;
const SAMPLE_SPACING_M = 0.25;

export interface ChallengePoint {
  /** Feet position (floor level), as add_occupant expects. */
  readonly position: Vec3;
  readonly roomId: string;
  /** Sampled body heights (m above the floor) that lie inside the affected region; never empty. */
  readonly heightsInRegionM: readonly number[];
  readonly method: "spray_line" | "region_sample";
}

export type ChallengeTarget =
  | ({ readonly available: true; readonly proposalId: string; readonly proposalStatus: ProposalStatus } & ChallengePoint)
  | { readonly available: false; readonly reason: string };

function floorBelow(prior: FloorPlanPrior, z: number): FloorPlanPrior["floors"][number] | null {
  let best: FloorPlanPrior["floors"][number] | null = null;
  for (const floor of prior.floors) if (floor.elevationM <= z + 0.05 && (best === null || floor.elevationM > best.elevationM)) best = floor;
  return best;
}

function roomWithClearance(prior: FloorPlanPrior, floorIndex: number, x: number, y: number): string | null {
  const c = WALL_CLEARANCE_M;
  const room = prior.rooms.find(r => r.floor === floorIndex && pointInPolygon(x, y, r.polygon));
  if (room === undefined) return null;
  const clear = [[c, 0], [-c, 0], [0, c], [0, -c]].every(([dx, dy]) => pointInPolygon(x + dx, y + dy, room.polygon));
  return clear ? room.id : null;
}

function candidate(prior: FloorPlanPrior, region: Region, x: number, y: number, zHint: number, method: ChallengePoint["method"]): ChallengePoint | null {
  const floor = floorBelow(prior, zHint);
  if (floor === null) return null;
  const roomId = roomWithClearance(prior, floor.index, x, y);
  if (roomId === null) return null;
  const heightsInRegionM = BODY_HEIGHTS_M.filter(h => floor.elevationM + h <= floor.ceilingM && regionContains(region, vec3(x, y, floor.elevationM + h)));
  return heightsInRegionM.length === 0 ? null : { position: vec3(x, y, floor.elevationM), roomId, heightsInRegionM, method };
}

/**
 * A floor point in a known room (floor-plan prior) where a standing person's body overlaps `region`. Tries the
 * spray line first, then a deterministic grid over the region ordered by distance from the line's midpoint.
 */
export function challengePoint(prior: FloorPlanPrior, region: Region, standoff: Vec3, aimPoint: Vec3): ChallengePoint | null {
  const at = (t: number) => vec3(standoff.x + (aimPoint.x - standoff.x) * t, standoff.y + (aimPoint.y - standoff.y) * t, standoff.z + (aimPoint.z - standoff.z) * t);
  for (const t of LINE_FRACTIONS) {
    const p = at(t);
    const found = candidate(prior, region, p.x, p.y, p.z, "spray_line");
    if (found !== null) return found;
  }
  const mid = at(0.5);
  const samples = samplePoints(region, SAMPLE_SPACING_M, 0, 2048)
    .filter(p => regionContains(region, p))
    .sort((a, b) => ((a.x - mid.x) ** 2 + (a.y - mid.y) ** 2 + (a.z - mid.z) ** 2) - ((b.x - mid.x) ** 2 + (b.y - mid.y) ** 2 + (b.z - mid.z) ** 2));
  for (const p of samples) {
    const found = candidate(prior, region, p.x, p.y, p.z, "region_sample");
    if (found !== null) return found;
  }
  return null;
}

/** The spray proposal a judge can challenge now, and where the person would stand. */
export function challengeTarget(view: Pick<MissionView, "status" | "proposals" | "affectedRegions" | "belief">): ChallengeTarget {
  if (view.status === "aborted" || view.status === "ended") return { available: false, reason: "The run is over." };
  const record = [...view.proposals].reverse().find(r => r.proposal.action.kind === "spray" && CHALLENGE_STATUSES.has(r.status));
  if (record === undefined || record.proposal.action.kind !== "spray") return { available: false, reason: "Available while a water-spray proposal is pending, approved or discharging." };
  const region = view.affectedRegions.find(r => r.proposalId === record.proposal.id)?.region ?? null;
  if (region === null) return { available: false, reason: `The harness reported no affected region for ${record.proposal.id}.` };
  const point = challengePoint(view.belief.mapPrior, region, record.proposal.action.standoff, record.proposal.action.aimPoint);
  if (point === null) return { available: false, reason: "No floor point in a known room puts a standing person inside the spray's affected region." };
  return { available: true, proposalId: record.proposal.id, proposalStatus: record.status, ...point };
}

/* Localization-loss preset. */

/** Matches the batch evaluation's localization_loss injection (src/lib/evaluation/batch/injections.ts). */
export const LOCALIZATION_LOSS_SIGMA_M = 3;

/* Rescue-record wording. */

export const ORACLE_FIXTURE_TAG = "oracle fixture (simulation raycast, not detector accuracy)";

const METHOD_WORDS: Readonly<Record<DetectionMethod, string>> = {
  oracle_fixture: "oracle fixture",
  thermal_blob: "thermal blob detector",
  image_detector: "image detector",
};

const PROVENANCE_WORDS: Readonly<Record<ObservationProvenance, string>> = {
  simulated_sensor: "simulated sensor frames",
  fixture: "fixture frames",
  recording: "recorded frames",
};

/** "Detected by …; from …" for one possible-occupant track. An empty list means unknown, not absent. */
export function trackMethodsText(track: { readonly detectionMethods: readonly DetectionMethod[]; readonly provenances: readonly ObservationProvenance[] }): string {
  if (track.detectionMethods.length === 0) return "Detection method unknown: its supporting observations have left the evidence window";
  const methods = track.detectionMethods.map(m => METHOD_WORDS[m]).join(", ");
  const from = track.provenances.length === 0 ? "" : `; from ${track.provenances.map(p => PROVENANCE_WORDS[p]).join(", ")}`;
  return `Detected by ${methods}${from}`;
}

/* Action-card wording for a decided proposal. */

export interface DecisionSummary {
  /** The reason recorded with the latest status change, if any. */
  readonly reason: string | null;
  readonly ruleIds: readonly string[];
  /** Water actually discharged by this proposal's execution; null when it never executed. */
  readonly dischargedL: number | null;
}

export function decisionSummary(record: ProposalRecord): DecisionSummary {
  const last = [...record.history].reverse().find(h => h.status === record.status) ?? null;
  return {
    reason: last?.reason ?? null,
    ruleIds: last?.ruleIds ?? [],
    dischargedL: record.execution === null ? null : record.execution.effects.waterDischargedL,
  };
}
