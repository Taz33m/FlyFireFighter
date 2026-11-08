/**
 * Holding a spray standoff against the jet. Regression (main mission, troy-seed-1): two of four sprays were stopped
 * by H11 at 0.409 and 0.405 m from their standoff (tolerance 0.4 m) and the fire was never put out. The jet's
 * reaction (ρQ²/A ≈ 3.2 N at 0.2 L/s through 4 mm) on the 2.2 kg Tender needs a velocity setpoint of about
 * τ·F/m ≈ 0.29 m/s from the hold, but the motion guard capped station keeping at 0.2 m/s, so the hold saturated
 * and the aircraft crept off. While a spray discharges the cap is now policy.sprayHoldSpeedMps.
 *
 * Scope: a closed loop of the harness's own motion guard (guardMotion, motion-fixtures context), the simulator's
 * velocity dynamics and jet reaction (stepDroneDynamics, jetReactionN) and a proportional hold with the station-
 * keeping settings' gain and arrival radius (the reflex controllers' approach law, command.ts), over one full
 * 1.5 s discharge. No sensing, no fire model; the staged_spray mission run exercises the whole path.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { add, distance, norm, scale, sub, vec3 } from "../contracts/frames.ts";
import { context, guardState, motionRequest } from "../harness/motion-fixtures.ts";
import { guardMotion } from "../harness/motion-guard.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { jetReactionN, stepDroneDynamics } from "../simulation/dynamics.ts";
import type { WorldState } from "../simulation/world-state.ts";
import { STATION_KEEPING_COMMAND_CONFIG } from "./controller-slot.ts";

const STANDOFF = vec3(10, 5, 3);
/** The jet points +x from the standoff toward the fire; its reaction pushes the aircraft −x. */
const RECOIL_N = vec3(-jetReactionN(TENDER_T1.modules.water?.maxFlowLps ?? 0, TENDER_T1.modules.water?.nozzleDiameterMm ?? 0), 0, 0);
const DISCHARGE_TICKS = 150;

/** One discharge from `startOffsetM` behind the standoff; the largest offset reached and whether the guard ever capped speed. */
function discharge(startOffsetM: number, sprayActive: boolean): { maxOffsetM: number; endOffsetM: number; speedLimited: boolean } {
  const world = { drone: { velocity: vec3(0, 0, 0), yawRad: 0, yawRateRadps: 0, enduranceRemainingS: 600 }, profile: TENDER_T1 } as unknown as WorldState;
  let position: Vec3 = sub(STANDOFF, vec3(startOffsetM, 0, 0));
  let previous = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };
  let maxOffsetM = startOffsetM;
  let speedLimited = false;
  const c = STATION_KEEPING_COMMAND_CONFIG;
  for (let tick = 0; tick < DISCHARGE_TICKS; tick++) {
    const toGoal = sub(STANDOFF, position);
    const d = norm(toGoal);
    const speed = c.approachGain * Math.max(0, d - c.arrivalRadiusM);
    const v = d > 1e-9 ? scale(toGoal, speed / d) : vec3(0, 0, 0);
    const motion = guardMotion(motionRequest(v.x, v.y, v.z), context(), guardState({ activeMotion: null, interventionActive: true, sprayActive, previous }));
    assert.ok(motion !== null);
    speedLimited ||= motion.limits.includes("speed");
    previous = motion.executed;
    stepDroneDynamics(world, motion, RECOIL_N, TICK_S);
    position = add(position, scale(world.drone.velocity, TICK_S));
    maxOffsetM = Math.max(maxOffsetM, distance(position, STANDOFF));
  }
  return { maxOffsetM, endOffsetM: distance(position, STANDOFF), speedLimited };
}

describe("holding a spray standoff against the jet's reaction", () => {
  test("from 0.3 m off (the planner proposes within 0.32 m) the hold stays inside H11's 0.4 m through a full discharge", () => {
    const held = discharge(0.3, true);
    assert.ok(held.maxOffsetM < DEFAULT_POLICY.standoffToleranceM, `max ${held.maxOffsetM.toFixed(3)} m`);
    assert.ok(held.endOffsetM < 0.3, `pulled back toward the standoff: ends ${held.endOffsetM.toFixed(3)} m off`);
  });

  test("under the general 0.2 m/s station-keeping cap the same discharge saturates the hold and drifts past the tolerance", () => {
    const capped = discharge(0.3, false);
    assert.equal(capped.speedLimited, true);
    assert.ok(capped.maxOffsetM > DEFAULT_POLICY.standoffToleranceM, `max ${capped.maxOffsetM.toFixed(3)} m`);
  });

  test("the larger cap applies only while a spray executes: a breach or other hold keeps the general cap", () => {
    const fast = motionRequest(0.3, 0, 0);
    const breach = guardMotion(fast, context(), guardState({ activeMotion: null, interventionActive: true, sprayActive: false }));
    const spray = guardMotion(fast, context(), guardState({ activeMotion: null, interventionActive: true, sprayActive: true }));
    assert.ok(breach !== null && spray !== null);
    assert.ok(Math.abs(Math.hypot(breach.executed.velocityBody.x, breach.executed.velocityBody.y) - DEFAULT_POLICY.stationKeepingSpeedMps) < 1e-9 || breach.limits.includes("acceleration"));
    assert.ok(breach.limits.includes("speed"));
    assert.equal(spray.limits.includes("speed"), false);
    assert.ok(DEFAULT_POLICY.sprayHoldSpeedMps > DEFAULT_POLICY.stationKeepingSpeedMps && DEFAULT_POLICY.sprayHoldSpeedMps < 0.5);
  });
});
