/**
 * Simplified compartment fire and smoke model for the twin: a documented approximation, explicitly NOT a
 * validated fire solver (no CFD, no two-zone layer physics, no flashover, no spread between items or rooms).
 * All state lives in WorldState (compartments, fires, openings), so checkpoints and replays carry it.
 *
 * Compartments: each scene room is one well-mixed volume with a temperature and a visible-light smoke
 * extinction coefficient K (1/m). "exterior" is a fixed ambient boundary (room outflow is diluted to
 * nothing); smoke an experiment adds there clears with exteriorSmokeClearPerS. Point queries apply a fixed
 * linear vertical profile inside rooms (1 − s at the floor to 1 + s at the ceiling, s = stratification) to
 * K and to the temperature excess, a crude stand-in for the hot smoky upper layer.
 *
 * Each step (0.1 s):
 * 1. Heat release Q grows as a t² fire (√Q += √α·dt) toward cap = min(item peak, ventilation limit, fuel
 *    limit) and relaxes toward the cap (decayTauS) when above it. Item peak = peakHeatReleaseKWPerM2 × π r².
 *    Ventilation limit (Kawagoe) = ventilationKWPerM52 × (leakage A√H + Σ A√H of the fire room's openings
 *    with open area; interior openings at interiorVentilationWeight). Fuel limit = 1000·fuelMJ / burnoutTauS;
 *    fuel burns at Q·dt and an exhausted fire is extinguished. A broken window therefore feeds a
 *    ventilation-limited fire as well as venting smoke.
 * 2. Sources into the fire room: convective heat χ·Q·dt / (ρc·V); soot K += σ·y·(Q/ΔH)·dt / V.
 * 3. Losses: lining heat loss h·A (exact exponential toward ambient) and soot deposition.
 * 4. Exchange through every opening with open area A: q = A·(v0 + C·√(g·H·|ΔT|/T)), applied as the exact
 *    two-volume relaxation of T and K (conserves V·T and V·K, cannot overshoot). Closed doors and intact
 *    glass have zero open area, so smoke never crosses them; each room also leaks a little to the exterior.
 *
 * Suppression rule (dose-limited): each litre that actually reaches the burning region removes
 * suppressionKWPerL of heat release; below extinguishBelowKW the fire is out for good, otherwise it regrows.
 * Water travels along straight jet rays spread over the spray sector and counts only where a ray enters the
 * fire region before any active collider (walls, intact glass and closed doors stop it). Example: an 80 kW
 * fire needs 0.4 L delivered to the fire (2 s of a 0.2 L/s nozzle if every ray lands), so a 1 L tank
 * suppresses the small scenario fire only when enough of the jet reaches it.
 */
import type { Tick } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, horizontalDistance, vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { regionBounds, regionContains, samplePoints, sphere } from "../contracts/geometry.ts";
import { raycast } from "./raycast.ts";
import { roomGeometry, roomIndexAt, segmentIntervals } from "./sensors/medium.ts";
import { coneDirections, rayChord, rayRegionEntry, segmentChordLength } from "./sensors/shapes.ts";
import type { CompartmentTruth, FireTruth, OpeningTruth, RuntimeOpening, RuntimeRoom, ScenarioConfig, SceneModel, WorldState } from "./world-state.ts";
import { activeColliders } from "./world-state.ts";

export const EXTERIOR = "exterior";

