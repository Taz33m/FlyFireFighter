/**
 * Authored test worlds for the fire, localization and sensor models. Built directly from world-state types
 * (independent of the scene loader) so these tests exercise the models alone.
 *
 * Two 4 m × 4 m rooms, 2.6 m high, on one floor (walls 0.1 m thick):
 *   room-a  x 0..4,     y 0..4   west window win-a (glazed, 1.0 × 1.2 m, sill 0.9) to the exterior;
 *                                a table (top 0.7–0.75 m) on four 4 cm legs at x 2.4–3.4, y 0.6–1.4
 *   room-b  x 4.1..8.1, y 0..4   east window win-b (glazed) to the exterior
 *   door-ab in the shared wall (x 4..4.1), 0.9 × 2.0 m, centre y 2; closed leaf collider when closed.
 * A ground slab, a ceiling slab and a perimeter of exterior walls complete the colliders.
 */
import type { AircraftProfile } from "../contracts/aircraft.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import { box } from "../contracts/geometry.ts";
import type { OpeningState } from "../contracts/observation.ts";
import type { ColliderKind } from "../contracts/scene.ts";
import { SCENE_META_SCHEMA } from "../contracts/scene.ts";
import { initFireState } from "./fire.ts";
import { initEstimator } from "./localization.ts";
import type { OccupantTruth, OpeningTruth, RuntimeCollider, RuntimeOpening, RuntimeRoom, ScenarioConfig, SceneModel, WorldState } from "./world-state.ts";

export const ROOM_HEIGHT_M = 2.6;

function collider(id: string, kind: ColliderKind, min: readonly [number, number, number], max: readonly [number, number, number], openingId: string | null = null): RuntimeCollider {
  return { id, kind, min: vec3(...min), max: vec3(...max), openingId };
}

const H = ROOM_HEIGHT_M;

const COLLIDERS: readonly RuntimeCollider[] = [
  collider("ground", "ground", [-12, -12, -0.2], [22, 16, 0]),
  collider("ceiling", "ceiling", [-0.1, -0.1, H], [8.2, 4.1, H + 0.1]),
  collider("wall-south", "wall", [-0.1, -0.1, 0], [8.2, 0, H]),
  collider("wall-north", "wall", [-0.1, 4, 0], [8.2, 4.1, H]),
  // West wall around win-a (y 1.5..2.5, z 0.9..2.1).
  collider("wall-west-1", "wall", [-0.1, 0, 0], [0, 1.5, H]),
  collider("wall-west-2", "wall", [-0.1, 2.5, 0], [0, 4, H]),
  collider("wall-west-sill", "wall", [-0.1, 1.5, 0], [0, 2.5, 0.9]),
  collider("wall-west-head", "wall", [-0.1, 1.5, 2.1], [0, 2.5, H]),
  collider("win-a-glass", "glass", [-0.055, 1.5, 0.9], [-0.045, 2.5, 2.1], "win-a"),
  // Shared wall around door-ab (y 1.55..2.45, z 0..2.0).
  collider("wall-mid-1", "wall", [4, 0, 0], [4.1, 1.55, H]),
  collider("wall-mid-2", "wall", [4, 2.45, 0], [4.1, 4, H]),
  collider("wall-mid-head", "wall", [4, 1.55, 2.0], [4.1, 2.45, H]),
  collider("door-ab-leaf", "door", [4.02, 1.55, 0], [4.08, 2.45, 2.0], "door-ab"),
  // East wall around win-b.
  collider("wall-east-1", "wall", [8.1, 0, 0], [8.2, 1.5, H]),
  collider("wall-east-2", "wall", [8.1, 2.5, 0], [8.2, 4, H]),
  collider("wall-east-sill", "wall", [8.1, 1.5, 0], [8.2, 2.5, 0.9]),
  collider("wall-east-head", "wall", [8.1, 1.5, 2.1], [8.2, 2.5, H]),
  collider("win-b-glass", "glass", [8.145, 1.5, 0.9], [8.155, 2.5, 2.1], "win-b"),
  // Table in room-a: thin legs, solid top.
  collider("table-top", "furniture", [2.4, 0.6, 0.7], [3.4, 1.4, 0.75]),
  collider("table-leg-1", "furniture", [2.4, 0.6, 0], [2.44, 0.64, 0.7]),
  collider("table-leg-2", "furniture", [3.36, 0.6, 0], [3.4, 0.64, 0.7]),
  collider("table-leg-3", "furniture", [2.4, 1.36, 0], [2.44, 1.4, 0.7]),
  collider("table-leg-4", "furniture", [3.36, 1.36, 0], [3.4, 1.4, 0.7]),
];

