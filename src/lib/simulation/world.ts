/**
 * World construction and the fixed 100 Hz step: the only way simulated truth advances.
 *
 * stepWorld accepts only batches the harness issued in this process, for this run and exactly the world's
 * current tick, so no planner, controller, UI handler or replayed batch can actuate the aircraft or skip
 * time. Order within a tick: actuator commands (water, strike, release, cues) → aircraft dynamics with jet
 * recoil → swept collisions → occupants → fire and smoke every FIRE_PERIOD_TICKS (stepped by
 * FIRE_PERIOD_TICKS·TICK_S once that much time has elapsed) → localization error model → tick + 1.
 * Rendering rate and wall time never enter.
 */
import type { ActuatorBatch } from "../contracts/actions.ts";
import { FIRE_PERIOD_TICKS, TICK_S } from "../contracts/clock.ts";
import { isFiniteVec3, ZERO } from "../contracts/frames.ts";
import { isHarnessIssued } from "../harness/issued.ts";
import { applyActuatorCommands } from "./actuators.ts";
import { moveDrone } from "./collisions.ts";
import { stepDroneDynamics } from "./dynamics.ts";
import { initFireState, stepFire } from "./fire.ts";
import { initEstimator, updateEstimator } from "./localization.ts";
import { stepOccupants } from "./occupant.ts";
import { clearOpeningAreaM2 } from "./scene.ts";
import type { OccupantTruth, OpeningTruth, ScenarioConfig, SceneModel, WorldState } from "./world-state.ts";

export interface WorldOptions {
  /** Payload ids aboard at launch; defaults to one "smoke-hood-N" per payload-bay slot. */
  readonly payloads?: readonly string[];
}

function scenarioErrors(scene: SceneModel, scenario: ScenarioConfig): string[] {
  const errors: string[] = [];
  if (!scenario.runId) errors.push("runId must be non-empty");
  if (!(scenario.profile.massKg > 0 && scenario.profile.spanM > 0)) errors.push("profile mass and span must be positive");
  const openingIds = new Set(scene.openings.map(o => o.id));
  for (const [id, state] of Object.entries(scenario.openingOverrides)) {
    if (!openingIds.has(id)) errors.push(`opening override names unknown opening ${id}`);
    if (state !== "open" && state !== "closed" && state !== "blocked") errors.push(`opening override for ${id} must be "open", "closed" or "blocked"`);
  }
  const keys = new Set<string>();
  for (const o of scenario.occupants) {
    if (keys.has(o.key)) errors.push(`duplicate occupant key ${o.key}`);
    keys.add(o.key);
    if (!isFiniteVec3(o.start)) errors.push(`occupant ${o.key} start must be finite`);
  }
  return errors;
}

export function newOccupant(key: string, start: OccupantTruth["position"], mobility: OccupantTruth["mobility"]): OccupantTruth {
  return { key, mobility, position: start, velocity: ZERO, yawRad: 0, activity: "shelter", animation: "idle", arrivalTick: null, smokeExposure: 0 };
}

/**
 * Initial truth for one run. The world owns a shallow copy of the scene with its own collider list (so
 * experiments can add obstructions without touching the shared, frozen scene model).
 */
export function createWorld(scene: SceneModel, scenario: ScenarioConfig, options: WorldOptions = {}): WorldState {
  const errors = scenarioErrors(scene, scenario);
  if (errors.length > 0) throw new RangeError(`Invalid scenario ${scenario.scenarioId}: ${errors.join("; ")}`);
  const profile = scenario.profile;
  const openings: OpeningTruth[] = scene.openings.map(o => {
    const state = scenario.openingOverrides[o.id] ?? o.initialState;
    return { id: o.id, state, openAreaM2: state === "open" ? clearOpeningAreaM2(o) : 0 };
  });
  const shut = new Set(openings.filter(o => o.state !== "open").map(o => o.id));
  const { compartments, fires } = initFireState(scene, scenario, openings);
  const slots = profile.modules.payloadBay?.slots ?? 0;
  return {
    runId: scenario.runId,
    seed: scenario.seed,
    scenarioId: scenario.scenarioId,
    tick: 0,
    scene: { ...scene, colliders: [...scene.colliders] },
    profile,
    drone: {
      position: scene.launchPoint.position,
      velocity: ZERO,
      yawRad: scene.launchPoint.yawRad,
      yawRateRadps: 0,
      enduranceRemainingS: profile.hardLimits.enduranceS,
      waterRemainingL: profile.modules.water?.tankL ?? 0,
      payloads: [...(options.payloads ?? Array.from({ length: slots }, (_, i) => `smoke-hood-${i + 1}`))],
      collisions: 0,
      lastCollisionTick: null,
    },
    openings,
    activeColliderIds: new Set(scene.colliders.filter(c => c.openingId === null || shut.has(c.openingId)).map(c => c.id)),
    compartments,
    fires,
    occupants: scenario.occupants.map(o => newOccupant(o.key, o.start, o.mobility)),
    cues: { light: null, audio: null },
    estimator: initEstimator(),
    truthEvents: [],
  };
}

/** Advances the world by one tick. Throws on a batch that is not harness-issued, for another run or for another tick. */
export function stepWorld(world: WorldState, batch: ActuatorBatch): void {
  if (!isHarnessIssued(batch)) throw new Error("stepWorld accepts only harness-issued actuator batches.");
  if (batch.runId !== world.runId) throw new Error(`Batch for run ${batch.runId} cannot step run ${world.runId}.`);
  if (batch.tick !== world.tick) throw new Error(`Batch tick ${batch.tick} does not match world tick ${world.tick}.`);
  const recoilN = applyActuatorCommands(world, batch.commands);
  stepDroneDynamics(world, batch.motion, recoilN, TICK_S);
  moveDrone(world, TICK_S);
  stepOccupants(world, TICK_S);
  if ((world.tick + 1) % FIRE_PERIOD_TICKS === 0) stepFire(world, FIRE_PERIOD_TICKS * TICK_S);
  updateEstimator(world);
  world.tick += 1;
}
