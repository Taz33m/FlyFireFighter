/**
 * A course = one layout (layout.ts) + one motion sequence, both fixed by the course seed, placed in the
 * world and exported as valid scene metadata (flyfirefighter.scene-meta/1, validated by sceneModelFromMeta).
 *
 * Sequence variation: corridor heading (one of four, which changes how the fixed light shades each face),
 * world origin (shifts the world-anchored surface texture of the headless renderer), approach-speed cap of
 * the move proposal, uniform smoke (add_smoke in both rooms), camera exposure gain (a separate, versioned
 * calibration id) and, when present, the debris trigger distance. Each course is checked with the truth
 * planner: start → goal must stay reachable at the planner's clearance both before and after the debris
 * falls; a failing attempt is redrawn with the next attempt index (deterministically).
 */
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { CameraCalibration } from "../../contracts/camera.ts";
import { calibrationFromSensor } from "../../contracts/camera.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3, wrapAngle } from "../../contracts/frames.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import type { JsonPoint2, JsonVec3, SceneCollider, SceneMetaJson } from "../../contracts/scene.ts";
import { SCENE_META_SCHEMA } from "../../contracts/scene.ts";
import { sceneModelFromMeta } from "../../simulation/scene.ts";
import type { SceneModel } from "../../simulation/world-state.ts";
import type { CourseLayout, LocalBox } from "./layout.ts";
import { generateLayout, layoutRandom } from "./layout.ts";
import type { PlanBox } from "./planner.ts";
import { PlanGrid, reachable } from "./planner.ts";
import type { CourseSplit } from "./splits.ts";
import { COURSE_FAMILY, courseId } from "./splits.ts";

export interface WorldBox {
  readonly id: string;
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface CourseSpec {
  readonly courseId: string;
  readonly seed: string;
  readonly split: CourseSplit;
  readonly family: typeof COURSE_FAMILY;
  readonly attempt: number;
  readonly layout: CourseLayout;
  readonly headingIndex: number;
  readonly origin: { readonly x: number; readonly y: number };
  readonly start: { readonly position: Vec3; readonly yawRad: number };
  readonly goal: Vec3;
  readonly speedCapMps: number;
  readonly smokePerM: number;
  readonly exposureGain: number;
  readonly budgetS: number;
  /** World box of the debris and the corridor coordinate u the aircraft must pass to release it. */
  readonly debris: { readonly box: WorldBox; readonly triggerU: number } | null;
  /** World-frame interior bounds of the corridor (both rooms), for the planner. */
  readonly interior: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  readonly meta: SceneMetaJson;
}

const SPEED_CAPS = [0.8, 1.0, 1.2, 1.5] as const;
const MAX_ATTEMPTS = 25;
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Local (u, v) → world (x, y) for heading index k (k · 90°), then the origin offset. */
export function toWorld(k: number, origin: { x: number; y: number }, u: number, v: number): [number, number] {
  const [x, y] = k === 0 ? [u, v] : k === 1 ? [-v, u] : k === 2 ? [-u, -v] : [v, -u];
  return [round(origin.x + x), round(origin.y + y)];
}

/** Inverse of toWorld: corridor coordinates of a world point. */
export function toLocal(spec: Pick<CourseSpec, "headingIndex" | "origin">, x: number, y: number): [number, number] {
  const dx = x - spec.origin.x;
  const dy = y - spec.origin.y;
  const k = spec.headingIndex;
  return k === 0 ? [dx, dy] : k === 1 ? [dy, -dx] : k === 2 ? [-dx, -dy] : [-dy, dx];
}

function worldBox(k: number, origin: { x: number; y: number }, b: Pick<LocalBox, "min" | "max">): { min: JsonVec3; max: JsonVec3 } {
  const [ax, ay] = toWorld(k, origin, b.min[0], b.min[1]);
  const [bx, by] = toWorld(k, origin, b.max[0], b.max[1]);
  return { min: [Math.min(ax, bx), Math.min(ay, by), b.min[2]], max: [Math.max(ax, bx), Math.max(ay, by), b.max[2]] };
}

function rectPolygon(k: number, origin: { x: number; y: number }, u0: number, v0: number, u1: number, v1: number): JsonPoint2[] {
  const { min, max } = worldBox(k, origin, { min: [u0, v0, 0], max: [u1, v1, 1] });
  return [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]];
}

