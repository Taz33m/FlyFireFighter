import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Vec3 } from "../contracts/frames.ts";
import { normalize, sub, vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { sector } from "../contracts/geometry.ts";
import { fixtureWorld, setOpening } from "./environment-fixtures.ts";
import { addSmoke, deliverWater, extinctionAt, FIRE_MODEL, fireBlocks, opticalDepth, stepFire, temperatureAt } from "./fire.ts";
import type { WorldState } from "./world-state.ts";

const FIRE_ORIGIN = vec3(3, 3, 0.3);
const SMALL_FIRE = { roomId: "room-a", origin: FIRE_ORIGIN, radiusM: 0.25, initialHeatReleaseKW: 40, fuelMJ: 60 } as const;

function run(world: WorldState, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 10); i++) stepFire(world, 0.1);
}

function smoke(world: WorldState, roomId: string): number {
  const compartment = world.compartments.find(c => c.id === roomId);
  assert.ok(compartment, `compartment ${roomId}`);
  return compartment.smokeExtinctionPerM;
}

function jetAt(apex: Vec3, target: Vec3): Region {
  return sector(apex, normalize(sub(target, apex)), (8 * Math.PI) / 180, 4);
}

describe("compartment smoke transport", () => {
  test("smoke spreads through an open door but not through a closed one", () => {
    const closed = fixtureWorld();
    const open = fixtureWorld({ openings: { "door-ab": "open" } });
    for (const world of [closed, open]) addSmoke(world, "room-a", 2);
    run(closed, 30);
    run(open, 30);
    assert.equal(smoke(closed, "room-b"), 0, "a closed door passes no smoke");
    // Cold smoke crosses only by the base exchange velocity: 1.8 m² × 0.1 m/s between two 41.6 m³ rooms.
    assert.ok(smoke(open, "room-b") > 0.15, `open door: room-b K ${smoke(open, "room-b")}`);
    assert.ok(extinctionAt(open, vec3(6, 2, 1.3)) > 0.15);
    // Exchange redistributes smoke; it never creates it (both rooms have the same volume).
    assert.ok(smoke(open, "room-a") + smoke(open, "room-b") <= 2 + 1e-9);
  });

  test("a broken window vents a smoky room faster than intact glass", () => {
    const intact = fixtureWorld();
    const broken = fixtureWorld({ openings: { "win-a": "broken" } });
    for (const world of [intact, broken]) addSmoke(world, "room-a", 2);
    run(intact, 120);
    run(broken, 120);
    assert.ok(smoke(broken, "room-a") < 0.85 * smoke(intact, "room-a"), `broken ${smoke(broken, "room-a")} vs intact ${smoke(intact, "room-a")}`);
    assert.equal(smoke(broken, "room-b"), 0, "the closed door still isolates room-b");
  });

  test("a broken window feeds a ventilation-limited fire in a closed room", () => {
    const closed = fixtureWorld({ fire: SMALL_FIRE });
    const vented = fixtureWorld({ fire: SMALL_FIRE });
    setOpening(vented, "win-a", "broken");
    const leakageLimitKW = FIRE_MODEL.ventilationKWPerM52 * FIRE_MODEL.leakageAreaM2 * Math.sqrt(FIRE_MODEL.leakageHeightM);
    run(closed, 60);
    run(vented, 60);
    assert.ok(closed.fires[0].heatReleaseKW <= leakageLimitKW + 1e-9, `closed room fire ${closed.fires[0].heatReleaseKW} kW`);
    assert.ok(vented.fires[0].heatReleaseKW > 1.5 * closed.fires[0].heatReleaseKW, `vented ${vented.fires[0].heatReleaseKW} kW`);
    assert.ok(vented.compartments[0].temperatureC > closed.compartments[0].temperatureC);
  });

  test("experiment smoke is validated and never negative", () => {
    const world = fixtureWorld();
    assert.throws(() => addSmoke(world, "attic", 1), RangeError);
    addSmoke(world, "room-a", -5);
    assert.equal(smoke(world, "room-a"), 0);
  });
});

