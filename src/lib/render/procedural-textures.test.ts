/**
 * Procedural detail textures: identical bytes on every run (so paired controller runs see the same
 * world), real texture where the flat-coloured scene had none, no visible seam when tiled, and a checksum
 * that forces a TEXTURE_SET_VERSION bump whenever a pattern changes.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DetailClass } from "./procedural-textures.ts";
import { DETAIL_CLASSES, DETAIL_SIZE, TEXTURE_SET_VERSION, classifyMaterial, fnv1a, generateDetail } from "./procedural-textures.ts";

/** Recorded for TEXTURE_SET_VERSION "procedural-detail/v1"; update both together. */
const CHECKSUM_V1 = 0x04671a70;

function stats(data: Uint8Array): { mean: number; std: number } {
  const mean = data.reduce((s, v) => s + v, 0) / data.length;
  const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Mean absolute difference across the wrap seam versus between interior neighbours (columns or rows). */
function seamRatio(data: Uint8Array, size: number, axis: "x" | "y"): number {
  const at = (a: number, b: number) => (axis === "x" ? data[b * size + a] : data[a * size + b]);
  let seam = 0;
  let interior = 0;
  for (let b = 0; b < size; b++) {
    seam += Math.abs(at(size - 1, b) - at(0, b));
    for (let a = 1; a < size; a++) interior += Math.abs(at(a, b) - at(a - 1, b));
  }
  return seam / size / (interior / (size * (size - 1)));
}

describe("procedural detail textures", () => {
  test("generation is deterministic and matches the recorded version checksum", () => {
    let combined = "";
    for (const cls of DETAIL_CLASSES) {
      const a = generateDetail(cls);
      const b = generateDetail(cls);
      assert.equal(a.length, DETAIL_SIZE * DETAIL_SIZE);
      assert.deepEqual(a, b, `${cls} must be byte-identical between generations`);
      combined += `${cls}:${fnv1a(Array.from(a, v => String.fromCharCode(v)).join(""))};`;
    }
    const checksum = fnv1a(combined);
    assert.equal(TEXTURE_SET_VERSION, "procedural-detail/v1");
    assert.equal(checksum, CHECKSUM_V1, `patterns changed: bump TEXTURE_SET_VERSION and record 0x${checksum.toString(16)}`);
  });

  test("every class carries visible texture around mid-grey", () => {
    for (const cls of DETAIL_CLASSES) {
      const { mean, std } = stats(generateDetail(cls));
      assert.ok(mean > 50 && mean < 200, `${cls} mean ${mean.toFixed(1)}`);
      assert.ok(std > 12, `${cls} std ${std.toFixed(1)} is too flat to drive motion detectors`);
    }
  });

  test("noise classes tile without a seam", () => {
    const noisy: DetailClass[] = ["plaster", "stone", "foliage"];
    for (const cls of noisy) {
      const data = generateDetail(cls);
      for (const axis of ["x", "y"] as const) {
        const ratio = seamRatio(data, DETAIL_SIZE, axis);
        assert.ok(ratio < 2, `${cls} ${axis}-seam is ${ratio.toFixed(2)}× the interior neighbour difference`);
      }
    }
  });

  test("exported material names map to classes; glass, metal, lights and the aircraft get none", () => {
    const expected: Record<string, DetailClass | null> = {
      brick_dark: "brick", paint_white: "plaster", ceiling: "plaster", floor_wood: "wood", wood_stair: "wood", door_wood: "wood",
      fabric_red: "fabric", linen: "fabric", floor_carpet: "carpet", floor_tile: "paving", pavers: "paving", asphalt: "stone",
      stone_trim: "stone", roof_metal: "roof", copper: "roof", grass: "foliage", bark: "foliage",
      glass_clear: null, lens: null, guide_light: null, metal_dark: null, drone_body: null, black: null,
    };
    for (const [name, cls] of Object.entries(expected)) assert.equal(classifyMaterial(name), cls, name);
  });
});
