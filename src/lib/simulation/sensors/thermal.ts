/**
 * Thermal camera observations: occlusion-aware depth-image footprint (imaging.ts), a person ORACLE FIXTURE and
 * fire/heat hazards. At 10 Hz the camera runs its person search (PERSON_SEARCH_HZ) on every frame.
 *
 * - Smoke: long-wave infrared extinction is taken as smokeFactor (8 %) of visible extinction, roughly the
 *   λ⁻¹ fall-off of soot extinction from 0.63 µm to 8–14 µm. Thermal is much less affected by smoke than
 *   visible light but not immune: nothing is seen beyond LWIR optical depth tauLimitLwir. Intact glass is
 *   opaque to LWIR and cuts it like a wall.
 * - Footprint: a depth image (imaging.ts) cut at the first surface (floors clipping from below) and where the
 *   person oracle below would no longer report a person in view at PERSON_DETECTION_CONFIDENCE
 *   (detectability.ts): along each ray, the first distance where 0.95 × contrast × clutter × MIN_BODY_SHARE ×
 *   range falls below it, or where LWIR optical depth passes tauLimitLwir. Contrast and clutter depend on the
 *   gas temperature and the fires around each point, so they enter as lower bounds over the ray from the camera
 *   outwards (thermalDetectableM): gas temperature sampled every ENV_STEP_M, a crossover between two samples
 *   counting as zero contrast, and clutter at the ray's closest approach to each fire. Near the thermal
 *   crossover (gas ≈ 63 °C) and beside large fires the footprint therefore shrinks to what the oracle could
 *   actually find.
 * - Person oracle (method "oracle_fixture"; personSearch "oracle_fixture" on person-search frames): a ray from
 *   the camera to sample points on each hidden occupant, within the FOV and reach and blocked by any active
 *   collider — walls, closed doors and intact glass (a broken pane's collider has been removed) — so it
 *   never sees through walls or intact windows. A sample point counts only while its LWIR optical depth is
 *   within tauLimitLwir, the limit that cuts the footprint, so a frame never reports a person where its own
 *   measurement no longer supports coverage. A raycast fixture, not detector accuracy.
 * - Confidence = 0.95 × contrast × clutter × visibility × range:
 *     contrast   = clamp(|skinC − T_bg| × LWIR transmission / fullContrastK, 0, 1), where the background
 *                  surfaces lag the gas: T_bg = ambient + surfaceLag·(gas − ambient) at that point (thermal
 *                  crossover when T_bg nears skin temperature, i.e. gas ≈ 63 °C with these constants);
 *     clutter    = 1 / (1 + Σ fires (Q / clutterReferenceKW)·(clutterRadiusM / max(d, clutterRadiusM))²),
 *                  d = distance to the fire region (heat clutter near fires: about ×0.55 right beside an
 *                  80 kW fire, ×0.83 one metre away);
 *     visibility = 0.5 + 0.5 × share of the occupant's sample points in view;
 *     range      = 1 − 0.5·(range / reach)².
 *   Below minConfidence nothing is reported (an honest miss). uncertaintyM = √(σ_pose² + σ_meas²) ×
 *   (2 − clutter), σ_meas = 0.1 m + 0.05·range (monocular ranging). The position is the sample point
 *   re-expressed from the estimated pose plus keyed noise of σ_meas.
 * - Quality: mean over the nx × ny measurement rays of contrast × clutter × range at each ray's end; a
 *   whole-frame figure (per-point detectability is the footprint's).
 * - Hazards: visible fires; heat when the hottest apparent gas temperature at a ray end reaches heatDetectC.
 * Occupant sample points: sampleHeights (detectability.ts).
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { distance, vec3 } from "../../contracts/frames.ts";
import { distanceToRegion, sphere } from "../../contracts/geometry.ts";
import type { Detection, Observation } from "../../contracts/observation.ts";
import { PERSON_DETECTION_CONFIDENCE } from "../../contracts/observation.ts";
import { FIRE_MODEL, fireExtent, opticalDepth, temperatureAt, visibilityAlong } from "../fire.ts";
import { keyedGaussian } from "../random.ts";
import type { FireTruth, OccupantTruth, WorldState } from "../world-state.ts";
import { bodyShare, detectableExtent, MIN_BODY_SHARE, sampleHeights } from "./detectability.ts";
import { fireDetection, inFieldOfView, sightFires } from "./hazards.ts";
import type { CameraRay, ImagingTrace } from "./imaging.ts";
import { depthFootprint, traceCamera } from "./imaging.ts";
import type { SenseContext } from "./observation.ts";
import { buildObservation, searchesForPeople } from "./observation.ts";
import { toEstimatedFrame } from "./pose.ts";
import { traceClear } from "./trace.ts";

export const THERMAL_MODEL = Object.freeze({
  nx: 8,
  ny: 6,
  /** Depth-image footprint cells across the image (rows follow from the aspect ratio). */
  footprintCols: 32,
  reachM: 15,
  smokeFactor: 0.08,
  tauLimitLwir: 2,
  fireTauLimitLwir: 4,
  personBaseConfidence: 0.95,
  skinC: 33,
  fullContrastK: 4,
  /** Background surfaces heat far more slowly than the gas in front of them. */
  surfaceLag: 0.3,
  clutterReferenceKW: 100,
  clutterRadiusM: 0.5,
  minConfidence: 0.05,
  heatDetectC: 50,
});