function direction(k: number): JsonVec3 {
  const [x, y] = toWorld(k, { x: 0, y: 0 }, 1, 0);
  return [x, y, 0];
}

function sceneMeta(id: string, layout: CourseLayout, k: number, origin: { x: number; y: number }, start: { position: Vec3; yawRad: number }, goal: Vec3): SceneMetaJson {
  const { lengthM: L, widthM: W, heightM: H, doorway: d, exit } = layout;
  const colliders: SceneCollider[] = layout.boxes.map(b => ({ id: b.id, kind: b.kind, ...worldBox(k, origin, b), ...(b.openingId ? { openingId: b.openingId } : {}) }));
  const at = (u: number, v: number, z: number): JsonVec3 => [...toWorld(k, origin, u, v), z];
  const bounds = worldBox(k, origin, { min: [-3, -3, -0.3], max: [L + 6, W + 3, 4] });
  const assembly = worldBox(k, origin, { min: [L + 3, 0, -0.1], max: [L + 5, W, 2.5] });
  return {
    schema: SCENE_META_SCHEMA,
    sceneId: `course-${id}`,
    revision: 1,
    units: "m",
    frames: { world: "Local site frame: right-handed, Z up, metres (procedural course)", gltf: "none: courses are rendered from colliders only" },
    origin: { description: `Procedural ${COURSE_FAMILY} course; corridor start corner at world (${origin.x}, ${origin.y}), heading ${k * 90}°`, latLon: null },
    provenance: {
      exterior: { reference: "none: procedural obstacle course", method: "seeded box layout (src/lib/evaluation/courses)", sources: [], estimated: [] },
      interior: { kind: "authored_fictional", statement: "Procedurally generated training/evaluation course; not a real building." },
      incident: "fictional",
    },
    floors: [{ index: 0, elevationM: 0, ceilingM: H }],
    rooms: [
      { id: "room-a", name: "Corridor A", floor: 0, polygon: rectPolygon(k, origin, 0, 0, d.u, W), zMin: 0, zMax: H },
      { id: "room-b", name: "Corridor B", floor: 0, polygon: rectPolygon(k, origin, d.u + d.thicknessM, 0, L, W), zMin: 0, zMax: H },
    ],
    openings: [
      { id: "doorway", kind: "opening", rooms: ["room-a", "room-b"], center: at(d.u + d.thicknessM / 2, d.v, d.heightM / 2), widthM: d.widthM, heightM: d.heightM, sillHeightM: 0, outwardNormal: direction(k), initialState: "open", glazed: false },
      { id: "exit-door", kind: "door", rooms: ["room-b", "exterior"], center: at(L + 0.075, exit.v, exit.heightM / 2), widthM: exit.widthM, heightM: exit.heightM, sillHeightM: 0, outwardNormal: direction(k), initialState: "closed", glazed: false },
    ],
    stairs: [],
    colliders,
    exits: [{ id: "exit-end", openingId: "exit-door" }],
    assemblyPoint: { id: "assembly-outside", ...assembly },
    launchPoint: { position: [start.position.x, start.position.y, start.position.z], yawRad: start.yawRad },
    scenarioAnchors: { scenarioOnly: true, note: "Course runs have no fire or occupant; anchors are unused.", fireOrigin: [goal.x, goal.y, 0], occupantStart: [goal.x, goal.y, 0] },
    drone: { spanM: TENDER_T1.spanM, heightM: 0.2, camera: { positionBody: [0.12, 0, 0.02], pitchRad: (10 * Math.PI) / 180, horizontalFovDeg: 90 } },
    bounds,
    assets: {},
  };
}