function room(id: string, x0: number, x1: number): RuntimeRoom {
  return { id, name: id, floor: 0, polygon: [[x0, 0], [x1, 0], [x1, 4], [x0, 4]], zMin: 0, zMax: H, volumeM3: (x1 - x0) * 4 * H };
}

function opening(id: string, kind: RuntimeOpening["kind"], rooms: readonly [string, string], center: Vec3, size: readonly [number, number, number], normal: Vec3, glazed: boolean): RuntimeOpening {
  const [widthM, heightM, sillHeightM] = size;
  return { id, kind, rooms, center, widthM, heightM, sillHeightM, outwardNormal: normal, initialState: "closed", glazed };
}

const OPENINGS: readonly RuntimeOpening[] = [
  opening("door-ab", "door", ["room-a", "room-b"], vec3(4.05, 2, 1), [0.9, 2, 0], vec3(1, 0, 0), false),
  opening("win-a", "window", ["room-a", "exterior"], vec3(-0.05, 2, 1.5), [1, 1.2, 0.9], vec3(-1, 0, 0), true),
  opening("win-b", "window", ["room-b", "exterior"], vec3(8.15, 2, 1.5), [1, 1.2, 0.9], vec3(1, 0, 0), true),
];

const FLOORS = [{ index: 0, elevationM: 0, ceilingM: H }] as const;

/** The shared two-room scene; one immutable object so per-scene geometry caches are reused. */
export const TWO_ROOM_SCENE: SceneModel = {
  meta: {
    schema: SCENE_META_SCHEMA,
    sceneId: "fixture-two-room",
    revision: 1,
    units: "m",
    frames: { world: "Z up, X east, Y north", gltf: "Y up" },
    origin: { description: "authored test fixture", latLon: null },
    provenance: {
      exterior: { reference: "none (test fixture)", method: "authored", sources: [], estimated: [] },
      interior: { kind: "authored_fictional", statement: "Authored test fixture, not a real building." },
      incident: "fictional",
    },
    floors: FLOORS,
    rooms: [],
    openings: [],
    stairs: [],
    colliders: [],
    exits: [],
    assemblyPoint: { id: "assembly", min: [-8, -8, 0], max: [-6, -6, 2] },
    launchPoint: { position: [-5, 2, 1.5], yawRad: 0 },
    scenarioAnchors: { scenarioOnly: true, note: "fixture", fireOrigin: [3, 3, 0.3], occupantStart: [6, 2, 0] },
    drone: { spanM: 0.55, heightM: 0.2, camera: { positionBody: [0.12, 0, 0.02], pitchRad: 0.17, horizontalFovDeg: 90 } },
    bounds: { min: [-12, -12, -0.2], max: [22, 16, 3] },
    assets: {},
  },
  colliders: COLLIDERS,
  rooms: [room("room-a", 0, 4), room("room-b", 4.1, 8.1)],
  openings: OPENINGS,
  floors: FLOORS,
  assemblyPoint: box(vec3(-8, -8, 0), vec3(-6, -6, 2)),
  launchPoint: { position: vec3(-5, 2, 1.5), yawRad: 0 },
  anchors: { fireOrigin: vec3(3, 3, 0.3), occupantStart: vec3(6, 2, 0) },
  bounds: { min: vec3(-12, -12, -0.2), max: vec3(22, 16, 3) },
};

