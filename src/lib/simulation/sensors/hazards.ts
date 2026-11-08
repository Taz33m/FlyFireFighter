/**
 * Simulated recognition shared by the RGB and thermal models. These are labelled simplifications, not image
 * classifiers: a fire is "seen" when part of its flame is inside the field of view, within reach, in line of
 * sight and not hidden by more smoke than that wavelength tolerates; an opening's state is reported when the
 * camera has a clear, not-too-oblique, not-too-smoky view of it. Reported regions are re-expressed from the
 * estimated pose and inflated by its uncertainty.
 *
 * A fire that has gone out is reported too, as a fire hazard of intensity 0 at the same place, under exactly
 * the visibility test a flame there would pass (the points where its flame stood: in view, within reach, in
 * line of sight, not too smoky). That is what the camera sees: the spot where the fire burned, with no flame.
 * Without it nothing would ever say a fire is out, and the last flame seen would stand until it aged out of
 * the evidence. A spot the camera cannot see yields no report at all, so a missing sighting still says nothing.
 *
 * Line of sight uses the modality's transparency (SeeThrough): visible light passes intact glass at a contrast
 * cost (the same factor as the RGB person oracle), LWIR does not, so thermal never sees a fire through a pane.
 *
 * Opening states report what the camera can see, not the hidden truth. Open, closed and broken look
 * different. A jammed door ("blocked" in the world) looks exactly like a closed one, so it is reported
 * "closed". "blocked" is reported only on visible evidence: an obstruction collider (experiment or debris,
 * id prefix OBSTRUCTION_ID_PREFIX) across the opening's walking line — the segment through the threshold
 * along the normal, DOORWAY_DEPTH_M either side, at the occupant route's knee height — whose part on that line
 * is in view, in clear line of sight and not too smoky. Debris on the far side of a closed door stays unseen.
 *
 * Hazard intensity units: fire = normalized flame intensity in [0, 1] (Q / (Q + 100 kW) × transmission, ×
 * the see-through factor behind glass; 0 where a fire is out); smoke = estimated extinction coefficient (1/m); heat = apparent gas
 * temperature (°C).
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { dot, normalize, sub, vec3 } from "../../contracts/frames.ts";
import { box, sphere } from "../../contracts/geometry.ts";
import type { Detection, OpeningState } from "../../contracts/observation.ts";
import { fireExtent, opticalDepth } from "../fire.ts";
import { KNEE_HEIGHT_M } from "../occupant-graph.ts";
import { OBSTRUCTION_ID_PREFIX } from "../occupant-route.ts";
import { openingThreshold } from "../scene.ts";
import type { FireTruth, RuntimeCollider, RuntimeOpening } from "../world-state.ts";
import type { SenseContext } from "./observation.ts";
import { inPinholeView, toEstimatedFrame } from "./pose.ts";
import { rayChord } from "./shapes.ts";
import type { TraceSet } from "./trace.ts";
import { traceClear } from "./trace.ts";

const FIRE_REFERENCE_KW = 100;
const OPENING_MAX_RANGE_M = 12;
const OPENING_TAU_LIMIT = 2.5;
const OPENING_MIN_FACING = 0.2;
/** How far either side of an opening's plane an obstruction still counts as "in the doorway". */
export const DOORWAY_DEPTH_M = 0.5;

/** Colliders a modality sees through, and the contrast it keeps when it does (visible light and intact glass). */
export interface SeeThrough {
  readonly transparent: (collider: RuntimeCollider) => boolean;
  /** Transmission factor for a target seen through at least one transparent collider. */
  readonly factor: number;
}

export interface FireSighting {
  readonly fire: FireTruth;
  readonly rangeM: number;
  /** Transmission at the sensor's wavelength along the line of sight (smoke, and glass when seen through it). */
  readonly transmission: number;
}

/** Inside the camera's pinhole frustum (the rendered image and the depth-image footprint) within reachM. */
export function inFieldOfView(ctx: SenseContext, spec: SensorSpec, point: Vec3, reachM: number): boolean {
  return inPinholeView(ctx.truth, spec, point, reachM);
}

/**
 * Fire places visible to a camera, burning or out (see the header); smokeFactor scales visible optical depth to
 * the sensor's wavelength. A fire that is out is looked for where a flame of its size would stand.
 */
