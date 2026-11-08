/**
 * Command-panel clock formatting: minutes and tenths of simulated seconds, rounded once so a time just under a
 * minute boundary never reads as 60 seconds.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatClock } from "./format.ts";

describe("formatClock", () => {
  test("rounds to tenths before splitting minutes from seconds", () => {
    assert.equal(formatClock(59996), "10:00.0", "599.96 s");
    assert.equal(formatClock(5995), "1:00.0", "59.95 s");
    assert.equal(formatClock(5994), "0:59.9", "59.94 s");
  });

  test("pads seconds and starts at zero", () => {
    assert.equal(formatClock(0), "0:00.0");
    assert.equal(formatClock(6524), "1:05.2", "65.24 s");
    assert.equal(formatClock(60000), "10:00.0");
  });
});