/** Spacing of the gas-temperature samples along a footprint ray (wider on rays longer than MAX_ENV_SAMPLES steps). */
export const ENV_STEP_M = 0.25;
const MAX_ENV_SAMPLES = 32;

export function thermalObservation(ctx: SenseContext, spec: SensorSpec): Observation {
  const tauLimit = THERMAL_MODEL.tauLimitLwir / THERMAL_MODEL.smokeFactor;
  const trace = traceCamera(ctx, spec, { nx: THERMAL_MODEL.nx, ny: THERMAL_MODEL.ny, reachM: THERMAL_MODEL.reachM, tauLimit });
  const quality = trace.centers.reduce((sum, ray) => sum + rayQuality(ctx.world, ray, trace.origin), 0) / trace.centers.length;
  const fires = sightFires(ctx, spec, trace.set, trace.origin, THERMAL_MODEL.reachM, THERMAL_MODEL.smokeFactor, THERMAL_MODEL.fireTauLimitLwir).map(sighting => fireDetection(ctx, sighting));
  const hazards = [...fires, ...heatDetection(ctx, trace)];
  if (!searchesForPeople(spec, ctx.tick)) return buildObservation(ctx, spec, { quality, footprint: null, personSearch: null, detections: hazards });
  const people = ctx.world.occupants.flatMap(occupant => sightPerson(ctx, spec, trace, occupant));
  const burning = burningFires(ctx.world);
  const footprint = depthFootprint(ctx, spec, trace.set, { cols: THERMAL_MODEL.footprintCols, reachM: THERMAL_MODEL.reachM, detectableM: (origin, dir, hitM) => thermalDetectableM(ctx.world, burning, origin, dir, hitM) });
  return buildObservation(ctx, spec, { quality, footprint, personSearch: "oracle_fixture", detections: [...people, ...hazards] });
}

function sightPerson(ctx: SenseContext, spec: SensorSpec, trace: ImagingTrace, occupant: OccupantTruth): Detection[] {
  const points = sampleHeights(occupant).map(h => vec3(occupant.position.x, occupant.position.y, occupant.position.z + h));
  const visible = points.filter(p => inFieldOfView(ctx, spec, p, THERMAL_MODEL.reachM) && traceClear(trace.set, trace.origin, p) && THERMAL_MODEL.smokeFactor * opticalDepth(ctx.world, trace.origin, p) <= THERMAL_MODEL.tauLimitLwir);
  if (visible.length === 0) return [];
  const target = visible[Math.floor(visible.length / 2)];
  const rangeM = distance(trace.origin, target);
  const transmission = Math.exp(-THERMAL_MODEL.smokeFactor * opticalDepth(ctx.world, trace.origin, target));
  const clutter = clutterFactor(ctx.world, target);
  const confidence = THERMAL_MODEL.personBaseConfidence * contrastFactor(temperatureAt(ctx.world, target), transmission) * clutter * bodyShare(visible.length, points.length) * rangeFactor(rangeM);
  if (confidence < THERMAL_MODEL.minConfidence) return [];
  const sigmaMeasM = 0.1 + 0.05 * rangeM;
  const noise = (axis: number) => sigmaMeasM * keyedGaussian(ctx.world.seed, `${spec.id}/person/${occupant.key}`, ctx.tick, axis);
  const p = toEstimatedFrame(ctx.truth, ctx.estimatePose, target);
  return [{
    kind: "possible_person",
    position: vec3(p.x + noise(0), p.y + noise(1), p.z + 0.5 * noise(2)),
    uncertaintyM: Math.hypot(ctx.estimate.sigmaM, sigmaMeasM) * (2 - clutter),
    confidence: Math.min(0.99, confidence),
    method: "oracle_fixture",
  }];
}

