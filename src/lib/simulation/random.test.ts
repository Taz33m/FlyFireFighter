import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keyedGaussian, keyedUniform } from "./random.ts";

describe("keyed randomness", () => {
  test("is a pure function of its key", () => {
    assert.equal(keyedUniform("seed-1", "lidar", 400, 7), keyedUniform("seed-1", "lidar", 400, 7));
    assert.notEqual(keyedUniform("seed-1", "lidar", 400, 7), keyedUniform("seed-2", "lidar", 400, 7));
    assert.notEqual(keyedUniform("seed-1", "lidar", 400, 7), keyedUniform("seed-1", "thermal", 400, 7));
    assert.notEqual(keyedUniform("seed-1", "lidar", 400, 7), keyedUniform("seed-1", "lidar", 401, 7));
  });

  test("draws on one stream do not depend on how many draws another stream made", () => {
    const before = Array.from({ length: 50 }, (_, i) => keyedUniform("s", "ultrasound", 10, i));
    for (let i = 0; i < 1000; i++) keyedUniform("s", "lidar", 10, i);
    const after = Array.from({ length: 50 }, (_, i) => keyedUniform("s", "ultrasound", 10, i));
    assert.deepEqual(after, before);
  });

  test("uniform draws stay in [0, 1) with a plausible mean and spread", () => {
    const values = Array.from({ length: 20000 }, (_, i) => keyedUniform("stat", "u", i % 500, Math.floor(i / 500)));
    assert.ok(values.every(v => v >= 0 && v < 1));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const buckets = new Array(10).fill(0);
    for (const v of values) buckets[Math.floor(v * 10)] += 1;
    assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
    assert.ok(buckets.every(count => Math.abs(count - 2000) < 200), `buckets ${buckets}`);
  });

  test("gaussian draws have near-zero mean and unit variance", () => {
    const values = Array.from({ length: 20000 }, (_, i) => keyedGaussian("stat", "g", i, 0));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    assert.ok(Math.abs(mean) < 0.03 && Math.abs(variance - 1) < 0.05, `mean ${mean}, variance ${variance}`);
  });
});
