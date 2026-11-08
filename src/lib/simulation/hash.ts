/**
 * Canonical digest of a world's mutable truth, for determinism checks, replay verification and result
 * bundles. Covers everything stepWorld and the experiment hooks can change: tick, aircraft, openings, active
 * and experiment-added colliders, compartments, fires, occupants, cues, the localization error state and
 * the truth-event log. The static scene is identified by its id and revision.
 */
import type { JsonValue } from "../contracts/canonical.ts";
import { canonicalJson, sha256Hex } from "../contracts/canonical.ts";
import { OBSTRUCTION_ID_PREFIX } from "./occupant-route.ts";
import type { WorldState } from "./world-state.ts";

function truthRecord(world: WorldState): unknown {
  return {
    runId: world.runId,
    seed: world.seed,
    scenarioId: world.scenarioId,
    scene: { sceneId: world.scene.meta.sceneId, revision: world.scene.meta.revision, colliderCount: world.scene.colliders.length },
    tick: world.tick,
    profile: { id: world.profile.id, revision: world.profile.revision },
    drone: world.drone,
    openings: world.openings,
    activeColliderIds: [...world.activeColliderIds].sort(),
    addedColliders: world.scene.colliders.filter(c => c.id.startsWith(OBSTRUCTION_ID_PREFIX)),
    compartments: world.compartments,
    fires: world.fires,
    occupants: world.occupants,
    cues: world.cues,
    estimator: world.estimator,
    truthEvents: world.truthEvents,
  };
}

/** Canonical JSON of the mutable truth. Throws if any truth value is non-finite. */
export function worldCanonicalJson(world: WorldState): string {
  return canonicalJson(truthRecord(world));
}

/** A detached copy of the mutable truth (e.g. for an evaluator overlay or a failing-test diff). */
export function worldSnapshot(world: WorldState): JsonValue {
  return JSON.parse(worldCanonicalJson(world)) as JsonValue;
}

/** SHA-256 of the canonical truth. */
export function hashWorld(world: WorldState): string {
  return sha256Hex(worldCanonicalJson(world));
}