/** Every constant of the model, for disclosure. Values are engineering assumptions, not calibrated data. */
export const FIRE_MODEL = Object.freeze({
  ambientC: 20,
  /** ρ·c_p of air, kJ/(m³·K). */
  airHeatCapacityKJPerM3K: 1.2,
  convectiveFraction: 0.7,
  /** Effective early-time lining loss (conduction into gypsum plus radiation), kW/(m²·K). */
  liningLossKWPerM2K: 0.03,
  /** Soot yield (g/g) of mixed residential furnishings; wood ≈ 0.015, polyurethane ≈ 0.1. */
  sootYield: 0.05,
  heatOfCombustionKJPerG: 20,
  /** Mass-specific extinction of flaming soot at visible wavelengths (Mulholland & Croarkin 2000). */
  massExtinctionM2PerG: 8.7,
  depositionPerS: 0.002,
  exteriorSmokeClearPerS: 0.1,
  /** Opening exchange q = A·(v0 + C·√(g·H·|ΔT|/T)). */
  openingBaseVelocityMps: 0.1,
  openingBuoyancyCoefficient: 0.2,
  leakageAreaM2: 0.02,
  leakageHeightM: 1,
  /** Kawagoe ventilation limit: ≈0.5·A√H kg/s of air × 3 MJ per kg of air. */
  ventilationKWPerM52: 1500,
  interiorVentilationWeight: 0.5,
  peakHeatReleaseKWPerM2: 400,
  /** NFPA "medium" t² growth coefficient. */
  growthAlphaKWPerS2: 0.0117,
  decayTauS: 10,
  burnoutTauS: 30,
  burnedOutBelowMJ: 0.01,
  /**
   * DEMO TUNING (was 200): heat release removed per litre that reaches the flame. About a quarter of a jet reaches
   * a 0.15 m fire from a 1.4–1.6 m standoff, so at 200 kW/L the ~28 kW hall fire took two or three 0.3 L sprays;
   * at 2000 kW/L about 0.012 L reaching it (well under half of one 1 s, 0.2 L spray) puts it out.
   */
  suppressionKWPerL: 2000,
  extinguishBelowKW: 5,
  flameTemperatureC: 800,
  flameExtinctionPerM: 1,
  stratification: 0.5,
  /** Heskestad plume centreline ΔT₀ = 25·Qc^(2/3)·h^(−5/3) (K, kW, m). */
  plumeCoefficient: 25,
  sprayRays: 61,
});

const EXTERIOR_VOLUME_M3 = 1e9;
const G = 9.81;

export function initFireState(scene: SceneModel, scenario: ScenarioConfig, openings: readonly OpeningTruth[]): { compartments: CompartmentTruth[]; fires: FireTruth[] } {
  const compartments: CompartmentTruth[] = roomGeometry(scene).map(g => ({ id: g.room.id, volumeM3: g.volumeM3, temperatureC: FIRE_MODEL.ambientC, smokeExtinctionPerM: 0 }));
  compartments.push({ id: EXTERIOR, volumeM3: EXTERIOR_VOLUME_M3, temperatureC: FIRE_MODEL.ambientC, smokeExtinctionPerM: 0 });
  const spec = scenario.fire;
  if (spec === null) return { compartments, fires: [] };
  if (!scene.rooms.some(room => room.id === spec.roomId)) throw new RangeError(`Fire room ${spec.roomId} is not in the scene`);
  const region = sphere(spec.origin, spec.radiusM);
  const cap = Math.min(peakHeatReleaseKW(region), ventilationLimitKW(scene, openings, spec.roomId));
  const burning = spec.initialHeatReleaseKW > 0 && spec.fuelMJ > 0;
  const fire: FireTruth = { id: `fire-${spec.roomId}`, roomId: spec.roomId, region, heatReleaseKW: burning ? Math.min(spec.initialHeatReleaseKW, cap) : 0, fuelMJ: Math.max(0, spec.fuelMJ), waterDeliveredL: 0, extinguished: !burning };
  return { compartments, fires: [fire] };
}

export function stepFire(world: WorldState, dtS: number): void {
  if (!(dtS > 0)) return;
  for (const fire of world.fires) stepOneFire(world, fire, dtS);
  for (const fire of world.fires) addFireProducts(world, fire, dtS);
  for (const g of roomGeometry(world.scene)) {
    const compartment = roomCompartment(world, g.index);
    if (compartment) relaxRoom(compartment, g.liningM2, dtS);
  }
  exchangeThroughOpenings(world, dtS);
  const exterior = exteriorCompartment(world);
  if (exterior) exterior.smokeExtinctionPerM *= Math.exp(-FIRE_MODEL.exteriorSmokeClearPerS * dtS);
}

