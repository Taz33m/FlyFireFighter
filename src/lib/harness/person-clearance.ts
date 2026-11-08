/**
 * Person clearance: which possible occupants motion keeps away from, and how far.
 *
 * Reads only the truth-free belief, never simulator truth. A possible occupant is
 * - a possible-occupant track (status "possible"; merged and retracted tracks are superseded), or
 * - a possible_person detection in the newest person-search frame of each sensor (a frame another frame
 *   supersedes does not count). Older sightings are carried by the tracks they fed, whose fused positions
 *   lag a walking person, so the newest frames add where the person is now.
 * Either kind counts while its confidence is at least policy.personConfidenceThreshold and no later
 * adequate person search looked at its position and saw no one near it — the "current" rule H6 uses.
 *
 * Distances are Euclidean from the aircraft's centre to the occupant's estimated position. Motion keeps
 * half the span (the aircraft's edge) plus policy.personClearanceM (policy.guidanceClearanceM while a guide
 * executes) plus the occupant's own one-sigma uncertainty.
 */
import type { ActionKind } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import type { OccupantTrack } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance } from "../contracts/frames.ts";
import { regionContains } from "../contracts/geometry.ts";
import type { ObservationId } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";
import { searchedForPeople } from "./coverage.ts";
import type { HarnessContext } from "./policy.ts";

export interface PossibleOccupant {
  readonly source: "track" | "detection";
  /** The track id, or the id of the observation that holds the detection. */
  readonly id: string;
  readonly position: Vec3;
  /** One-sigma radius. */
  readonly uncertaintyM: number;
  readonly confidence: number;
  /** When the evidence was captured: a track's lastSeenTick, a detection's capture tick. */
  readonly seenTick: Tick;
  readonly evidenceIds: readonly ObservationId[];
}

/** Evidence ids a track contributes to a finding: its most recent observations. */
const TRACK_EVIDENCE_IDS = 16;

/**
 * Possible occupants above the confidence threshold and not superseded, before the later-look check (which
 * scans observations, so callers apply isCurrentOccupant only to the ones near enough to matter). A NaN
 * confidence is kept: an estimate that cannot be compared fails safe.
 */
export function possibleOccupants(ctx: HarnessContext): PossibleOccupant[] {
  const threshold = ctx.policy.personConfidenceThreshold;
  const occupants: PossibleOccupant[] = [];
  for (const track of ctx.belief.tracks) {
    if (track.status !== "possible" || track.confidence < threshold) continue;
    occupants.push({ source: "track", id: track.id, position: track.position, uncertaintyM: track.uncertaintyM, confidence: track.confidence, seenTick: track.lastSeenTick, evidenceIds: track.observationIds.slice(-TRACK_EVIDENCE_IDS) });
  }
  for (const frame of newestPersonSearchFrames(ctx.belief.observations)) {
    for (const detection of frame.detections) {
      if (detection.kind !== "possible_person" || detection.confidence < threshold) continue;
      occupants.push({ source: "detection", id: frame.id, position: detection.position, uncertaintyM: detection.uncertaintyM, confidence: detection.confidence, seenTick: frame.captureTick, evidenceIds: [frame.id] });
    }
  }
  return occupants;
}

/** Not cleared by a later look. */
export function isCurrentOccupant(occupant: PossibleOccupant, ctx: HarnessContext): boolean {
  return !clearedByLaterLook(occupant.position, occupant.uncertaintyM, occupant.seenTick, ctx);
}

/** The newest frame of each sensor that ran a person search and that no other frame supersedes. */
function newestPersonSearchFrames(observations: readonly Observation[]): Observation[] {
  const superseded = new Set<ObservationId>();
  for (const o of observations) if (o.supersedes !== null) superseded.add(o.supersedes);
  const newest = new Map<string, Observation>();
  for (const o of observations) {
    if (!searchedForPeople(o) || superseded.has(o.id)) continue;
    const best = newest.get(o.sensorId);
    if (best === undefined || o.captureTick >= best.captureTick) newest.set(o.sensorId, o);
  }
  return [...newest.values()];
}

