/**
 * Documented experiment hooks: the only sanctioned way to change world truth outside stepWorld.
 *
 * They change the ENVIRONMENT (geometry, people, smoke, localization conditions) between ticks — scenario
 * setup, judge challenges and paired-run perturbations — and never actuate the aircraft. Nothing here is
 * visible to planners except through the normal sensor path (e.g. "add_occupant" in a spray region is
 * detected only if a sensor sees the person). Each hook validates first and then mutates, so a rejected
 * experiment leaves the world untouched.
 *
 * - add_obstruction: a new box collider (id prefixed "obstruction:"), e.g. debris in a doorway; it blocks
 *   the aircraft and occupants.
 * - add_occupant: a person at a position, sheltering until the occupant policy moves them.
 * - set_door: opens (leaf collider removed, full clear area), closes (leaf back, no area; occupants can still
 *   open it) or blocks (closed and jammed: occupants cannot pass) a door. Broken openings never change.
 * - add_smoke / degrade_localization: delegate to the fire and localization models.
 */
import type { Vec3 } from "../contracts/frames.ts";
import { isFiniteVec3 } from "../contracts/frames.ts";
import { addSmoke } from "./fire.ts";
import { degradeLocalization } from "./localization.ts";
import { OBSTRUCTION_ID_PREFIX } from "./occupant-route.ts";
import type { DoorState } from "./openings.ts";
import { setDoorState } from "./openings.ts";
import { newOccupant } from "./world.ts";
import type { RuntimeCollider, WorldState } from "./world-state.ts";

export type Experiment =
  | { readonly kind: "add_obstruction"; readonly id: string; readonly min: Vec3; readonly max: Vec3; readonly colliderKind?: "furniture" | "wall" }
  | { readonly kind: "add_occupant"; readonly key: string; readonly position: Vec3; readonly mobility: "mobile" | "immobile" }
  | { readonly kind: "set_door"; readonly openingId: string; readonly state: DoorState }
  | { readonly kind: "add_smoke"; readonly roomId: string; readonly extinctionPerM: number }
  | { readonly kind: "degrade_localization"; readonly sigmaM: number };

const MIN_EXTENT_M = 1e-3;

export function applyExperiment(world: WorldState, experiment: Experiment): void {
  switch (experiment.kind) {
    case "add_obstruction":
      return addObstruction(world, experiment);
    case "add_occupant":
      return addOccupant(world, experiment);
    case "set_door":
      setDoorState(world, experiment.openingId, experiment.state);
      return;
    case "add_smoke":
      return addSmoke(world, experiment.roomId, experiment.extinctionPerM);
    case "degrade_localization":
      return degradeLocalization(world, experiment.sigmaM);
  }
}

function addObstruction(world: WorldState, e: Extract<Experiment, { kind: "add_obstruction" }>): void {
  const id = `${OBSTRUCTION_ID_PREFIX}${e.id}`;
  if (!e.id || world.scene.colliders.some(c => c.id === id)) throw new RangeError(`Obstruction id ${e.id} is empty or already used`);
  const valid = isFiniteVec3(e.min) && isFiniteVec3(e.max) && e.max.x - e.min.x >= MIN_EXTENT_M && e.max.y - e.min.y >= MIN_EXTENT_M && e.max.z - e.min.z >= MIN_EXTENT_M;
  if (!valid) throw new RangeError(`Obstruction ${e.id} must be a finite, non-degenerate box`);
  const collider: RuntimeCollider = { id, kind: e.colliderKind ?? "furniture", min: e.min, max: e.max, openingId: null };
  // The world owns its collider list (createWorld copies it); the frozen scene model is never touched.
  (world.scene.colliders as RuntimeCollider[]).push(collider);
  world.activeColliderIds.add(id);
}

function addOccupant(world: WorldState, e: Extract<Experiment, { kind: "add_occupant" }>): void {
  if (!e.key || world.occupants.some(o => o.key === e.key)) throw new RangeError(`Occupant key ${e.key} is empty or already used`);
  const { min, max } = world.scene.bounds;
  const p = e.position;
  if (!isFiniteVec3(p) || p.x < min.x || p.y < min.y || p.z < min.z || p.x > max.x || p.y > max.y || p.z > max.z) throw new RangeError(`Occupant ${e.key} must start inside the scene bounds`);
  world.occupants.push(newOccupant(e.key, p, e.mobility));
}
