import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalJson } from "../../contracts/canonical.ts";
import { sceneModelFromMeta } from "../../simulation/scene.ts";
import { buildCourse, toLocal, toWorld } from "./course.ts";
import { LAYOUT } from "./layout.ts";
import type { PlanBox } from "./planner.ts";
import { lookaheadPoint, PlanGrid, reachable } from "./planner.ts";
import { COURSE_SEEDS, courseId, splitOf } from "./splits.ts";

// Scope: the fixed split lists (disjoint, stable), course generation for every listed seed (valid scene
// metadata, doorway width, determinism, solvability before and after debris, distinct layouts), the
// local/world transform, and the truth planner on hand-built geometry.

const ALL = (["train", "validation", "test"] as const).flatMap(split => COURSE_SEEDS[split].map(seed => ({ split, seed })));

describe("course splits", () => {
  test("train, validation and test seed lists are disjoint, fixed in size and resolve back to their split", () => {
    const seeds = ALL.map(c => c.seed);
    assert.equal(new Set(seeds).size, seeds.length);
    assert.deepEqual([COURSE_SEEDS.train.length, COURSE_SEEDS.validation.length, COURSE_SEEDS.test.length], [40, 12, 24]);
    for (const { split, seed } of ALL) assert.equal(splitOf(seed), split);
    assert.equal(splitOf("not-a-seed"), null);
    assert.equal(courseId("validation", "abc"), "val-abc");
  });
});

describe("course generation", () => {
  const courses = ALL.map(({ split, seed }) => buildCourse(split, seed));

  test("every listed seed yields valid scene metadata with a doorway the 0.55 m aircraft can pass", () => {
    for (const c of courses) {
      assert.doesNotThrow(() => sceneModelFromMeta(c.meta), c.courseId);
      assert.ok(c.layout.doorway.widthM >= 0.85, `${c.courseId} doorway ${c.layout.doorway.widthM}`);
      assert.ok(c.budgetS > 0 && c.speedCapMps > 0 && c.exposureGain > 0);
      assert.equal(c.meta.drone.spanM, 0.55);
    }
  });

  test("a course is a pure function of its seed, and different seeds give different layouts", () => {
    const again = buildCourse("test", COURSE_SEEDS.test[3]);
    assert.equal(canonicalJson(again.meta as never), canonicalJson(courses.find(c => c.courseId === again.courseId)?.meta as never));
    assert.equal(new Set(courses.map(c => canonicalJson(c.layout.boxes as never))).size, courses.length);
  });

  test("start → goal stays reachable at the planner clearance with and without the debris; variation is present", () => {
    for (const c of courses.slice(0, 20)) {
      const boxes = (extra: PlanBox[]): PlanBox[] => [...c.meta.colliders.filter(b => b.max[2] > LAYOUT.flightHeightM - 0.33 && b.min[2] < LAYOUT.flightHeightM + 0.33).map(b => ({ minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] })), ...extra];
      assert.ok(reachable(new PlanGrid(c.interior, boxes([])), c.start.position, c.goal), c.courseId);
      if (c.debris) {
        const d = c.debris.box;
        assert.ok(reachable(new PlanGrid(c.interior, boxes([{ minX: d.min.x, minY: d.min.y, maxX: d.max.x, maxY: d.max.y }])), c.start.position, c.goal), `${c.courseId} with debris`);
      }
    }
    assert.ok(courses.some(c => c.debris) && courses.some(c => !c.debris));
    assert.ok(courses.some(c => c.smokePerM > 0) && courses.some(c => c.smokePerM === 0));
    assert.equal(new Set(courses.map(c => c.headingIndex)).size, 4);
    assert.ok(new Set(courses.map(c => c.speedCapMps)).size >= 3);
  });

  test("toLocal inverts toWorld for every heading", () => {
    for (let k = 0; k < 4; k++) {
      const origin = { x: 3.5, y: -7.25 };
      const [x, y] = toWorld(k, origin, 4.2, 1.3);
      const [u, v] = toLocal({ headingIndex: k, origin }, x, y);
      assert.ok(Math.abs(u - 4.2) < 1e-6 && Math.abs(v - 1.3) < 1e-6, `heading ${k}`);
    }
  });
});

describe("truth planner", () => {
  const bounds = { minX: 0, minY: 0, maxX: 6, maxY: 3 };
  const wallWithGap = (gap: number): PlanBox[] => [
    { minX: 3, minY: 0, maxX: 3.1, maxY: 1.5 - gap / 2 }, { minX: 3, minY: 1.5 + gap / 2, maxX: 3.1, maxY: 3 },
    { minX: -1, minY: -0.2, maxX: 7, maxY: 0 }, { minX: -1, minY: 3, maxX: 7, maxY: 3.2 },
  ];

  test("a gap narrower than twice the minimum clearance blocks the path; a wider one does not", () => {
    assert.equal(reachable(new PlanGrid(bounds, wallWithGap(0.6)), { x: 1, y: 1.5 }, { x: 5, y: 1.5 }), false);
    assert.equal(reachable(new PlanGrid(bounds, wallWithGap(0.9)), { x: 1, y: 1.5 }, { x: 5, y: 1.5 }), true);
  });

  test("the look-ahead point heads for the gap from an offset start and the clearance is exact", () => {
    const grid = new PlanGrid(bounds, wallWithGap(0.9));
    const p = lookaheadPoint(grid, grid.field(5, 1.5), 2.0, 0.6, 0.6);
    assert.ok(p && p.x > 2.0 && p.y > 0.6, JSON.stringify(p));
    assert.ok(Math.abs(grid.clearanceAt(2, 1.5) - Math.hypot(1, 0.45)) < 1e-12, "nearest point is the gap edge at (3, 1.05)");
  });
});
