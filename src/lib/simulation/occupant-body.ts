/**
 * Occupant body geometry (truth-side). OccupantTruth.position is the FEET point on the floor; the body is a
 * vertical capsule of radius OCCUPANT_RADIUS_M above it whose height follows the posture: standing, crouched
 * (crouch and cough animations) or lying (incapacitated).
 */
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import type { OccupantTruth } from "./world-state.ts";

export const OCCUPANT_RADIUS_M = 0.25;
export const STANDING_HEIGHT_M = 1.7;
export const CROUCHED_HEIGHT_M = 1.0;
export const LYING_HEIGHT_M = 0.4;

export function occupantHeightM(occupant: Pick<OccupantTruth, "activity" | "animation">): number {
  if (occupant.activity === "incapacitated") return LYING_HEIGHT_M;
  return occupant.animation === "crouch" || occupant.animation === "cough" ? CROUCHED_HEIGHT_M : STANDING_HEIGHT_M;
}

/** Eye/mouth height point, where smoke exposure and cue perception are evaluated. */
export function occupantHead(occupant: Pick<OccupantTruth, "position" | "activity" | "animation">): Vec3 {
  const p = occupant.position;
  return vec3(p.x, p.y, p.z + Math.max(0.2, occupantHeightM(occupant) - 0.1));
}

/** Points along the body axis from shin to head, for jet and line-of-sight tests. */
export function occupantBodyPoints(occupant: Pick<OccupantTruth, "position" | "activity" | "animation">): Vec3[] {
  const p = occupant.position;
  const height = occupantHeightM(occupant);
  const count = Math.max(2, Math.ceil(height / 0.35));
  return Array.from({ length: count }, (_, i) => vec3(p.x, p.y, p.z + 0.15 + ((height - 0.3) * i) / (count - 1)));
}
