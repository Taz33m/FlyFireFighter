/**
 * Truth-side aircraft dynamics for one fixed 100 Hz step (simplified; not a validated flight model).
 *
 * The onboard controller tracks the harness-guarded body-frame velocity with a first-order response whose
 * commanded acceleration is limited by hardLimits.maxAccelMps2. The jet reaction is an external force the
 * velocity loop must fight, so a discharging aircraft drifts by about τ·F/m until a position loop corrects
 * it. Yaw rate tracks its command with a shorter time constant. Gravity and hover thrust are folded into
 * the controller; there is no attitude, rotor or aerodynamic model. Position integration and collision
 * response happen in collisions.ts.
 */
import type { GuardedMotion } from "../contracts/actions.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { add, isFiniteVec3, norm, rotateBodyToWorld, scale, sub, vec3, wrapAngle, ZERO } from "../contracts/frames.ts";
import type { WorldState } from "./world-state.ts";

/** Velocity-loop time constant, s. */
export const VELOCITY_TIME_CONSTANT_S = 0.2;
/** Yaw-rate loop time constant, s. */
export const YAW_RATE_TIME_CONSTANT_S = 0.1;
/** Uncommanded descent once endurance is exhausted, m/s. */
export const FORCED_DESCENT_MPS = 0.5;
export const WATER_DENSITY_KG_M3 = 1000;

/** Jet reaction force F = ρQ²/A in newtons (Q in m³/s, A the nozzle exit area in m²). */
export function jetReactionN(flowLps: number, nozzleDiameterMm: number): number {
  const q = flowLps / 1000;
  const radiusM = nozzleDiameterMm / 2000;
  const area = Math.PI * radiusM * radiusM;
  return area > 0 ? (WATER_DENSITY_KG_M3 * q * q) / area : 0;
}

function clampMagnitude(v: Vec3, max: number): Vec3 {
  const n = norm(v);
  return n > max && n > 0 ? scale(v, max / n) : v;
}

/** World-frame velocity setpoint and yaw-rate command for this step. A null motion is a zero setpoint. */
function setpoint(world: WorldState, motion: GuardedMotion | null): { velocity: Vec3; yawRate: number } {
  const drone = world.drone;
  if (drone.enduranceRemainingS <= 0) return { velocity: vec3(0, 0, -FORCED_DESCENT_MPS), yawRate: 0 };
  const executed = motion?.executed;
  if (!executed || !isFiniteVec3(executed.velocityBody) || !Number.isFinite(executed.yawRateRadps)) return { velocity: ZERO, yawRate: 0 };
  const maxYaw = world.profile.hardLimits.maxYawRateRadps;
  return {
    velocity: rotateBodyToWorld(drone.yawRad, executed.velocityBody),
    yawRate: Math.max(-maxYaw, Math.min(maxYaw, executed.yawRateRadps)),
  };
}

/**
 * Advances velocity, yaw and endurance by dtS. `recoilN` is the jet reaction force in the world frame
 * (zero when not discharging). Does not move the aircraft.
 */
export function stepDroneDynamics(world: WorldState, motion: GuardedMotion | null, recoilN: Vec3, dtS: number): void {
  const drone = world.drone;
  const target = setpoint(world, motion);
  const tracking = clampMagnitude(scale(sub(target.velocity, drone.velocity), 1 / VELOCITY_TIME_CONSTANT_S), world.profile.hardLimits.maxAccelMps2);
  const external = scale(recoilN, 1 / world.profile.massKg);
  drone.velocity = add(drone.velocity, scale(add(tracking, external), dtS));
  drone.yawRateRadps += (target.yawRate - drone.yawRateRadps) * Math.min(1, dtS / YAW_RATE_TIME_CONSTANT_S);
  drone.yawRad = wrapAngle(drone.yawRad + drone.yawRateRadps * dtS);
  drone.enduranceRemainingS = Math.max(0, drone.enduranceRemainingS - dtS);
}
