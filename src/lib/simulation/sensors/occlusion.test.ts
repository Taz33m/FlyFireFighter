import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import { regionContains } from "../../contracts/geometry.ts";
import type { Detection, Observation } from "../../contracts/observation.ts";
import type { FixtureOptions } from "../environment-fixtures.ts";
import { fixtureWorld, sceneWith, setOpening } from "../environment-fixtures.ts";
import { addSmoke } from "../fire.ts";
import { keyedUniform } from "../random.ts";
import { raycast } from "../raycast.ts";
import type { WorldState } from "../world-state.ts";
import { activeColliders } from "../world-state.ts";
import { senseTick } from "./index.ts";
import { lidarSurface } from "./lidar-ray.ts";
import { traceNearest, traceSet } from "./trace.ts";

function observe(world: WorldState, sensorId: string): Observation {
  const o = senseTick(world).observations.find(candidate => candidate.sensorId === sensorId);
  assert.ok(o, `${sensorId} fired at tick ${world.tick}`);
  return o;
}

function people(o: Observation): Extract<Detection, { kind: "possible_person" }>[] {
  return o.detections.flatMap(d => (d.kind === "possible_person" ? [d] : []));
}

function covers(o: Observation, p: Vec3): boolean {
  return o.footprint !== null && regionContains(o.footprint, p);
}

/** Summed reach of a footprint: sector ranges, or depth-image cell depths. */
function totalRange(r: Region | null): number {
  if (r === null) return 0;
  if (r.kind === "union") return r.parts.reduce((sum, part) => sum + totalRange(part), 0);
  if (r.kind === "depth_image") return r.depthsM.reduce((sum, d) => sum + d, 0);
  return r.kind === "sector" ? r.rangeM : 0;
}

const inRoomA: FixtureOptions["drone"] = { position: vec3(2, 2, 1.2), yawRad: 0 };

describe("RGB person oracle and glass", () => {
  const outsideWinA = { drone: { position: vec3(-2.5, 2, 1.5), yawRad: 0 }, occupants: [{ key: "p", position: vec3(2, 2, 0) }] };

  test("visible light sees a person through intact glass where thermal cannot, and RGB coverage extends past the pane", () => {
    const world = fixtureWorld(outsideWinA);
    const rgb = observe(world, "rgb-front");
    const thermal = observe(world, "thermal-front");
    assert.equal(rgb.personSearch, "oracle_fixture");
    assert.equal(people(rgb).length, 1, "RGB sees through the window");
    assert.equal(people(thermal).length, 0, "LWIR does not pass glass");
    const behindPane = vec3(1, 2, 1.5);
    assert.ok(covers(rgb, behindPane), "RGB footprint continues into the room");
    assert.ok(!covers(thermal, behindPane), "thermal footprint stops at the pane");
    setOpening(world, "win-a", "broken");
    const throughOpening = people(observe(world, "rgb-front"));
    assert.equal(throughOpening.length, 1);
    assert.ok(throughOpening[0].confidence > people(rgb)[0].confidence, "a pane costs contrast");
  });

  test("the downward camera sees a person on the ground directly below the hovering aircraft", () => {
    const world = fixtureWorld({ drone: { position: vec3(-3, 2, 5), yawRad: 0 }, occupants: [{ key: "below", position: vec3(-3.4, 2.3, 0) }] });
    world.tick = 10;
    const down = observe(world, "rgb-down");
    assert.equal(down.personSearch, "oracle_fixture");
    assert.equal(people(down).length, 1);
    assert.ok(covers(down, vec3(-3, 2, 0.5)), "its footprint covers the ground below");
    assert.deepEqual(people(observe(world, "rgb-front")), [], "the forward camera cannot see straight down");
  });

  test("walls and closed doors still hide the person from RGB", () => {
    const world = fixtureWorld({ drone: inRoomA, occupants: [{ key: "p", position: vec3(6, 2, 0) }] });
    assert.deepEqual(people(observe(world, "rgb-front")), []);
  });

  test("dense smoke hides the person from RGB while thermal still detects them", () => {
    const world = fixtureWorld({ drone: { position: vec3(0.5, 2, 1.2), yawRad: 0 }, occupants: [{ key: "p", position: vec3(3, 2, 0) }] });
    assert.equal(people(observe(world, "rgb-front")).length, 1, "clear air: seen");
    addSmoke(world, "room-a", 3);
    assert.deepEqual(people(observe(world, "rgb-front")), [], "visible light is lost in smoke");
    assert.equal(people(observe(world, "thermal-front")).length, 1, "LWIR passes the same smoke");
  });
});

