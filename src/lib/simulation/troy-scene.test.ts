import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { TICK_S } from "../contracts/clock.ts";
import { vec3 } from "../contracts/frames.ts";
import { regionContains } from "../contracts/geometry.ts";
import { fromJsonVec3 } from "../contracts/scene.ts";
import { extinctionAt, stepFire } from "./fire.ts";
import { stepOccupants } from "./occupant.ts";
import { locateFeet, planEvacuationRoute } from "./occupant-route.ts";
import { setDoorState } from "./openings.ts";
import { floorPlanPriorFromScene } from "./prior.ts";
import { lineOfSight } from "./raycast.ts";
import { parseSceneMeta, sceneModelFromMeta } from "./scene.ts";
import { createWorld } from "./world.ts";
import type { WorldState } from "./world-state.ts";
import { activeColliders } from "./world-state.ts";

const PATH = new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url);
const available = existsSync(PATH);

function troyWorld(): WorldState {
  const meta = parseSceneMeta(JSON.parse(readFileSync(PATH, "utf8")));
  const start = fromJsonVec3(meta.scenarioAnchors.occupantStart);
  return createWorld(sceneModelFromMeta(meta), { scenarioId: "troy-route", seed: "troy-1", runId: "run-troy", profile: TENDER_T1, fire: null, occupants: [{ key: "o", start, mobility: "mobile" }], openingOverrides: {} });
}

describe("occupant routing in the exported Troy training scene", { skip: available ? false : "public/scenes/troy-training/scene.meta.json is not present" }, () => {
  test("the scene converts; its prior links stair-main from room-g-entry up to room-u-hall and carries no scenario anchors", () => {
    const meta = parseSceneMeta(JSON.parse(readFileSync(PATH, "utf8")));
    assert.ok(sceneModelFromMeta(meta).rooms.length > 0);
    const prior = floorPlanPriorFromScene(meta);
    const stair = prior.stairs?.find(st => st.id === "stair-main");
    assert.equal(stair?.bottomRoomId, "room-g-entry");
    assert.equal(stair?.topRoomId, "room-u-hall");
    assert.ok(!JSON.stringify(prior).includes("occupantStart"));
  });

  test("from the rear bedroom: down the stair through the slab band, opening the closed front door, to the assembly point", () => {
    const world = troyWorld();
    const o = world.occupants[0];
    assert.equal(world.openings.find(x => x.id === "door-front")?.state, "closed");
    assert.ok(planEvacuationRoute(world, o.position));
    world.cues.audio = { templateId: "exit-ahead", origin: o.position, tick: 0 };
    let sawStair = false;
    for (let i = 0; i < 8000 && o.activity !== "arrived"; i++) {
      stepOccupants(world, TICK_S);
      sawStair ||= locateFeet(world.scene, o.position).kind === "stair";
      world.tick += 1;
    }
    assert.equal(o.activity, "arrived");
    assert.ok(sawStair, "the walk passed through stair positions that belong to no room");
    assert.ok(regionContains(world.scene.assemblyPoint, vec3(o.position.x, o.position.y, o.position.z + 0.05)));
    assert.equal(world.openings.find(x => x.id === "door-front")?.state, "open");
    assert.equal(world.activeColliderIds.has("col-door-door-front"), false);
  });

  test("with the front door blocked there is no way out", () => {
    const world = troyWorld();
    setDoorState(world, "door-front", "blocked");
    assert.equal(planEvacuationRoute(world, world.occupants[0].position), null);
  });
});

describe("smoke in the exported Troy training scene", { skip: available ? false : "public/scenes/troy-training/scene.meta.json is not present" }, () => {
  test("the open stairwell is a gas path: an upstairs hall fire smokes the stair and the entry below", () => {
    const meta = parseSceneMeta(JSON.parse(readFileSync(PATH, "utf8")));
    const well = meta.openings.filter(o => o.rooms.includes("room-g-entry") && o.rooms.includes("room-u-hall"));
    assert.deepEqual(well.map(o => [o.id, o.kind, o.initialState]), [["opening-stairwell", "opening", "open"]]);
    const world = createWorld(sceneModelFromMeta(meta), {
      scenarioId: "troy-smoke", seed: "troy-smoke", runId: "run-troy-smoke", profile: TENDER_T1, occupants: [], openingOverrides: {},
      fire: { roomId: "room-u-hall", origin: fromJsonVec3(meta.scenarioAnchors.fireOrigin), radiusM: 0.45, initialHeatReleaseKW: 60, fuelMJ: 40 },
    });
    // The stairwell is physically open: nothing between the stair foot's headroom and the upstairs hall.
    assert.ok(lineOfSight(activeColliders(world), vec3(17.0, 3.757, 2.0), vec3(17.0, 3.757, 5.0)));
    for (let i = 0; i < 1200; i++) stepFire(world, 0.1); // 120 s
    const k = (id: string) => world.compartments.find(c => c.id === id)!.smokeExtinctionPerM;
    assert.ok(k("room-u-hall") > 0.5, `the hall fills with smoke (K ${k("room-u-hall")})`);
    assert.ok(k("room-g-entry") > 0.1 * k("room-u-hall"), `smoke descends the stairwell into the entry (entry K ${k("room-g-entry")}, hall K ${k("room-u-hall")})`);
    assert.ok(extinctionAt(world, vec3(17.0, 3.757, 2.5)) > 0.1, "the lower stair is smoky");
  });
});
