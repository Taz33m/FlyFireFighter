import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TICK_S } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { distanceToRegion, regionContains, sphere } from "../contracts/geometry.ts";
import { fixtureScenario } from "./fixture-scene.ts";
import { initFireState } from "./fire.ts";
import { stepOccupants } from "./occupant.ts";
import { planEvacuationRoute, radiantStandoffM } from "./occupant-route.ts";
import { setDoorState } from "./openings.ts";
import { bareWorld, FIXTURE_SCENE, occupantAt } from "./world-fixtures.ts";
import type { OccupantTruth, WorldState } from "./world-state.ts";

const BEDROOM_START = FIXTURE_SCENE.anchors.occupantStart;
const LIGHT_ORIGIN = vec3(6.5, 6.5, 4.0);
const NEAR_BEDROOM_DOOR = vec3(4.6, 5.5, 3.9);

/** Bare world with the hall fire burning and one occupant at the bedroom anchor. */
function bedroomWorld(mobility: OccupantTruth["mobility"] = "mobile"): WorldState {
  const world = bareWorld({ position: LIGHT_ORIGIN });
  world.fires.push({ id: "fire-hall-up", roomId: "hall-up", region: sphere(FIXTURE_SCENE.anchors.fireOrigin, 0.45), heatReleaseKW: 60, fuelMJ: 40, waterDeliveredL: 0, extinguished: false });
  world.occupants.push(occupantAt("occupant-1", BEDROOM_START, mobility));
  return world;
}

function extinguish(world: WorldState): void {
  for (const fire of world.fires) {
    fire.extinguished = true;
    fire.heatReleaseKW = 0;
  }
}

interface RunOptions {
  readonly light?: { readonly origin: Vec3; readonly target: Vec3 } | null;
  readonly onTick?: (world: WorldState) => void;
}

/** Steps occupants only, refreshing a guidance light cue every tick like the harness's guide action. */
function run(world: WorldState, ticks: number, options: RunOptions = {}): void {
  for (let i = 0; i < ticks; i++) {
    if (options.light) world.cues.light = { ...options.light, tick: world.tick };
    stepOccupants(world, TICK_S);
    options.onTick?.(world);
    world.tick += 1;
  }
}

const occupant = (world: WorldState) => world.occupants[0];
const guidance = { origin: LIGHT_ORIGIN, target: NEAR_BEDROOM_DOOR };

