import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalJson, digestOf } from "../contracts/canonical.ts";
import { vec3 } from "../contracts/frames.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { FIXTURE_SCENE_META } from "./fixture-scene.ts";
import { floorPlanPriorFromScene } from "./prior.ts";

const withAnchors = (fireOrigin: [number, number, number], occupantStart: [number, number, number]): SceneMetaJson => ({
  ...FIXTURE_SCENE_META,
  scenarioAnchors: { ...FIXTURE_SCENE_META.scenarioAnchors, fireOrigin, occupantStart },
});

describe("floor-plan prior from scene metadata", () => {
  test("carries rooms, openings with their plan state, exits and the assembly point", () => {
    const prior = floorPlanPriorFromScene(FIXTURE_SCENE_META);
    assert.equal(prior.rooms.length, FIXTURE_SCENE_META.rooms.length);
    assert.equal(prior.openings.find(o => o.id === "win-rear-bedroom")?.priorState, "closed");
    assert.equal(prior.openings.find(o => o.id === "door-bedroom")?.priorState, "open");
    assert.deepEqual(prior.exits, [{ id: "exit-front", openingId: "front-door" }]);
    assert.equal(prior.assemblyPoint.kind, "box");
    assert.ok(Object.isFrozen(prior.openings));
  });

  test("links each stair to the rooms its ends stand in, and offsets stair geometry with the plan", () => {
    const prior = floorPlanPriorFromScene(FIXTURE_SCENE_META);
    assert.deepEqual(prior.stairs?.map(st => [st.id, st.bottomRoomId, st.topRoomId]), [["stair-main", "entry", "hall-up"]]);
    assert.deepEqual(prior.stairs?.[0].top, vec3(0.7, 3.9, 2.9));
    const shifted = floorPlanPriorFromScene(FIXTURE_SCENE_META, { corruption: { offsetM: vec3(1, 0, 0) } });
    assert.equal(shifted.stairs?.[0].bottom.x, 1.7);
    assert.equal(shifted.stairs?.[0].bottomRoomId, "entry", "room links are topological, not shifted");
  });

  test("never contains scenario anchors: moving the fire and occupant leaves the prior byte-identical", () => {
    const base = floorPlanPriorFromScene(FIXTURE_SCENE_META);
    const moved = floorPlanPriorFromScene(withAnchors([9.1, 1.1, 2.9], [1.0, 7.0, 0]));
    assert.equal(digestOf(moved), digestOf(base));
    const json = canonicalJson(base);
    for (const word of ["scenarioAnchors", "fireOrigin", "occupantStart", "colliders", "launchPoint"]) assert.ok(!json.includes(word), word);
  });

  test("applies corruption for map-prior experiments without touching the scene", () => {
    const prior = floorPlanPriorFromScene(FIXTURE_SCENE_META, {
      corruption: { openingStates: { "door-bedroom": "closed", "door-bath": "unknown" }, omitOpenings: ["arch-entry-living"] },
    });
    assert.equal(prior.openings.find(o => o.id === "door-bedroom")?.priorState, "closed");
    assert.equal(prior.openings.find(o => o.id === "door-bath")?.priorState, "unknown");
    assert.equal(prior.openings.some(o => o.id === "arch-entry-living"), false);
    assert.match(prior.source, /corrupted/);
    assert.equal(FIXTURE_SCENE_META.openings.find(o => o.id === "door-bedroom")?.initialState, "open");
  });

  test("an omitted exit opening removes the exit, and an offset misregisters every coordinate", () => {
    const noExit = floorPlanPriorFromScene(FIXTURE_SCENE_META, { corruption: { omitOpenings: ["front-door"] } });
    assert.deepEqual(noExit.exits, []);
    const shifted = floorPlanPriorFromScene(FIXTURE_SCENE_META, { corruption: { offsetM: vec3(0.5, -0.25, 0) } });
    const base = floorPlanPriorFromScene(FIXTURE_SCENE_META);
    assert.deepEqual(shifted.rooms[0].polygon[0], [base.rooms[0].polygon[0][0] + 0.5, base.rooms[0].polygon[0][1] - 0.25]);
    assert.equal(shifted.openings[0].center.x, base.openings[0].center.x + 0.5);
  });

  test("refuses corruption that names unknown openings instead of silently doing nothing", () => {
    assert.throws(() => floorPlanPriorFromScene(FIXTURE_SCENE_META, { corruption: { openingStates: { "door-garage": "closed" } } }), RangeError);
    assert.throws(() => floorPlanPriorFromScene(FIXTURE_SCENE_META, { corruption: { omitOpenings: ["nope"] } }), RangeError);
  });
});