export interface FixtureOptions {
  /** A scene derived from TWO_ROOM_SCENE (e.g. with extra colliders); defaults to TWO_ROOM_SCENE. */
  readonly scene?: SceneModel;
  readonly seed?: string;
  readonly tick?: Tick;
  readonly profile?: AircraftProfile;
  readonly drone?: { readonly position: Vec3; readonly yawRad?: number; readonly velocity?: Vec3 };
  /** Opening states; everything else starts closed (intact glass, closed door). */
  readonly openings?: { readonly [openingId: string]: OpeningState };
  readonly fire?: ScenarioConfig["fire"];
  readonly occupants?: readonly { readonly key: string; readonly position: Vec3; readonly animation?: OccupantTruth["animation"] }[];
}

export function fixtureWorld(options: FixtureOptions = {}): WorldState {
  const scene = options.scene ?? TWO_ROOM_SCENE;
  const profile = options.profile ?? TENDER_T1;
  const openings: OpeningTruth[] = scene.openings.map(o => ({ id: o.id, state: "closed", openAreaM2: 0 }));
  const scenario: ScenarioConfig = { scenarioId: scene.meta.sceneId, seed: options.seed ?? "fixture-seed", runId: "run-fixture", profile, fire: options.fire ?? null, occupants: [], openingOverrides: {} };
  const world: WorldState = {
    runId: scenario.runId,
    seed: scenario.seed,
    scenarioId: scenario.scenarioId,
    tick: options.tick ?? 0,
    scene,
    profile,
    drone: droneTruth(options.drone, profile),
    openings,
    activeColliderIds: new Set(scene.colliders.map(c => c.id)),
    compartments: [],
    fires: [],
    occupants: (options.occupants ?? []).map(o => occupant(o.key, o.position, o.animation ?? "idle")),
    cues: { light: null, audio: null },
    estimator: initEstimator(),
    truthEvents: [],
  };
  for (const [id, state] of Object.entries(options.openings ?? {})) setOpening(world, id, state);
  const { compartments, fires } = initFireState(scene, scenario, world.openings);
  world.compartments = compartments;
  world.fires = fires;
  return world;
}

/** TWO_ROOM_SCENE plus extra colliders (a new scene object, so geometry caches stay per scene). */
export function sceneWith(extra: readonly RuntimeCollider[]): SceneModel {
  return { ...TWO_ROOM_SCENE, colliders: [...TWO_ROOM_SCENE.colliders, ...extra] };
}

/** Mimic the actuator effect of an opening change: open area for gas flow and removal of its colliders. */
export function setOpening(world: WorldState, openingId: string, state: OpeningState): void {
  const geometry = world.scene.openings.find(o => o.id === openingId);
  const truth = world.openings.find(o => o.id === openingId);
  if (!geometry || !truth) throw new RangeError(`Unknown opening ${openingId}`);
  const passable = state === "open" || state === "broken";
  truth.state = state;
  truth.openAreaM2 = passable ? geometry.widthM * geometry.heightM : 0;
  for (const c of world.scene.colliders) {
    if (c.openingId !== openingId) continue;
    if (passable) world.activeColliderIds.delete(c.id);
    else world.activeColliderIds.add(c.id);
  }
}

function droneTruth(drone: FixtureOptions["drone"], profile: AircraftProfile): WorldState["drone"] {
  return {
    position: drone?.position ?? vec3(2, 2, 1.2),
    velocity: drone?.velocity ?? vec3(0, 0, 0),
    yawRad: drone?.yawRad ?? 0,
    yawRateRadps: 0,
    enduranceRemainingS: 600,
    waterRemainingL: profile.modules.water?.tankL ?? 0,
    payloads: [],
    collisions: 0,
    lastCollisionTick: null,
  };
}

function occupant(key: string, position: Vec3, animation: OccupantTruth["animation"]): OccupantTruth {
  return { key, mobility: "mobile", position, velocity: vec3(0, 0, 0), yawRad: 0, activity: "shelter", animation, arrivalTick: null, smokeExposure: 0 };
}
