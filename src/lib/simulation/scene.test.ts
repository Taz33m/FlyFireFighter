import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { distance, vec3 } from "../contracts/frames.ts";
import { regionContains } from "../contracts/geometry.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { fromJsonVec3 } from "../contracts/scene.ts";
import { FIXTURE_SCENE_META } from "./fixture-scene.ts";
import { parseSceneMeta, roomAt, sceneModelFromMeta, SceneValidationError, validateSceneMeta } from "./scene.ts";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const copy = (): Mutable<SceneMetaJson> => structuredClone(FIXTURE_SCENE_META) as Mutable<SceneMetaJson>;
const errorsFor = (mutate: (meta: Mutable<SceneMetaJson>) => void): string[] => {
  const meta = copy();
  mutate(meta);
  return validateSceneMeta(meta);
};
const hasError = (errors: string[], fragment: string): boolean => errors.some(e => e.includes(fragment));

describe("scene metadata validation", () => {
  test("the fixture scene is valid", () => {
    assert.deepEqual(validateSceneMeta(FIXTURE_SCENE_META), []);
  });

  test("rejects a wrong schema or units", () => {
    assert.ok(hasError(errorsFor(m => { (m as { schema: string }).schema = "cloudbreak.scene/1"; }), "$.schema"));
    assert.ok(hasError(errorsFor(m => { (m as { units: string }).units = "ft"; }), "$.units"));
  });

  test("rejects NaN and infinite numbers wherever they appear, with their path", () => {
    const errors = errorsFor(m => {
      m.colliders[3].min[1] = Number.NaN;
      m.openings[0].widthM = Number.POSITIVE_INFINITY;
    });
    assert.ok(hasError(errors, "$.colliders[3].min[1]: non-finite"));
    assert.ok(hasError(errors, "$.openings[0].widthM: non-finite"));
  });

  test("rejects openings that name unknown rooms and colliders or exits that name unknown openings", () => {
    assert.ok(hasError(errorsFor(m => { m.openings[2].rooms[1] = "garage"; }), 'unknown room "garage"'));
    const leaf = FIXTURE_SCENE_META.colliders.findIndex(cl => cl.openingId === "door-bath");
    assert.ok(hasError(errorsFor(m => { m.colliders[leaf].openingId = "door-gone"; }), 'unknown opening "door-gone"'));
    assert.ok(hasError(errorsFor(m => { m.exits[0].openingId = "back-door"; }), 'unknown opening "back-door"'));
  });

  test("rejects an exit that does not lead outside and exterior on the inward side", () => {
    assert.ok(hasError(errorsFor(m => { m.exits[0].openingId = "door-bedroom"; }), "does not lead"));
    assert.ok(hasError(errorsFor(m => { m.openings[0].rooms = ["exterior", "entry"]; }), "may only be the second room"));
  });

  test("rejects degenerate boxes, including zero-thickness glass and an empty assembly point", () => {
    const glass = FIXTURE_SCENE_META.colliders.findIndex(cl => cl.kind === "glass");
    assert.ok(hasError(errorsFor(m => { m.colliders[glass].max[1] = m.colliders[glass].min[1]; }), "degenerate box"));
    assert.ok(hasError(errorsFor(m => { m.assemblyPoint.max[0] = m.assemblyPoint.min[0] - 1; }), "$.assemblyPoint: degenerate box"));
  });

  test("rejects clockwise (mirrored) and degenerate room polygons", () => {
    assert.ok(hasError(errorsFor(m => { m.rooms[0].polygon.reverse(); }), "clockwise"));
    assert.ok(hasError(errorsFor(m => { m.rooms[1].polygon = [[0, 0], [1, 1], [2, 2]]; }), "degenerate polygon"));
  });

  test("rejects rooms placed off their floor (cross-floor coordinate errors)", () => {
    assert.ok(hasError(errorsFor(m => { m.rooms[3].zMin = 0; }), "does not sit within floor 1"));
  });

  test("rejects stair ends that stand in no room or in a room on the wrong floor", () => {
    assert.ok(hasError(errorsFor(m => { m.stairs[0].top = [0.7, 3.9, 2.75]; }), "$.stairs[0].top: does not stand on the floor of any room"));
    assert.ok(hasError(errorsFor(m => { m.stairs[0].bottom = [6.0, 1.0, 0]; m.stairs[0].fromFloor = 1; m.stairs[0].toFloor = 0; }), "stands in living on floor 0, not floor 1"));
  });

  test("rejects a stair whose bottom and top rooms share no gas path (the fire model would seal the floors)", () => {
    const withoutWell = errorsFor(m => { m.openings = m.openings.filter(o => o.id !== "stairwell"); });
    assert.ok(hasError(withoutWell, "$.stairs[0]: no door or opening joins its bottom room entry and top room hall-up"), withoutWell.join("; "));
    // A window between the two rooms is not a stair's gas path either.
    const windowOnly = errorsFor(m => { const well = m.openings.find(o => o.id === "stairwell")!; well.kind = "window"; });
    assert.ok(hasError(windowOnly, "no door or opening joins its bottom room entry"), windowOnly.join("; "));
  });

  test("rejects duplicate ids, glass without a glazed opening and anchors not marked scenario-only", () => {
    assert.ok(hasError(errorsFor(m => { m.colliders[5].id = m.colliders[4].id; }), "duplicate id"));
    const glass = FIXTURE_SCENE_META.colliders.findIndex(cl => cl.kind === "glass");
    assert.ok(hasError(errorsFor(m => { m.colliders[glass].openingId = "door-bath"; }), "glazed opening"));
    assert.ok(hasError(errorsFor(m => { (m.scenarioAnchors as { scenarioOnly: boolean }).scenarioOnly = false; }), "scenarioOnly"));
  });

  test("reports structural problems without throwing on arbitrary input", () => {
    assert.ok(validateSceneMeta(null).length > 0);
    assert.ok(hasError(validateSceneMeta({ ...copy(), rooms: "none" }), "$.rooms: must be an array"));
  });

  test("conversion throws a SceneValidationError carrying every error", () => {
    const meta = copy();
    meta.units = "ft" as "m";
    meta.rooms[0].polygon.reverse();
    assert.throws(() => sceneModelFromMeta(meta as SceneMetaJson), (error: unknown) => error instanceof SceneValidationError && error.errors.length >= 2);
    assert.throws(() => parseSceneMeta({}), SceneValidationError);
  });
});

