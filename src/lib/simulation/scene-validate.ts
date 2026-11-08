/**
 * Validation of exported scene metadata (contracts/scene.ts) before it becomes a SceneModel.
 *
 * Every problem is reported with a JSON path, so an exporter bug — a mirrored axis that turns room
 * polygons clockwise, a NaN from a failed transform, a collider naming a deleted opening, a zero-thickness
 * box — fails at load time instead of silently corrupting collisions or the planner's prior.
 */
import { vec3 } from "../contracts/frames.ts";
import { polygonArea } from "../contracts/geometry.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { SCENE_META_SCHEMA } from "../contracts/scene.ts";
import { roomUnderFeet } from "./feet.ts";

/** Room id used by openings that lead outside; never a room of its own. */
export const EXTERIOR = "exterior";

const COLLIDER_KINDS = new Set(["ground", "wall", "floor", "ceiling", "roof", "stair", "furniture", "glass", "door", "tree", "street_furniture"]);
const OPENING_KINDS = new Set(["door", "window", "opening"]);
/** Smallest accepted box extent on any axis; glass panes are thin but never zero-thickness. */
const MIN_EXTENT_M = 1e-3;
const MIN_ROOM_AREA_M2 = 0.05;
/** Room volumes must sit on their floor's elevation within this tolerance. */
const FLOOR_TOLERANCE_M = 0.05;
const ARRAYS = ["floors", "rooms", "openings", "stairs", "colliders", "exits"] as const;
const OBJECTS = ["frames", "origin", "provenance", "assemblyPoint", "launchPoint", "scenarioAnchors", "drone", "bounds", "assets"] as const;

type Meta = SceneMetaJson;
type Opening = Meta["openings"][number];

/** All problems found in candidate scene metadata; empty when it is valid. */
export function validateSceneMeta(value: unknown): string[] {
  const errors: string[] = [];
  collectNonFinite(value, "$", errors);
  if (!isRecord(value)) return [...errors, "$: scene metadata must be an object"];
  const structural = checkStructure(value);
  if (structural.length > 0) return [...errors, ...structural];
  const meta = value as unknown as Meta;
  checkHeader(meta, errors);
  const floors = checkFloors(meta, errors);
  const rooms = checkRooms(meta, floors, errors);
  const openings = checkOpenings(meta, rooms, errors);
  checkStairs(meta, floors, openings, errors);
  checkColliders(meta, openings, errors);
  checkExits(meta, openings, errors);
  checkTargets(meta, errors);
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVec3(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(n => typeof n === "number" && Number.isFinite(n));
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function collectNonFinite(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "number" && !Number.isFinite(value)) errors.push(`${path}: non-finite number`);
  else if (Array.isArray(value)) value.forEach((item, i) => collectNonFinite(item, `${path}[${i}]`, errors));
  else if (isRecord(value)) for (const key of Object.keys(value)) collectNonFinite(value[key], `${path}.${key}`, errors);
}

function checkStructure(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ARRAYS) if (!Array.isArray(value[key])) errors.push(`$.${key}: must be an array`);
  for (const key of OBJECTS) if (!isRecord(value[key])) errors.push(`$.${key}: must be an object`);
  for (const key of ARRAYS) {
    const items = value[key];
    if (Array.isArray(items)) items.forEach((item, i) => { if (!isRecord(item)) errors.push(`$.${key}[${i}]: must be an object`); });
  }
  return errors;
}

