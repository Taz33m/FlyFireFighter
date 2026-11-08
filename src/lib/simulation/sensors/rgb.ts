/**
 * RGB camera observation METADATA. The browser renders the pixels for display and the visual controller;
 * this model supplies what the frame covered and what simulated recognition reports:
 * - person search (PERSON_SEARCH_HZ, observation.ts: every fifth frame of the 50 Hz forward camera, every
 *   frame of the 10 Hz downward one). Only these frames carry personSearch "oracle_fixture", possible-person
 *   detections and a footprint; the others carry personSearch null and no footprint (quality and hazards are
 *   still reported, and the controller's rendered frames are unaffected);
 * - footprint: a depth image (imaging.ts) of what the camera saw, cut at the first opaque surface (floors
 *   clipping from below) and where the person oracle below would no longer report a person in view at
 *   PERSON_DETECTION_CONFIDENCE: along each ray, where 0.9 × exp(−τ(d)) × glass(d) × MIN_BODY_SHARE × range(d)
 *   falls below it (detectability.ts). In clear air that never happens within reach; in smoke the cut sits
 *   near τ = ln 3 ≈ 1.1 (about 0.9 through a pane), so the clear near field of a smoky frame stays covered
 *   while its far field does not. Visible light passes intact glass, so a pane does not cut the RGB footprint
 *   but lowers the budget beyond it by the glass factor (thermal stops at panes: LWIR does not pass glass);
 * - quality: contrast proxy, the mean of exp(−τ) over the nx × ny measurement rays (every frame), each ray
 *   stopping where τ reaches tauLimit (3, about 5 % contrast). A whole-frame figure: per-point detectability is
 *   the footprint's;
 * - person ORACLE FIXTURE (method "oracle_fixture"): a ray
 *   from the camera to sample points on each hidden occupant, within the FOV and reach, blocked by walls,
 *   doors and other opaque colliders but not by intact glass. Confidence = 0.9 × exp(−τ_visible) ×
 *   glass (0.8 when seen through a pane: reflections and tint) × visibility (bodyShare) × range, measured to the
 *   middle visible sample point. A raycast fixture, not detector accuracy: no image person detector runs on the
 *   rendered pixels;
 * - detections: visible fires, a smoke hazard when the estimated extinction along the view exceeds
 *   smokeDetectPerM, and the state of openings in clear view (hazards.ts: a jammed door looks closed). Fires
 *   and openings are sighted through intact glass like the person oracle, a fire behind a pane at glassFactor
 *   of its intensity.
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import { distance, vec3 } from "../../contracts/frames.ts";
import { sector } from "../../contracts/geometry.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import type { Detection, Observation } from "../../contracts/observation.ts";
import { PERSON_DETECTION_CONFIDENCE } from "../../contracts/observation.ts";
import { opticalDepth } from "../fire.ts";
import { keyedGaussian } from "../random.ts";
import type { OccupantTruth, RuntimeCollider, WorldState } from "../world-state.ts";
import { bodyShare, detectableExtent, MIN_BODY_SHARE, sampleHeights } from "./detectability.ts";
import type { SeeThrough } from "./hazards.ts";
import { fireDetection, inFieldOfView, sightFires, sightOpenings } from "./hazards.ts";
import type { ImagingTrace } from "./imaging.ts";
import { depthFootprint, traceCamera } from "./imaging.ts";
import type { SenseContext } from "./observation.ts";
import { buildObservation, searchesForPeople } from "./observation.ts";
import { sensorDirection, sensorOrigin, toEstimatedFrame } from "./pose.ts";
import { traceClear } from "./trace.ts";

export const RGB_MODEL = Object.freeze({
  nx: 8,
  ny: 5,
  /** Depth-image footprint cells across the image (rows follow from the aspect ratio). */
  footprintCols: 32,
  reachM: 20,
  /** Where a measurement ray stops (quality and smoke estimates); the footprint uses detectability instead. */
  tauLimit: 3,
  /** Luminous flames stay visible through more smoke than surfaces do. */
  fireTauLimit: 5,
  smokeDetectPerM: 0.1,
  /** Relative noise of the extinction estimate. */
  smokeNoise: 0.1,
  personBaseConfidence: 0.9,
  /** Contrast retained when the person is seen through an intact pane. */
  glassFactor: 0.8,
  personMinConfidence: 0.05,
});

const RAD = Math.PI / 180;

/** Visible light passes intact glass. */
export const visibleThrough = (collider: RuntimeCollider): boolean => collider.kind === "glass";

const THROUGH_GLASS: SeeThrough = Object.freeze({ transparent: visibleThrough, factor: RGB_MODEL.glassFactor });

