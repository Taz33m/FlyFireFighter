/**
 * Hidden world truth for the digital twin.
 *
 * ONLY src/lib/simulation and src/lib/evaluation may import this module. Planners, motion controllers,
 * the evidence store and the harness receive observations and estimates only (contracts/observation.ts,
 * contracts/evidence.ts). World state is mutable inside the simulator for hot-loop performance; it
 * advances only through stepWorld at the fixed 100 Hz clock.
 */
import type { AircraftProfile } from "../contracts/aircraft.ts";
import type { JsonValue } from "../contracts/canonical.ts";
import type { Tick } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Point2, Region } from "../contracts/geometry.ts";
import type { RunId } from "../contracts/ids.ts";
import type { OpeningState } from "../contracts/observation.ts";
import type { ColliderKind, SceneMetaJson } from "../contracts/scene.ts";

/* Static scene, converted from validated scene metadata to world-frame runtime geometry. */

export interface RuntimeCollider {
  readonly id: string;
  readonly kind: ColliderKind;
  readonly min: Vec3;
  readonly max: Vec3;
  /** Glass panes and door leaves name their opening; they are removed when it is broken or opened. */
  readonly openingId: string | null;
}

export interface RuntimeRoom {
  readonly id: string;
  readonly name: string;
  readonly floor: number;
  /** Interior free space, counter-clockwise. */
  readonly polygon: readonly Point2[];
  readonly zMin: number;
  readonly zMax: number;
  readonly volumeM3: number;
}

export interface RuntimeOpening {
  readonly id: string;
  readonly kind: "door" | "window" | "opening";
  readonly rooms: readonly [string, string];
  readonly center: Vec3;
  readonly widthM: number;
  readonly heightM: number;
  readonly sillHeightM: number;
  /** Unit vector from rooms[0] toward rooms[1]. */
  readonly outwardNormal: Vec3;
  readonly initialState: "open" | "closed";
  readonly glazed: boolean;
}

export interface SceneModel {
  readonly meta: SceneMetaJson;
  readonly colliders: readonly RuntimeCollider[];
  readonly rooms: readonly RuntimeRoom[];
  readonly openings: readonly RuntimeOpening[];
  readonly floors: readonly { readonly index: number; readonly elevationM: number; readonly ceilingM: number }[];
  readonly assemblyPoint: Region;
  readonly launchPoint: { readonly position: Vec3; readonly yawRad: number };
  /** Scenario-only initialization anchors; never copied into a planner prior. */
  readonly anchors: { readonly fireOrigin: Vec3; readonly occupantStart: Vec3 };
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
}

/* Seeded scenario: initial conditions only. */

export interface ScenarioConfig {
  readonly scenarioId: string;
  readonly seed: string;
  readonly runId: RunId;
  readonly profile: AircraftProfile;
  readonly fire: { readonly roomId: string; readonly origin: Vec3; readonly radiusM: number; readonly initialHeatReleaseKW: number; readonly fuelMJ: number } | null;
  readonly occupants: readonly { readonly key: string; readonly start: Vec3; readonly mobility: "mobile" | "immobile" }[];
  /** Openings whose initial state differs from the scene metadata. */
  /** "blocked": jammed or obstructed — nobody can pass or open it (e.g. an unusable front door). */
  readonly openingOverrides: { readonly [openingId: string]: "open" | "closed" | "blocked" };
}

/* Mutable truth. */

export interface DroneTruth {
  position: Vec3;
  velocity: Vec3;
  yawRad: number;
  yawRateRadps: number;
  enduranceRemainingS: number;
  waterRemainingL: number;
  payloads: string[];
  collisions: number;
  lastCollisionTick: Tick | null;
}

export interface OpeningTruth {
  readonly id: string;
  state: OpeningState;
  /** Area open to gas flow, m²; zero while glazed and intact or closed. */
  openAreaM2: number;
}

/** A room (or "exterior") as a well-mixed compartment. */
export interface CompartmentTruth {
  readonly id: string;
  readonly volumeM3: number;
  temperatureC: number;
  /** Optical extinction coefficient for visible light, 1/m. */
  smokeExtinctionPerM: number;
}

export interface FireTruth {
  readonly id: string;
  readonly roomId: string;
  /** Active burning volume; occupants never walk through it and water must reach it. */
  region: Region;
  heatReleaseKW: number;
  fuelMJ: number;
  waterDeliveredL: number;
  extinguished: boolean;
}

export type OccupantActivity = "shelter" | "follow" | "evacuate" | "outside" | "arrived" | "incapacitated";
export type OccupantAnimation = "idle" | "crouch" | "cough" | "walk" | "follow";

export interface OccupantTruth {
  readonly key: string;
  readonly mobility: "mobile" | "immobile";
  /** The feet point on the floor; sensors and renderers add body height. */
  position: Vec3;
  velocity: Vec3;
  yawRad: number;
  activity: OccupantActivity;
  animation: OccupantAnimation;
  arrivalTick: Tick | null;
  /** Integrated smoke exposure, (1/m)·s. */
  smokeExposure: number;
}

export interface CueTruth {
  light: { readonly origin: Vec3; readonly target: Vec3; readonly tick: Tick } | null;
  audio: { readonly templateId: string; readonly origin: Vec3; readonly tick: Tick } | null;
}

/** Simulated localization error model state (not a SLAM implementation). */
export interface EstimatorState {
  driftM: Vec3;
  yawDriftRad: number;
  sigmaM: number;
  /** 0..1 quality of the range/visual features available on the last update. */
  featureQuality: number;
}

/** Truth-side record for the evaluator; never shown to planners. */
export interface TruthEvent {
  readonly tick: Tick;
  readonly kind: "collision" | "water_delivered" | "fire_extinguished" | "water_on_occupant" | "glass_broken" | "payload_released" | "occupant_activity" | "occupant_arrived";
  readonly detail: string;
  readonly data: { readonly [key: string]: JsonValue };
}

export interface WorldState {
  readonly runId: RunId;
  readonly seed: string;
  readonly scenarioId: string;
  tick: Tick;
  readonly scene: SceneModel;
  readonly profile: AircraftProfile;
  drone: DroneTruth;
  openings: OpeningTruth[];
  /** Ids of colliders currently present (broken glass and opened doors are removed). */
  activeColliderIds: Set<string>;
  compartments: CompartmentTruth[];
  fires: FireTruth[];
  occupants: OccupantTruth[];
  cues: CueTruth;
  estimator: EstimatorState;
  truthEvents: TruthEvent[];
}

export function activeColliders(world: WorldState): RuntimeCollider[] {
  return world.scene.colliders.filter(collider => world.activeColliderIds.has(collider.id));
}
