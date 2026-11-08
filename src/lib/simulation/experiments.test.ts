import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TICK_S } from "../contracts/clock.ts";
import type { JsonValue } from "../contracts/canonical.ts";
import { canonicalJson } from "../contracts/canonical.ts";
import { vec3 } from "../contracts/frames.ts";
import { issueBatch } from "../harness/issued.ts";
import type { Experiment } from "./experiments.ts";
import { applyExperiment } from "./experiments.ts";
import { fixtureScenario } from "./fixture-scene.ts";
import { hashWorld, worldSnapshot } from "./hash.ts";
import { planEvacuationRoute } from "./occupant-route.ts";
import { createWorld, stepWorld } from "./world.ts";
import { FIXTURE_SCENE, guarded } from "./world-fixtures.ts";
import type { WorldState } from "./world-state.ts";

const fresh = (): WorldState => createWorld(FIXTURE_SCENE, fixtureScenario());

/** Top-level truth sections an experiment changed. */
function changedSections(world: WorldState, experiment: Experiment): string[] {
  const before = worldSnapshot(world) as { [key: string]: JsonValue };
  applyExperiment(world, experiment);
  const after = worldSnapshot(world) as { [key: string]: JsonValue };
  return Object.keys(after).filter(key => canonicalJson(before[key]) !== canonicalJson(after[key])).sort();
}

describe("experiment hooks", () => {
  test("each hook changes only the truth it documents", () => {
    assert.deepEqual(changedSections(fresh(), { kind: "add_obstruction", id: "debris-1", min: vec3(1.5, 4.5, 2.9), max: vec3(2.5, 5.0, 3.5) }), ["activeColliderIds", "addedColliders", "scene"]);
    assert.deepEqual(changedSections(fresh(), { kind: "add_occupant", key: "judge-1", position: vec3(3.0, 5.0, 2.9), mobility: "mobile" }), ["occupants"]);
    assert.deepEqual(changedSections(fresh(), { kind: "set_door", openingId: "door-bath", state: "open" }), ["activeColliderIds", "openings"]);
    assert.deepEqual(changedSections(fresh(), { kind: "add_smoke", roomId: "bedroom", extinctionPerM: 1.0 }), ["compartments"]);
    assert.deepEqual(changedSections(fresh(), { kind: "degrade_localization", sigmaM: 0.5 }), ["estimator"]);
  });

  test("a rejected experiment leaves the world untouched", () => {
    const world = fresh();
    const before = hashWorld(world);
    const bad: Experiment[] = [
      { kind: "add_obstruction", id: "flat", min: vec3(1, 1, 1), max: vec3(2, 1, 2) },
      { kind: "add_obstruction", id: "nan", min: vec3(Number.NaN, 1, 1), max: vec3(2, 2, 2) },
      { kind: "add_occupant", key: "occupant-1", position: vec3(3, 5, 2.9), mobility: "mobile" },
      { kind: "add_occupant", key: "far", position: vec3(500, 0, 0), mobility: "mobile" },
      { kind: "set_door", openingId: "win-rear-bedroom", state: "open" },
      { kind: "set_door", openingId: "door-nowhere", state: "open" },
      { kind: "add_smoke", roomId: "attic", extinctionPerM: 1 },
      { kind: "degrade_localization", sigmaM: -1 },
    ];
    for (const experiment of bad) assert.throws(() => applyExperiment(world, experiment), RangeError, experiment.kind);
    assert.equal(hashWorld(world), before);
  });

  test("an obstruction blocks the aircraft and, in a doorway, the occupant's route", () => {
    const world = fresh();
    world.fires.forEach(f => { f.extinguished = true; f.heatReleaseKW = 0; });
    assert.ok(planEvacuationRoute(world, FIXTURE_SCENE.anchors.occupantStart));
    applyExperiment(world, { kind: "add_obstruction", id: "debris-door", min: vec3(3.9, 5.0, 2.9), max: vec3(4.2, 6.0, 3.6) });
    assert.equal(planEvacuationRoute(world, FIXTURE_SCENE.anchors.occupantStart), null);

    applyExperiment(world, { kind: "add_obstruction", id: "debris-yard", min: vec3(5.5, -5.0, 0), max: vec3(6.5, -4.6, 2) });
    world.drone.position = vec3(6, -6, 1);
    world.drone.yawRad = Math.PI / 2;
    for (let i = 0; i < 150; i++) stepWorld(world, issueBatch({ runId: world.runId, tick: world.tick, motion: guarded(vec3(1.5, 0, 0)), commands: [] }));
    const hits = world.truthEvents.filter(e => e.kind === "collision");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].data.colliderId, "obstruction:debris-yard");
  });

  test("a judge-placed occupant in the spray region is wetted by the true jet and recorded for the evaluator", () => {
    const world = fresh();
    world.drone.position = vec3(2.6, 2.5, 3.9);
    world.drone.yawRad = Math.PI / 2;
    applyExperiment(world, { kind: "add_occupant", key: "judge-1", position: vec3(2.6, 3.7, 2.9), mobility: "mobile" });
    stepWorld(world, issueBatch({ runId: world.runId, tick: 0, motion: null, commands: [{ kind: "water", proposalId: "p-spray", flowLps: 0.2, volumeL: 0.2 * TICK_S, aimPoint: vec3(2.6, 4.85, 3.0) }] }));
    const wet = world.truthEvents.filter(e => e.kind === "water_on_occupant");
    assert.equal(wet.length, 1);
    assert.equal(wet[0].data.occupantKey, "judge-1");
  });

  test("set_door opens, closes or blocks a leaf: collision geometry, open area and the occupant route follow", () => {
    const world = fresh();
    world.fires.forEach(f => { f.extinguished = true; f.heatReleaseKW = 0; });
    const start = FIXTURE_SCENE.anchors.occupantStart;
    applyExperiment(world, { kind: "set_door", openingId: "door-bedroom", state: "closed" });
    assert.equal(world.activeColliderIds.has("door-leaf-bedroom"), true, "a closed leaf stops the aircraft");
    assert.equal(world.openings.find(o => o.id === "door-bedroom")?.openAreaM2, 0);
    assert.ok(planEvacuationRoute(world, start), "an occupant can still open it");
    applyExperiment(world, { kind: "set_door", openingId: "door-bedroom", state: "blocked" });
    assert.equal(planEvacuationRoute(world, start), null);
    applyExperiment(world, { kind: "set_door", openingId: "door-bedroom", state: "open" });
    assert.equal(world.activeColliderIds.has("door-leaf-bedroom"), false);
    assert.ok(Math.abs(world.openings.find(o => o.id === "door-bedroom")!.openAreaM2 - 1.8) < 1e-12);
    assert.ok(planEvacuationRoute(world, start));
  });
});
