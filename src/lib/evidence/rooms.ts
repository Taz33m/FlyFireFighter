import type { FloorPlanPrior } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { pointInPolygon } from "../contracts/geometry.ts";

export type PriorRoom = FloorPlanPrior["rooms"][number];

/**
 * The first prior room whose floor polygon contains the point and whose height band includes it, or null
 * (exterior, stairwell, or a position the prior does not describe). The prior is not current geometry, so
 * this is the room the plan assigns, not a verified location.
 */
export function roomContaining(prior: FloorPlanPrior, p: Vec3): PriorRoom | null {
  for (const room of prior.rooms) {
    if (p.z >= room.zMin && p.z <= room.zMax && pointInPolygon(p.x, p.y, room.polygon)) return room;
  }
  return null;
}