describe("dose-limited suppression", () => {
  const nozzle = vec3(1.2, 3, 1.0);

  test("water reduces heat release only when the jet reaches the fire region, by the documented dose rule", () => {
    const world = fixtureWorld({ fire: SMALL_FIRE, openings: { "door-ab": "open" } });
    const before = world.fires[0].heatReleaseKW;
    const missed = deliverWater(world, sector(nozzle, vec3(-1, 0, 0), (8 * Math.PI) / 180, 4), 0.1, 0);
    assert.equal(missed, 0);
    assert.equal(world.fires[0].heatReleaseKW, before);
    const reached = deliverWater(world, jetAt(nozzle, FIRE_ORIGIN), 0.1, 1);
    assert.ok(reached > 0.05 && reached <= 0.1, `reached ${reached} L`);
    assert.ok(Math.abs(world.fires[0].heatReleaseKW - (before - FIRE_MODEL.suppressionKWPerL * reached)) < 1e-9);
    assert.equal(world.fires[0].waterDeliveredL, reached);
  });

  test("intact glass stops the jet; once broken, water passes the opening", () => {
    const nearWindow = { ...SMALL_FIRE, origin: vec3(1, 2, 1.2) };
    const world = fixtureWorld({ fire: nearWindow });
    const outside = vec3(-1.5, 2, 1.4);
    assert.equal(deliverWater(world, jetAt(outside, nearWindow.origin), 0.1, 0), 0);
    setOpening(world, "win-a", "broken");
    assert.ok(deliverWater(world, jetAt(outside, nearWindow.origin), 0.1, 1) > 0.05);
  });

  test("a partial dose leaves a fire that regrows; a sufficient dose extinguishes it for good", () => {
    const world = fixtureWorld({ fire: SMALL_FIRE, openings: { "door-ab": "open" } });
    deliverWater(world, jetAt(nozzle, FIRE_ORIGIN), 0.1, 0);
    const knockedDown = world.fires[0].heatReleaseKW;
    assert.ok(knockedDown > FIRE_MODEL.extinguishBelowKW && !world.fires[0].extinguished);
    run(world, 20);
    assert.ok(world.fires[0].heatReleaseKW > knockedDown, "regrowth after a partial dose");

    const startKW = world.fires[0].heatReleaseKW;
    let tick = 100;
    let totalReached = 0;
    while (!world.fires[0].extinguished && tick < 200) totalReached += deliverWater(world, jetAt(nozzle, FIRE_ORIGIN), 0.02, tick++);
    assert.equal(world.fires[0].extinguished, true);
    assert.equal(world.fires[0].heatReleaseKW, 0);
    assert.ok(totalReached >= (startKW - FIRE_MODEL.extinguishBelowKW) / FIRE_MODEL.suppressionKWPerL - 1e-9);
    assert.ok(world.truthEvents.some(event => event.kind === "fire_extinguished"));
    run(world, 30);
    assert.equal(world.fires[0].heatReleaseKW, 0, "an extinguished fire does not reignite");
    assert.equal(fireBlocks(world, vec3(1, 3, 0.3), vec3(5, 3, 0.3)), false);
  });
});

describe("field queries", () => {
  test("fireBlocks a segment through the burning region but not one passing beside it", () => {
    const world = fixtureWorld({ fire: SMALL_FIRE });
    assert.equal(fireBlocks(world, vec3(1, 3, 0.3), vec3(3.8, 3, 0.3)), true);
    assert.equal(fireBlocks(world, vec3(1, 2.4, 0.3), vec3(3.8, 2.4, 0.3)), false);
    assert.equal(fireBlocks(world, vec3(3, 3, 1.4), vec3(3.5, 3.5, 1.4)), false, "above the burning region");
    assert.equal(fireBlocks(world, FIRE_ORIGIN, FIRE_ORIGIN), true, "a point inside the fire");
  });

  test("optical depth integrates room extinction along the segment and the exterior is clear", () => {
    const world = fixtureWorld({ openings: { "win-a": "broken" } });
    addSmoke(world, "room-a", 1);
    const midHeight = 1.3;
    assert.ok(Math.abs(opticalDepth(world, vec3(0.5, 2, midHeight), vec3(3.5, 2, midHeight)) - 3) < 1e-9);
    assert.ok(Math.abs(opticalDepth(world, vec3(2, 2, midHeight), vec3(-3, 2, midHeight)) - 2) < 1e-9, "only the indoor part is smoky");
    assert.equal(extinctionAt(world, vec3(-3, 2, midHeight)), 0);
    assert.ok(extinctionAt(world, vec3(2, 2, 2.5)) > extinctionAt(world, vec3(2, 2, 0.2)), "smoke is denser near the ceiling");
  });

  test("temperature is hottest in the plume above the fire, not beside it, and ambient outdoors", () => {
    const world = fixtureWorld({ fire: SMALL_FIRE, openings: { "door-ab": "open" } });
    run(world, 30);
    const above = temperatureAt(world, vec3(3, 3, 1.6));
    const beside = temperatureAt(world, vec3(1.5, 3, 1.6));
    assert.ok(above > beside + 50, `above ${above} °C, beside ${beside} °C`);
    assert.ok(beside > FIRE_MODEL.ambientC, "the fire room warms");
    assert.equal(temperatureAt(world, vec3(-3, 2, 1.5)), FIRE_MODEL.ambientC);
    assert.equal(temperatureAt(world, FIRE_ORIGIN), FIRE_MODEL.flameTemperatureC);
  });

  test("the same inputs always produce the same fire and smoke state", () => {
    const a = fixtureWorld({ fire: SMALL_FIRE, openings: { "door-ab": "open" } });
    const b = fixtureWorld({ fire: SMALL_FIRE, openings: { "door-ab": "open" } });
    run(a, 45);
    run(b, 45);
    assert.deepEqual(a.compartments, b.compartments);
    assert.deepEqual(a.fires, b.fires);
  });
});
