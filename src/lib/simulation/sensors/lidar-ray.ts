/**
 * The surface a lidar ray can return from, shared by the lidar sensor and the localization feature model so
 * both use the same physics (sensors/range-model.ts): oblique glass is transparent and the ray continues to
 * whatever lies behind it; smoke optical depth is integrated to the surface.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import { opticalDepth } from "../fire.ts";
import type { RuntimeCollider, WorldState } from "../world-state.ts";
import { lidarReturnProbability, lidarSeesGlass } from "./range-model.ts";
import type { TraceSet } from "./trace.ts";
import { hitIncidenceCos, traceNearest } from "./trace.ts";

export interface LidarSurface {
  readonly collider: RuntimeCollider;
  readonly distanceM: number;
  readonly cosIncidence: number;
  /** Visible-light optical depth from the sensor to the surface. */
  readonly tauVisible: number;
}

const MAX_GLASS_PASSES = 3;

export function lidarSurface(world: WorldState, set: TraceSet, origin: Vec3, dir: Vec3, maxRangeM: number): LidarSurface | null {
  const passed: string[] = [];
  const skipPassed = (collider: RuntimeCollider) => passed.includes(collider.id);
  for (let pass = 0; pass < MAX_GLASS_PASSES; pass++) {
    const index = traceNearest(set, origin, dir, maxRangeM, passed.length > 0 ? skipPassed : undefined);
    if (index < 0) return null;
    const distanceM = set.distance;
    const collider = set.colliders[index];
    const cosIncidence = hitIncidenceCos(set, index, origin, dir, distanceM);
    if (collider.kind !== "glass" || lidarSeesGlass(cosIncidence)) {
      const hit = vec3(origin.x + dir.x * distanceM, origin.y + dir.y * distanceM, origin.z + dir.z * distanceM);
      return { collider, distanceM, cosIncidence, tauVisible: opticalDepth(world, origin, hit) };
    }
    passed.push(collider.id);
  }
  return null;
}

/** Expected probability that the ray produces a true return (no randomness; used for feature quality). */
export function expectedLidarReturn(world: WorldState, set: TraceSet, origin: Vec3, dir: Vec3, maxRangeM: number): number {
  const surface = lidarSurface(world, set, origin, dir, maxRangeM);
  return surface === null ? 0 : lidarReturnProbability(surface.collider.kind, surface.distanceM, surface.tauVisible, maxRangeM, surface.cosIncidence);
}
