/**
 * Small authored test scene: a two-floor house used by simulator and evaluator tests. Fictional; it is not
 * the Blender scene and not a real floor plan.
 *
 * World frame: a local site frame (right-handed, Z up, metres; no relation to true north). The house spans
 * x 0–10, y 0–8 with its front (street side) facing −Y. Ground floor (z 0–2.6): entry with the stair, kitchen behind a 0.8 m door, living room
 * through an archway. Upper floor (z 2.9–5.5): hall over the stairwell, bath, rear bedroom with a closed,
 * glazed rear window. The front door is the only exit; the assembly point lies ≥ 10 m in front of it. Room
 * polygons are interior free space; walls, slabs, door leaves and panes are separate colliders. Scenario
 * anchors put the fire in the upstairs hall just outside the bedroom door, across the only route from the
 * bedroom to the stair, and the occupant in the bedroom.
 */
import type { AircraftProfile } from "../contracts/aircraft.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { JsonPoint2, JsonVec3, SceneCollider, SceneMetaJson } from "../contracts/scene.ts";
import { fromJsonVec3, SCENE_META_SCHEMA } from "../contracts/scene.ts";
import type { ScenarioConfig } from "./world-state.ts";

type Kind = SceneCollider["kind"];

const c = (id: string, kind: Kind, min: JsonVec3, max: JsonVec3, openingId?: string): SceneCollider =>
  openingId === undefined ? { id, kind, min, max } : { id, kind, min, max, openingId };
const rect = (x0: number, y0: number, x1: number, y1: number): JsonPoint2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export const FIXTURE_GROUND_CEILING_M = 2.6;
export const FIXTURE_UPPER_FLOOR_M = 2.9;
export const FIXTURE_ROOF_M = 5.5;
const UP = FIXTURE_UPPER_FLOOR_M;
const TOP = FIXTURE_ROOF_M;

const STAIR_STEPS = 12;
const STAIR_Y0 = 0.5;
const STAIR_Y1 = 3.9;

function stairSteps(): SceneCollider[] {
  const run = (STAIR_Y1 - STAIR_Y0) / STAIR_STEPS;
  const rise = UP / STAIR_STEPS;
  return Array.from({ length: STAIR_STEPS }, (_, i) => c(`stair-step-${i + 1}`, "stair", [0.2, STAIR_Y0 + i * run, 0], [1.2, STAIR_Y0 + (i + 1) * run, (i + 1) * rise]));
}

const EXTERIOR_WALLS: SceneCollider[] = [
  c("wall-s-1", "wall", [0, 0, 0], [1.55, 0.2, TOP]),
  c("wall-s-2", "wall", [1.55, 0, 2.0], [2.45, 0.2, TOP]),
  c("wall-s-3", "wall", [2.45, 0, 0], [6.5, 0.2, TOP]),
  c("wall-s-4", "wall", [6.5, 0, 0], [8.0, 0.2, 0.9]),
  c("wall-s-5", "wall", [6.5, 0, 2.1], [8.0, 0.2, TOP]),
  c("wall-s-6", "wall", [8.0, 0, 0], [10, 0.2, TOP]),
  c("wall-n-1", "wall", [0, 7.8, 0], [6.5, 8.0, TOP]),
  c("wall-n-2", "wall", [6.5, 7.8, 0], [7.5, 8.0, 3.8]),
  c("wall-n-3", "wall", [6.5, 7.8, 5.0], [7.5, 8.0, TOP]),
  c("wall-n-4", "wall", [7.5, 7.8, 0], [10, 8.0, TOP]),
  c("wall-w", "wall", [0, 0.2, 0], [0.2, 7.8, TOP]),
  c("wall-e", "wall", [9.8, 0.2, 0], [10, 7.8, TOP]),
];

const INTERIOR_WALLS: SceneCollider[] = [
  c("wall-g-el-1", "wall", [3.95, 0.2, 0], [4.05, 1.3, 2.6]),
  c("wall-g-el-2", "wall", [3.95, 1.3, 2.1], [4.05, 2.7, 2.6]),
  c("wall-g-el-3", "wall", [3.95, 2.7, 0], [4.05, 7.8, 2.6]),
  c("wall-g-ek-1", "wall", [0.2, 3.95, 0], [2.4, 4.05, 2.6]),
  c("wall-g-ek-2", "wall", [2.4, 3.95, 2.0], [3.2, 4.05, 2.6]),
  c("wall-g-ek-3", "wall", [3.2, 3.95, 0], [3.95, 4.05, 2.6]),
  c("wall-u-1", "wall", [3.95, 0.2, UP], [4.05, 1.15, TOP]),
  c("wall-u-2", "wall", [3.95, 1.15, 4.9], [4.05, 2.05, TOP]),
  c("wall-u-3", "wall", [3.95, 2.05, UP], [4.05, 5.05, TOP]),
  c("wall-u-4", "wall", [3.95, 5.05, 4.9], [4.05, 5.95, TOP]),
  c("wall-u-5", "wall", [3.95, 5.95, UP], [4.05, 7.8, TOP]),
  c("wall-u-6", "wall", [4.05, 2.95, UP], [9.8, 3.05, TOP]),
];

