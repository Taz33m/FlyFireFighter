import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActuatorBatch, ActuatorCommand, GuardedMotion } from "../contracts/actions.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { vec3 } from "../contracts/frames.ts";
import { issueBatch } from "../harness/issued.ts";
import { applyExperiment } from "./experiments.ts";
import { fixtureScenario } from "./fixture-scene.ts";
import { hashWorld } from "./hash.ts";
import { createWorld, stepWorld } from "./world.ts";
import { FIXTURE_SCENE, guarded } from "./world-fixtures.ts";
import type { WorldState } from "./world-state.ts";

const batch = (world: WorldState, motion: GuardedMotion | null, commands: readonly ActuatorCommand[] = []): ActuatorBatch =>
  issueBatch({ runId: world.runId, tick: world.tick, motion, commands });

/** A fixed, scripted command sequence standing in for the harness: fly, spray, guide. */
function scripted(world: WorldState): ActuatorBatch {
  const t = world.tick;
  const motion = t < 200 ? guarded(vec3(2, 0, 0.3), 0.1, t) : guarded(vec3(0, 0, 0), 0, t);
  const commands: ActuatorCommand[] = [];
  if (t >= 100 && t < 150) commands.push({ kind: "water", proposalId: "p-1", flowLps: 0.2, volumeL: 0.002, aimPoint: vec3(6, -2, 0.5) });
  if (t >= 200) commands.push({ kind: "light_cue", proposalId: "p-2", target: vec3(4, -4, 1) });
  if (t === 220) commands.push({ kind: "audio", proposalId: "p-2", templateId: "follow-light" });
  return batch(world, motion, commands);
}

function runScripted(ticks: number, seed = "fixture-seed-1"): WorldState {
  const world = createWorld(FIXTURE_SCENE, fixtureScenario({ seed }));
  for (let i = 0; i < ticks; i++) stepWorld(world, scripted(world));
  return world;
}

describe("world creation", () => {
  test("starts the aircraft at the launch point with a full tank and its payloads, and the scene's opening states", () => {
    const world = createWorld(FIXTURE_SCENE, fixtureScenario({ openingOverrides: { "door-bath": "open" } }));
    assert.deepEqual(world.drone.position, FIXTURE_SCENE.launchPoint.position);
    assert.equal(world.drone.waterRemainingL, TENDER_T1.modules.water!.tankL);
    assert.deepEqual(world.drone.payloads, ["smoke-hood-1"]);
    assert.equal(world.openings.find(o => o.id === "door-bath")?.state, "open");
    assert.equal(world.activeColliderIds.has("door-leaf-bath"), false, "an open door's leaf does not collide");
    assert.equal(world.activeColliderIds.has("door-leaf-bedroom"), false);
    assert.equal(world.activeColliderIds.has("glass-rear-bedroom"), true);
    assert.equal(world.fires.length, 1);
    assert.equal(world.fires[0].roomId, "hall-up");
    assert.equal(world.occupants[0].activity, "shelter");
    assert.notEqual(world.scene.colliders, FIXTURE_SCENE.colliders, "the world owns its collider list");
  });

  test("rejects scenarios that name unknown openings or reuse occupant keys", () => {
    assert.throws(() => createWorld(FIXTURE_SCENE, fixtureScenario({ openingOverrides: { "door-garage": "open" } })), RangeError);
    const start = FIXTURE_SCENE.anchors.occupantStart;
    assert.throws(() => createWorld(FIXTURE_SCENE, fixtureScenario({ occupants: [{ key: "a", start, mobility: "mobile" }, { key: "a", start, mobility: "mobile" }] })), RangeError);
  });
});

describe("world stepping", () => {
  test("is deterministic: the same scene, scenario and harness batches give the same truth digest", () => {
    const a = runScripted(400);
    const b = runScripted(400);
    assert.equal(a.tick, 400);
    assert.equal(hashWorld(a), hashWorld(b));
    assert.ok(a.drone.waterRemainingL < TENDER_T1.modules.water!.tankL);
    assert.ok(a.truthEvents.some(e => e.kind === "water_delivered"));
  });

  test("the digest is sensitive to time, commands and keyed noise", () => {
    const base = runScripted(300);
    assert.notEqual(hashWorld(runScripted(301)), hashWorld(base));
    const nudged = runScripted(299);
    stepWorld(nudged, batch(nudged, guarded(vec3(2.01, 0, 0))));
    assert.notEqual(hashWorld(nudged), hashWorld(base));
    const s1 = createWorld(FIXTURE_SCENE, fixtureScenario({ seed: "s1" }));
    const s2 = createWorld(FIXTURE_SCENE, fixtureScenario({ seed: "s2" }));
    applyExperiment(s1, { kind: "degrade_localization", sigmaM: 0.5 });
    applyExperiment(s2, { kind: "degrade_localization", sigmaM: 0.5 });
    assert.notDeepEqual(s1.estimator.driftM, s2.estimator.driftM);
  });

  test("rejects a batch the harness did not issue, a copy of an issued batch, another run's batch and a wrong tick — without changing truth", () => {
    const world = createWorld(FIXTURE_SCENE, fixtureScenario());
    const before = hashWorld(world);
    const forged: ActuatorBatch = { runId: world.runId, tick: 0, motion: guarded(vec3(1, 0, 0)), commands: [] };
    assert.throws(() => stepWorld(world, forged), /harness-issued/);
    assert.throws(() => stepWorld(world, structuredClone(batch(world, null))), /harness-issued/);
    assert.throws(() => stepWorld(world, issueBatch({ runId: "other-run", tick: 0, motion: null, commands: [] })), /run/);
    assert.throws(() => stepWorld(world, issueBatch({ runId: world.runId, tick: 5, motion: null, commands: [] })), /tick/);
    assert.equal(hashWorld(world), before);
    const once = batch(world, null);
    stepWorld(world, once);
    assert.throws(() => stepWorld(world, once), /tick/, "a batch cannot be replayed");
  });

  test("fire and smoke advance only every FIRE_PERIOD_TICKS ticks", () => {
    const world = createWorld(FIXTURE_SCENE, fixtureScenario());
    const changes: number[] = [];
    let previous = world.fires[0].heatReleaseKW;
    for (let i = 0; i < 40; i++) {
      stepWorld(world, batch(world, null));
      if (world.fires[0].heatReleaseKW !== previous) changes.push(world.tick);
      previous = world.fires[0].heatReleaseKW;
    }
    assert.deepEqual(changes, [10, 20, 30, 40]);
  });

  test("a broken window stays broken through later ticks: glass gone, clear area kept, no way to re-close it", () => {
    const world = createWorld(FIXTURE_SCENE, fixtureScenario());
    world.drone.position = vec3(7.0, 8.3, 4.4);
    world.drone.yawRad = -Math.PI / 2;
    stepWorld(world, batch(world, null, [{ kind: "strike", proposalId: "p-breach", openingId: "win-rear-bedroom", point: vec3(7.0, 7.905, 4.4) }]));
    for (let i = 0; i < 500; i++) stepWorld(world, batch(world, null));
    const win = world.openings.find(o => o.id === "win-rear-bedroom")!;
    assert.equal(win.state, "broken");
    assert.ok(win.openAreaM2 > 1.19);
    assert.equal(world.activeColliderIds.has("glass-rear-bedroom"), false);
    assert.throws(() => applyExperiment(world, { kind: "set_door", openingId: "win-rear-bedroom", state: "closed" }), RangeError);
    assert.equal(world.truthEvents.filter(e => e.kind === "glass_broken").length, 1);
  });
});
