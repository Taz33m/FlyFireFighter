/**
 * Floor-plan prior for planners, derived from scene metadata.
 *
 * The prior carries only what a supplied plan would: floors, rooms, openings with their plan state, stairs
 * (with the rooms their ends stand in, so routes can cross floors), exits and the assembly point. It never
 * carries scenario anchors (fire origin, occupant start), collider geometry, the launch point or any runtime
 * truth. Optional corruption models an outdated or misregistered
 * plan for map-prior experiments (a door drawn closed that is open, an unmapped doorway, an offset survey).
 */
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { add, vec3, ZERO } from "../contracts/frames.ts";
import type { Point2 } from "../contracts/geometry.ts";
import { box } from "../contracts/geometry.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { OpeningState } from "../contracts/observation.ts";
import type { JsonVec3, SceneMetaJson } from "../contracts/scene.ts";
import { fromJsonVec3 } from "../contracts/scene.ts";
import { roomUnderFeet } from "./feet.ts";
import { parseSceneMeta } from "./scene.ts";

export interface PriorCorruption {
  /** Plan state to report for these openings regardless of the scene, e.g. an open door drawn closed. */
  readonly openingStates?: { readonly [openingId: string]: OpeningState | "unknown" };
  /** Openings missing from the plan entirely (exits through them are dropped too). */
  readonly omitOpenings?: readonly string[];
  /** Survey misregistration applied to every coordinate in the plan, metres. */
  readonly offsetM?: Vec3;
}

export interface PriorOptions {
  readonly revision?: number;
  readonly source?: string;
  readonly corruption?: PriorCorruption;
}

type PriorOpening = FloorPlanPrior["openings"][number];
type PriorStair = NonNullable<FloorPlanPrior["stairs"]>[number];

/** Stairs with the rooms their ends stand in (validation guarantees both ends resolve). */
function priorStairs(meta: SceneMetaJson, shift: (v: JsonVec3) => Vec3): PriorStair[] {
  return meta.stairs.map(s => {
    const bottomRoom = roomUnderFeet(meta.rooms, fromJsonVec3(s.bottom));
    const topRoom = roomUnderFeet(meta.rooms, fromJsonVec3(s.top));
    if (!bottomRoom || !topRoom) throw new RangeError(`Stair ${s.id} does not join two rooms`);
    return { id: s.id, bottomRoomId: bottomRoom.id, topRoomId: topRoom.id, bottom: shift(s.bottom), top: shift(s.top), widthM: s.widthM };
  });
}

/** Throws RangeError when the corruption names openings the scene does not have, so an experiment cannot silently do nothing. */
export function floorPlanPriorFromScene(meta: SceneMetaJson, options: PriorOptions = {}): FloorPlanPrior {
  parseSceneMeta(meta);
  const corruption = options.corruption ?? {};
  checkCorruption(meta, corruption);
  const offset = corruption.offsetM ?? ZERO;
  const omitted = new Set(corruption.omitOpenings ?? []);
  const shift = (v: JsonVec3): Vec3 => add(fromJsonVec3(v), offset);
  const shift2 = (p: readonly [number, number]): Point2 => [p[0] + offset.x, p[1] + offset.y];

  const openings: PriorOpening[] = meta.openings.filter(o => !omitted.has(o.id)).map(o => ({
    id: o.id,
    kind: o.kind,
    rooms: [o.rooms[0], o.rooms[1]],
    center: shift(o.center),
    widthM: o.widthM,
    heightM: o.heightM,
    outwardNormal: fromJsonVec3(o.outwardNormal),
    priorState: corruption.openingStates?.[o.id] ?? o.initialState,
  }));

  const prior: FloorPlanPrior = {
    revision: options.revision ?? meta.revision,
    source: options.source ?? `scene:${meta.sceneId}@${meta.revision}${isCorrupted(corruption) ? " (corrupted for experiment)" : ""}`,
    floors: meta.floors.map(f => ({ index: f.index, elevationM: f.elevationM + offset.z, ceilingM: f.ceilingM + offset.z })),
    rooms: meta.rooms.map(r => ({ id: r.id, name: r.name, floor: r.floor, polygon: r.polygon.map(shift2), zMin: r.zMin + offset.z, zMax: r.zMax + offset.z })),
    openings,
    stairs: priorStairs(meta, shift),
    exits: meta.exits.filter(e => !omitted.has(e.openingId)).map(e => ({ id: e.id, openingId: e.openingId })),
    assemblyPoint: box(shift(meta.assemblyPoint.min), shift(meta.assemblyPoint.max)),
  };
  return deepFreeze(prior);
}

function checkCorruption(meta: SceneMetaJson, corruption: PriorCorruption): void {
  const known = new Set(meta.openings.map(o => o.id));
  const named = [...Object.keys(corruption.openingStates ?? {}), ...(corruption.omitOpenings ?? [])];
  const unknown = named.filter(id => !known.has(id));
  if (unknown.length > 0) throw new RangeError(`Prior corruption names unknown openings: ${unknown.join(", ")}`);
  const o = corruption.offsetM;
  if (o && !(Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z))) throw new RangeError("Prior offset must be finite");
}

function isCorrupted(corruption: PriorCorruption): boolean {
  const o = corruption.offsetM ?? vec3(0, 0, 0);
  return Object.keys(corruption.openingStates ?? {}).length > 0 || (corruption.omitOpenings ?? []).length > 0 || o.x !== 0 || o.y !== 0 || o.z !== 0;
}