function planBoxes(meta: SceneMetaJson, flightZ: number, extra: readonly WorldBox[]): PlanBox[] {
  const band = TENDER_T1.spanM / 2 + 0.05;
  const all = [...meta.colliders.map(c => ({ min: vec3(...c.min), max: vec3(...c.max) })), ...extra];
  return all.filter(c => c.max.z > flightZ - band && c.min.z < flightZ + band).map(c => ({ minX: c.min.x, minY: c.min.y, maxX: c.max.x, maxY: c.max.y }));
}

/** Build the course for a seed. Throws if no solvable attempt exists (never observed for this family). */
export function buildCourse(split: CourseSplit, seed: string): CourseSpec {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const spec = courseAttempt(split, seed, attempt);
    if (spec) return deepFreeze(spec);
  }
  throw new Error(`Course ${seed}: no solvable layout in ${MAX_ATTEMPTS} attempts`);
}

function courseAttempt(split: CourseSplit, seed: string, attempt: number): CourseSpec | null {
  const layout = generateLayout(seed, attempt);
  const r = layoutRandom(seed, attempt);
  const k = Math.floor(r("heading") * 4) % 4;
  const origin = { x: round((r("origin-x") - 0.5) * 60), y: round((r("origin-y") - 0.5) * 60) };
  const z = layout.flightHeightM;
  const [sx, sy] = toWorld(k, origin, layout.start.u, layout.start.v);
  const [gx, gy] = toWorld(k, origin, layout.goal.u, layout.goal.v);
  const start = { position: vec3(sx, sy, z), yawRad: round(wrapAngle(layout.start.yawRad + (k * Math.PI) / 2)) };
  const goal = vec3(gx, gy, z);
  const id = courseId(split, seed);
  const meta = sceneMeta(id, layout, k, origin, start, goal);
  const interiorBox = worldBox(k, origin, { min: [0, 0, 0], max: [layout.lengthM, layout.widthM, 1] });
  const interior = { minX: interiorBox.min[0], minY: interiorBox.min[1], maxX: interiorBox.max[0], maxY: interiorBox.max[1] };
  const debris = layout.debris === null ? null : (() => {
    const b = worldBox(k, origin, layout.debris.box);
    return { box: { id: layout.debris.box.id, min: vec3(...b.min), max: vec3(...b.max) }, triggerU: Math.max(layout.start.u + 0.4, layout.debris.triggerU) };
  })();
  const before = new PlanGrid(interior, planBoxes(meta, z, []));
  if (!reachable(before, start.position, goal)) return null;
  if (debris) {
    const after = new PlanGrid(interior, planBoxes(meta, z, [debris.box]));
    if (!reachable(after, start.position, goal)) return null;
  }
  const speedCapMps = SPEED_CAPS[Math.floor(r("speed") * SPEED_CAPS.length) % SPEED_CAPS.length];
  const smokePerM = r("smoke") < 0.5 ? 0 : round(0.08 + 0.27 * r("smoke-level"));
  return {
    courseId: id, seed, split, family: COURSE_FAMILY, attempt, layout, headingIndex: k, origin, start, goal, speedCapMps, smokePerM,
    exposureGain: round(0.7 + 0.6 * r("exposure")), budgetS: Math.round((2.5 * layout.lengthM) / Math.min(speedCapMps, 1.2) + 10), debris, interior, meta,
  };
}

export function courseScene(spec: CourseSpec): SceneModel {
  return sceneModelFromMeta(spec.meta);
}

/** The locked rgb-front calibration with this course's exposure gain (its own calibration id). */
export function courseCalibration(spec: Pick<CourseSpec, "exposureGain">): CameraCalibration {
  const rgb = TENDER_T1.sensors.find(s => s.id === "rgb-front");
  if (!rgb) throw new Error("TENDER_T1 has no rgb-front camera");
  const base = calibrationFromSensor(rgb, 1);
  return { ...base, id: `${base.id}+gain${spec.exposureGain.toFixed(3)}`, exposure: { gain: spec.exposureGain, gamma: base.exposure.gamma } };
}
