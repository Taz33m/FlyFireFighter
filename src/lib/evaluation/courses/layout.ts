/**
 * Procedural course layout in the course's LOCAL frame: u along the corridor (start at u = 0, goal near
 * u = length), v across it (0 … width), z up. One family ("corridor-doorway/v1"): a furnished corridor
 * (room A), a partition wall with a narrow doorway (0.85–1.10 m clear for the 0.55 m aircraft), a second
 * room (B) with more furniture, tall and low lateral clutter along both walls, an optional free-standing
 * column and optional falling debris (an obstruction added mid-run when the aircraft passes a trigger).
 * Every draw is keyed by (course seed, stream, attempt), so a course is a pure function of its seed.
 */
import type { ColliderKind } from "../../contracts/scene.ts";
import { keyedUniform } from "../../simulation/random.ts";

export type BoxRole = "structure" | "furniture" | "column" | "clutter" | "low" | "debris";

export interface LocalBox {
  readonly id: string;
  readonly kind: ColliderKind;
  readonly role: BoxRole;
  /** [u, v, z] */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly openingId?: string;
}

export interface CourseLayout {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly flightHeightM: number;
  readonly doorway: { readonly u: number; readonly thicknessM: number; readonly v: number; readonly widthM: number; readonly heightM: number };
  readonly exit: { readonly v: number; readonly widthM: number; readonly heightM: number };
  readonly boxes: readonly LocalBox[];
  readonly debris: { readonly box: LocalBox; readonly triggerU: number } | null;
  readonly start: { readonly u: number; readonly v: number; readonly yawRad: number };
  readonly goal: { readonly u: number; readonly v: number };
}

export const LAYOUT = Object.freeze({ heightM: 2.6, wallM: 0.15, flightHeightM: 1.2, minPassM: 0.95, doorHeightM: 2.1, firstObstacleU: 2.4 });

type Rand = (stream: string, index?: number) => number;

export function layoutRandom(seed: string, attempt: number): Rand {
  return (stream, index = 0) => keyedUniform(seed, `${stream}#${attempt}`, 0, index);
}

const lerp = (lo: number, hi: number, t: number): number => lo + (hi - lo) * t;
const round = (value: number): number => Math.round(value * 1000) / 1000;
const box = (id: string, kind: ColliderKind, role: BoxRole, min: [number, number, number], max: [number, number, number], openingId?: string): LocalBox =>
  ({ id, kind, role, min: min.map(round) as [number, number, number], max: max.map(round) as [number, number, number], ...(openingId === undefined ? {} : { openingId }) });

function structure(L: number, W: number, door: CourseLayout["doorway"], exit: CourseLayout["exit"]): LocalBox[] {
  const { heightM: H, wallM: t } = LAYOUT;
  const d0 = door.v - door.widthM / 2;
  const d1 = door.v + door.widthM / 2;
  const e0 = exit.v - exit.widthM / 2;
  const e1 = exit.v + exit.widthM / 2;
  return [
    box("ground", "ground", "structure", [-2, -2, -0.3], [L + 2, W + 2, 0]),
    box("ceiling", "ceiling", "structure", [-t, -t, H], [L + t, W + t, H + 0.2]),
    box("wall-right", "wall", "structure", [-t, -t, 0], [L + t, 0, H]),
    box("wall-left", "wall", "structure", [-t, W, 0], [L + t, W + t, H]),
    box("wall-start", "wall", "structure", [-t, 0, 0], [0, W, H]),
    box("wall-end-1", "wall", "structure", [L, 0, 0], [L + t, e0, H]),
    box("wall-end-2", "wall", "structure", [L, e1, 0], [L + t, W, H]),
    box("wall-end-lintel", "wall", "structure", [L, e0, exit.heightM], [L + t, e1, H]),
    box("door-leaf-exit", "door", "structure", [L + 0.05, e0, 0], [L + 0.1, e1, exit.heightM], "exit-door"),
    box("partition-1", "wall", "structure", [door.u, 0, 0], [door.u + door.thicknessM, d0, H]),
    box("partition-2", "wall", "structure", [door.u, d1, 0], [door.u + door.thicknessM, W, H]),
    box("partition-lintel", "wall", "structure", [door.u, d0, door.heightM], [door.u + door.thicknessM, d1, H]),
  ];
}

/** Furniture blocks against alternating walls in [u0, u1], each leaving at least minPassM of free width. */
function furniture(r: Rand, prefix: string, u0: number, u1: number, count: number, W: number): LocalBox[] {
  const out: LocalBox[] = [];
  if (count <= 0 || u1 - u0 < 0.8) return out;
  const segment = (u1 - u0) / count;
  let side = r(`${prefix}-side0`) < 0.5 ? 0 : 1;
  for (let k = 0; k < count; k++) {
    const depth = lerp(0.45, 1.1, r(`${prefix}-depth`, k));
    const u = u0 + segment * k + (segment - Math.min(depth, segment * 0.8)) * r(`${prefix}-u`, k);
    const protrude = lerp(0.5, Math.max(0.55, W - LAYOUT.minPassM - 0.05), r(`${prefix}-protrude`, k));
    const height = lerp(1.6, 2.4, r(`${prefix}-height`, k));
    const v0 = side === 0 ? 0 : W - protrude;
    out.push(box(`${prefix}-${k}`, "furniture", "furniture", [u, v0, 0], [u + Math.min(depth, segment * 0.8), v0 + protrude, height]));
    if (r(`${prefix}-flip`, k) < 0.75) side = 1 - side;
  }
  return out;
}

function overlapsU(boxes: readonly LocalBox[], u0: number, u1: number, v0: number, v1: number, margin: number): boolean {
  return boxes.some(b => b.role !== "structure" && b.min[0] < u1 + margin && b.max[0] > u0 - margin && b.min[1] < v1 + margin && b.max[1] > v0 - margin);
}