export function deliverWater(world: WorldState, sprayRegion: Region, volumeL: number, tick: Tick): number {
  if (!(volumeL > 0)) return 0;
  const burning = world.fires.filter(fire => !fire.extinguished);
  if (burning.length === 0) return 0;
  const shares = sprayRegion.kind === "sector" ? jetShares(world, sprayRegion, burning) : volumeShares(sprayRegion, burning);
  let reached = 0;
  burning.forEach((fire, index) => {
    const litres = volumeL * shares[index];
    if (!(litres > 0)) return;
    reached += litres;
    applyWater(world, fire, litres, tick);
  });
  return reached;
}

export function extinctionAt(world: WorldState, p: Vec3): number {
  let k = intervalExtinction(world, roomIndexAt(world.scene, p), p.z);
  for (const fire of world.fires) if (!fire.extinguished && regionContains(fire.region, p)) k += FIRE_MODEL.flameExtinctionPerM;
  return k;
}

export function opticalDepth(world: WorldState, a: Vec3, b: Vec3): number {
  const length = distance(a, b);
  if (length < 1e-9) return 0;
  return mediumSpans(world, a, b, length).reduce((tau, span) => tau + span.k * (span.s1 - span.s0), 0);
}

/**
 * Optical depth along a unit ray up to maxDistanceM, stopping where it reaches tauLimit. Sensors use the
 * stopping distance as the range their measurement supports in smoke.
 */
export function visibilityAlong(world: WorldState, origin: Vec3, dir: Vec3, maxDistanceM: number, tauLimit = Infinity): { readonly distanceM: number; readonly tau: number } {
  if (!(maxDistanceM > 0)) return { distanceM: 0, tau: 0 };
  const end = vec3(origin.x + dir.x * maxDistanceM, origin.y + dir.y * maxDistanceM, origin.z + dir.z * maxDistanceM);
  let tau = 0;
  for (const span of mediumSpans(world, origin, end, maxDistanceM)) {
    const step = span.k * (span.s1 - span.s0);
    if (span.k > 0 && tau + step >= tauLimit) return { distanceM: span.s0 + (tauLimit - tau) / span.k, tau: tauLimit };
    tau += step;
  }
  return { distanceM: maxDistanceM, tau };
}

export function fireBlocks(world: WorldState, a: Vec3, b: Vec3): boolean {
  return world.fires.some(fire => !fire.extinguished && (regionContains(fire.region, a) || segmentChordLength(fire.region, a, b) > 1e-9));
}

/** Experiment hook: add (or, with a negative value, remove) smoke in a compartment; K never drops below 0. */
export function addSmoke(world: WorldState, roomId: string, extinctionPerM: number): void {
  const compartment = compartmentById(world, roomId);
  if (!compartment) throw new RangeError(`Unknown compartment ${roomId}`);
  if (!Number.isFinite(extinctionPerM)) throw new RangeError(`Smoke change must be finite, got ${extinctionPerM}`);
  compartment.smokeExtinctionPerM = Math.max(0, compartment.smokeExtinctionPerM + extinctionPerM);
}

/** Gas temperature: room value on the vertical profile, plus the fire's flame and plume in its own room. */
export function temperatureAt(world: WorldState, p: Vec3): number {
  const index = roomIndexAt(world.scene, p);
  if (index < 0) return exteriorCompartment(world)?.temperatureC ?? FIRE_MODEL.ambientC;
  const room = world.scene.rooms[index];
  const compartment = roomCompartment(world, index);
  const gas = compartment ? FIRE_MODEL.ambientC + (compartment.temperatureC - FIRE_MODEL.ambientC) * profileFactor(room, p.z) : FIRE_MODEL.ambientC;
  let excess = 0;
  for (const fire of world.fires) if (!fire.extinguished && fire.roomId === room.id) excess += plumeExcessC(fire, p);
  return Math.min(gas + excess, Math.max(gas, FIRE_MODEL.flameTemperatureC));
}

/* Fire dynamics. */

