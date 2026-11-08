/**
 * Possible-occupant tracks with conservative association.
 *
 * A detection joins an existing track only when that is the single physically plausible identity:
 * gate = max(noise, min(gateMax, noise + occupant speed x |time between sightings|)), where
 * noise = ASSOCIATION_GATE_SIGMAS x hypot(track uncertainty, detection uncertainty). When more than one track could explain a detection, or the only
 * candidate is on another floor (the detection's height is clearly outside that floor's band), a new track is
 * created and the possible identities are linked both ways in `ambiguousWith`. A track's position fuses its
 * sightings, so repeated noisy sightings of one person at frame rate stay one track. Tracks are never
 * merged, retracted or deleted implicitly; explicit, reasoned corrections keep the original record.
 */
import type { Tick } from "../contracts/clock.ts";
import { secondsFromTicks } from "../contracts/clock.ts";
import type { FloorPlanPrior, OccupantTrack } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import type { RoomId, RunId, TrackId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { Detection, Observation } from "../contracts/observation.ts";
import { EvidenceRejection } from "./errors.ts";
import { roomContaining } from "./rooms.ts";

type PersonDetection = Extract<Detection, { kind: "possible_person" }>;

/**
 * Gate half-width for measurement noise, in combined one-sigma units. Two sightings of one stationary person
 * differ by a vector whose per-axis sigma is hypot(track, detection); 3.5 of those contains a repeat sighting
 * with probability above 0.99, whereas the sum of the two sigmas (about 1.4 combined sigmas) rejects most of
 * them and split one person seen at 50 Hz into hundreds of tracks.
 */
export const ASSOCIATION_GATE_SIGMAS = 3.5;

/**
 * How far, in the detection's one-sigma uncertainty, its height may lie outside a track's floor band and still
 * be that floor. Sensors report person height with half the horizontal noise, so two sigmas is generous for
 * one person, while a sighting inside another floor's rooms is normally several sigmas away.
 */
export const FLOOR_TOLERANCE_SIGMAS = 2;

export interface TrackingParams {
  readonly runId: RunId;
  readonly prior: FloorPlanPrior;
  readonly associationGateMaxM: number;
  readonly occupantSpeedMps: number;
  readonly minTrackConfidence: number;
}

/** What one possible_person detection did to the tracks. */
export interface TrackChange {
  readonly detectionIndex: number;
  readonly trackId: TrackId;
  readonly change: "created" | "associated";
  /** For a created track: existing tracks that may be the same person (identity unresolved). */
  readonly ambiguousWith: readonly TrackId[];
}

/** An explicit, reasoned correction. The corrected track stays in the belief with its new status. */
export interface TrackCorrection {
  readonly kind: "retracted" | "merged";
  readonly trackId: TrackId;
  readonly mergedInto: TrackId | null;
  readonly reason: string;
  readonly tick: Tick;
}

interface Plan {
  readonly index: number;
  readonly detection: PersonDetection;
  /** Possible tracks, as they were before this observation, whose gate contains the detection. */
  readonly candidates: readonly OccupantTrack[];
}

export class TrackTable {
  private readonly params: TrackingParams;
  private readonly floorByRoom: ReadonlyMap<RoomId, number>;
  /** Height band [lowest room zMin, highest room zMax] of each floor in the prior. */
  private readonly floorBands: ReadonlyMap<number, { readonly zMin: number; readonly zMax: number }>;
  private readonly records: OccupantTrack[] = [];
  private readonly indexById = new Map<TrackId, number>();
  private readonly correctionLog: TrackCorrection[] = [];
  /** Variance (m^2) of each possible track's fused position estimate; internal, not part of the belief. */
  private readonly variance = new Map<TrackId, number>();

  constructor(params: TrackingParams) {
    this.params = params;
    this.floorByRoom = new Map(params.prior.rooms.map(room => [room.id, room.floor]));
    const bands = new Map<number, { zMin: number; zMax: number }>();
    for (const room of params.prior.rooms) {
      const band = bands.get(room.floor);
      bands.set(room.floor, band === undefined ? { zMin: room.zMin, zMax: room.zMax } : { zMin: Math.min(band.zMin, room.zMin), zMax: Math.max(band.zMax, room.zMax) });
    }
    this.floorBands = bands;
  }

  /** Every track ever created, in creation order, including merged and retracted ones. */
  all(): OccupantTrack[] {
    return this.records.slice();
  }

  get(trackId: TrackId): OccupantTrack | undefined {
    const index = this.indexById.get(trackId);
    return index === undefined ? undefined : this.records[index];
  }

  corrections(): TrackCorrection[] {
    return this.correctionLog.slice();
  }

  /**
   * Associate every possible_person detection of one observation. All decisions use the tracks as they were
   * before the observation, so detection order within a frame does not matter, and two detections in the
   * same frame are never folded into the same track.
   */
  ingest(observation: Observation): { changes: TrackChange[]; ignored: number[] } {
    const possible = this.records.filter(track => track.status === "possible");
    const plans: Plan[] = [];
    const ignored: number[] = [];
    observation.detections.forEach((detection, index) => {
      if (detection.kind !== "possible_person") return;
      if (detection.confidence < this.params.minTrackConfidence) {
        ignored.push(index);
        return;
      }
      plans.push({ index, detection, candidates: possible.filter(track => this.withinGate(track, detection, observation.captureTick)) });
    });
    const claims = new Map<TrackId, number>();
    for (const plan of plans) for (const track of plan.candidates) claims.set(track.id, (claims.get(track.id) ?? 0) + 1);
    return { changes: plans.map(plan => this.apply(plan, claims, observation)), ignored };
  }

  retract(trackId: TrackId, reason: string, tick: Tick): TrackCorrection {
    const track = this.requirePossible(trackId);
    requireReason(reason);
    this.replace(deepFreeze({ ...track, status: "retracted" }));
    return this.logCorrection({ kind: "retracted", trackId, mergedInto: null, reason, tick });
  }

  /**
   * Fold `mergedId` into `keepId`. The kept track gains the merged track's observations and its more recent
   * position; the merged track remains with status "merged". Possible tracks that were ambiguous with the
   * merged track become ambiguous with the kept one.
   */
  merge(keepId: TrackId, mergedId: TrackId, reason: string, tick: Tick): TrackCorrection {
    if (keepId === mergedId) throw new EvidenceRejection("invalid_state", `Track ${keepId} cannot be merged into itself.`);
    const keep = this.requirePossible(keepId);
    const merged = this.requirePossible(mergedId);
    requireReason(reason);
    const latest = merged.lastSeenTick > keep.lastSeenTick ? merged : keep;
    this.replace(deepFreeze({
      ...keep,
      observationIds: unique([...keep.observationIds, ...merged.observationIds]),
      position: latest.position,
      uncertaintyM: latest.uncertaintyM,
      roomId: latest.roomId,
      firstSeenTick: Math.min(keep.firstSeenTick, merged.firstSeenTick),
      lastSeenTick: Math.max(keep.lastSeenTick, merged.lastSeenTick),
      confidence: Math.max(keep.confidence, merged.confidence),
      ambiguousWith: unique([...keep.ambiguousWith, ...merged.ambiguousWith]).filter(id => id !== keepId && id !== mergedId),
    }));
    this.replace(deepFreeze({ ...merged, status: "merged", mergedInto: keepId }));
    this.variance.set(keepId, latest.uncertaintyM ** 2);
    this.variance.delete(mergedId);
    for (const other of this.records) {
      if (other.status !== "possible" || other.id === keepId || !other.ambiguousWith.includes(mergedId)) continue;
      this.replace(deepFreeze({ ...other, ambiguousWith: unique(other.ambiguousWith.map(id => (id === mergedId ? keepId : id))) }));
    }
    return this.logCorrection({ kind: "merged", trackId: mergedId, mergedInto: keepId, reason, tick });
  }

  private withinGate(track: OccupantTrack, detection: PersonDetection, captureTick: Tick): boolean {
    const elapsedS = secondsFromTicks(Math.abs(captureTick - track.lastSeenTick));
    // The cap bounds the motion allowance so a stale track cannot claim everything nearby. A sighting
    // noisier than the cap still gets its noise gate: otherwise one imprecisely seen person never associates.
    const noise = ASSOCIATION_GATE_SIGMAS * Math.hypot(track.uncertaintyM, detection.uncertaintyM);
    const gate = Math.max(noise, Math.min(this.params.associationGateMaxM, noise + this.params.occupantSpeedMps * elapsedS));
    return distance(track.position, detection.position) <= gate;
  }

  private apply(plan: Plan, claims: ReadonlyMap<TrackId, number>, observation: Observation): TrackChange {
    const target = this.chooseTarget(plan, claims);
    if (target !== null) {
      this.replace(this.associate(target, plan.detection, observation));
      return { detectionIndex: plan.index, trackId: target.id, change: "associated", ambiguousWith: [] };
    }
    const created = this.create(plan.detection, observation, plan.candidates.map(track => track.id));
    return { detectionIndex: plan.index, trackId: created.id, change: "created", ambiguousWith: created.ambiguousWith };
  }

  /**
   * The single track this detection may join, or null for a new track. A candidate is eligible only if no
   * other detection in the same frame could also claim it and it is not on a different floor. With several
   * candidates, the detection may join one only when that track is already recorded as possibly the same
   * person as every other candidate; this extends an existing unresolved identity instead of creating a new
   * ambiguous track on every frame, and it never resolves or merges anything.
   */
  private chooseTarget(plan: Plan, claims: ReadonlyMap<TrackId, number>): OccupantTrack | null {
    const eligible = plan.candidates.filter(track => claims.get(track.id) === 1 && this.sameFloorPossible(this.floorOf(track), plan.detection));
    if (plan.candidates.length === 1) return eligible[0] ?? null;
    const extendsAmbiguity = eligible.filter(track => plan.candidates.every(other => other.id === track.id || track.ambiguousWith.includes(other.id)));
    return nearest(extendsAmbiguity, plan.detection.position);
  }

  /**
   * Whether the detection may be on the track's floor: its height lies within FLOOR_TOLERANCE_SIGMAS of its
   * own uncertainty of that floor's height band. A sighting whose noisy height dips just below the floor slab
   * (or resolves to no room) is not taken for another floor; one clearly in another floor's band is.
   */
  private sameFloorPossible(trackFloor: number | null, detection: PersonDetection): boolean {
    const band = trackFloor === null ? undefined : this.floorBands.get(trackFloor);
    if (band === undefined) return true;
    const tolerance = FLOOR_TOLERANCE_SIGMAS * detection.uncertaintyM;
    return detection.position.z >= band.zMin - tolerance && detection.position.z <= band.zMax + tolerance;
  }

  private floorOf(track: OccupantTrack): number | null {
    return track.roomId === null ? null : this.floorByRoom.get(track.roomId) ?? null;
  }

  /**
   * Joins a detection to a track. Only a sighting at least as recent moves the track: the position is fused
   * with it (isotropic Kalman update whose process noise is the occupant speed times the elapsed time, so a
   * long gap follows the new sighting almost fully while 50 Hz repeats average out measurement noise), and
   * the reported uncertainty becomes the sighting's own. The fused estimate's smaller variance is never
   * reported: pose error shared by consecutive sightings does not average out.
   */
  private associate(before: OccupantTrack, detection: PersonDetection, observation: Observation): OccupantTrack {
    const track = this.get(before.id) ?? before;
    const newer = observation.captureTick >= track.lastSeenTick;
    let position = track.position;
    if (newer) {
      const drift = this.params.occupantSpeedMps * secondsFromTicks(observation.captureTick - track.lastSeenTick);
      const predicted = (this.variance.get(track.id) ?? track.uncertaintyM ** 2) + drift ** 2;
      const measured = detection.uncertaintyM ** 2;
      const gain = predicted + measured > 0 ? predicted / (predicted + measured) : 1;
      position = vec3(
        track.position.x + gain * (detection.position.x - track.position.x),
        track.position.y + gain * (detection.position.y - track.position.y),
        track.position.z + gain * (detection.position.z - track.position.z),
      );
      this.variance.set(track.id, (1 - gain) * predicted);
    }
    return deepFreeze({
      ...track,
      observationIds: [...track.observationIds, observation.id],
      position,
      uncertaintyM: newer ? detection.uncertaintyM : track.uncertaintyM,
      roomId: newer ? roomContaining(this.params.prior, position)?.id ?? null : track.roomId,
      firstSeenTick: Math.min(track.firstSeenTick, observation.captureTick),
      lastSeenTick: Math.max(track.lastSeenTick, observation.captureTick),
      // A later, weaker sighting never lowers how strongly a possible person is indicated.
      confidence: Math.max(track.confidence, detection.confidence),
    });
  }

  private create(detection: PersonDetection, observation: Observation, ambiguousWith: readonly TrackId[]): OccupantTrack {
    const track: OccupantTrack = deepFreeze({
      id: `${this.params.runId}/t${this.records.length + 1}`,
      status: "possible",
      observationIds: [observation.id],
      position: detection.position,
      uncertaintyM: detection.uncertaintyM,
      roomId: roomContaining(this.params.prior, detection.position)?.id ?? null,
      firstSeenTick: observation.captureTick,
      lastSeenTick: observation.captureTick,
      confidence: detection.confidence,
      mergedInto: null,
      ambiguousWith: [...ambiguousWith],
    });
    this.indexById.set(track.id, this.records.length);
    this.records.push(track);
    this.variance.set(track.id, detection.uncertaintyM ** 2);
    for (const otherId of ambiguousWith) {
      const other = this.get(otherId);
      if (other !== undefined && !other.ambiguousWith.includes(track.id)) this.replace(deepFreeze({ ...other, ambiguousWith: [...other.ambiguousWith, track.id] }));
    }
    return track;
  }

  private requirePossible(trackId: TrackId): OccupantTrack {
    const track = this.get(trackId);
    if (track === undefined) throw new EvidenceRejection("unknown_reference", `Unknown track ${trackId}.`);
    if (track.status !== "possible") throw new EvidenceRejection("invalid_state", `Track ${trackId} is already ${track.status}.`);
    return track;
  }

  private replace(track: OccupantTrack): void {
    const index = this.indexById.get(track.id);
    if (index === undefined) throw new Error(`Track ${track.id} is not registered.`);
    this.records[index] = track;
  }

  private logCorrection(correction: TrackCorrection): TrackCorrection {
    const frozen = deepFreeze({ ...correction });
    this.correctionLog.push(frozen);
    return frozen;
  }
}

function requireReason(reason: string): void {
  if (typeof reason !== "string" || reason.trim().length === 0) throw new EvidenceRejection("invalid", "A track correction needs a stated reason.");
}

function nearest(tracks: readonly OccupantTrack[], p: Vec3): OccupantTrack | null {
  let best: OccupantTrack | null = null;
  for (const track of tracks) {
    if (best === null || distance(track.position, p) < distance(best.position, p)) best = track;
  }
  return best;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
