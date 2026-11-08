import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "../contracts/frames.ts";
import { lineOfSight, raycast, rayBoxDistance } from "./raycast.ts";
import type { RuntimeCollider } from "./world-state.ts";

const wall: RuntimeCollider = { id: "wall", kind: "wall", min: vec3(2, -1, 0), max: vec3(2.12, 1, 2.6), openingId: null };
const glass: RuntimeCollider = { id: "glass", kind: "glass", min: vec3(4, -1, 0), max: vec3(4.01, 1, 2.6), openingId: "win-1" };

describe("ray casting against collider boxes", () => {
  test("hits the near face of a box ahead and misses boxes behind or beside the ray", () => {
    assert.equal(rayBoxDistance(vec3(0, 0, 1), vec3(1, 0, 0), wall.min, wall.max, 10), 2);
    assert.equal(rayBoxDistance(vec3(0, 0, 1), vec3(-1, 0, 0), wall.min, wall.max, 10), null);
    assert.equal(rayBoxDistance(vec3(0, 5, 1), vec3(1, 0, 0), wall.min, wall.max, 10), null);
  });

  test("respects the maximum distance and reports 0 from inside a box", () => {
    assert.equal(rayBoxDistance(vec3(0, 0, 1), vec3(1, 0, 0), wall.min, wall.max, 1.5), null);
    assert.equal(rayBoxDistance(vec3(2.05, 0, 1), vec3(1, 0, 0), wall.min, wall.max, 10), 0);
  });

  test("returns the nearest collider and can ignore some (e.g. broken glass)", () => {
    const hit = raycast([glass, wall], vec3(0, 0, 1), vec3(1, 0, 0), 10);
    assert.equal(hit?.colliderId, "wall");
    const throughWall = raycast([glass, wall], vec3(3, 0, 1), vec3(1, 0, 0), 10);
    assert.equal(throughWall?.colliderId, "glass");
    assert.equal(raycast([glass], vec3(3, 0, 1), vec3(1, 0, 0), 10, c => c.kind === "glass"), null);
  });

  test("line of sight is blocked by a wall but not by a box beyond the target", () => {
    assert.equal(lineOfSight([wall], vec3(0, 0, 1), vec3(3, 0, 1)), false);
    assert.equal(lineOfSight([wall], vec3(0, 0, 1), vec3(1.9, 0, 1)), true);
  });
});