describe("thermal person oracle", () => {
  test("a wall or closed door hides the occupant; the open doorway does not", () => {
    const closed = fixtureWorld({ drone: inRoomA, occupants: [{ key: "p", position: vec3(6, 2, 0) }] });
    const frame = observe(closed, "thermal-front");
    assert.equal(frame.personSearch, "oracle_fixture");
    assert.deepEqual(people(frame), []);
    setOpening(closed, "door-ab", "open");
    const seen = people(observe(closed, "thermal-front"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "oracle_fixture");
    assert.ok(seen[0].uncertaintyM >= closed.estimator.sigmaM);
  });

  test("intact glass blocks the thermal oracle; a broken window does not", () => {
    const world = fixtureWorld({ drone: { position: vec3(-2.5, 2, 1.5), yawRad: 0 }, occupants: [{ key: "p", position: vec3(2, 2, 0) }] });
    const intact = observe(world, "thermal-front");
    assert.equal(intact.personSearch, "oracle_fixture");
    assert.deepEqual(people(intact), []);
    setOpening(world, "win-a", "broken");
    const broken = observe(world, "thermal-front");
    assert.equal(broken.personSearch, "oracle_fixture");
    assert.equal(people(broken).length, 1);
  });

  test("heat clutter near a fire lowers confidence and widens uncertainty", () => {
    const options = { drone: { position: vec3(1, 2.6, 1.2), yawRad: 0 }, occupants: [{ key: "p", position: vec3(3, 2.6, 0) }] };
    const calm = people(observe(fixtureWorld(options), "thermal-front"));
    const cluttered = people(observe(fixtureWorld({ ...options, fire: { roomId: "room-a", origin: vec3(3, 3.3, 0.3), radiusM: 0.25, initialHeatReleaseKW: 60, fuelMJ: 60 } }), "thermal-front"));
    assert.equal(calm.length, 1);
    assert.equal(cluttered.length, 1);
    assert.ok(cluttered[0].confidence < calm[0].confidence - 0.1, `${cluttered[0].confidence} vs ${calm[0].confidence}`);
    assert.ok(cluttered[0].uncertaintyM > calm[0].uncertaintyM);
  });
});

describe("occlusion-aware footprints", () => {
  test("coverage stops at a wall: a point behind it is not contained, a point in front is", () => {
    const world = fixtureWorld({ drone: inRoomA });
    const frame = senseTick(world).observations;
    const byId = (id: string) => frame.find(o => o.sensorId === id) as Observation;
    for (const id of ["rgb-front", "thermal-front"]) {
      assert.equal(covers(byId(id), vec3(5, 2, 1)), false, `${id} leaks behind the wall`);
      assert.equal(covers(byId(id), vec3(3.5, 2, 1)), true, `${id} covers the room ahead`);
    }
    assert.equal(covers(byId("lidar-planar"), vec3(5, 2, 1.28)), false, "lidar leaks behind the wall");
    assert.equal(covers(byId("lidar-planar"), vec3(3.5, 2, 1.28)), true);
    setOpening(world, "door-ab", "open");
    assert.equal(covers(observe(world, "thermal-front"), vec3(5, 2, 1)), true, "the open doorway lets coverage through");
  });

  test("smoke shortens RGB coverage far more than thermal coverage", () => {
    const clear = fixtureWorld({ drone: inRoomA });
    const smoky = fixtureWorld({ drone: inRoomA });
    addSmoke(smoky, "room-a", 2);
    const rgbClear = observe(clear, "rgb-front");
    const rgbSmoky = observe(smoky, "rgb-front");
    const thermalClear = observe(clear, "thermal-front");
    const thermalSmoky = observe(smoky, "thermal-front");
    // Many RGB cones already end on the floor nearby, so the summed range shrinks by less than the wall rays do.
    assert.ok(totalRange(rgbSmoky.footprint) < 0.85 * totalRange(rgbClear.footprint));
    assert.ok(totalRange(thermalSmoky.footprint) > 0.95 * totalRange(thermalClear.footprint));
    assert.ok(rgbSmoky.quality < 0.2 && rgbClear.quality > 0.9, `rgb quality ${rgbSmoky.quality} / ${rgbClear.quality}`);
    assert.ok(thermalSmoky.quality > 0.6, `thermal quality ${thermalSmoky.quality}`);
    // Not immune: looking 3.5 m down the room through dense smoke, LWIR transmission falls to ~0.15.
    const longView = { position: vec3(0.5, 2, 1.2), yawRad: 0 };
    const dense = fixtureWorld({ drone: longView });
    addSmoke(dense, "room-a", 8);
    const thermalLongClear = observe(fixtureWorld({ drone: longView }), "thermal-front");
    const thermalDense = observe(dense, "thermal-front");
    assert.ok(thermalDense.quality < thermalLongClear.quality - 0.2, `thermal is not immune: ${thermalDense.quality}`);
    assert.ok(totalRange(thermalDense.footprint) < totalRange(thermalLongClear.footprint));
  });
});

describe("range sensors", () => {
  function meanQuality(smoke: number, sensorId: string): number {
    const world = fixtureWorld({ drone: inRoomA });
    addSmoke(world, "room-a", smoke);
    let sum = 0;
    const captures = 40;
    for (let i = 0; i < captures; i++) {
      world.tick = i * 5;
      sum += observe(world, sensorId).quality;
    }
    return sum / captures;
  }

  test("lidar misses grow with smoke while ultrasound degrades much less", () => {
    const lidar = [0, 1, 2, 4].map(k => meanQuality(k, "lidar-planar"));
    const ultrasound = [0, 1, 2, 4].map(k => meanQuality(k, "ultrasound-front"));
    assert.ok(lidar[0] > 0.9 && lidar[3] < 0.1, `lidar ${lidar.join(", ")}`);
    assert.ok(lidar.every((q, i) => i === 0 || q <= lidar[i - 1] + 0.02), "lidar degrades monotonically");
    assert.ok(ultrasound[3] > 0.8, `ultrasound ${ultrasound.join(", ")}`);
    for (let i = 1; i < 4; i++) assert.ok(ultrasound[0] - ultrasound[i] < lidar[0] - lidar[i], `smoke level ${i}`);
  });

  test("ultrasound misses a thin pole that a lidar beam returns from", () => {
    const pole = { id: "pole", kind: "furniture" as const, min: vec3(2.99, 1.99, 0), max: vec3(3.01, 2.01, 2.6), openingId: null };
    const world = fixtureWorld({ scene: sceneWith([pole]), drone: inRoomA });
    const origin = vec3(2, 2, 1.28);
    const surface = lidarSurface(world, traceSet(world, origin, 8), origin, vec3(1, 0, 0), 8);
    assert.equal(surface?.collider.id, "pole");
    const ranges = senseTick(world).ranges;
    assert.ok(ranges?.forwardM !== null && ranges !== null);
    const ultrasound = observe(world, "ultrasound-front");
    const sector = ultrasound.footprint?.kind === "sector" ? ultrasound.footprint : null;
    assert.ok(sector !== null && sector.rangeM > 1.5, `ultrasound echo ${sector?.rangeM} m comes from the wall, not the pole at 0.86 m`);
  });

  test("the allocation-free tracer agrees with the shared raycast", () => {
    const world = fixtureWorld({ openings: { "win-a": "broken" } });
    const origin = vec3(2, 2, 1.2);
    const set = traceSet(world, origin, 30);
    const colliders = activeColliders(world);
    for (let i = 0; i < 300; i++) {
      const z = 2 * keyedUniform("trace", "z", i) - 1;
      const phi = 2 * Math.PI * keyedUniform("trace", "phi", i);
      const dir = vec3(Math.sqrt(1 - z * z) * Math.cos(phi), Math.sqrt(1 - z * z) * Math.sin(phi), z);
      const expected = raycast(colliders, origin, dir, 30);
      const index = traceNearest(set, origin, dir, 30);
      assert.equal(index < 0 ? null : set.colliders[index].id, expected?.colliderId ?? null, `ray ${i}`);
      if (expected) assert.ok(Math.abs(set.distance - expected.distanceM) < 1e-12);
    }
  });
});

describe("simulated recognition", () => {
  test("RGB reports the state of an opening in clear view and a visible fire", () => {
    const world = fixtureWorld({ drone: inRoomA, fire: { roomId: "room-a", origin: vec3(3.3, 2.3, 0.3), radiusM: 0.25, initialHeatReleaseKW: 40, fuelMJ: 60 } });
    const states = (o: Observation) => o.detections.flatMap(d => (d.kind === "opening_state" ? [`${d.openingId}=${d.state}`] : []));
    const first = observe(world, "rgb-front");
    assert.deepEqual(states(first), ["door-ab=closed"]);
    const fire = first.detections.find(d => d.kind === "hazard" && d.hazard === "fire");
    assert.ok(fire && fire.kind === "hazard" && regionContains(fire.region, vec3(3.3, 2.3, 0.3)), "fire hazard around the burning region");
    setOpening(world, "door-ab", "open");
    assert.ok(states(observe(world, "rgb-front")).includes("door-ab=open"));
  });
});
