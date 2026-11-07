/**
 * Sensor frames → evidence, on the mission clock.
 *
 * Every tick the simulator's sensor suite is read (senseTick); observations and range readings wait until
 * their arrivalTick and are then ingested in (arrivalTick, id) order. Key evidence events go to the mission
 * timeline: possible-occupant tracks created (and re-sighted after a gap or in another room), opening states
 * observed, observed corrections to the floor-plan prior (map changes) and fire sightings. Frames are not
 * logged one by one. Detections made by the thermal person oracle are labelled as a fixture, not a detector.
 */
import type { Tick } from "../contracts/clock.ts";
import type { EventLog } from "../contracts/events.ts";
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { box, distanceToRegion, representativePoint } from "../contracts/geometry.ts";
import type { Detection, Observation, OpeningState } from "../contracts/observation.ts";
import { roomContaining } from "../evidence/rooms.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import type { TrackChange } from "../evidence/tracks.ts";
import type { ImuReading, RangeReadings } from "../simulation/sensors/index.ts";
import { senseTick } from "../simulation/sensors/index.ts";
import type { WorldState } from "../simulation/world-state.ts";

const TRACK_RESIGHT_TICKS = 500;
const FIRE_RELOG_TICKS = 1000;
const MAX_PROBLEMS = 8;

export class SensingPipeline {
  latestRanges: RangeReadings | null = null;
  latestImu: ImuReading | null = null;
  latestRgbQuality = 0;
  ingested = 0;
  readonly rejections: string[] = [];
  private readonly pending: Observation[] = [];
  private readonly pendingRanges: RangeReadings[] = [];
  private readonly pendingImu: ImuReading[] = [];
  private readonly openingStates = new Map<string, OpeningState>();
  private readonly trackSightings = new Map<string, { tick: Tick; roomId: string | null }>();
  private readonly fireSightings: { tick: Tick; region: Region; readonly out: boolean }[] = [];

  constructor(prior: FloorPlanPrior) {
    for (const opening of prior.openings) if (opening.priorState !== "unknown") this.openingStates.set(opening.id, opening.priorState);
  }

  /** Read this tick's sensor frames (pure read of the world) and queue them until they arrive. */
  sense(world: WorldState): readonly Observation[] {
    const frame = senseTick(world);
    for (const observation of frame.observations) insertSorted(this.pending, observation);
    if (frame.ranges !== null) this.pendingRanges.push(frame.ranges);
    if (frame.imu !== null) this.pendingImu.push(frame.imu);
    return frame.observations;
  }

  /** Ingest everything that has arrived by `tick`, in (arrivalTick, id) order, and log key evidence. */
  ingest(tick: Tick, evidence: EvidenceStore, log: EventLog, prior: FloorPlanPrior): void {
    while (this.pending.length > 0 && this.pending[0].arrivalTick <= tick) {
      const observation = this.pending.shift() as Observation;
      // Passing the current tick lets the store reject future-dated input instead of wedging later snapshots.
      const result = evidence.ingestObservation(observation, tick);
      if (!result.accepted) {
        if (this.rejections.length < MAX_PROBLEMS) this.rejections.push(`${result.observationId ?? "?"}: ${result.reason} — ${result.detail}`);
        log.append({ tick, source: "evidence", kind: "observation.rejected", subject: result.observationId, reason: `Observation rejected (${result.reason}): ${result.detail}`, data: { reason: result.reason } });
        continue;
      }
      this.ingested += 1;
      if (observation.modality === "rgb") this.latestRgbQuality = observation.quality;
      this.logTracks(tick, observation, result.tracks, prior, log);
      this.logOpenings(tick, observation, evidence, log, prior);
      this.logFires(tick, observation, log);
    }
    while (this.pendingRanges.length > 0 && this.pendingRanges[0].arrivalTick <= tick) this.latestRanges = this.pendingRanges.shift() as RangeReadings;
    while (this.pendingImu.length > 0 && this.pendingImu[0].arrivalTick <= tick) this.latestImu = this.pendingImu.shift() as ImuReading;
  }

