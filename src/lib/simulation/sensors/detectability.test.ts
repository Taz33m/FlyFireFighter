/*
 * Person-search footprints claim only what the person oracle would find (detectability.ts): a contained point is
 * one where a person in view would be reported at PERSON_DETECTION_CONFIDENCE or more. Scope: rgb-front, rgb-down
 * and thermal-front on the two-room fixture (environment-fixtures.ts) with smoke, heat, fires, range, glass and
 * partly hidden occupants, judged against the oracles themselves (hidden occupants placed in the world), not
 * against a re-implementation of the confidence formulas. Footprints are re-expressed at the TRUE camera pose:
 * these tests judge the measurement, not localization jitter.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { DepthImageRegion } from "../../contracts/geometry.ts";
import { regionContains } from "../../contracts/geometry.ts";
import type { Observation } from "../../contracts/observation.ts";
import { PERSON_DETECTION_CONFIDENCE } from "../../contracts/observation.ts";
import type { FixtureOptions } from "../environment-fixtures.ts";
import { fixtureWorld, setOpening } from "../environment-fixtures.ts";
import { addSmoke, FIRE_MODEL, opticalDepth, temperatureAt } from "../fire.ts";
import { keyedUniform } from "../random.ts";
import type { OccupantTruth, WorldState } from "../world-state.ts";
import { MIN_BODY_SHARE, sampleHeights } from "./detectability.ts";
import { senseTick } from "./index.ts";
import { cameraFrame, inPinholeView, sensorOrigin, truePose } from "./pose.ts";
import { RGB_MODEL, visibleThrough } from "./rgb.ts";
import { THERMAL_MODEL } from "./thermal.ts";
import { traceClear, traceSet } from "./trace.ts";

const CAMERAS = ["rgb-front", "rgb-down", "thermal-front"] as const;
const spec = (id: string) => TENDER_T1.sensors.find(sensor => sensor.id === id)!;
const reach = (id: string) => (id.startsWith("rgb") ? RGB_MODEL.reachM : THERMAL_MODEL.reachM);

function frames(world: WorldState): Map<string, Observation & { readonly footprint: DepthImageRegion }> {
  const out = new Map<string, Observation & { readonly footprint: DepthImageRegion }>();
  for (const o of senseTick(world).observations) if (o.personSearch !== null && o.footprint?.kind === "depth_image") out.set(o.sensorId, { ...o, footprint: inTruthFrame(world, o.sensorId, o.footprint) });
  return out;
}

function inTruthFrame(world: WorldState, sensorId: string, r: DepthImageRegion): DepthImageRegion {
  const truth = cameraFrame(truePose(world), spec(sensorId));
  const dz = r.apex.z - truth.origin.z;
  return { ...r, apex: truth.origin, forward: truth.forward, up: truth.up, floorZM: r.floorZM.map(z => (z === null ? null : z - dz)) };
}

function bodyPoints(occupant: OccupantTruth): Vec3[] {
  return sampleHeights(occupant).map(h => vec3(occupant.position.x, occupant.position.y, occupant.position.z + h));
}

/** Body points the camera has in view: inside its frustum and reach, in line of sight (RGB passes intact glass). */
function inView(world: WorldState, sensorId: string, points: readonly Vec3[]): Vec3[] {
  const origin = sensorOrigin(truePose(world), spec(sensorId));
  const set = traceSet(world, origin, reach(sensorId));
  return points.filter(p => inPinholeView(truePose(world), spec(sensorId), p, reach(sensorId)) && traceClear(set, origin, p, sensorId.startsWith("rgb") ? visibleThrough : undefined));
}

const personConfidence = (o: Observation): number => Math.max(0, ...o.detections.flatMap(d => (d.kind === "possible_person" ? [d.confidence] : [])));

function setGas(world: WorldState, roomId: string, temperatureC: number): void {
  const compartment = world.compartments.find(c => c.id === roomId);
  assert.ok(compartment, roomId);
  compartment.temperatureC = temperatureC;
}

interface Trial {
  readonly world: WorldState;
  readonly outside: boolean;
  readonly hot: boolean;
  readonly label: string;
}

const TEMPERATURES = [20, 35, 50, 58, 63, 66, 69, 72, 80, 120];

/**
 * A keyed random scene on the two-room fixture: the aircraft in room-a (or outside win-a, looking in through the
 * pane), smoke up to 2.5 /m, gas from ambient through the thermal crossover to 120 °C, sometimes a 30–300 kW fire,
 * and one standing, crouching or lying occupant anywhere in room-a.
 */