/**
 * A later adequate-quality frame searched for people looked at the position and detected no possible person
 * within its uncertainty plus policy.personMarginM (H6 uses the same rule for interventions).
 */
export function clearedByLaterLook(position: Vec3, uncertaintyM: number, seenTick: Tick, ctx: HarnessContext): boolean {
  const radiusM = uncertaintyM + ctx.policy.personMarginM;
  return ctx.belief.observations.some(o => o.captureTick > seenTick && o.quality >= ctx.policy.minCoverageQuality && lookedAt(o, position) && !personNear(o, position, radiusM));
}

function lookedAt(observation: Observation, position: Vec3): boolean {
  return searchedForPeople(observation) && observation.footprint !== null && regionContains(observation.footprint, position);
}

function personNear(observation: Observation, position: Vec3, radiusM: number): boolean {
  return observation.detections.some(d => d.kind === "possible_person" && distance(d.position, position) <= radiusM);
}

/** Edge-to-occupant clearance for an action kind: the guidance clearance while guiding (never the smaller one). */
export function personClearanceFor(ctx: HarnessContext, kind: ActionKind | null): number {
  const personM = ctx.policy.personClearanceM;
  return kind === "guide" ? Math.max(personM, ctx.policy.guidanceClearanceM) : personM;
}

/**
 * Centre-to-occupant distance motion keeps: half the span, the clearance and the occupant's one-sigma
 * uncertainty. A negative uncertainty or clearance counts as zero; NaN propagates, and callers compare so
 * that NaN fails safe.
 */
export function requiredPersonDistanceM(ctx: HarnessContext, uncertaintyM: number, clearanceM: number): number {
  return ctx.profile.spanM / 2 + Math.max(0, clearanceM) + Math.max(0, uncertaintyM);
}

/**
 * True when moving to `point` would close in on an occupant `requiredM` must be kept from: the point is
 * inside that distance and nearer the occupant than `from` (the aircraft now). A point at least as far as
 * the aircraft already is never closes in, so backing away from someone who came near stays possible.
 */
export function closesInOn(point: Vec3, from: Vec3, occupant: Vec3, requiredM: number): boolean {
  const atPointM = distance(point, occupant);
  return !(atPointM >= requiredM) && !(atPointM >= distance(from, occupant));
}

/**
 * Lead the occupant from ahead: the first waypoint after the one nearest the occupant that lies beyond the
 * guidance distance from them, or the last waypoint when none does. Shared by guide execution (the light
 * cue and the motion goal) and H18, so validation checks the waypoints the aircraft will actually fly to.
 */
export function guideLeadIndex(waypoints: readonly Vec3[], track: OccupantTrack, ctx: HarnessContext): number {
  const last = waypoints.length - 1;
  const requiredM = requiredPersonDistanceM(ctx, track.uncertaintyM, personClearanceFor(ctx, "guide"));
  for (let i = nearestIndex(waypoints, track.position) + 1; i <= last; i++) {
    if (distance(waypoints[i], track.position) >= requiredM) return i;
  }
  return Math.max(0, last);
}

export function nearestIndex(points: readonly Vec3[], position: Vec3): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    if (distance(points[i], position) < distance(points[best], position)) best = i;
  }
  return best;
}

/**
 * The guided person's own evidence: the guided track, tracks marked as possibly the same person, and
 * detections in frames the guided track already fused. A guide's route starts at that person, and the per-tick
 * guard keeps the guidance clearance from all of it while the guide leads.
 */
export function isGuidedPerson(occupant: PossibleOccupant, guided: OccupantTrack, guidedFrames: ReadonlySet<ObservationId>, tracks: readonly OccupantTrack[]): boolean {
  if (occupant.source === "detection") return guidedFrames.has(occupant.id);
  if (occupant.id === guided.id || guided.ambiguousWith.includes(occupant.id)) return true;
  return tracks.some(t => t.id === occupant.id && t.ambiguousWith.includes(guided.id));
}

export function describeOccupant(occupant: PossibleOccupant): string {
  return occupant.source === "track" ? `possible-occupant track ${occupant.id}` : `the possible person detected in observation ${occupant.id}`;
}
