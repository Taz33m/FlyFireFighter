import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "../contracts/frames.ts";
import { applyExperiment } from "./experiments.ts";
import { FIXTURE_SCENE_META, fixtureScenario } from "./fixture-scene.ts";
import { routeGraph } from "./occupant-graph.ts";
import { planEvacuationRoute } from "./occupant-route.ts";
import { sceneModelFromMeta } from "./scene.ts";
import { createWorld } from "./world.ts";

const BEDROOM = vec3(8.3, 6.9, 2.9);
/** A "wall"-kind obstruction across the bedroom doorway, the occupant's only way out. */
const DEBRIS = { kind: "add_obstruction", id: "debris", min: vec3(4.2, 5.0, 2.9), max: vec3(4.35, 6.0, 3.6), colliderKind: "wall" } as const;

describe("occupant route graph cache", () => {
  test("a wall obstruction added by one run before the first route query does not leak into later runs on the same scene", () => {
    const shared = sceneModelFromMeta(FIXTURE_SCENE_META);
    const obstructed = createWorld(shared, fixtureScenario({ fire: null, runId: "run-obstructed" }));
    applyExperiment(obstructed, DEBRIS);
    // The obstruction still blocks the run that added it (checked dynamically at query time)...
    assert.equal(planEvacuationRoute(obstructed, BEDROOM), null);

    // ...but a clean run sharing the scene metadata routes exactly as one built from fresh metadata.
    const clean = planEvacuationRoute(createWorld(shared, fixtureScenario({ fire: null, runId: "run-clean" })), BEDROOM);
    const fresh = planEvacuationRoute(createWorld(sceneModelFromMeta(structuredClone(FIXTURE_SCENE_META)), fixtureScenario({ fire: null, runId: "run-fresh" })), BEDROOM);
    assert.ok(fresh !== null);
    assert.ok(clean !== null, "the clean run must not depend on what the obstructed run did");
    assert.equal(clean.lengthM, fresh.lengthM);
  });

  test("the cached graph is the same whichever world builds it first", () => {
    const meta = structuredClone(FIXTURE_SCENE_META);
    const obstructed = createWorld(sceneModelFromMeta(meta), fixtureScenario({ fire: null, runId: "run-obstructed" }));
    applyExperiment(obstructed, DEBRIS);
    const fromObstructed = routeGraph(obstructed.scene);
    const fromFresh = routeGraph(sceneModelFromMeta(structuredClone(FIXTURE_SCENE_META)));
    const edgeCount = (g: typeof fromFresh) => g.edges.reduce((n, e) => n + e.length, 0);
    assert.equal(fromObstructed.nodes.length, fromFresh.nodes.length);
    assert.equal(edgeCount(fromObstructed), edgeCount(fromFresh));
  });
});