function stepOneFire(world: WorldState, fire: FireTruth, dtS: number): void {
  if (fire.extinguished) return;
  const cap = Math.min(peakHeatReleaseKW(fire.region), ventilationLimitKW(world.scene, world.openings, fire.roomId), (1000 * fire.fuelMJ) / FIRE_MODEL.burnoutTauS);
  const q = fire.heatReleaseKW;
  fire.heatReleaseKW = q < cap ? Math.min(cap, (Math.sqrt(q) + Math.sqrt(FIRE_MODEL.growthAlphaKWPerS2) * dtS) ** 2) : cap + (q - cap) * Math.exp(-dtS / FIRE_MODEL.decayTauS);
  fire.fuelMJ = Math.max(0, fire.fuelMJ - (fire.heatReleaseKW * dtS) / 1000);
  if (fire.fuelMJ > FIRE_MODEL.burnedOutBelowMJ) return;
  fire.heatReleaseKW = 0;
  fire.extinguished = true;
}

function addFireProducts(world: WorldState, fire: FireTruth, dtS: number): void {
  if (fire.extinguished || !(fire.heatReleaseKW > 0)) return;
  const room = compartmentById(world, fire.roomId);
  if (!room) return;
  room.temperatureC += (FIRE_MODEL.convectiveFraction * fire.heatReleaseKW * dtS) / (FIRE_MODEL.airHeatCapacityKJPerM3K * room.volumeM3);
  const sootGPerS = (FIRE_MODEL.sootYield * fire.heatReleaseKW) / FIRE_MODEL.heatOfCombustionKJPerG;
  room.smokeExtinctionPerM += (FIRE_MODEL.massExtinctionM2PerG * sootGPerS * dtS) / room.volumeM3;
}

function relaxRoom(room: CompartmentTruth, liningM2: number, dtS: number): void {
  const lossRate = (FIRE_MODEL.liningLossKWPerM2K * liningM2) / (FIRE_MODEL.airHeatCapacityKJPerM3K * room.volumeM3);
  room.temperatureC = FIRE_MODEL.ambientC + (room.temperatureC - FIRE_MODEL.ambientC) * Math.exp(-lossRate * dtS);
  room.smokeExtinctionPerM *= Math.exp(-FIRE_MODEL.depositionPerS * dtS);
}

function exchangeThroughOpenings(world: WorldState, dtS: number): void {
  const geometry = openingGeometry(world.scene);
  for (const opening of world.openings) {
    const g = opening.openAreaM2 > 0 ? geometry.get(opening.id) : undefined;
    const a = g ? compartmentById(world, g.rooms[0]) : undefined;
    const b = g ? compartmentById(world, g.rooms[1]) : undefined;
    if (g && a && b) exchange(a, b, opening.openAreaM2, Math.max(g.heightM, 0.1), dtS);
  }
  const exterior = exteriorCompartment(world);
  if (!exterior) return;
  for (const g of roomGeometry(world.scene)) {
    const room = roomCompartment(world, g.index);
    if (room) exchange(room, exterior, FIRE_MODEL.leakageAreaM2, FIRE_MODEL.leakageHeightM, dtS);
  }
}

function exchange(a: CompartmentTruth, b: CompartmentTruth, areaM2: number, heightM: number, dtS: number): void {
  const meanK = 273.15 + (a.temperatureC + b.temperatureC) / 2;
  const buoyancy = Math.sqrt((G * heightM * Math.abs(a.temperatureC - b.temperatureC)) / meanK);
  const flowM3s = areaM2 * (FIRE_MODEL.openingBaseVelocityMps + FIRE_MODEL.openingBuoyancyCoefficient * buoyancy);
  if (a.id === EXTERIOR) relaxToward(b, a, flowM3s, dtS);
  else if (b.id === EXTERIOR) relaxToward(a, b, flowM3s, dtS);
  else relaxPair(a, b, flowM3s, dtS);
}

function relaxToward(room: CompartmentTruth, boundary: CompartmentTruth, flowM3s: number, dtS: number): void {
  const f = Math.exp(-(flowM3s * dtS) / room.volumeM3);
  room.temperatureC = boundary.temperatureC + (room.temperatureC - boundary.temperatureC) * f;
  room.smokeExtinctionPerM = boundary.smokeExtinctionPerM + (room.smokeExtinctionPerM - boundary.smokeExtinctionPerM) * f;
}