/** Apparent background temperature behind a person: the surfaces lag the gas (see the header). */
function backgroundC(gasC: number): number {
  return FIRE_MODEL.ambientC + THERMAL_MODEL.surfaceLag * (gasC - FIRE_MODEL.ambientC);
}

/** Contrast before smoke: |skin − background| / fullContrastK. */
function contrastScale(gasC: number): number {
  return Math.abs(THERMAL_MODEL.skinC - backgroundC(gasC)) / THERMAL_MODEL.fullContrastK;
}

function contrastFactor(gasC: number, transmission: number): number {
  return Math.max(0, Math.min(1, contrastScale(gasC) * transmission));
}

const ENDS = new Float64Array(MAX_ENV_SAMPLES);
const SCALE = new Float64Array(MAX_ENV_SAMPLES);
const CLUTTER = new Float64Array(MAX_ENV_SAMPLES);

/**
 * Detectable extent of one footprint ray (see the header). At distance d in piece k the oracle reports at least
 * the threshold when min(1, scale·T) ≥ q, T = exp(−smokeFactor·τ) and q = threshold / (0.95 × clutter ×
 * MIN_BODY_SHARE × range(d)): τ ≤ ln(scale / q) / smokeFactor, never beyond tauLimitLwir; q > 1 or scale 0
 * fails whatever the smoke. scale and clutter are lower bounds over the ray from the camera to the piece's far
 * end, so the budget only falls outwards:
 * - scale: the running minimum of the contrast scale at the gas-temperature samples, and 0 from the first pair
 *   of neighbouring samples whose background temperatures straddle skin temperature (the crossover lies between
 *   them, assuming the temperature varies monotonically from one sample to the next);
 * - clutter: from each burning fire's load at the point of the ray segment nearest its centre (exact for the
 *   spherical fire regions the fire model creates), summed over fires.
 */
function thermalDetectableM(world: WorldState, burning: readonly BurningFire[], origin: Vec3, dir: Vec3, hitM: number): number {
  const lwirLimit = THERMAL_MODEL.tauLimitLwir / THERMAL_MODEL.smokeFactor;
  const lwir = visibilityAlong(world, origin, dir, hitM, lwirLimit);
  const maxM = lwir.distanceM;
  if (!(maxM > 0)) return 0;
  const at = (s: number): Vec3 => vec3(origin.x + dir.x * s, origin.y + dir.y * s, origin.z + dir.z * s);
  const clutterUpTo = (s: number): number => {
    let load = 0;
    for (const { fire, center } of burning) {
      const nearestM = Math.max(0, (center.x - origin.x) * dir.x + (center.y - origin.y) * dir.y + (center.z - origin.z) * dir.z);
      load += clutterLoad(fire, at(Math.min(nearestM, s)));
    }
    return 1 / (1 + load);
  };
  const base = THERMAL_MODEL.personBaseConfidence * MIN_BODY_SHARE / PERSON_DETECTION_CONFIDENCE;
  const budget = (piece: number, d: number): number => {
    const q = 1 / (base * CLUTTER[piece] * rangeFactor(d));
    if (!(q <= 1) || !(SCALE[piece] > 0)) return -1;
    return Math.min(lwirLimit, Math.log(SCALE[piece] / q) / THERMAL_MODEL.smokeFactor);
  };
  const steps = Math.min(MAX_ENV_SAMPLES, Math.max(1, Math.ceil(maxM / ENV_STEP_M)));
  let previousC = temperatureAt(world, origin);
  let scale = contrastScale(previousC);
  let n = 0;
  while (n < steps) {
    const s = (maxM * (n + 1)) / steps;
    const gasC = temperatureAt(world, at(s));
    const straddles = (backgroundC(previousC) - THERMAL_MODEL.skinC) * (backgroundC(gasC) - THERMAL_MODEL.skinC) <= 0;
    scale = straddles ? 0 : Math.min(scale, contrastScale(gasC));
    previousC = gasC;
    ENDS[n] = s;
    SCALE[n] = scale;
    CLUTTER[n] = burning.length === 0 ? 1 : clutterUpTo(s);
    n += 1;
    // The bounds only fall outwards: once no point of a piece qualifies, no later one does.
    if (budget(n - 1, s) < 0) break;
  }
  // τ at the end is known exactly only when the LWIR limit did not cut the ray short (detectability.ts).
  return detectableExtent(world, origin, dir, { ends: ENDS.subarray(0, n), budget }, n === steps && maxM >= hitM ? lwir.tau : undefined);
}