function propertyTrial(i: number): Trial {
  const u = (stream: string) => keyedUniform("detectability-property", stream, i);
  const outside = u("outside") < 0.2;
  const drone: FixtureOptions["drone"] = outside
    ? { position: vec3(-2.5 + 1.9 * u("dx"), 1.7 + 0.6 * u("dy"), 1.3 + 0.6 * u("dz")), yawRad: -0.25 + 0.5 * u("yaw") }
    : { position: vec3(0.3 + 1.3 * u("dx"), 0.6 + 2.8 * u("dy"), 0.5 + 1.3 * u("dz")), yawRad: -0.7 + 1.4 * u("yaw") };
  const burning = u("fire") < 0.4;
  const fire: FixtureOptions["fire"] = burning ? { roomId: "room-a", origin: vec3(3.4, 3.3, 0.3), radiusM: 0.25, initialHeatReleaseKW: 30, fuelMJ: 60 } : undefined;
  const world = fixtureWorld({ drone, fire, occupants: [{ key: "p", position: vec3(0.2 + 3.7 * u("ox"), 0.2 + 3.6 * u("oy"), 0), animation: u("pose") < 0.5 ? "idle" : "crouch" }] });
  // The closed fixture room caps a fire's initial heat release by ventilation; set it directly.
  if (burning) world.fires[0].heatReleaseKW = 30 + 270 * u("q");
  if (u("lying") < 0.25) world.occupants[0].activity = "incapacitated";
  const smokePerM = 2.5 * u("smoke") ** 2;
  addSmoke(world, "room-a", smokePerM);
  const gasC = TEMPERATURES[Math.floor(u("gas") * TEMPERATURES.length)];
  setGas(world, "room-a", gasC);
  const label = `smoke ${smokePerM.toFixed(2)}/m, gas ${gasC} °C, fire ${burning ? world.fires[0].heatReleaseKW.toFixed(0) : "none"} kW`;
  return { world, outside, hot: gasC >= 50 || burning, label };
}

interface CoverStats {
  covered: number;
  partial: number;
  smoky: number;
  glass: number;
  hot: number;
  minRatio: number;
}

function record(stats: Map<string, CoverStats>, id: string, trial: Trial, visible: readonly Vec3[], bodySamples: number, confidence: number): void {
  const s = stats.get(id) ?? { covered: 0, partial: 0, smoky: 0, glass: 0, hot: 0, minRatio: Infinity };
  stats.set(id, s);
  const origin = sensorOrigin(truePose(trial.world), spec(id));
  s.covered += 1;
  if (visible.length < bodySamples) s.partial += 1;
  if (visible.some(p => opticalDepth(trial.world, origin, p) > 0.5)) s.smoky += 1;
  if (trial.outside && id.startsWith("rgb")) s.glass += 1;
  if (trial.hot) s.hot += 1;
  s.minRatio = Math.min(s.minRatio, confidence / PERSON_DETECTION_CONFIDENCE);
}