const SLABS: SceneCollider[] = [
  c("ground", "ground", [-15, -25, -0.3], [25, 20, 0]),
  c("slab-1", "floor", [1.2, 0.2, 2.6], [9.8, 7.8, UP]),
  c("slab-2", "floor", [0.2, 0.2, 2.6], [1.2, STAIR_Y0, UP]),
  c("slab-3", "floor", [0.2, 3.95, 2.6], [1.2, 7.8, UP]),
  c("roof", "roof", [0, 0, TOP], [10, 8, 5.8]),
];

const LEAVES_AND_PANES: SceneCollider[] = [
  c("glass-living-front", "glass", [6.5, 0.095, 0.9], [8.0, 0.105, 2.1], "win-living-front"),
  c("glass-rear-bedroom", "glass", [6.5, 7.895, 3.8], [7.5, 7.905, 5.0], "win-rear-bedroom"),
  c("door-leaf-front", "door", [1.55, 0.08, 0], [2.45, 0.12, 2.0], "front-door"),
  c("door-leaf-kitchen", "door", [2.4, 3.98, 0], [3.2, 4.02, 2.0], "door-kitchen"),
  c("door-leaf-bath", "door", [3.98, 1.15, UP], [4.02, 2.05, 4.9], "door-bath"),
  c("door-leaf-bedroom", "door", [3.98, 5.05, UP], [4.02, 5.95, 4.9], "door-bedroom"),
];

const FURNITURE: SceneCollider[] = [
  c("sofa-living", "furniture", [6.0, 5.6, 0], [8.2, 6.5, 0.85]),
  c("table-living", "furniture", [6.4, 3.8, 0], [7.6, 4.6, 0.45]),
  c("counter-kitchen", "furniture", [0.2, 4.05, 0], [0.8, 7.8, 0.9]),
  c("table-kitchen", "furniture", [1.4, 5.6, 0], [2.6, 6.6, 0.75]),
  c("bed-bedroom", "furniture", [7.6, 4.0, UP], [9.6, 6.2, 3.5]),
  c("dresser-bedroom", "furniture", [4.3, 7.3, UP], [5.5, 7.8, 4.0]),
  c("tub-bath", "furniture", [8.0, 0.2, UP], [9.8, 1.0, 3.5]),
  c("shelf-hall", "furniture", [0.2, 6.5, UP], [0.5, 7.6, 4.7]),
  c("tree-front", "tree", [12.0, -4.8, 0], [12.8, -4.0, 6.0]),
  c("mailbox", "street_furniture", [-1.5, -3.0, 0], [-1.2, -2.7, 1.2]),
  c("bench", "street_furniture", [9.0, -9.0, 0], [10.5, -8.5, 0.5]),
];

type Opening = SceneMetaJson["openings"][number];
const opening = (id: string, kind: Opening["kind"], rooms: [string, string], center: JsonVec3, size: [number, number, number], normal: JsonVec3, initialState: Opening["initialState"], glazed = false): Opening =>
  ({ id, kind, rooms, center, widthM: size[0], heightM: size[1], sillHeightM: size[2], outwardNormal: normal, initialState, glazed });

