/**
 * Scene metadata → runtime scene model.
 *
 * The model is the simulator's static truth: collider boxes, room volumes, openings with their authored
 * initial states, floors, the assembly point, the launch point and the scenario-only anchors. Mutable state
 * (opening states, active colliders, fire, occupants) lives in WorldState, never here. The model is frozen.
 */
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Point2 } from "../contracts/geometry.ts";
import { box, pointInPolygon, polygonArea } from "../contracts/geometry.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { fromJsonVec3 } from "../contracts/scene.ts";
import { validateSceneMeta } from "./scene-validate.ts";
import type { RuntimeCollider, RuntimeOpening, RuntimeRoom, SceneModel } from "./world-state.ts";

export { EXTERIOR, validateSceneMeta } from "./scene-validate.ts";

export class SceneValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    const shown = errors.slice(0, 5).join("; ");
    super(`Invalid scene metadata: ${shown}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}`);
    this.name = "SceneValidationError";
    this.errors = errors;
  }
}

/** Validates unknown JSON (e.g. a fetched scene.meta.json) and returns it typed, or throws with every error. */
export function parseSceneMeta(value: unknown): SceneMetaJson {
  const errors = validateSceneMeta(value);
  if (errors.length > 0) throw new SceneValidationError(errors);
  return value as SceneMetaJson;
}

/** Validates and converts metadata into the frozen runtime model. Throws SceneValidationError. */
export function sceneModelFromMeta(meta: SceneMetaJson): SceneModel {
  parseSceneMeta(meta);
  const model: SceneModel = {
    meta,
    colliders: meta.colliders.map(toCollider),
    rooms: meta.rooms.map(toRoom),
    openings: meta.openings.map(toOpening),
    floors: meta.floors.map(f => ({ index: f.index, elevationM: f.elevationM, ceilingM: f.ceilingM })),
    assemblyPoint: box(fromJsonVec3(meta.assemblyPoint.min), fromJsonVec3(meta.assemblyPoint.max)),
    launchPoint: { position: fromJsonVec3(meta.launchPoint.position), yawRad: meta.launchPoint.yawRad },
    anchors: { fireOrigin: fromJsonVec3(meta.scenarioAnchors.fireOrigin), occupantStart: fromJsonVec3(meta.scenarioAnchors.occupantStart) },
    bounds: { min: fromJsonVec3(meta.bounds.min), max: fromJsonVec3(meta.bounds.max) },
  };
  return deepFreeze(model);
}

function toCollider(c: SceneMetaJson["colliders"][number]): RuntimeCollider {
  return { id: c.id, kind: c.kind, min: fromJsonVec3(c.min), max: fromJsonVec3(c.max), openingId: c.openingId ?? null };
}

function toRoom(r: SceneMetaJson["rooms"][number]): RuntimeRoom {
  const polygon: Point2[] = r.polygon.map(p => [p[0], p[1]]);
  return { id: r.id, name: r.name, floor: r.floor, polygon, zMin: r.zMin, zMax: r.zMax, volumeM3: polygonArea(polygon) * (r.zMax - r.zMin) };
}

function toOpening(o: SceneMetaJson["openings"][number]): RuntimeOpening {
  return {
    id: o.id,
    kind: o.kind,
    rooms: [o.rooms[0], o.rooms[1]],
    center: fromJsonVec3(o.center),
    widthM: o.widthM,
    heightM: o.heightM,
    sillHeightM: o.sillHeightM,
    outwardNormal: fromJsonVec3(o.outwardNormal),
    initialState: o.initialState,
    glazed: o.glazed,
  };
}

/** The room whose volume contains p (within toleranceM vertically), or null (outside, inside a wall or slab). */
export function roomAt(scene: SceneModel, p: Vec3, toleranceM = 0): RuntimeRoom | null {
  for (const room of scene.rooms) {
    if (p.z < room.zMin - toleranceM || p.z > room.zMax + toleranceM) continue;
    if (pointInPolygon(p.x, p.y, room.polygon)) return room;
  }
  return null;
}

export function findOpening(scene: SceneModel, openingId: string): RuntimeOpening | null {
  return scene.openings.find(o => o.id === openingId) ?? null;
}

/** Clear area of an opening when nothing fills it (open door, open sash, broken pane), m². */
export function clearOpeningAreaM2(opening: RuntimeOpening): number {
  return opening.widthM * opening.heightM;
}

/** Centre of the bottom edge of an opening: where a person's feet pass through a doorway. */
export function openingThreshold(opening: RuntimeOpening): Vec3 {
  return vec3(opening.center.x, opening.center.y, opening.center.z - opening.heightM / 2);
}
