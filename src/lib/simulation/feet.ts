/**
 * Which room a person standing at a point is in: inside the room's floor polygon with the feet within
 * FEET_BAND_M above its floor. Shared by scene validation (stair ends must stand in rooms), the planner's
 * floor-plan prior (stair room links) and occupant routing. Works on scene metadata rooms and runtime rooms.
 */
import type { Vec3 } from "../contracts/frames.ts";
import type { Point2 } from "../contracts/geometry.ts";
import { pointInPolygon } from "../contracts/geometry.ts";

/** Feet within this height above a room's floor are on that floor. */
export const FEET_BAND_M = 0.3;
/** Feet may sit this far below a floor (export rounding) and still stand on it. */
const BELOW_FLOOR_M = 0.1;

export interface FloorRoom {
  readonly id: string;
  readonly polygon: readonly Point2[];
  readonly zMin: number;
}

export function onRoomFloor(room: FloorRoom, p: Vec3): boolean {
  return p.z >= room.zMin - BELOW_FLOOR_M && p.z <= room.zMin + FEET_BAND_M && pointInPolygon(p.x, p.y, room.polygon);
}

export function roomUnderFeet<R extends FloorRoom>(rooms: readonly R[], p: Vec3): R | null {
  return rooms.find(room => onRoomFloor(room, p)) ?? null;
}
