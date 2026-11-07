/**
 * Door state changes shared by the occupant policy (an occupant opens an unlocked door it walks through)
 * and the experiment hooks (set_door). Windows change only through the glass breaker (actuators.ts), and a
 * broken opening never changes again.
 *
 * - open: state "open", door-leaf colliders removed, full clear area for the fire/smoke exchange.
 * - closed: state "closed", leaves back, no open area. Occupants can still open it; the aircraft cannot.
 * - blocked: like closed, but jammed or obstructed: occupants cannot pass or open it.
 */
import { clearOpeningAreaM2, findOpening } from "./scene.ts";
import type { WorldState } from "./world-state.ts";

export type DoorState = "open" | "closed" | "blocked";

/** Throws RangeError for a non-door or a broken opening; returns the previous state. */
export function setDoorState(world: WorldState, openingId: string, state: DoorState): string {
  const opening = findOpening(world.scene, openingId);
  const truth = world.openings.find(o => o.id === openingId);
  if (!opening || !truth || opening.kind !== "door") throw new RangeError(`${openingId} is not a door in this scene`);
  if (truth.state === "broken") throw new RangeError(`${openingId} is broken; broken openings stay broken`);
  const previous = truth.state;
  truth.state = state;
  truth.openAreaM2 = state === "open" ? clearOpeningAreaM2(opening) : 0;
  for (const collider of world.scene.colliders) {
    if (collider.kind !== "door" || collider.openingId !== openingId) continue;
    if (state === "open") world.activeColliderIds.delete(collider.id);
    else world.activeColliderIds.add(collider.id);
  }
  return previous;
}