export function sightFires(ctx: SenseContext, spec: SensorSpec, set: TraceSet, origin: Vec3, reachM: number, smokeFactor: number, tauLimit: number, through?: SeeThrough): FireSighting[] {
  const sightings: FireSighting[] = [];
  for (const fire of ctx.world.fires) {
    const { center, radiusM } = fireExtent(fire.region);
    const flameHeightM = Math.max(radiusM, 0.235 * Math.max(0, burningKW(fire)) ** 0.4 - 2.04 * radiusM);
    const targets = [vec3(center.x, center.y, center.z + radiusM * 0.9), vec3(center.x, center.y, center.z - radiusM + flameHeightM * 0.6)];
    const visible = targets.find(target => inFieldOfView(ctx, spec, target, reachM) && traceClear(set, origin, target, through?.transparent));
    if (!visible) continue;
    const tau = smokeFactor * opticalDepth(ctx.world, origin, visible);
    if (tau > tauLimit) continue;
    const pane = through !== undefined && !traceClear(set, origin, visible) ? through.factor : 1;
    sightings.push({ fire, rangeM: Math.hypot(visible.x - origin.x, visible.y - origin.y, visible.z - origin.z), transmission: Math.exp(-tau) * pane });
  }
  return sightings;
}

/** Heat release of a burning fire; 0 once it is out. */
function burningKW(fire: FireTruth): number {
  return fire.extinguished || !(fire.heatReleaseKW > 0) ? 0 : fire.heatReleaseKW;
}

/** Intensity 0 for a fire that is out (the camera sees the place and no flame). */
export function fireDetection(ctx: SenseContext, sighting: FireSighting): Detection {
  const { center, radiusM } = fireExtent(sighting.fire.region);
  const q = burningKW(sighting.fire);
  return {
    kind: "hazard",
    hazard: "fire",
    region: sphere(toEstimatedFrame(ctx.truth, ctx.estimatePose, center), radiusM + ctx.estimate.sigmaM + 0.05 * sighting.rangeM),
    intensity: (q / (q + FIRE_REFERENCE_KW)) * sighting.transmission,
  };
}

/** How an opening in the given world state looks: a jammed door is indistinguishable from a closed one. */
export function apparentOpeningState(state: OpeningState): OpeningState {
  return state === "blocked" ? "closed" : state;
}

/** Opening states a camera can judge: clear, facing and not too smoky a view of the opening's near side (see the header). */
export function sightOpenings(ctx: SenseContext, spec: SensorSpec, set: TraceSet, origin: Vec3, reachM: number, through?: SeeThrough): Detection[] {
  const detections: Detection[] = [];
  const reach = Math.min(reachM, OPENING_MAX_RANGE_M);
  for (const opening of ctx.world.scene.openings) {
    const truth = ctx.world.openings.find(o => o.id === opening.id);
    if (!truth) continue;
    const side = dot(sub(origin, opening.center), opening.outwardNormal) >= 0 ? 1 : -1;
    const n = opening.outwardNormal;
    const target = vec3(opening.center.x + n.x * side * 0.1, opening.center.y + n.y * side * 0.1, opening.center.z + n.z * side * 0.1);
    if (!inFieldOfView(ctx, spec, target, reach)) continue;
    const toTarget = sub(target, origin);
    if (Math.hypot(toTarget.x, toTarget.y, toTarget.z) < 1e-6 || Math.abs(dot(normalize(toTarget), n)) < OPENING_MIN_FACING) continue;
    if (seesObstruction(ctx, spec, set, origin, opening, reach, through)) {
      detections.push({ kind: "opening_state", openingId: opening.id, state: "blocked" });
      continue;
    }
    if (!traceClear(set, origin, target, through?.transparent) || opticalDepth(ctx.world, origin, target) > OPENING_TAU_LIMIT) continue;
    detections.push({ kind: "opening_state", openingId: opening.id, state: apparentOpeningState(truth.state) });
  }
  return detections;
}

/** True when an obstruction crosses the opening's walking line and the camera has a clear view of that part of it. */
function seesObstruction(ctx: SenseContext, spec: SensorSpec, set: TraceSet, origin: Vec3, opening: RuntimeOpening, reachM: number, through: SeeThrough | undefined): boolean {
  const n = opening.outwardNormal;
  const threshold = openingThreshold(opening);
  const z = threshold.z + Math.min(KNEE_HEIGHT_M, opening.heightM / 2);
  const start = vec3(threshold.x - n.x * DOORWAY_DEPTH_M, threshold.y - n.y * DOORWAY_DEPTH_M, z);
  const lengthM = 2 * DOORWAY_DEPTH_M;
  const dir = vec3(n.x, n.y, 0);
  for (const collider of set.colliders) {
    if (!collider.id.startsWith(OBSTRUCTION_ID_PREFIX)) continue;
    const chord = rayChord(box(collider.min, collider.max), start, dir, lengthM);
    if (chord === null) continue;
    const t = (chord[0] + chord[1]) / 2;
    const seen = vec3(start.x + dir.x * t, start.y + dir.y * t, z);
    if (!inFieldOfView(ctx, spec, seen, reachM)) continue;
    if (!traceClear(set, origin, seen, c => c === collider || (through?.transparent(c) ?? false))) continue;
    if (opticalDepth(ctx.world, origin, seen) > OPENING_TAU_LIMIT) continue;
    return true;
  }
  return false;
}