interface BurningFire {
  readonly fire: FireTruth;
  readonly center: Vec3;
}

/** Fires that clutter the thermal image (burning, with heat release). */
function burningFires(world: WorldState): BurningFire[] {
  return world.fires.filter(fire => !fire.extinguished && fire.heatReleaseKW > 0).map(fire => ({ fire, center: fireExtent(fire.region).center }));
}

/** One burning fire's heat-clutter load at p (clutterFactor = 1 / (1 + Σ loads)). */
function clutterLoad(fire: FireTruth, p: Vec3): number {
  const near = THERMAL_MODEL.clutterRadiusM / Math.max(distanceToRegion(fire.region, p), THERMAL_MODEL.clutterRadiusM);
  return (fire.heatReleaseKW / THERMAL_MODEL.clutterReferenceKW) * near * near;
}

function clutterFactor(world: WorldState, p: Vec3): number {
  let load = 0;
  for (const { fire } of burningFires(world)) load += clutterLoad(fire, p);
  return 1 / (1 + load);
}

function rangeFactor(rangeM: number): number {
  return Math.max(0, 1 - 0.5 * (rangeM / THERMAL_MODEL.reachM) ** 2);
}

/** A point just short of the ray's end, so a wall hit samples the room air rather than the wall plane. */
function backgroundPoint(ray: CameraRay, origin: Vec3): Vec3 {
  const back = Math.max(0, ray.cutM - 0.05);
  return vec3(origin.x + ray.dir.x * back, origin.y + ray.dir.y * back, origin.z + ray.dir.z * back);
}

function rayQuality(world: WorldState, ray: CameraRay, origin: Vec3): number {
  const where = backgroundPoint(ray, origin);
  return contrastFactor(temperatureAt(world, where), Math.exp(-THERMAL_MODEL.smokeFactor * ray.tau)) * clutterFactor(world, where) * rangeFactor(ray.cutM);
}

function heatDetection(ctx: SenseContext, trace: ImagingTrace): Detection[] {
  let hottest: { readonly point: Vec3; readonly apparentC: number } | null = null;
  for (const ray of trace.centers) {
    const point = backgroundPoint(ray, trace.origin);
    const apparentC = FIRE_MODEL.ambientC + (temperatureAt(ctx.world, point) - FIRE_MODEL.ambientC) * Math.exp(-THERMAL_MODEL.smokeFactor * ray.tau);
    if (hottest === null || apparentC > hottest.apparentC) hottest = { point, apparentC };
  }
  if (hottest === null || hottest.apparentC < THERMAL_MODEL.heatDetectC) return [];
  const region = sphere(toEstimatedFrame(ctx.truth, ctx.estimatePose, hottest.point), 1 + ctx.estimate.sigmaM);
  return [{ kind: "hazard", hazard: "heat", region, intensity: hottest.apparentC }];
}