describe("occupant route policy", () => {
  test("with the hall fire burning across the route there is no passable route, even with a visible light", () => {
    const world = bedroomWorld();
    assert.equal(planEvacuationRoute(world, BEDROOM_START), null);
    let closestToFire = Infinity;
    run(world, 500, { light: guidance, onTick: w => { closestToFire = Math.min(closestToFire, distanceToRegion(w.fires[0].region, occupant(w).position)); } });
    assert.equal(occupant(world).activity, "shelter");
    assert.deepEqual(occupant(world).position, BEDROOM_START);
    assert.ok(closestToFire > 1);
  });

  test("once the fire is out it follows the light and walks out to the assembly point, recording arrival", () => {
    const world = bedroomWorld();
    run(world, 50, { light: guidance });
    extinguish(world);
    const route = planEvacuationRoute(world, BEDROOM_START);
    assert.ok(route && route.lengthM > 10, "bedroom → hall → stair → front door");
    run(world, 20, { light: guidance });
    assert.equal(occupant(world).activity, "follow");
    assert.equal(occupant(world).animation, "follow");
    run(world, 4000, { light: guidance });
    const o = occupant(world);
    assert.equal(o.activity, "arrived");
    assert.ok(o.arrivalTick !== null && o.arrivalTick > 1500 && o.arrivalTick < 4000, `arrival ${o.arrivalTick}`);
    assert.ok(regionContains(FIXTURE_SCENE.assemblyPoint, vec3(o.position.x, o.position.y, o.position.z + 0.05)));
    assert.equal(world.truthEvents.filter(e => e.kind === "occupant_arrived").length, 1);
    const activities = world.truthEvents.filter(e => e.kind === "occupant_activity").map(e => e.data.to);
    assert.ok(activities.includes("outside") && activities[activities.length - 1] === "arrived");
  });

  test("a small fire mid-hall can be walked around at a distance; a large one cannot (radiant standoff)", () => {
    const world = bareWorld();
    const fire = { id: "fire-mid-hall", roomId: "hall-up", region: sphere(vec3(2.6, 4.85, 2.9), 0.45), heatReleaseKW: 20, fuelMJ: 40, waterDeliveredL: 0, extinguished: false };
    world.fires.push(fire);
    assert.ok(radiantStandoffM(20) < 0.95 && radiantStandoffM(200) > 0.95);
    const detour = planEvacuationRoute(world, BEDROOM_START);
    assert.ok(detour, "a 20 kW fire is passed about 1 m away");
    assert.ok(detour.waypoints.every(p => distanceToRegion(fire.region, p) > 0.4));
    fire.heatReleaseKW = 200;
    assert.equal(planEvacuationRoute(world, BEDROOM_START), null);
  });

  test("a light that is ahead in the same room steers the occupant toward it", () => {
    const world = bedroomWorld();
    extinguish(world);
    const spot = vec3(6.0, 4.5, 3.9);
    run(world, 50, { light: { origin: LIGHT_ORIGIN, target: spot } });
    const expected = Math.atan2(spot.y - BEDROOM_START.y, spot.x - BEDROOM_START.x);
    assert.ok(Math.abs(occupant(world).yawRad - expected) < 0.05, `yaw ${occupant(world).yawRad} vs ${expected}`);
  });

  test("without perceivable guidance the occupant shelters even when the route is passable", () => {
    const world = bedroomWorld();
    extinguish(world);
    run(world, 300);
    assert.equal(occupant(world).activity, "shelter");
    const hallLight = { origin: vec3(2.0, 3.0, 4.0), target: vec3(2.0, 2.0, 3.0) };
    run(world, 300, { light: hallLight });
    assert.equal(occupant(world).activity, "shelter", "a light behind a wall is not perceived");
  });

  test("a spoken cue within range starts an evacuation without a light", () => {
    const world = bedroomWorld();
    extinguish(world);
    world.cues.audio = { templateId: "exit-ahead", origin: vec3(6.0, 6.0, 4.0), tick: 0 };
    run(world, 100);
    assert.equal(occupant(world).activity, "evacuate");
    assert.equal(occupant(world).animation, "walk");
    assert.ok(distance(occupant(world).position, BEDROOM_START) > 0.5);
  });

  test("closed doors do not stop an occupant: it opens each on arrival, exits, and the doors stay open for the smoke model", () => {
    const world = bedroomWorld();
    extinguish(world);
    setDoorState(world, "front-door", "closed");
    setDoorState(world, "door-bedroom", "closed");
    assert.ok(planEvacuationRoute(world, BEDROOM_START), "people can open an unlocked door");
    run(world, 4000, { light: guidance });
    assert.equal(occupant(world).activity, "arrived");
    for (const [door, leaf] of [["front-door", "door-leaf-front"], ["door-bedroom", "door-leaf-bedroom"]]) {
      const truth = world.openings.find(o => o.id === door)!;
      assert.equal(truth.state, "open", door);
      assert.ok(Math.abs(truth.openAreaM2 - 1.8) < 1e-12, door);
      assert.equal(world.activeColliderIds.has(leaf), false, leaf);
    }
    const opened = world.truthEvents.filter(e => e.kind === "occupant_activity" && e.data.action === "opened_door").map(e => e.data.openingId);
    assert.deepEqual(opened, ["door-bedroom", "front-door"]);
  });

  test("a blocked door can be neither opened nor passed: with the only exit blocked there is no way out", () => {
    const world = bedroomWorld();
    extinguish(world);
    setDoorState(world, "front-door", "blocked");
    assert.equal(planEvacuationRoute(world, BEDROOM_START), null);
    run(world, 1000, { light: guidance });
    assert.equal(occupant(world).activity, "shelter");
    assert.equal(world.openings.find(o => o.id === "front-door")?.state, "blocked");
    assert.equal(world.activeColliderIds.has("door-leaf-front"), true);
  });

  test("an immobile occupant never self-evacuates or arrives", () => {
    const world = bedroomWorld("immobile");
    extinguish(world);
    world.cues.audio = { templateId: "exit-ahead", origin: vec3(6.0, 6.0, 4.0), tick: 0 };
    run(world, 3000, { light: guidance });
    assert.deepEqual(occupant(world).position, BEDROOM_START);
    assert.equal(occupant(world).arrivalTick, null);
    assert.equal(occupant(world).activity, "shelter");
  });

  test("smoke at head height makes a sheltering occupant crouch, then cough, and blocks a smoky route", () => {
    const world = bedroomWorld();
    extinguish(world);
    const smoke = initFireState(world.scene, fixtureScenario({ fire: null }), world.openings);
    world.compartments = smoke.compartments;
    const bedroom = world.compartments.find(c => c.id === "bedroom")!;
    bedroom.smokeExtinctionPerM = 0.3;
    run(world, 2);
    assert.equal(occupant(world).animation, "crouch");
    bedroom.smokeExtinctionPerM = 1.5;
    run(world, 2);
    assert.equal(occupant(world).animation, "cough");
    world.compartments.find(c => c.id === "hall-up")!.smokeExtinctionPerM = 8;
    assert.equal(planEvacuationRoute(world, BEDROOM_START), null);
    assert.ok(occupant(world).smokeExposure > 0);
  });
});
