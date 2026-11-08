/**
 * Per-capture context and the common observation envelope. Ids, ticks and the sensor pose come from the
 * capture tick and the aircraft's ESTIMATED pose (estimatedPose), never from ground truth.
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Tick } from "../../contracts/clock.ts";
import { SIM_HZ } from "../../contracts/clock.ts";
import type { EstimatedPose } from "../../contracts/evidence.ts";
import type { Pose } from "../../contracts/frames.ts";
import { wrapAngle } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import type { DetectionMethod, Detection, Observation, SensorPoseEstimate } from "../../contracts/observation.ts";
import { estimatedPose } from "../localization.ts";
import type { WorldState } from "../world-state.ts";
import { sensorOrigin, truePose } from "./pose.ts";

/** Rate of the person search (oracle detection and footprint) on each camera: a realistic onboard detector rate. */
export const PERSON_SEARCH_HZ = 10;

export function sensorPeriodTicks(spec: SensorSpec): number {
  return Math.max(1, Math.round(SIM_HZ / spec.rateHz));
}

/**
 * Whether this capture runs the person search: the first frame of the camera in each 1 / PERSON_SEARCH_HZ
 * window, so a camera at or below that rate searches every frame and a 50 Hz camera every fifth.
 */
export function searchesForPeople(spec: SensorSpec, tick: Tick): boolean {
  return tick % Math.max(1, Math.round(SIM_HZ / PERSON_SEARCH_HZ)) < sensorPeriodTicks(spec);
}

export interface SenseContext {
  readonly world: WorldState;
  readonly tick: Tick;
  /** Where the aircraft really is: physical rays start here. */
  readonly truth: Pose;
  /** What the aircraft believes: every reported position and direction uses this. */
  readonly estimate: EstimatedPose;
  readonly estimatePose: Pose;
}

export function senseContext(world: WorldState): SenseContext {
  const estimate = estimatedPose(world);
  return { world, tick: world.tick, truth: truePose(world), estimate, estimatePose: { position: estimate.position, yawRad: estimate.yawRad } };
}

export function observationId(world: WorldState, sensorId: string, tick: Tick): string {
  return `${world.runId}/${sensorId}/${tick}`;
}

export function sensorPoseEstimate(ctx: SenseContext, spec: SensorSpec): SensorPoseEstimate {
  return { position: sensorOrigin(ctx.estimatePose, spec), yawRad: wrapAngle(ctx.estimate.yawRad + spec.mount.yawRad), sigmaM: ctx.estimate.sigmaM };
}

export interface ObservationBody {
  readonly quality: number;
  readonly footprint: Region | null;
  readonly personSearch: DetectionMethod | null;
  readonly detections: readonly Detection[];
}

const IMAGING = new Set(["rgb", "thermal"]);

export function buildObservation(ctx: SenseContext, spec: SensorSpec, body: ObservationBody): Observation {
  const imaging = IMAGING.has(spec.modality) && spec.resolution !== null;
  return {
    id: observationId(ctx.world, spec.id, ctx.tick),
    runId: ctx.world.runId,
    sensorId: spec.id,
    modality: spec.modality,
    captureTick: ctx.tick,
    arrivalTick: ctx.tick + spec.latencyTicks,
    frameId: imaging ? `${ctx.world.runId}/${spec.id}/frame/${ctx.tick}` : null,
    calibrationId: imaging ? `${spec.id}/v1` : null,
    provenance: "simulated_sensor",
    sensorPose: sensorPoseEstimate(ctx, spec),
    quality: Number.isFinite(body.quality) ? Math.max(0, Math.min(1, body.quality)) : 0,
    footprint: body.footprint,
    personSearch: body.personSearch,
    detections: body.detections.slice(0, 64),
    supersedes: null,
  };
}
