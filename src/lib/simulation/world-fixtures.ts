/**
 * Test helpers: a bare WorldState over a scene with no fire or smoke and a zero-error estimator, for unit
 * tests of dynamics, collisions, actuators and occupants that must not depend on the fire model. Production
 * worlds come from createWorld (world.ts). Deliberately does not issue actuator batches: only tests (standing
 * in for the harness) call issueBatch.
 */
import type { GuardedMotion, MotionCommand } from "../contracts/actions.ts";
import type { AircraftProfile } from "../contracts/aircraft.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3, ZERO } from "../contracts/frames.ts";
import { FIXTURE_SCENE_META } from "./fixture-scene.ts";
import { sceneModelFromMeta } from "./scene.ts";
import type { OccupantTruth, SceneModel, WorldState } from "./world-state.ts";

export const FIXTURE_SCENE: SceneModel = sceneModelFromMeta(FIXTURE_SCENE_META);

export interface BareWorldOptions {
  readonly scene?: SceneModel;
  readonly profile?: AircraftProfile;
  readonly position?: Vec3;
  readonly yawRad?: number;
  readonly runId?: string;
}

export function bareWorld(options: BareWorldOptions = {}): WorldState {
  const scene = options.scene ?? FIXTURE_SCENE;
  const profile = options.profile ?? TENDER_T1;
  const openings = scene.openings.map(o => ({ id: o.id, state: o.initialState, openAreaM2: o.initialState === "open" ? o.widthM * o.heightM : 0 }));
  const closed = new Set(openings.filter(o => o.state === "closed").map(o => o.id));
  return {
    runId: options.runId ?? "run-bare",
    seed: "bare-seed",
    scenarioId: "bare",
    tick: 0,
    scene: { ...scene, colliders: [...scene.colliders] },
    profile,
    drone: {
      position: options.position ?? scene.launchPoint.position,
      velocity: ZERO,
      yawRad: options.yawRad ?? scene.launchPoint.yawRad,
      yawRateRadps: 0,
      enduranceRemainingS: profile.hardLimits.enduranceS,
      waterRemainingL: profile.modules.water?.tankL ?? 0,
      payloads: ["smoke-hood-1"],
      collisions: 0,
      lastCollisionTick: null,
    },
    openings,
    activeColliderIds: new Set(scene.colliders.filter(c => c.openingId === null || closed.has(c.openingId)).map(c => c.id)),
    compartments: [],
    fires: [],
    occupants: [],
    cues: { light: null, audio: null },
    estimator: { driftM: ZERO, yawDriftRad: 0, sigmaM: 0.05, featureQuality: 1 },
    truthEvents: [],
  };
}

export function occupantAt(key: string, position: Vec3, mobility: OccupantTruth["mobility"] = "mobile"): OccupantTruth {
  return { key, mobility, position, velocity: ZERO, yawRad: 0, activity: "shelter", animation: "idle", arrivalTick: null, smokeExposure: 0 };
}

export function guarded(velocityBody: Vec3, yawRateRadps = 0, tick: Tick = 0): GuardedMotion {
  const executed: MotionCommand = { velocityBody, yawRateRadps };
  return { requested: { source: "operator", tick, velocityBody, yawRateRadps }, executed, limits: [] };
}

export const forward = (speedMps: number): Vec3 => vec3(speedMps, 0, 0);
