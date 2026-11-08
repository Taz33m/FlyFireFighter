/**
 * Efference-copy alignment: the command executed between two frame captures, not the latest command.
 * Misalignment fed the controller's own turns back as lateral flow (a closed-loop yaw limit cycle).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MotionCommand } from "../../contracts/actions.ts";
import { vec3 } from "../../contracts/frames.ts";
import { EfferenceHistory } from "./efference.ts";

const command = (vx: number, yaw: number): MotionCommand => ({ velocityBody: vec3(vx, 0, 0), yawRateRadps: yaw });

describe("efference history", () => {
  test("returns the time-weighted command over a capture interval that spans several steps", () => {
    const history = new EfferenceHistory();
    history.record(2, command(1.0, 0.2));
    history.record(4, command(0.6, -0.4));
    history.record(6, command(0.2, 0.0));
    assert.deepEqual(history.mean(2, 4), { yawRateRadps: -0.4, forwardMps: 0.6 });
    const spanning = history.mean(1, 5);
    assert.ok(spanning);
    assert.ok(Math.abs(spanning.yawRateRadps - (0.2 * 1 + -0.4 * 2 + 0 * 1) / 4) < 1e-12);
  });

  test("returns null when history covers less than half the interval, and clears when time goes backwards", () => {
    const history = new EfferenceHistory();
    history.record(10, command(1, 0.5));
    assert.equal(history.mean(0, 6), null);
    history.record(4, command(1, 0.5));
    assert.equal(history.mean(8, 10), null, "the entry before the backwards tick is gone");
    history.record(4, command(9, 9));
    assert.deepEqual(history.mean(2, 4), { yawRateRadps: 0.5, forwardMps: 1 }, "a repeated tick is ignored");
  });

  test("non-finite commands are recorded as zero", () => {
    const history = new EfferenceHistory();
    history.record(2, { velocityBody: vec3(Number.NaN, 0, 0), yawRateRadps: Infinity });
    assert.deepEqual(history.mean(0, 2), { yawRateRadps: 0, forwardMps: 0 });
  });
});