describe("scene model", () => {
  const scene = sceneModelFromMeta(FIXTURE_SCENE_META);

  test("converts rooms with their volumes and keeps openings, floors and anchors in world coordinates", () => {
    const bedroom = scene.rooms.find(r => r.id === "bedroom");
    assert.ok(bedroom);
    assert.ok(Math.abs(bedroom.volumeM3 - 5.75 * 4.75 * 2.6) < 1e-9);
    assert.equal(scene.openings.find(o => o.id === "win-rear-bedroom")?.glazed, true);
    assert.equal(scene.colliders.find(cl => cl.id === "glass-rear-bedroom")?.openingId, "win-rear-bedroom");
    assert.equal(scene.colliders.find(cl => cl.id === "wall-w")?.openingId, null);
    assert.deepEqual(scene.anchors.occupantStart, vec3(8.3, 6.9, 2.9));
    assert.ok(Object.isFrozen(scene) && Object.isFrozen(scene.colliders[0]));
  });

  test("assigns points to rooms by floor, so the same plan position resolves differently upstairs", () => {
    assert.equal(roomAt(scene, vec3(2, 6, 1))?.id, "kitchen");
    assert.equal(roomAt(scene, vec3(2, 6, 4))?.id, "hall-up");
    assert.equal(roomAt(scene, vec3(2, 6, 2.75)), null, "inside the slab");
    assert.equal(roomAt(scene, vec3(2, -3, 1)), null, "outside");
  });

  test("the fixture keeps its scenario geometry: assembly ≥ 10 m in front, fire in the hall, occupant in the bedroom", () => {
    const door = fromJsonVec3(FIXTURE_SCENE_META.openings.find(o => o.id === "front-door")!.center);
    const a = scene.assemblyPoint;
    assert.ok(a.kind === "box" && a.max.y <= door.y - 10);
    assert.ok(regionContains(a, vec3(2, -12.5, 0)));
    assert.equal(roomAt(scene, scene.anchors.fireOrigin)?.id, "hall-up");
    assert.equal(roomAt(scene, scene.anchors.occupantStart)?.id, "bedroom");
    assert.ok(distance(scene.launchPoint.position, door) > 5);
  });
});
