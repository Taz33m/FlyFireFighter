import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { GuardedMotion } from "../contracts/actions.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { TICK_S } from "../contracts/clock.ts";
import { vec3, ZERO } from "../contracts/frames.ts";
import { droneRadiusM, isTouchedDown, moveDrone } from "./collisions.ts";
import { stepDroneDynamics } from "./dynamics.ts";
import { parseSceneMeta, sceneModelFromMeta } from "./scene.ts";
import { bareWorld, forward, guarded } from "./world-fixtures.ts";
import type { WorldState } from "./world-state.ts";

const PANE_OUTER_Y = 7.905;
const TROY = sceneModelFromMeta(parseSceneMeta(JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8"))));
/** Over the Troy house's flat roof: the top face (z 6.9) of the "ceiling" box col-ceiling-f1-01. */
const TROY_ROOF = { x: 15.5, y: 1.5, topZ: 6.9 };
const MAX_SPEED = TENDER_T1.hardLimits.maxSpeedMps;

function run(world: WorldState, motion: GuardedMotion | null, ticks: number, onTick?: (w: WorldState) => void): void {
  for (let i = 0; i < ticks; i++) {
    stepDroneDynamics(world, motion, ZERO, TICK_S);
    moveDrone(world, TICK_S);
    world.tick += 1;
    onTick?.(world);
  }
}

const collisionEvents = (world: WorldState) => world.truthEvents.filter(e => e.kind === "collision");

/** Outside the rear bedroom window, facing it (south), centred on the 1.0 × 1.2 m opening. */
const outsideRearWindow = (): WorldState => bareWorld({ position: vec3(7.0, 9.0, 4.4), yawRad: -Math.PI / 2 });

describe("swept aircraft collisions", () => {
  test("at maximum speed the aircraft cannot tunnel through a 1 cm pane: it stops, records one collision and keeps its clearance", () => {
    const world = outsideRearWindow();
    world.drone.velocity = vec3(0, -MAX_SPEED, 0);
    const r = droneRadiusM(world);
    let closest = Infinity;
    run(world, guarded(forward(MAX_SPEED)), 150, w => { closest = Math.min(closest, w.drone.position.y); });
    assert.ok(closest >= PANE_OUTER_Y + r - 1e-6, `centre reached y=${closest}`);
    const events = collisionEvents(world);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.colliderId, "glass-rear-bedroom");
    assert.ok((events[0].data.speedMps as number) > 3.5);
    assert.equal(world.drone.collisions, 1);
    assert.ok(Math.abs(world.drone.velocity.y) < 0.05, "velocity into the pane is removed");
  });

  test("no tunnelling even when one step travels farther than the pane plus the aircraft diameter", () => {
    const world = outsideRearWindow();
    world.drone.position = vec3(7.0, 8.6, 4.4);
    world.drone.velocity = vec3(0, -100, 0);
    moveDrone(world, TICK_S);
    assert.ok(world.drone.position.y >= PANE_OUTER_Y + droneRadiusM(world) - 1e-6);
    assert.equal(collisionEvents(world).length, 1);
  });

  test("at maximum speed into an exterior wall: one collision, stopped short of the wall face", () => {
    const world = bareWorld({ position: vec3(8.0, 2.0, 1.5), yawRad: 0 });
    world.drone.velocity = vec3(MAX_SPEED, 0, 0);
    let farthest = -Infinity;
    run(world, guarded(forward(MAX_SPEED)), 150, w => { farthest = Math.max(farthest, w.drone.position.x); });
    assert.ok(farthest <= 9.8 - droneRadiusM(world) + 1e-6, `centre reached x=${farthest}`);
    const events = collisionEvents(world);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.colliderKind, "wall");
    assert.ok((events[0].data.speedMps as number) > 3.5);
  });

  test("the same approach passes through once the pane's collider is no longer active", () => {
    const world = outsideRearWindow();
    world.activeColliderIds.delete("glass-rear-bedroom");
    run(world, guarded(forward(2)), 150);
    assert.ok(world.drone.position.y < 7.5, `y=${world.drone.position.y}`);
    assert.equal(collisionEvents(world).length, 0);
  });

  test("an oblique contact removes only the velocity into the wall, so the aircraft slides", () => {
    const world = bareWorld({ position: vec3(9.3, 2.0, 1.5), yawRad: 0 });
    world.drone.velocity = vec3(1, 1, 0);
    moveDrone(world, 0.5);
    assert.equal(collisionEvents(world).length, 1);
    assert.ok(Math.abs(world.drone.velocity.x) < 1e-9 && Math.abs(world.drone.velocity.y - 1) < 1e-9);
    assert.ok(world.drone.position.y > 2.2, "kept moving along the wall");
  });

  test("sustained pressing is one collision; a new strike after leaving contact counts again", () => {
    const world = bareWorld({ position: vec3(9.0, 2.0, 1.5), yawRad: 0 });
    run(world, guarded(forward(1)), 150);
    assert.equal(world.drone.collisions, 1);
    run(world, guarded(forward(-1)), 100);
    run(world, guarded(forward(1)), 150);
    assert.equal(world.drone.collisions, 2);
    assert.equal(collisionEvents(world).length, 2);
  });

  test("a slow descent onto the ground is a touchdown, a fast one is a collision", () => {
    const soft = bareWorld({ position: vec3(6, -8, 0.8), yawRad: 0 });
    run(soft, guarded(vec3(0, 0, -0.4)), 300);
    assert.equal(collisionEvents(soft).length, 0);
    assert.ok(isTouchedDown(soft));
    assert.ok(soft.drone.position.z >= droneRadiusM(soft) - 1e-6);

    const hard = bareWorld({ position: vec3(6, -8, 1.2), yawRad: 0 });
    hard.drone.velocity = vec3(0, 0, -3);
    run(hard, null, 120);
    assert.equal(collisionEvents(hard).length, 1);
    assert.equal(collisionEvents(hard)[0].data.colliderKind, "ground");
  });

  test("support is decided by contact geometry: a slow descent onto the flat roof's top face (a ceiling box) is a touchdown", () => {
    const world = bareWorld({ scene: TROY, position: vec3(TROY_ROOF.x, TROY_ROOF.y, TROY_ROOF.topZ + 0.6), yawRad: 0 });
    run(world, guarded(vec3(0, 0, -0.3)), 300);
    assert.deepEqual(collisionEvents(world).map(e => e.detail), []);
    assert.ok(isTouchedDown(world));
    assert.ok(Math.abs(world.drone.position.z - (TROY_ROOF.topZ + droneRadiusM(world))) < 0.05);
  });

  test("the same roof top struck faster than the touchdown speed, a wall face struck sideways and a ceiling struck from below are collisions", () => {
    const fast = bareWorld({ scene: TROY, position: vec3(TROY_ROOF.x, TROY_ROOF.y, TROY_ROOF.topZ + 0.6), yawRad: 0 });
    fast.drone.velocity = vec3(0, 0, -3);
    run(fast, null, 60);
    assert.equal(collisionEvents(fast).length, 1);
    assert.equal(collisionEvents(fast)[0].data.colliderId, "col-ceiling-f1-01");

    // Upstairs in the stairwell, drifting west at 0.3 m/s into the face of the sealed mass (a "wall" box).
    const side = bareWorld({ scene: TROY, position: vec3(14.6, 3.757, 5.0), yawRad: Math.PI });
    run(side, guarded(forward(0.3)), 200);
    assert.equal(collisionEvents(side).length, 1);
    assert.equal(collisionEvents(side)[0].data.colliderId, "col-mass-ra-upper");
    assert.equal(isTouchedDown(side), false);

    // Rising at 0.3 m/s under the upstairs ceiling: the underside of the same box is never a support.
    const below = bareWorld({ scene: TROY, position: vec3(TROY_ROOF.x + 2, TROY_ROOF.y, 6.0), yawRad: 0 });
    run(below, guarded(vec3(0, 0, 0.3)), 200);
    assert.equal(collisionEvents(below).length, 1);
    assert.equal(collisionEvents(below)[0].data.colliderKind, "ceiling");
  });

  test("a hovering aircraft is not touched down", () => {
    const world = bareWorld({ position: vec3(6, -8, 2), yawRad: 0 });
    assert.equal(isTouchedDown(world), false);
  });
});