export function rgbObservation(ctx: SenseContext, spec: SensorSpec): Observation {
  const trace = traceCamera(ctx, spec, { ...RGB_MODEL, transparent: visibleThrough });
  const quality = trace.centers.reduce((sum, ray) => sum + Math.exp(-ray.tau), 0) / trace.centers.length;
  const fires = sightFires(ctx, spec, trace.set, trace.origin, RGB_MODEL.reachM, 1, RGB_MODEL.fireTauLimit, THROUGH_GLASS).map(sighting => fireDetection(ctx, sighting));
  const smoke = smokeDetection(ctx, spec, trace);
  const openings = sightOpenings(ctx, spec, trace.set, trace.origin, RGB_MODEL.reachM, THROUGH_GLASS);
  if (!searchesForPeople(spec, ctx.tick)) return buildObservation(ctx, spec, { quality, footprint: null, personSearch: null, detections: [...fires, ...smoke, ...openings] });
  const people = ctx.world.occupants.flatMap(occupant => sightPersonVisible(ctx, spec, trace, occupant));
  const footprint = depthFootprint(ctx, spec, trace.set, { cols: RGB_MODEL.footprintCols, reachM: RGB_MODEL.reachM, transparent: visibleThrough, detectableM: (origin, dir, hitM, glassM) => rgbDetectableM(ctx.world, origin, dir, hitM, glassM) });
  return buildObservation(ctx, spec, { quality, footprint, personSearch: "oracle_fixture", detections: [...people, ...fires, ...smoke, ...openings] });
}

function sightPersonVisible(ctx: SenseContext, spec: SensorSpec, trace: ImagingTrace, occupant: OccupantTruth): Detection[] {
  const points = sampleHeights(occupant).map(h => vec3(occupant.position.x, occupant.position.y, occupant.position.z + h));
  const visible = points.filter(p => inFieldOfView(ctx, spec, p, RGB_MODEL.reachM) && traceClear(trace.set, trace.origin, p, visibleThrough));
  if (visible.length === 0) return [];
  const target = visible[Math.floor(visible.length / 2)];
  const rangeM = distance(trace.origin, target);
  const transmission = Math.exp(-opticalDepth(ctx.world, trace.origin, target));
  const glass = traceClear(trace.set, trace.origin, target) ? 1 : RGB_MODEL.glassFactor;
  const confidence = RGB_MODEL.personBaseConfidence * transmission * glass * bodyShare(visible.length, points.length) * rangeFactor(rangeM);
  if (confidence < RGB_MODEL.personMinConfidence) return [];
  const sigmaMeasM = 0.1 + 0.05 * rangeM;
  const noise = (axis: number) => sigmaMeasM * keyedGaussian(ctx.world.seed, `${spec.id}/person/${occupant.key}`, ctx.tick, axis);
  const p = toEstimatedFrame(ctx.truth, ctx.estimatePose, target);
  return [{
    kind: "possible_person",
    position: vec3(p.x + noise(0), p.y + noise(1), p.z + 0.5 * noise(2)),
    uncertaintyM: Math.hypot(ctx.estimate.sigmaM, sigmaMeasM),
    confidence: Math.min(0.99, confidence),
    method: "oracle_fixture",
  }];
}

function rangeFactor(rangeM: number): number {
  return Math.max(0, 1 - 0.5 * (rangeM / RGB_MODEL.reachM) ** 2);
}

/**
 * Detectable extent of one footprint ray (see the header): the oracle reports at least the threshold where
 * τ(d) ≤ ln(0.9 × glass(d) × MIN_BODY_SHARE × range(d) / threshold), glass(d) dropping to the glass factor past
 * the first pane.
 */
function rgbDetectableM(world: WorldState, origin: Vec3, dir: Vec3, hitM: number, glassM: number): number {
  const throughPane = glassM < hitM;
  const ends = throughPane ? [glassM, hitM] : [hitM];
  const scale = RGB_MODEL.personBaseConfidence * MIN_BODY_SHARE / PERSON_DETECTION_CONFIDENCE;
  return detectableExtent(world, origin, dir, { ends, budget: (piece, d) => Math.log(scale * (throughPane && piece === 1 ? RGB_MODEL.glassFactor : 1) * rangeFactor(d)) });
}

/** Mean extinction along the view (total optical depth over total ray length), with keyed estimation noise. */
function smokeDetection(ctx: SenseContext, spec: SensorSpec, trace: ImagingTrace): Detection[] {
  const length = trace.centers.reduce((sum, ray) => sum + ray.cutM, 0);
  if (length < 0.1) return [];
  const tau = trace.centers.reduce((sum, ray) => sum + ray.tau, 0);
  const estimate = (tau / length) * Math.max(0, 1 + RGB_MODEL.smokeNoise * keyedGaussian(ctx.world.seed, `${spec.id}/smoke`, ctx.tick));
  if (!(estimate >= RGB_MODEL.smokeDetectPerM)) return [];
  const halfAngle = (Math.min(spec.horizontalFovDeg ?? 0, spec.verticalFovDeg ?? 0) * RAD) / 2;
  const region = sector(sensorOrigin(ctx.estimatePose, spec), sensorDirection(ctx.estimatePose, spec, 0, 0), halfAngle, Math.max(0.5, length / trace.centers.length));
  return [{ kind: "hazard", hazard: "smoke", region, intensity: estimate }];
}
