/*
 * What a frame may claim: detections and footprints must follow from what the simulated measurement could
 * actually see, never from hidden simulator state. Regression tests for independently reproduced defects:
 * a jammed door reported from one glance, footprints leaking behind narrow occluders and through walls on a
 * lidar miss, RGB sightings ignoring glass transparency, and thermal reporting a person its own footprint
 * says it did not cover. Scope: the sensor models on the two-room fixture (environment-fixtures.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "../../contracts/frames.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { regionContains } from "../../contracts/geometry.ts";
import type { Region } from "../../contracts/geometry.ts";
import type { Detection, Observation } from "../../contracts/observation.ts";
import type { FixtureOptions } from "../environment-fixtures.ts";
import { fixtureWorld, sceneWith, setOpening } from "../environment-fixtures.ts";
import { addSmoke, opticalDepth } from "../fire.ts";
import { OBSTRUCTION_ID_PREFIX } from "../occupant-route.ts";
import { raycast } from "../raycast.ts";
import type { RuntimeCollider, WorldState } from "../world-state.ts";
import { activeColliders } from "../world-state.ts";
import { senseTick } from "./index.ts";
import { RGB_MODEL } from "./rgb.ts";
import { THERMAL_MODEL } from "./thermal.ts";

function observe(world: WorldState, sensorId: string): Observation {
  const o = senseTick(world).observations.find(candidate => candidate.sensorId === sensorId);
  assert.ok(o, `${sensorId} fired at tick ${world.tick}`);
  return o;
}

const people = (o: Observation) => o.detections.filter(d => d.kind === "possible_person");
const fires = (o: Observation) => o.detections.flatMap(d => (d.kind === "hazard" && d.hazard === "fire" ? [d] : []));
const states = (o: Observation) => o.detections.flatMap(d => (d.kind === "opening_state" ? [`${d.openingId}=${d.state}`] : []));
const covers = (o: Observation, p: Vec3) => o.footprint !== null && regionContains(o.footprint, p);
const body = (feet: Vec3) => [0.5, 1.0, 1.5].map(h => vec3(feet.x, feet.y, feet.z + h));

function box(id: string, min: readonly [number, number, number], max: readonly [number, number, number]): RuntimeCollider {
  return { id, kind: "furniture", min: vec3(...min), max: vec3(...max), openingId: null };
}

const inRoomA: FixtureOptions["drone"] = { position: vec3(2, 2, 1.2), yawRad: 0 };

describe("opening states report what a camera can see", () => {
  // From room-a the RGB camera has a clear, facing view of door-ab (x 4.0–4.1, y 1.55–2.45, z 0–2).
  const nearDebris = box(`${OBSTRUCTION_ID_PREFIX}near`, [3.5, 1.7, 0], [3.9, 2.3, 1.0]);
  const farDebris = box(`${OBSTRUCTION_ID_PREFIX}far`, [4.2, 1.7, 0], [4.6, 2.3, 1.0]);

  test("a jammed door looks exactly like a closed one", () => {
    const world = fixtureWorld({ drone: inRoomA });
    assert.deepEqual(states(observe(world, "rgb-front")), ["door-ab=closed"]);
    setOpening(world, "door-ab", "blocked");
    assert.deepEqual(states(observe(world, "rgb-front")), ["door-ab=closed"], "the hidden jammed state is not visible");
  });

  test("'blocked' is reported only for an obstruction across the doorway that the camera can see", () => {
    const door = (world: WorldState) => states(observe(world, "rgb-front")).filter(s => s.startsWith("door-ab="));
    const near = fixtureWorld({ scene: sceneWith([nearDebris]), drone: inRoomA, openings: { "door-ab": "blocked" } });
    assert.deepEqual(door(near), ["door-ab=blocked"], "debris in front of the door is visible evidence");
    const far = fixtureWorld({ scene: sceneWith([farDebris]), drone: inRoomA });
    assert.deepEqual(door(far), ["door-ab=closed"], "debris behind the closed leaf is unseen");
    setOpening(far, "door-ab", "open");
    assert.deepEqual(door(far), ["door-ab=blocked"], "through the open doorway the debris is in view");
    const beside = fixtureWorld({ scene: sceneWith([box(`${OBSTRUCTION_ID_PREFIX}beside`, [3.6, 2.3, 0], [3.9, 2.44, 1.0])]), drone: inRoomA });
    assert.deepEqual(door(beside), ["door-ab=closed"], "a box off the walking line does not block passage");
  });
});

describe("RGB sightings through intact glass", () => {
  const outsideWinA: FixtureOptions = {
    drone: { position: vec3(-2.5, 2, 1.5), yawRad: 0 },
    fire: { roomId: "room-a", origin: vec3(1.0, 2, 0.9), radiusM: 0.25, initialHeatReleaseKW: 40, fuelMJ: 60 },
  };

  test("a fire behind an intact window is visible to RGB at the glass contrast factor, never to thermal", () => {
    const world = fixtureWorld(outsideWinA);
    const intact = fires(observe(world, "rgb-front"));
    assert.equal(intact.length, 1, "flames behind clear glass are visible");
    assert.equal(fires(observe(world, "thermal-front")).length, 0, "LWIR does not pass glass");
    setOpening(world, "win-a", "broken");
    const broken = fires(observe(world, "rgb-front"));
    assert.equal(broken.length, 1);
    assert.ok(Math.abs(intact[0].intensity / broken[0].intensity - RGB_MODEL.glassFactor) < 1e-9, `${intact[0].intensity} vs ${broken[0].intensity}`);
    assert.equal(fires(observe(world, "thermal-front")).length, 1, "control: thermal sees the fire once the pane is gone");
  });

  test("RGB judges an interior door through an intact window", () => {
    const world = fixtureWorld(outsideWinA);
    assert.deepEqual(states(observe(world, "rgb-front")).sort(), ["door-ab=closed", "win-a=closed"]);
  });
});

describe("footprints claim only space the sensor could see", () => {
  // The post (9 cm wide, 1.7 m from the camera) lies between the camera's grid rays (azimuth 0° and 5.6°) and
  // hides the person standing behind it.
  const post = box("post", [2.3, 2.04, 0], [2.4, 2.13, 2.6]);
  const hidden = vec3(3.7, 2.15, 0);
  const view: FixtureOptions["drone"] = { position: vec3(0.5, 2, 1.2), yawRad: 0 };

  test("a narrow post between camera rays cuts the RGB and thermal footprints", () => {
    const open = fixtureWorld({ drone: view, occupants: [{ key: "p", position: hidden }] });
    const rgbOpen = observe(open, "rgb-front");
    assert.equal(people(rgbOpen).length, 1, "control: visible without the post");
    for (const id of ["rgb-front", "thermal-front"]) assert.ok(body(hidden).every(p => covers(observe(open, id), p)), `control: ${id} covers the person`);
    const blocked = fixtureWorld({ scene: sceneWith([post]), drone: view, occupants: [{ key: "p", position: hidden }] });
    assert.equal(people(observe(blocked, "rgb-front")).length, 0, "the post hides the person from the oracle");
    for (const id of ["rgb-front", "thermal-front"]) {
      const frame = observe(blocked, id);
      assert.equal(frame.personSearch, "oracle_fixture");
      assert.deepEqual(body(hidden).map(p => covers(frame, p)), [false, false, false], `${id} claims space behind the post`);
    }
  });

  test("a missed lidar return does not extend coverage past the surface the beam reached", () => {
    // Outside the house at 6–7.5 m, many beams meet walls far away and obliquely: weak returns, frequent misses.
    let cones = 0;
    const leaks: string[] = [];
    for (const position of [vec3(-6.5, 0.5, 1.2), vec3(-6, 6, 1.2), vec3(4, -6.5, 1.2), vec3(14, 5.5, 1.2)]) {
      const world = fixtureWorld({ drone: { position, yawRad: 0.3 } });
      const colliders = activeColliders(world);
      for (let tick = 0; tick < 1000; tick += 5) {
        world.tick = tick;
        const footprint = observe(world, "lidar-planar").footprint as Region;
        for (const part of footprint.kind === "union" ? footprint.parts : [footprint]) {
          if (part.kind !== "sector" || part.rangeM <= 0) continue;
          cones += 1;
          const hit = raycast(colliders, part.apex, part.axis, 50, c => c.kind === "glass");
          if (hit && part.rangeM > hit.distanceM + 0.75) leaks.push(`(${position.x}, ${position.y}) tick ${tick}: cone ${part.rangeM.toFixed(2)} m, ${hit.colliderId} at ${hit.distanceM.toFixed(2)} m`);
        }
      }
    }
    assert.ok(cones > 10000);
    assert.deepEqual(leaks, [], "cones reaching more than 0.75 m past the first opaque surface on their axis");
  });
});

describe("detections stay within the measurement's support", () => {
  test("thermal reports no person beyond the LWIR optical depth that cuts its own footprint", () => {
    const view: FixtureOptions["drone"] = { position: vec3(0.5, 2, 1.2), yawRad: 0 };
    const near = vec3(1.8, 2, 0);
    const far = vec3(3.5, 2, 0);
    const lwirTau = (world: WorldState, p: Vec3) => THERMAL_MODEL.smokeFactor * opticalDepth(world, vec3(0.62, 2.03, 1.22), p);
    const nearWorld = fixtureWorld({ drone: view, occupants: [{ key: "p", position: near }] });
    const farWorld = fixtureWorld({ drone: view, occupants: [{ key: "p", position: far }] });
    for (const world of [nearWorld, farWorld]) addSmoke(world, "room-a", 12);
    assert.ok(body(near).every(p => lwirTau(nearWorld, p) < THERMAL_MODEL.tauLimitLwir), "precondition: the near person is within the limit");
    assert.ok(body(far).every(p => lwirTau(farWorld, p) > THERMAL_MODEL.tauLimitLwir), "precondition: the far person is beyond it");
    const seen = observe(nearWorld, "thermal-front");
    assert.equal(people(seen).length, 1, "control: thermal still sees through moderate optical depth");
    assert.ok(body(near).some(p => covers(seen, p)), "and the detection lies within its footprint");
    const unseen = observe(farWorld, "thermal-front");
    assert.deepEqual(body(far).map(p => covers(unseen, p)), [false, false, false], "precondition: the footprint stops short of the far person");
    assert.deepEqual(people(unseen) as Detection[], [], "no detection where the frame claims no coverage");
  });
});