describe("a person-search footprint holds only points where a person in view would be detected", () => {
  test("property: an occupant whose every body point in view lies in the footprint is reported at or above the threshold", () => {
    const stats = new Map<string, CoverStats>();
    const violations: string[] = [];
    for (let i = 0; i < 360; i++) {
      const trial = propertyTrial(i);
      const points = bodyPoints(trial.world.occupants[0]);
      for (const [id, o] of frames(trial.world)) {
        const visible = inView(trial.world, id, points);
        if (visible.length === 0 || !visible.every(p => regionContains(o.footprint, p))) continue;
        const confidence = personConfidence(o);
        record(stats, id, trial, visible, points.length, confidence);
        if (confidence < PERSON_DETECTION_CONFIDENCE) violations.push(`trial ${i} ${id}: confidence ${confidence.toFixed(3)} (${trial.label}, ${visible.length}/${points.length} body points in view)`);
      }
    }
    console.log(`detectability property: ${JSON.stringify(Object.fromEntries([...stats].map(([id, s]) => [id, { ...s, minRatio: Number(s.minRatio.toFixed(3)) }])))}`);
    assert.deepEqual(violations, []);
    // The property must not hold vacuously: every camera covers occupants, partly hidden ones, ones in smoke and in heat.
    for (const id of CAMERAS) {
      const s = stats.get(id);
      assert.ok(s && s.covered >= 20 && s.partial >= 5, `${id}: ${JSON.stringify(s)}`);
    }
    for (const id of ["rgb-front", "thermal-front"]) assert.ok(stats.get(id)!.smoky >= 10 && stats.get(id)!.hot >= 10, `${id}: ${JSON.stringify(stats.get(id))}`);
    assert.ok(stats.get("rgb-front")!.glass >= 5, `rgb-front through glass: ${JSON.stringify(stats.get("rgb-front"))}`);
  });

  test("in moderate smoke the near field stays covered while the far field is cut where the oracle would miss", () => {
    // Low in room-a, level with a crouching or lying person, looking east across the room to the shared wall.
    const view: FixtureOptions["drone"] = { position: vec3(0.5, 2, 0.6), yawRad: 0 };
    const near = [vec3(1.5, 2, 0.3), vec3(1.5, 2, 0.6), vec3(1.6, 1.8, 0.45), vec3(1.6, 2.2, 0.45)];
    const far = [vec3(3.7, 2, 0.4), vec3(3.7, 2.3, 0.6)];
    const smoky = fixtureWorld({ drone: view });
    addSmoke(smoky, "room-a", 0.8);
    const origin = sensorOrigin(truePose(smoky), spec("rgb-front"));
    const rgb = frames(smoky).get("rgb-front")!;
    assert.ok(far.every(p => opticalDepth(smoky, origin, p) < RGB_MODEL.tauLimit), "precondition: the far points lie within the old τ = 3 cut, which claimed them");
    assert.ok(rgb.quality < 0.6, `precondition: a frame the old 0.6 quality bar discarded whole (quality ${rgb.quality.toFixed(2)})`);
    assert.deepEqual(near.map(p => regionContains(rgb.footprint, p)), near.map(() => true), "the clear near field is covered");
    assert.deepEqual(far.map(p => regionContains(rgb.footprint, p)), far.map(() => false), "the obscured far field is not");
    // The oracle agrees: a crouching person near the camera is found above the threshold, one by the far wall is not.
    const at = (x: number) => {
      const world = fixtureWorld({ drone: view, occupants: [{ key: "p", position: vec3(x, 2, 0), animation: "crouch" }] });
      addSmoke(world, "room-a", 0.8);
      return personConfidence(frames(world).get("rgb-front")!);
    };
    assert.ok(at(1.5) >= PERSON_DETECTION_CONFIDENCE, `near person reported at ${at(1.5).toFixed(3)}`);
    assert.ok(at(3.7) < PERSON_DETECTION_CONFIDENCE, `far person reported at ${at(3.7).toFixed(3)}`);
  });

  test("in clear air the cameras' footprints still reach the far wall", () => {
    const rgb = frames(fixtureWorld({ drone: { position: vec3(0.5, 2, 1.2), yawRad: 0 } }));
    for (const id of ["rgb-front", "thermal-front"]) assert.ok(regionContains(rgb.get(id)!.footprint, vec3(3.9, 2, 1.0)), `${id} covers the far side of room-a`);
  });

  test("glass lowers the RGB budget past the pane by its own factor and cuts nothing else; thermal stops at the pane", () => {
    // Outside win-a looking in, room-a smoky. Along the ray through the centre of the depth-image cell just below
    // the optical axis, the footprint ends where the oracle's confidence for a person in view (least body share),
    // 0.9·exp(−τ)·glass·share·range, reaches the threshold for the cell's binding ray.
    const view: FixtureOptions["drone"] = { position: vec3(-1.2, 2, 1.5), yawRad: 0 };
    const cutInCell = (world: WorldState, footprint: DepthImageRegion): number => {
      const camera = cameraFrame(truePose(world), spec("rgb-front"));
      const x = -Math.tan(footprint.hfovRad / 2) / footprint.cols;
      const y = -Math.tan(footprint.vfovRad / 2) / footprint.rows;
      const ray = vec3(camera.forward.x + camera.left.x * x + camera.up.x * y, camera.forward.y + camera.left.y * x + camera.up.y * y, camera.forward.z + camera.left.z * x + camera.up.z * y);
      const length = Math.hypot(ray.x, ray.y, ray.z);
      const point = (d: number) => vec3(camera.origin.x + (ray.x / length) * d, camera.origin.y + (ray.y / length) * d, camera.origin.z + (ray.z / length) * d);
      let lo = 0.5;
      let hi = 6;
      assert.ok(regionContains(footprint, point(lo)) && !regionContains(footprint, point(hi)));
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (regionContains(footprint, point(mid))) lo = mid;
        else hi = mid;
      }
      const range = Math.max(0, 1 - 0.5 * (lo / RGB_MODEL.reachM) ** 2);
      return RGB_MODEL.personBaseConfidence * Math.exp(-opticalDepth(world, camera.origin, point(lo))) * MIN_BODY_SHARE * range;
    };
    const intact = fixtureWorld({ drone: view });
    addSmoke(intact, "room-a", 0.6);
    const broken = fixtureWorld({ drone: view });
    addSmoke(broken, "room-a", 0.6);
    setOpening(broken, "win-a", "broken");
    const intactFrames = frames(intact);
    const brokenFrames = frames(broken);
    const throughPane = cutInCell(intact, intactFrames.get("rgb-front")!.footprint) * RGB_MODEL.glassFactor;
    const noPane = cutInCell(broken, brokenFrames.get("rgb-front")!.footprint);
    // At the cut the oracle's confidence is the threshold, never below it, and at most a few per cent above (the
    // cell's upper rays, in the denser smoke higher up, bind it). Behind the pane the same holds with the glass
    // factor applied, so the pane moves the cut by exactly that factor and no more.
    for (const [label, confidence] of [["open window", noPane], ["intact pane", throughPane]] as const) {
      assert.ok(confidence >= PERSON_DETECTION_CONFIDENCE && confidence < 1.06 * PERSON_DETECTION_CONFIDENCE, `${label}: confidence at the cut ${confidence.toFixed(4)}`);
    }
    assert.ok(Math.abs(throughPane / noPane - 1) < 0.03, `the pane changes the confidence at the cut by ${(throughPane / noPane).toFixed(4)}, not by its factor alone`);
    // Nothing in front of the pane is lost, and the room behind it stays in view.
    for (const p of [vec3(-0.6, 2, 1.45), vec3(-0.2, 2, 1.4), vec3(0.3, 2, 1.35)]) assert.ok(regionContains(intactFrames.get("rgb-front")!.footprint, p), `RGB covers ${JSON.stringify(p)} with the pane intact`);
    // LWIR does not pass glass: nothing beyond the pane, until it is broken.
    assert.ok(!regionContains(intactFrames.get("thermal-front")!.footprint, vec3(0.3, 2, 1.35)));
    assert.ok(regionContains(brokenFrames.get("thermal-front")!.footprint, vec3(0.3, 2, 1.35)));
  });

  test("near the thermal crossover the thermal footprint shrinks with the oracle, and a hot or cold room restores it", () => {
    // At 69 °C in room-a the gas 1.0 m above the floor is at the crossover (background ≈ skin temperature): a
    // standing person's middle sample point, the one the oracle measures, shows no contrast.
    const view: FixtureOptions["drone"] = { position: vec3(0.5, 2, 1.2), yawRad: 0 };
    const chest = vec3(2.5, 2, 1.0);
    const thermal = (gasC: number) => {
      const world = fixtureWorld({ drone: view, occupants: [{ key: "p", position: vec3(chest.x, chest.y, 0) }] });
      setGas(world, "room-a", gasC);
      return frames(world).get("thermal-front")!;
    };
    const covered = (gasC: number) => {
      const footprint = thermal(gasC).footprint;
      let n = 0;
      for (let k = 0; k < 400; k++) {
        const u = (stream: string) => keyedUniform("crossover", stream, k);
        if (regionContains(footprint, vec3(1 + 2.9 * u("x"), 0.2 + 3.6 * u("y"), 0.1 + 2 * u("z")))) n += 1;
      }
      return n;
    };
    const [cold, crossover, hot] = [covered(20), covered(69), covered(150)];
    assert.ok(cold > 100 && hot > 100, `cold ${cold}, hot ${hot}`);
    assert.ok(crossover < 0.25 * cold, `at the crossover only ${crossover} of the cold ${cold} points stay covered`);
    const atCrossover = thermal(69);
    assert.ok(personConfidence(atCrossover) < PERSON_DETECTION_CONFIDENCE, `oracle at the crossover: ${personConfidence(atCrossover).toFixed(3)}`);
    assert.ok(!regionContains(atCrossover.footprint, chest), "and the footprint does not claim the point it would miss");
    for (const gasC of [20, 150]) {
      assert.ok(personConfidence(thermal(gasC)) >= PERSON_DETECTION_CONFIDENCE && regionContains(thermal(gasC).footprint, chest), `${gasC} °C: seen and covered`);
    }
  });
  test("a crossover shell thinner than the gas sampling step still cuts the thermal footprint", () => {
    // Beside a fire's plume the gas warms from the room's 40 °C to flame temperature within centimetres, so the
    // shell where the background matches skin temperature is far thinner than ENV_STEP_M. A standing person whose
    // middle sample point sits in it shows no contrast; the footprint must stop short of it.
    const view: FixtureOptions["drone"] = { position: vec3(0.5, 2, 1.2), yawRad: 0 };
    const fire: FixtureOptions["fire"] = { roomId: "room-a", origin: vec3(3.0, 2.0, 0.3), radiusM: 0.25, initialHeatReleaseKW: 150, fuelMJ: 60 };
    const probe = fixtureWorld({ drone: view, fire });
    setGas(probe, "room-a", 40);
    const background = (p: Vec3) => FIRE_MODEL.ambientC + THERMAL_MODEL.surfaceLag * (temperatureAt(probe, p) - FIRE_MODEL.ambientC);
    let cool = 1.0;
    let hot = 2.9;
    assert.ok(background(vec3(cool, 2, 1)) < THERMAL_MODEL.skinC && background(vec3(hot, 2, 1)) > THERMAL_MODEL.skinC, "precondition: the line crosses the shell");
    for (let k = 0; k < 50; k++) {
      const mid = (cool + hot) / 2;
      if (background(vec3(mid, 2, 1)) < THERMAL_MODEL.skinC) cool = mid;
      else hot = mid;
    }
    const shellX = (cool + hot) / 2;
    const thermalWith = (x: number) => {
      const world = fixtureWorld({ drone: view, fire, occupants: [{ key: "p", position: vec3(x, 2, 0) }] });
      setGas(world, "room-a", 40);
      return frames(world).get("thermal-front")!;
    };
    const inShell = thermalWith(shellX);
    assert.ok(personConfidence(inShell) < PERSON_DETECTION_CONFIDENCE, `oracle in the shell: ${personConfidence(inShell).toFixed(3)}`);
    assert.ok(!regionContains(inShell.footprint, vec3(shellX, 2, 1)), `the footprint claims the shell at x = ${shellX.toFixed(3)}`);
    const nearer = thermalWith(shellX - 0.6);
    assert.ok(personConfidence(nearer) >= PERSON_DETECTION_CONFIDENCE && regionContains(nearer.footprint, vec3(shellX - 0.6, 2, 1)), "control: in the cool air nearer the camera a person is seen and covered");
  });
  test("heat clutter beside a large fire hides a person, and the thermal footprint leaves that space out", () => {
    // A 400 kW fire burning 1.0–1.5 m up (on a shelf); a crouching person right under it stays in cool room air
    // (below the fire, no plume) but within half a metre of the flames, where clutter cuts thermal confidence to a
    // fifth.
    const view: FixtureOptions["drone"] = { position: vec3(0.5, 2, 1.2), yawRad: 0 };
    const fire: FixtureOptions["fire"] = { roomId: "room-a", origin: vec3(3.0, 2.0, 1.25), radiusM: 0.25, initialHeatReleaseKW: 400, fuelMJ: 200 };
    const thermalWith = (x: number) => {
      const world = fixtureWorld({ drone: view, fire, occupants: [{ key: "p", position: vec3(x, 2, 0), animation: "crouch" }] });
      // The closed fixture room caps the initial heat release by ventilation; this case needs the large fire.
      world.fires[0].heatReleaseKW = 400;
      return frames(world).get("thermal-front")!;
    };
    const under = thermalWith(3.0);
    assert.ok(personConfidence(under) < PERSON_DETECTION_CONFIDENCE, `oracle under the fire: ${personConfidence(under).toFixed(3)}`);
    assert.ok(!regionContains(under.footprint, vec3(3.0, 2, 0.6)), "the footprint claims the space beside the flames");
    const away = thermalWith(1.8);
    assert.ok(personConfidence(away) >= PERSON_DETECTION_CONFIDENCE && regionContains(away.footprint, vec3(1.8, 2, 0.6)), "control: 1.2 m from the fire a person is seen and covered");
  });
});