function relaxPair(a: CompartmentTruth, b: CompartmentTruth, flowM3s: number, dtS: number): void {
  const f = Math.exp(-flowM3s * dtS * (1 / a.volumeM3 + 1 / b.volumeM3));
  const total = a.volumeM3 + b.volumeM3;
  const meanT = (a.volumeM3 * a.temperatureC + b.volumeM3 * b.temperatureC) / total;
  const meanK = (a.volumeM3 * a.smokeExtinctionPerM + b.volumeM3 * b.smokeExtinctionPerM) / total;
  a.temperatureC = meanT + (a.temperatureC - meanT) * f;
  b.temperatureC = meanT + (b.temperatureC - meanT) * f;
  a.smokeExtinctionPerM = meanK + (a.smokeExtinctionPerM - meanK) * f;
  b.smokeExtinctionPerM = meanK + (b.smokeExtinctionPerM - meanK) * f;
}

function ventilationLimitKW(scene: SceneModel, openings: readonly OpeningTruth[], roomId: string): number {
  const geometry = openingGeometry(scene);
  let factor = FIRE_MODEL.leakageAreaM2 * Math.sqrt(FIRE_MODEL.leakageHeightM);
  for (const opening of openings) {
    const g = opening.openAreaM2 > 0 ? geometry.get(opening.id) : undefined;
    if (!g || !g.rooms.includes(roomId)) continue;
    const weight = g.rooms.includes(EXTERIOR) ? 1 : FIRE_MODEL.interiorVentilationWeight;
    factor += weight * opening.openAreaM2 * Math.sqrt(Math.max(g.heightM, 0.1));
  }
  return FIRE_MODEL.ventilationKWPerM52 * factor;
}

function peakHeatReleaseKW(region: Region): number {
  return FIRE_MODEL.peakHeatReleaseKWPerM2 * Math.PI * fireExtent(region).radiusM ** 2;
}

/* Water. */

function jetShares(world: WorldState, spray: Extract<Region, { kind: "sector" }>, burning: readonly FireTruth[]): number[] {
  const colliders = activeColliders(world);
  const counts = burning.map(() => 0);
  const rays = coneDirections(spray.axis, spray.halfAngleRad, FIRE_MODEL.sprayRays);
  for (const dir of rays) {
    const hit = raycast(colliders, spray.apex, dir, spray.rangeM);
    const limit = hit === null ? spray.rangeM : hit.distanceM + 1e-6;
    let best = -1;
    let bestDistance = Infinity;
    burning.forEach((fire, index) => {
      const t = rayRegionEntry(fire.region, spray.apex, dir, spray.rangeM);
      if (t !== null && t <= limit && t < bestDistance) [best, bestDistance] = [index, t];
    });
    if (best >= 0) counts[best] += 1;
  }
  return counts.map(count => count / rays.length);
}

function volumeShares(region: Region, burning: readonly FireTruth[]): number[] {
  const points = samplePoints(region, 0.1, 0, 2000);
  const counts = burning.map(() => 0);
  for (const p of points) {
    const index = burning.findIndex(fire => regionContains(fire.region, p));
    if (index >= 0) counts[index] += 1;
  }
  return counts.map(count => count / points.length);
}

function applyWater(world: WorldState, fire: FireTruth, litres: number, tick: Tick): void {
  fire.waterDeliveredL += litres;
  fire.heatReleaseKW = Math.max(0, fire.heatReleaseKW - FIRE_MODEL.suppressionKWPerL * litres);
  if (fire.heatReleaseKW >= FIRE_MODEL.extinguishBelowKW) return;
  fire.heatReleaseKW = 0;
  fire.extinguished = true;
  world.truthEvents.push({ tick, kind: "fire_extinguished", detail: `${fire.id} extinguished after ${fire.waterDeliveredL.toFixed(3)} L reached it`, data: { fireId: fire.id, waterDeliveredL: fire.waterDeliveredL } });
}

/* Field queries. */

interface Span {
  readonly s0: number;
  readonly s1: number;
  readonly k: number;
}

