/**
 * Room-to-box decomposition for the smoke shader: the boxes must tile each room polygon exactly (same
 * area, no overlap, nothing outside), so smoke optical depth is neither double-counted nor leaked.
 * Checked against every room in the committed troy-training scene metadata, plus synthetic cases.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Point2 } from "../contracts/geometry.ts";
import { pointInPolygon, polygonArea } from "../contracts/geometry.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import type { Rect } from "./room-boxes.ts";
import { polygonToRects, roomBoxes } from "./room-boxes.ts";

const meta = JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")) as SceneMetaJson;

const area = (r: Rect) => (r.maxX - r.minX) * (r.maxY - r.minY);

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}

function assertTiles(polygon: readonly Point2[], label: string): Rect[] {
  const rects = polygonToRects(polygon);
  const total = rects.reduce((sum, r) => sum + area(r), 0);
  assert.ok(Math.abs(total - Math.abs(polygonArea(polygon))) < 1e-9, `${label}: area ${total} vs ${polygonArea(polygon)}`);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) assert.equal(overlap(rects[i], rects[j]), 0, `${label}: boxes ${i} and ${j} overlap`);
    const r = rects[i];
    assert.ok(pointInPolygon((r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2, polygon), `${label}: box ${i} lies outside the room`);
  }
  return rects;
}

describe("room box decomposition", () => {
  test("every room in the committed scene metadata is tiled exactly", () => {
    assert.ok(meta.rooms.length > 0);
    let boxes = 0;
    for (const room of meta.rooms) boxes += assertTiles(room.polygon, room.id).length;
    assert.ok(boxes <= 32, `${boxes} boxes exceed the shader's 32-box smoke budget`);
  });

  test("an L-shaped room needs two boxes and a U-shaped room three", () => {
    assert.equal(assertTiles([[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]], "L").length, 2);
    assert.equal(assertTiles([[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]], "U").length, 3);
  });

  test("a rectangle stays one box and keeps the prism heights", () => {
    assert.deepEqual(roomBoxes([[0, 0], [4, 0], [4, 3], [0, 3]], 3.6, 6.5), [{ min: [0, 0, 3.6], max: [4, 3, 6.5] }]);
  });

  test("degenerate input yields no boxes", () => {
    assert.deepEqual(polygonToRects([[0, 0], [1, 1]]), []);
  });
});