  private logTracks(tick: Tick, observation: Observation, changes: readonly TrackChange[], prior: FloorPlanPrior, log: EventLog): void {
    for (const change of changes) {
      const detection = observation.detections[change.detectionIndex];
      if (detection?.kind !== "possible_person") continue;
      const roomId = roomContaining(prior, detection.position)?.id ?? null;
      const previous = this.trackSightings.get(change.trackId);
      this.trackSightings.set(change.trackId, { tick, roomId });
      const resighted = previous !== undefined && (tick - previous.tick >= TRACK_RESIGHT_TICKS || previous.roomId !== roomId);
      if (change.change === "associated" && !resighted) continue;
      const label = detection.method === "oracle_fixture" ? "thermal person oracle — a labelled raycast fixture, not detector accuracy" : detection.method;
      const verb = change.change === "created" ? "Possible occupant detected" : "Possible occupant seen again";
      log.append({
        tick, source: "evidence", kind: change.change === "created" ? "track.created" : "track.updated", subject: change.trackId,
        reason: `${verb} by ${observation.sensorId} (${label})${roomId === null ? "" : ` in ${roomId}`}; a detection is not a confirmed person.`,
        data: { trackId: change.trackId, observationId: observation.id, roomId, method: detection.method, confidence: detection.confidence, uncertaintyM: detection.uncertaintyM, ambiguousWith: [...change.ambiguousWith] },
      });
    }
  }

  private logOpenings(tick: Tick, observation: Observation, evidence: EvidenceStore, log: EventLog, prior: FloorPlanPrior): void {
    for (const detection of observation.detections) {
      if (detection.kind !== "opening_state") continue;
      const previous = this.openingStates.get(detection.openingId) ?? null;
      if (previous === detection.state) continue;
      this.openingStates.set(detection.openingId, detection.state);
      log.append({ tick, source: "evidence", kind: "opening.observed", subject: detection.openingId, reason: `${observation.sensorId} observed opening ${detection.openingId} ${detection.state}${previous === null ? "" : ` (previously ${previous})`}.`, data: { openingId: detection.openingId, state: detection.state, previous, observationId: observation.id } });
      const region = openingRegion(prior, detection.openingId);
      if (previous === null || region === null) continue;
      const change = evidence.addMapChange({ tick, region, reason: `Opening ${detection.openingId} observed ${detection.state}; the plan or earlier evidence said ${previous}.`, observationIds: [observation.id] });
      log.append({ tick, source: "evidence", kind: "map.changed", subject: detection.openingId, reason: change.reason, data: { mapRevision: change.revision, openingId: detection.openingId, observationId: observation.id } });
    }
  }

  /** A flame sighting logs hazard.fire_observed; a sighting of the place with no flame (intensity 0) logs hazard.fire_out_observed. */
  private logFires(tick: Tick, observation: Observation, log: EventLog): void {
    for (const detection of observation.detections) {
      if (!isFire(detection)) continue;
      const out = !(detection.intensity > 0);
      const center = representativePoint(detection.region);
      const known = this.fireSightings.find(s => s.out === out && tick - s.tick < FIRE_RELOG_TICKS && distanceToRegion(s.region, center) < 1.5);
      if (known !== undefined) {
        known.tick = tick;
        continue;
      }
      this.fireSightings.push({ tick, region: detection.region, out });
      const at = `(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)})`;
      const reason = out ? `${observation.sensorId} saw the place near ${at} where fire was and no flame there.` : `${observation.sensorId} observed fire near ${at}, intensity ${detection.intensity.toFixed(2)}.`;
      log.append({ tick, source: "evidence", kind: out ? "hazard.fire_out_observed" : "hazard.fire_observed", subject: observation.id, reason, data: { observationId: observation.id, intensity: detection.intensity } });
    }
  }
}

function isFire(detection: Detection): detection is Extract<Detection, { kind: "hazard" }> {
  return detection.kind === "hazard" && detection.hazard === "fire";
}

/** A thin box around an opening from the prior: the region whose observed change is a map correction. */
export function openingRegion(prior: FloorPlanPrior, openingId: string): Region | null {
  const opening = prior.openings.find(o => o.id === openingId);
  if (opening === undefined) return null;
  const alongX = Math.abs(opening.outwardNormal.x) >= Math.abs(opening.outwardNormal.y);
  const hx = alongX ? 0.3 : opening.widthM / 2;
  const hy = alongX ? opening.widthM / 2 : 0.3;
  const hz = opening.heightM / 2;
  const c = opening.center;
  return box(vec3(c.x - hx, c.y - hy, c.z - hz), vec3(c.x + hx, c.y + hy, c.z + hz));
}

function insertSorted(queue: Observation[], observation: Observation): void {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const other = queue[mid];
    if (other.arrivalTick < observation.arrivalTick || (other.arrivalTick === observation.arrivalTick && other.id < observation.id)) low = mid + 1;
    else high = mid;
  }
  queue.splice(low, 0, observation);
}