function mediumSpans(world: WorldState, a: Vec3, b: Vec3, length: number): Span[] {
  const spans = segmentIntervals(world.scene, a, b).map(iv => ({ s0: iv.t0 * length, s1: iv.t1 * length, k: intervalExtinction(world, iv.room, a.z + (b.z - a.z) * ((iv.t0 + iv.t1) / 2)) }));
  const dir = vec3((b.x - a.x) / length, (b.y - a.y) / length, (b.z - a.z) / length);
  const chords = world.fires.flatMap(fire => {
    const chord = fire.extinguished ? null : rayChord(fire.region, a, dir, length);
    return chord !== null && chord[1] > chord[0] ? [chord] : [];
  });
  return chords.length === 0 ? spans : spans.flatMap(span => splitSpan(span, chords));
}

function splitSpan(span: Span, chords: readonly (readonly [number, number])[]): Span[] {
  const cuts = [span.s0, span.s1, ...chords.flat().filter(s => s > span.s0 && s < span.s1)].sort((p, q) => p - q);
  const out: Span[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const mid = (cuts[i] + cuts[i + 1]) / 2;
    const flames = chords.filter(([c0, c1]) => mid >= c0 && mid <= c1).length;
    out.push({ s0: cuts[i], s1: cuts[i + 1], k: span.k + flames * FIRE_MODEL.flameExtinctionPerM });
  }
  return out;
}

function intervalExtinction(world: WorldState, roomIndex: number, z: number): number {
  if (roomIndex < 0) return exteriorCompartment(world)?.smokeExtinctionPerM ?? 0;
  const compartment = roomCompartment(world, roomIndex);
  return compartment ? compartment.smokeExtinctionPerM * profileFactor(world.scene.rooms[roomIndex], z) : 0;
}

function profileFactor(room: RuntimeRoom, z: number): number {
  const half = (room.zMax - room.zMin) / 2;
  if (!(half > 0)) return 1;
  return 1 + FIRE_MODEL.stratification * Math.max(-1, Math.min(1, (z - room.zMin - half) / half));
}

function plumeExcessC(fire: FireTruth, p: Vec3): number {
  const flameExcess = FIRE_MODEL.flameTemperatureC - FIRE_MODEL.ambientC;
  if (regionContains(fire.region, p)) return flameExcess;
  const q = fire.heatReleaseKW;
  const { center, radiusM } = fireExtent(fire.region);
  const h = p.z - (center.z - radiusM);
  if (!(q > 0) || h <= 0) return 0;
  const flameHeightM = Math.max(0, 0.235 * q ** 0.4 - 2.04 * radiusM);
  const plume = FIRE_MODEL.plumeCoefficient * (FIRE_MODEL.convectiveFraction * q) ** (2 / 3) * h ** (-5 / 3);
  const centerline = h <= flameHeightM ? flameExcess : Math.min(flameExcess, plume);
  const widthM = radiusM + 0.15 * h;
  return centerline * Math.exp(-((horizontalDistance(p, center) / widthM) ** 2));
}

/** Centre and horizontal radius of a fire region (exact for the spheres this model creates). */
export function fireExtent(region: Region): { readonly center: Vec3; readonly radiusM: number } {
  if (region.kind === "sphere") return { center: region.center, radiusM: region.radiusM };
  const b = regionBounds(region);
  const center = vec3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
  return { center, radiusM: Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2 };
}

/* Lookups. Compartments are created in scene-room order with the exterior last; fall back to a search. */

function roomCompartment(world: WorldState, roomIndex: number): CompartmentTruth | undefined {
  const id = world.scene.rooms[roomIndex].id;
  const direct = world.compartments[roomIndex];
  return direct !== undefined && direct.id === id ? direct : compartmentById(world, id);
}

function exteriorCompartment(world: WorldState): CompartmentTruth | undefined {
  const last = world.compartments[world.compartments.length - 1];
  return last !== undefined && last.id === EXTERIOR ? last : compartmentById(world, EXTERIOR);
}

function compartmentById(world: WorldState, id: string): CompartmentTruth | undefined {
  return world.compartments.find(compartment => compartment.id === id);
}

const openingCache = new WeakMap<SceneModel, ReadonlyMap<string, RuntimeOpening>>();

function openingGeometry(scene: SceneModel): ReadonlyMap<string, RuntimeOpening> {
  let map = openingCache.get(scene);
  if (!map) {
    map = new Map(scene.openings.map(opening => [opening.id, opening]));
    openingCache.set(scene, map);
  }
  return map;
}