export const FIXTURE_SCENE_META: SceneMetaJson = deepFreeze({
  schema: SCENE_META_SCHEMA,
  sceneId: "fixture-two-floor-house",
  revision: 1,
  units: "m",
  frames: { world: "Local site frame: right-handed, Z up, metres", gltf: "Y-up; world (x, y, z) -> render (x, z, -y)" },
  origin: { description: "South-west outer corner of the fixture house", latLon: null },
  provenance: {
    exterior: { reference: "none: authored test fixture", method: "hand-authored boxes", sources: [], estimated: [] },
    interior: { kind: "authored_fictional", statement: "Authored test fixture; not a real floor plan." },
    incident: "fictional",
  },
  floors: [
    { index: 0, elevationM: 0, ceilingM: FIXTURE_GROUND_CEILING_M },
    { index: 1, elevationM: UP, ceilingM: TOP },
  ],
  rooms: [
    { id: "entry", name: "Entry and stair", floor: 0, polygon: rect(0.2, 0.2, 3.95, 3.95), zMin: 0, zMax: 2.6 },
    { id: "kitchen", name: "Kitchen", floor: 0, polygon: rect(0.2, 4.05, 3.95, 7.8), zMin: 0, zMax: 2.6 },
    { id: "living", name: "Living room", floor: 0, polygon: rect(4.05, 0.2, 9.8, 7.8), zMin: 0, zMax: 2.6 },
    { id: "hall-up", name: "Upstairs hall", floor: 1, polygon: rect(0.2, 0.2, 3.95, 7.8), zMin: UP, zMax: TOP },
    { id: "bath", name: "Bathroom", floor: 1, polygon: rect(4.05, 0.2, 9.8, 2.95), zMin: UP, zMax: TOP },
    { id: "bedroom", name: "Rear bedroom", floor: 1, polygon: rect(4.05, 3.05, 9.8, 7.8), zMin: UP, zMax: TOP },
  ],
  openings: [
    opening("front-door", "door", ["entry", "exterior"], [2.0, 0.1, 1.0], [0.9, 2.0, 0], [0, -1, 0], "open"),
    opening("win-living-front", "window", ["living", "exterior"], [7.25, 0.1, 1.5], [1.5, 1.2, 0.9], [0, -1, 0], "closed", true),
    opening("arch-entry-living", "opening", ["entry", "living"], [4.0, 2.0, 1.05], [1.4, 2.1, 0], [1, 0, 0], "open"),
    opening("door-kitchen", "door", ["entry", "kitchen"], [2.8, 4.0, 1.0], [0.8, 2.0, 0], [0, 1, 0], "open"),
    opening("stairwell", "opening", ["entry", "hall-up"], [0.7, 2.225, 2.75], [1.0, 3.45, 0], [0, 0, 1], "open"),
    opening("door-bath", "door", ["hall-up", "bath"], [4.0, 1.6, 3.9], [0.9, 2.0, 0], [1, 0, 0], "closed"),
    opening("door-bedroom", "door", ["hall-up", "bedroom"], [4.0, 5.5, 3.9], [0.9, 2.0, 0], [1, 0, 0], "open"),
    opening("win-rear-bedroom", "window", ["bedroom", "exterior"], [7.0, 7.9, 4.4], [1.0, 1.2, 0.9], [0, 1, 0], "closed", true),
  ],
  stairs: [{ id: "stair-main", fromFloor: 0, toFloor: 1, bottom: [0.7, STAIR_Y0, 0], top: [0.7, STAIR_Y1, UP], widthM: 1.0 }],
  colliders: [...SLABS, ...EXTERIOR_WALLS, ...INTERIOR_WALLS, ...stairSteps(), ...LEAVES_AND_PANES, ...FURNITURE],
  exits: [{ id: "exit-front", openingId: "front-door" }],
  assemblyPoint: { id: "assembly-front", min: [0, -14, -0.1], max: [4, -11, 2.5] },
  launchPoint: { position: [6.0, -8.0, 0.3], yawRad: Math.PI / 2 },
  scenarioAnchors: { scenarioOnly: true, note: "Fixture scenario initialization only.", fireOrigin: [3.2, 5.5, UP], occupantStart: [8.3, 6.9, UP] },
  drone: { spanM: 0.55, heightM: 0.2, camera: { positionBody: [0.12, 0, 0.02], pitchRad: (10 * Math.PI) / 180, horizontalFovDeg: 90 } },
  bounds: { min: [-15, -25, -0.3], max: [25, 20, 12] },
  assets: {},
} satisfies SceneMetaJson);

/** Fixture scenario: a small fire at the hall anchor and one mobile occupant at the bedroom anchor. */
export function fixtureScenario(overrides: Partial<ScenarioConfig> = {}, profile: AircraftProfile = TENDER_T1): ScenarioConfig {
  const anchors = FIXTURE_SCENE_META.scenarioAnchors;
  return {
    scenarioId: "fixture-hall-fire",
    seed: "fixture-seed-1",
    runId: "run-fixture-1",
    profile,
    fire: { roomId: "hall-up", origin: fromJsonVec3(anchors.fireOrigin), radiusM: 0.45, initialHeatReleaseKW: 60, fuelMJ: 40 },
    occupants: [{ key: "occupant-1", start: fromJsonVec3(anchors.occupantStart), mobility: "mobile" }],
    openingOverrides: {},
    ...overrides,
  };
}