/** Shelves and boxes against both walls (tall ones narrow the corridor; short ones are visual clutter only). */
function clutter(r: Rand, L: number, W: number, door: CourseLayout["doorway"], taken: readonly LocalBox[]): LocalBox[] {
  const out: LocalBox[] = [];
  const count = 4 + Math.floor(r("clutter-count") * 6);
  for (let k = 0; k < count; k++) {
    const depth = lerp(0.3, 0.8, r("clutter-depth", k));
    const u = lerp(1.4, L - 1.6 - depth, r("clutter-u", k));
    const protrude = lerp(0.12, 0.32, r("clutter-protrude", k));
    const tall = r("clutter-tall", k) < 0.55;
    const height = tall ? lerp(1.5, 2.3, r("clutter-height", k)) : lerp(0.5, 0.85, r("clutter-height", k));
    const left = r("clutter-side", k) < 0.5;
    const v0 = left ? W - protrude : 0;
    const v1 = v0 + protrude;
    const nearDoor = u < door.u + door.thicknessM + 0.3 && u + depth > door.u - 0.3;
    if (nearDoor || overlapsU([...taken, ...out], u, u + depth, v0, v1, 0.05)) continue;
    out.push(box(`clutter-${k}`, "furniture", "clutter", [u, v0, 0], [u + depth, v1, height]));
  }
  const lows = Math.floor(r("low-count") * 3);
  for (let k = 0; k < lows; k++) {
    const size = lerp(0.4, 0.9, r("low-size", k));
    const u = lerp(LAYOUT.firstObstacleU, L - 2.2, r("low-u", k));
    const v = lerp(0.2, W - 0.2 - size, r("low-v", k));
    if (overlapsU([...taken, ...out], u, u + size, v, v + size, 0.1)) continue;
    out.push(box(`low-${k}`, "furniture", "low", [u, v, 0], [u + size, v + size, lerp(0.35, 0.7, r("low-height", k))]));
  }
  return out;
}

/** Generate one layout attempt. Solvability is checked by the caller (course.ts) with the truth planner. */
export function generateLayout(seed: string, attempt: number): CourseLayout {
  const r = layoutRandom(seed, attempt);
  const L = round(lerp(11, 14, r("length")));
  const W = round(lerp(2.0, 3.0, r("width")));
  const doorWidth = lerp(0.85, 1.1, r("door-width"));
  const doorway = { u: round(L * lerp(0.45, 0.6, r("door-u"))), thicknessM: LAYOUT.wallM, v: round(lerp(0.2 + doorWidth / 2, W - 0.2 - doorWidth / 2, r("door-v"))), widthM: round(doorWidth), heightM: LAYOUT.doorHeightM };
  const exit = { v: round(W / 2), widthM: 0.9, heightM: 2.0 };
  const roomA = furniture(r, "furn-a", LAYOUT.firstObstacleU, doorway.u - 1.2, 2 + Math.floor(r("furn-a-count") * 2), W);
  const roomB = furniture(r, "furn-b", doorway.u + doorway.thicknessM + 1.3, L - 2.2, 1 + Math.floor(r("furn-b-count") * 2), W);
  const obstacles: LocalBox[] = [...roomA, ...roomB];
  if (W >= 2.4 && r("column") < 0.4) {
    const size = lerp(0.3, 0.45, r("column-size"));
    const inA = r("column-room") < 0.5;
    const u = inA ? lerp(LAYOUT.firstObstacleU + 0.5, doorway.u - 1.0, r("column-u")) : lerp(doorway.u + 1.4, L - 2.4, r("column-u"));
    const v = lerp(LAYOUT.minPassM + 0.05, W - LAYOUT.minPassM - 0.05 - size, r("column-v"));
    if (!overlapsU(obstacles, u, u + size, 0, W, 0.5)) obstacles.push(box("column", "wall", "column", [u, v, 0], [u + size, v + size, LAYOUT.heightM]));
  }
  obstacles.push(...clutter(r, L, W, doorway, obstacles));
  const goal = { u: round(L - 1.0), v: round(W / 2 + (r("goal-v") - 0.5) * 0.5 * Math.max(0, W - 1.2)) };
  const start = { u: 0.9, v: round(lerp(0.6, W - 0.6, r("start-v"))), yawRad: round((r("start-yaw") - 0.5) * 0.7) };
  let debris: CourseLayout["debris"] = null;
  if (r("debris") < 0.6) {
    const inB = r("debris-room") < 0.6;
    const u = inB ? lerp(doorway.u + 1.2, L - 2.3, r("debris-u")) : lerp(LAYOUT.firstObstacleU + 0.4, doorway.u - 1.0, r("debris-u"));
    const width = lerp(0.6, Math.min(1.0, W - LAYOUT.minPassM - 0.1), r("debris-width"));
    const centre = Math.min(W - width / 2 - 0.02, Math.max(width / 2 + 0.02, goal.v + (r("debris-v") - 0.5) * 0.6));
    const depth = lerp(0.35, 0.6, r("debris-depth"));
    const debrisBox = box("debris", "furniture", "debris", [u, centre - width / 2, 0], [u + depth, centre + width / 2, lerp(1.6, 2.2, r("debris-height"))]);
    debris = { box: debrisBox, triggerU: round(u - lerp(2.0, 3.5, r("debris-trigger"))) };
  }
  return { lengthM: L, widthM: W, heightM: LAYOUT.heightM, flightHeightM: LAYOUT.flightHeightM, doorway, exit, boxes: [...structure(L, W, doorway, exit), ...obstacles], debris, start, goal };
}