/** Records a duplicate or empty id and returns whether the id is usable. */
function claimId(seen: Set<string>, id: unknown, path: string, errors: string[]): id is string {
  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${path}.id: must be a non-empty string`);
    return false;
  }
  if (seen.has(id)) errors.push(`${path}.id: duplicate id "${id}"`);
  seen.add(id);
  return true;
}

function checkBox(min: unknown, max: unknown, path: string, errors: string[]): void {
  if (!isVec3(min) || !isVec3(max)) {
    errors.push(`${path}: min and max must be finite [x, y, z]`);
    return;
  }
  const a = min as number[];
  const b = max as number[];
  if (a.some((v, i) => b[i] - v < MIN_EXTENT_M)) errors.push(`${path}: degenerate box; max must exceed min by at least ${MIN_EXTENT_M} m on every axis`);
}

function checkHeader(meta: Meta, errors: string[]): void {
  if (meta.schema !== SCENE_META_SCHEMA) errors.push(`$.schema: expected "${SCENE_META_SCHEMA}", got ${JSON.stringify(meta.schema)}`);
  if (meta.units !== "m") errors.push(`$.units: expected "m", got ${JSON.stringify(meta.units)}`);
  if (typeof meta.sceneId !== "string" || meta.sceneId.length === 0) errors.push("$.sceneId: must be a non-empty string");
  if (!Number.isSafeInteger(meta.revision) || meta.revision < 0) errors.push("$.revision: must be a non-negative integer");
  if (meta.provenance.interior?.kind !== "authored_fictional") errors.push('$.provenance.interior.kind: must be "authored_fictional"');
  if (meta.provenance.incident !== "fictional") errors.push('$.provenance.incident: must be "fictional"');
}

function checkFloors(meta: Meta, errors: string[]): Map<number, Meta["floors"][number]> {
  const floors = new Map<number, Meta["floors"][number]>();
  if (meta.floors.length === 0) errors.push("$.floors: at least one floor is required");
  meta.floors.forEach((floor, i) => {
    const path = `$.floors[${i}]`;
    if (!Number.isSafeInteger(floor.index)) errors.push(`${path}.index: must be an integer`);
    else if (floors.has(floor.index)) errors.push(`${path}.index: duplicate floor index ${floor.index}`);
    if (!(floor.ceilingM - floor.elevationM >= MIN_EXTENT_M)) errors.push(`${path}: ceilingM must exceed elevationM`);
    floors.set(floor.index, floor);
  });
  return floors;
}

function checkRooms(meta: Meta, floors: Map<number, Meta["floors"][number]>, errors: string[]): Set<string> {
  const ids = new Set<string>();
  meta.rooms.forEach((room, i) => {
    const path = `$.rooms[${i}]`;
    if (claimId(ids, room.id, path, errors) && room.id === EXTERIOR) errors.push(`${path}.id: "${EXTERIOR}" is reserved`);
    if (typeof room.name !== "string") errors.push(`${path}.name: must be a string`);
    checkPolygon(room.polygon, `${path}.polygon`, errors);
    if (!(room.zMax - room.zMin >= MIN_EXTENT_M)) errors.push(`${path}: zMax must exceed zMin`);
    const floor = floors.get(room.floor);
    if (!floor) errors.push(`${path}.floor: unknown floor ${JSON.stringify(room.floor)}`);
    else if (Math.abs(room.zMin - floor.elevationM) > FLOOR_TOLERANCE_M || room.zMax > floor.ceilingM + FLOOR_TOLERANCE_M) {
      errors.push(`${path}: z range [${room.zMin}, ${room.zMax}] does not sit within floor ${room.floor} [${floor.elevationM}, ${floor.ceilingM}]`);
    }
  });
  return ids;
}

function checkPolygon(polygon: unknown, path: string, errors: string[]): void {
  const valid = Array.isArray(polygon) && polygon.length >= 3
    && polygon.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n)));
  if (!valid) {
    errors.push(`${path}: needs at least three finite [x, y] vertices`);
    return;
  }
  const area = polygonArea(polygon as [number, number][]);
  if (Math.abs(area) < MIN_ROOM_AREA_M2) errors.push(`${path}: degenerate polygon (area ${area.toFixed(4)} m²)`);
  else if (area < 0) errors.push(`${path}: clockwise polygon (signed area ${area.toFixed(2)} m²); rooms must be counter-clockwise in the Z-up world frame`);
}

function checkOpenings(meta: Meta, rooms: Set<string>, errors: string[]): Map<string, Opening> {
  const openings = new Map<string, Opening>();
  const ids = new Set<string>();
  meta.openings.forEach((opening, i) => {
    const path = `$.openings[${i}]`;
    if (claimId(ids, opening.id, path, errors)) openings.set(opening.id, opening);
    if (!OPENING_KINDS.has(opening.kind)) errors.push(`${path}.kind: unknown opening kind ${JSON.stringify(opening.kind)}`);
    checkOpeningRooms(opening.rooms, rooms, path, errors);
    if (!isVec3(opening.center)) errors.push(`${path}.center: must be a finite [x, y, z]`);
    if (!isPositive(opening.widthM) || !isPositive(opening.heightM)) errors.push(`${path}: widthM and heightM must be positive`);
    if (!(opening.sillHeightM >= 0)) errors.push(`${path}.sillHeightM: must be non-negative`);
    const n = opening.outwardNormal;
    if (!isVec3(n) || Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-3) errors.push(`${path}.outwardNormal: must be a unit vector`);
    if (opening.initialState !== "open" && opening.initialState !== "closed") errors.push(`${path}.initialState: must be "open" or "closed"`);
    if (typeof opening.glazed !== "boolean") errors.push(`${path}.glazed: must be a boolean`);
    else if (opening.glazed && opening.kind === "opening") errors.push(`${path}: an unframed opening cannot be glazed`);
  });
  return openings;
}

function checkOpeningRooms(pair: unknown, rooms: Set<string>, path: string, errors: string[]): void {
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(r => typeof r === "string")) {
    errors.push(`${path}.rooms: must be two room ids`);
    return;
  }
  const [a, b] = pair as [string, string];
  if (a === EXTERIOR) errors.push(`${path}.rooms[0]: "${EXTERIOR}" may only be the second room (the outward side)`);
  else if (!rooms.has(a)) errors.push(`${path}.rooms[0]: unknown room "${a}"`);
  if (b !== EXTERIOR && !rooms.has(b)) errors.push(`${path}.rooms[1]: unknown room "${b}"`);
  if (a === b) errors.push(`${path}.rooms: an opening must join two different rooms`);
}

function checkStairs(meta: Meta, floors: Map<number, unknown>, openings: Map<string, Opening>, errors: string[]): void {
  const ids = new Set<string>();
  const rooms = meta.rooms.filter(r => typeof r.id === "string" && Number.isFinite(r.zMin) && Array.isArray(r.polygon)
    && r.polygon.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n))));
  meta.stairs.forEach((stair, i) => {
    const path = `$.stairs[${i}]`;
    claimId(ids, stair.id, path, errors);
    if (!floors.has(stair.fromFloor) || !floors.has(stair.toFloor)) errors.push(`${path}: fromFloor and toFloor must name known floors`);
    else if (stair.fromFloor === stair.toFloor) errors.push(`${path}: a stair must join two different floors`);
    if (!isVec3(stair.bottom) || !isVec3(stair.top)) errors.push(`${path}: bottom and top must be finite [x, y, z]`);
    else if (!(stair.top[2] > stair.bottom[2])) errors.push(`${path}: top must be higher than bottom`);
    else {
      const bottom = checkStairEnd(rooms, stair.bottom, stair.fromFloor, `${path}.bottom`, errors);
      const top = checkStairEnd(rooms, stair.top, stair.toFloor, `${path}.top`, errors);
      if (bottom && top) checkStairGasPath(openings, bottom, top, path, errors);
    }
    if (!isPositive(stair.widthM)) errors.push(`${path}.widthM: must be positive`);
  });
}

/** Each stair end must stand on the floor of a room on the stair's floor, so routes and priors can link rooms; returns that room's id. */
function checkStairEnd(rooms: Meta["rooms"], end: readonly [number, number, number], floor: number, path: string, errors: string[]): string | null {
  const room = roomUnderFeet(rooms, vec3(end[0], end[1], end[2]));
  if (!room) errors.push(`${path}: does not stand on the floor of any room`);
  else if (room.floor !== floor) errors.push(`${path}: stands in ${room.id} on floor ${room.floor}, not floor ${floor}`);
  else return room.id;
  return null;
}

/**
 * A stair the occupant and aircraft can pass is also a path for smoke and heat. The compartment fire model
 * exchanges gas only through openings, so the stair's bottom and top rooms must share one (an unframed stairwell
 * "opening" or a stair door), or the floors would be sealed from each other in the fire model.
 */
function checkStairGasPath(openings: Map<string, Opening>, bottom: string, top: string, path: string, errors: string[]): void {
  if (bottom === top) return;
  const joins = [...openings.values()].some(o => o.kind !== "window" && Array.isArray(o.rooms) && o.rooms.includes(bottom) && o.rooms.includes(top));
  if (!joins) errors.push(`${path}: no door or opening joins its bottom room ${bottom} and top room ${top}, so smoke cannot follow the stair`);
}

function checkColliders(meta: Meta, openings: Map<string, Opening>, errors: string[]): void {
  const ids = new Set<string>();
  meta.colliders.forEach((collider, i) => {
    const path = `$.colliders[${i}]`;
    claimId(ids, collider.id, path, errors);
    if (!COLLIDER_KINDS.has(collider.kind)) errors.push(`${path}.kind: unknown collider kind ${JSON.stringify(collider.kind)}`);
    checkBox(collider.min, collider.max, path, errors);
    const opening = collider.openingId === undefined ? undefined : openings.get(collider.openingId);
    if (collider.openingId !== undefined && !opening) errors.push(`${path}.openingId: unknown opening "${collider.openingId}"`);
    if (collider.kind === "glass" && !opening?.glazed) errors.push(`${path}: a glass collider must name a glazed opening`);
    if (collider.kind === "door" && opening?.kind !== "door") errors.push(`${path}: a door collider must name a door opening`);
  });
}

function checkExits(meta: Meta, openings: Map<string, Opening>, errors: string[]): void {
  const ids = new Set<string>();
  if (meta.exits.length === 0) errors.push("$.exits: at least one exit is required for evacuation");
  meta.exits.forEach((exit, i) => {
    const path = `$.exits[${i}]`;
    claimId(ids, exit.id, path, errors);
    const opening = openings.get(exit.openingId);
    if (!opening) errors.push(`${path}.openingId: unknown opening "${exit.openingId}"`);
    else if (opening.rooms[1] !== EXTERIOR) errors.push(`${path}: exit opening "${exit.openingId}" does not lead to "${EXTERIOR}"`);
  });
}

function checkTargets(meta: Meta, errors: string[]): void {
  checkBox(meta.bounds.min, meta.bounds.max, "$.bounds", errors);
  checkBox(meta.assemblyPoint.min, meta.assemblyPoint.max, "$.assemblyPoint", errors);
  if (typeof meta.assemblyPoint.id !== "string") errors.push("$.assemblyPoint.id: must be a string");
  if (!isVec3(meta.launchPoint.position) || !Number.isFinite(meta.launchPoint.yawRad)) errors.push("$.launchPoint: position and yawRad must be finite");
  const anchors = meta.scenarioAnchors;
  if (anchors.scenarioOnly !== true) errors.push("$.scenarioAnchors.scenarioOnly: must be true");
  if (!isVec3(anchors.fireOrigin) || !isVec3(anchors.occupantStart)) errors.push("$.scenarioAnchors: fireOrigin and occupantStart must be finite [x, y, z]");
  if (!isPositive(meta.drone.spanM) || !isPositive(meta.drone.heightM)) errors.push("$.drone: spanM and heightM must be positive");
  if (isVec3(meta.bounds.min) && isVec3(meta.bounds.max) && isVec3(meta.launchPoint.position)) {
    const p = meta.launchPoint.position;
    if (p.some((v, i) => v < meta.bounds.min[i] || v > meta.bounds.max[i])) errors.push("$.launchPoint.position: outside the scene bounds");
  }
}
