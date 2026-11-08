/**
 * Station keeping against jet recoil, closed loop on the simulator's own aircraft dynamics (dynamics.ts) and the
 * shared reflex hold law (command.ts holdTranslation): a spray's reaction force acts on the aircraft while the
 * hold steers it back to its standoff. The harness stops a spray once the aircraft is more than its standoff
 * tolerance (H11, 0.4 m) from the standoff.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GuardedMotion } from "../contracts/actions.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { TICK_S } from "../contracts/clock.ts";
import { rotateWorldToBody, vec3 } from "../contracts/frames.ts";
import type { CommandConfig } from "../navigation/reflex/command.ts";
import { holdTranslation } from "../navigation/reflex/command.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { jetReactionN, stepDroneDynamics } from "../simulation/dynamics.ts";
import { bareWorld } from "../simulation/world-fixtures.ts";
import { DOCKING_COMMAND_CONFIG, STATION_KEEPING_COMMAND_CONFIG } from "./controller-slot.ts";

/** Largest horizontal distance from the standoff during a spray that starts `startOffM` behind it. */
function maxOffsetDuringSpray(config: CommandConfig, startOffM: number, durationS: number): number {
  const standoff = vec3(5, 5, 2);
  const world = bareWorld({ position: vec3(standoff.x - startOffM, standoff.y, standoff.z), yawRad: 0 });
  const water = TENDER_T1.modules.water;
  assert.ok(water);
  // The jet points along +x, so its reaction pushes the aircraft along −x, away from the standoff's aim.
  const recoil = vec3(-jetReactionN(water.maxFlowLps, water.nozzleDiameterMm), 0, 0);
  let worst = 0;
  for (let i = 0; i < Math.round(durationS / TICK_S); i++) {
    const drone = world.drone;
    const offset = rotateWorldToBody(drone.yawRad, vec3(standoff.x - drone.position.x, standoff.y - drone.position.y, 0));
    const goal = { bearingRad: Math.atan2(offset.y, offset.x), distanceM: Math.hypot(offset.x, offset.y), heightErrorM: 0 };
    const hold = holdTranslation(config, goal, config.cruiseSpeedMps);
    const motion = { executed: { velocityBody: vec3(hold.forward, hold.lateral, 0), yawRateRadps: 0 } } as unknown as GuardedMotion;
    stepDroneDynamics(world, motion, recoil, TICK_S);
    drone.position = vec3(drone.position.x + drone.velocity.x * TICK_S, drone.position.y + drone.velocity.y * TICK_S, drone.position.z);
    worst = Math.max(worst, Math.hypot(standoff.x - drone.position.x, standoff.y - drone.position.y));
  }
  return worst;
}

describe("station keeping against jet recoil", () => {
  const tolerance = DEFAULT_POLICY.standoffToleranceM;

  test("the docking hold lets a discharging Tender drift past the harness's standoff tolerance", () => {
    assert.ok(maxOffsetDuringSpray(DOCKING_COMMAND_CONFIG, 0.32, 4) > tolerance, "reproduces the live H11 stops at 0.402-0.422 m");
  });

  test("the station-keeping hold keeps it inside the tolerance with margin, from anywhere on station", () => {
    for (const start of [0, 0.15, 0.32]) {
      const worst = maxOffsetDuringSpray(STATION_KEEPING_COMMAND_CONFIG, start, 6);
      assert.ok(worst < tolerance - 0.05, `start ${start} m: worst ${worst.toFixed(3)} m`);
    }
  });
});
