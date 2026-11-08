import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GuardedMotion } from "../contracts/actions.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { norm, sub, vec3, ZERO } from "../contracts/frames.ts";
import { moveDrone } from "./collisions.ts";
import { jetReactionN, stepDroneDynamics, VELOCITY_TIME_CONSTANT_S } from "./dynamics.ts";
import { bareWorld, forward, guarded } from "./world-fixtures.ts";
import type { WorldState } from "./world-state.ts";

/** An open-air spot in front of the fixture house (above the street, clear of every collider). */
const OPEN_AIR = vec3(4, -16, 3);

function run(world: WorldState, motion: GuardedMotion | null, ticks: number, recoil: Vec3 = ZERO, onTick?: (w: WorldState) => void): void {
  for (let i = 0; i < ticks; i++) {
    stepDroneDynamics(world, motion, recoil, TICK_S);
    moveDrone(world, TICK_S);
    world.tick += 1;
    onTick?.(world);
  }
}

describe("aircraft dynamics", () => {
  test("tracks a body velocity command first-order without exceeding the acceleration hard limit", () => {
    const world = bareWorld({ position: OPEN_AIR, yawRad: 0 });
    const limit = TENDER_T1.hardLimits.maxAccelMps2;
    let previous = world.drone.velocity;
    let worst = 0;
    run(world, guarded(forward(3)), 300, ZERO, w => {
      worst = Math.max(worst, norm(sub(w.drone.velocity, previous)) / TICK_S);
      previous = w.drone.velocity;
    });
    assert.ok(worst <= limit + 1e-9, `peak acceleration ${worst}`);
    assert.ok(Math.abs(world.drone.velocity.x - 3) < 0.01);
    assert.ok(world.drone.position.x > OPEN_AIR.x + 5);
  });

  test("interprets the command in the body frame of the true heading", () => {
    const world = bareWorld({ position: OPEN_AIR, yawRad: Math.PI / 2 });
    run(world, guarded(forward(1)), 200);
    assert.ok(Math.abs(world.drone.velocity.y - 1) < 0.01 && Math.abs(world.drone.velocity.x) < 1e-9);
  });

  test("a null motion is a zero setpoint: the aircraft brakes to a stop", () => {
    const world = bareWorld({ position: OPEN_AIR, yawRad: 0 });
    world.drone.velocity = vec3(2, 0, 0);
    run(world, null, 200);
    assert.ok(norm(world.drone.velocity) < 1e-3);
  });

  test("jet recoil drifts a hovering aircraft opposite the jet by about τ·F/m", () => {
    const force = jetReactionN(0.2, 4);
    assert.ok(Math.abs(force - 3.18) < 0.01, `F = ${force}`);
    const world = bareWorld({ position: OPEN_AIR, yawRad: 0 });
    run(world, guarded(ZERO), 300, vec3(-force, 0, 0));
    const expected = (VELOCITY_TIME_CONSTANT_S * force) / TENDER_T1.massKg;
    assert.ok(Math.abs(world.drone.velocity.x + expected) < 1e-3, `drift ${world.drone.velocity.x}`);
    assert.ok(world.drone.position.x < OPEN_AIR.x - 0.5);
  });

  test("yaw rate tracks its command, clamped to the hard limit", () => {
    const world = bareWorld({ position: OPEN_AIR, yawRad: 0 });
    const limit = TENDER_T1.hardLimits.maxYawRateRadps;
    let peak = 0;
    run(world, guarded(ZERO, 10), 100, ZERO, w => { peak = Math.max(peak, w.drone.yawRateRadps); });
    assert.ok(peak <= limit + 1e-12 && Math.abs(world.drone.yawRateRadps - limit) < 1e-3);
  });

  test("endurance drains with time and, once exhausted, the aircraft descends regardless of the command", () => {
    const world = bareWorld({ position: OPEN_AIR, yawRad: 0 });
    run(world, guarded(ZERO), 100);
    assert.ok(Math.abs(world.drone.enduranceRemainingS - (TENDER_T1.hardLimits.enduranceS - 1)) < 1e-9);
    world.drone.enduranceRemainingS = 0;
    run(world, guarded(vec3(0, 0, 1)), 200);
    assert.ok(world.drone.velocity.z < -0.4 && world.drone.position.z < OPEN_AIR.z);
  });
});
