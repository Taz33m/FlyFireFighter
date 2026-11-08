/**
 * Flow baseline safety and failure modes: frame quality, range assistance with uninformative (dark)
 * frames, reset, determinism, configurable caps under hostile inputs and malformed frames.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MotionCommand } from "../../contracts/actions.ts";
import { vec3 } from "../../contracts/frames.ts";
import { DEFAULT_COMMAND_CONFIG } from "./command.ts";
import { FRAME_STATUS, FlowBaselineController } from "./flow-baseline.ts";
import type { ScenarioFrame } from "./scenarios.ts";
import { approachSequence, darkSequence, staticSequence } from "./scenarios.ts";
import { mulberry32 } from "./synthetic.ts";
import type { CameraFrame, ControllerInput, ControllerOutput, GoalEstimate, RangeAssist } from "./types.ts";

const AHEAD: GoalEstimate = { bearingRad: 0, distanceM: 10, heightErrorM: 0 };
const command = (vx: number, yaw = 0): MotionCommand => ({ velocityBody: vec3(vx, 0, 0), yawRateRadps: yaw });
const baseInput = (frame: CameraFrame | null, tick: number): ControllerInput => ({ tick, frame, goal: AHEAD, previous: command(0), quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null });

function run(frames: readonly ScenarioFrame[], overrides: Partial<ControllerInput> = {}, controller = new FlowBaselineController()): ControllerOutput[] {
  return frames.map(({ frame }) => controller.step({ ...baseInput(frame, frame.captureTick), ...overrides }));
}

const STATIC = staticSequence({ frames: 8, noiseSigma: 0.005 });
const DARK = darkSequence({ frames: 8 });
const APPROACH = approachSequence({ frames: 60, speedMps: 1.2, wallDistanceM: 3.2, noiseSigma: 0.01 });

describe("flow baseline: frame quality", () => {
  test("lower frame quality lowers the requested speed and very low quality holds", () => {
    const speed = (frame: number) => run(STATIC, { quality: { frame, poseSigmaM: 0.1 } }).at(-1) as ControllerOutput;
    const good = speed(1);
    const poor = speed(0.35);
    const blind = speed(0.1);
    assert.ok(poor.request.velocityBody.x > 0 && poor.request.velocityBody.x < 0.6 * good.request.velocityBody.x, `${poor.request.velocityBody.x} vs ${good.request.velocityBody.x}`);
    assert.equal(poor.label, "flow_baseline/slow_low_vision");
    assert.equal(blind.request.velocityBody.x, 0);
    assert.equal(blind.label, "flow_baseline/hold_no_vision");
  });

  test("large pose uncertainty slows the approach and weakens goal steering", () => {
    const at = (poseSigmaM: number) => run(STATIC, { quality: { frame: 1, poseSigmaM }, goal: { ...AHEAD, bearingRad: 0.5 } }).at(-1) as ControllerOutput;
    const sure = at(0.1);
    const unsure = at(1.4);
    assert.ok(unsure.request.velocityBody.x < sure.request.velocityBody.x);
    assert.ok(unsure.request.yawRateRadps < 0.5 * sure.request.yawRateRadps);
  });
});

describe("flow baseline: range assistance with an uninformative dark frame", () => {
  const ranges = (forwardM: number | null): RangeAssist => ({ forwardM, leftM: 1.0, rightM: 2.0, downM: 1.2 });

  test("without ranges the dark frames give no usable vision, so the controller holds", () => {
    const out = run(DARK, { previous: command(0.8) }).at(-1) as ControllerOutput;
    assert.ok(out.features.visualConfidence < 0.15, `confidence ${out.features.visualConfidence}`);
    assert.equal(out.request.velocityBody.x, 0);
    assert.equal(out.label, "flow_baseline/hold_no_vision");
  });

  test("a forward range inside the clearance brakes and turns toward the more open side", () => {
    for (const out of run(DARK, { previous: command(0.8), ranges: ranges(0.35) })) {
      assert.equal(out.label, "flow_baseline/range_brake");
      assert.ok(out.request.velocityBody.x <= 0);
      assert.ok(out.request.yawRateRadps < 0, "right range is larger, so turn right");
    }
  });

  test("a clear forward range permits only the range-only creep speed", () => {
    const out = run(DARK, { previous: command(0.3), ranges: ranges(3) }).at(-1) as ControllerOutput;
    assert.ok(out.request.velocityBody.x > 0 && out.request.velocityBody.x <= DEFAULT_COMMAND_CONFIG.rangeOnlySpeedMps + 1e-12);
  });
});

describe("flow baseline: temporal state and determinism", () => {
  test("reset clears the frame pair, cue filters and free-distance memory", () => {
    const used = new FlowBaselineController();
    const braking = run(APPROACH, { previous: command(1.2) }, used).at(-1) as ControllerOutput;
    assert.equal(braking.features.freeDistanceKnown, 1);
    used.reset();
    const afterReset = run(STATIC, {}, used);
    const fresh = run(STATIC, {}, new FlowBaselineController());
    assert.equal(afterReset[0].features.frameStatus, FRAME_STATUS.firstOfPair);
    assert.equal(afterReset[0].features.freeDistanceKnown, 0);
    assert.deepEqual(afterReset, fresh);
  });

  test("identical input sequences produce identical outputs", () => {
    const mixed = (controller: FlowBaselineController) => APPROACH.map(({ frame }, k) =>
      controller.step({ ...baseInput(k % 7 === 3 ? null : frame, frame.captureTick), previous: command(1.2, 0.05 * Math.sin(k)), ranges: k % 5 === 0 ? { forwardM: 2.5 - 0.02 * k, leftM: null, rightM: 1.1, downM: 1.2 } : null }));
    assert.deepEqual(mixed(new FlowBaselineController()), mixed(new FlowBaselineController()));
  });
});

describe("flow baseline: caps and malformed input", () => {
  test("requests never exceed the configured caps, whatever the inputs", () => {
    const limits = { maxSpeedMps: 0.7, maxVerticalSpeedMps: 0.3, maxYawRateRadps: 0.5 };
    const controller = new FlowBaselineController({ command: { ...DEFAULT_COMMAND_CONFIG, limits } });
    const random = mulberry32(42);
    const pick = <T>(options: readonly T[]): T => options[Math.floor(random() * options.length)];
    const wild = () => pick([random() * 20 - 10, Number.NaN, Infinity, -Infinity, 0, -0.01, 1e9]);
    const frames = [...APPROACH.map(s => s.frame), ...DARK.map(s => s.frame), null];
    for (let k = 0; k < 400; k++) {
      const goal = random() < 0.15 ? null : { bearingRad: wild(), distanceM: wild(), heightErrorM: wild() };
      const ranges = random() < 0.4 ? null : { forwardM: pick([wild(), null]), leftM: pick([wild(), null]), rightM: pick([wild(), null]), downM: pick([wild(), null]) };
      const out = controller.step({ tick: 2 * k, frame: pick(frames), goal, previous: { velocityBody: vec3(wild(), wild(), wild()), yawRateRadps: wild() }, quality: { frame: wild(), poseSigmaM: wild() }, ranges });
      const v = out.request.velocityBody;
      assert.ok([v.x, v.y, v.z, out.request.yawRateRadps, ...Object.values(out.features)].every(Number.isFinite), `non-finite output at step ${k}`);
      assert.ok(Math.hypot(v.x, v.y) <= limits.maxSpeedMps + 1e-9 && Math.abs(v.z) <= limits.maxVerticalSpeedMps + 1e-9 && Math.abs(out.request.yawRateRadps) <= limits.maxYawRateRadps + 1e-9);
      assert.equal(out.request.source, "flow_baseline");
      assert.equal(out.request.tick, 2 * k);
      assert.match(out.label, /^flow_baseline\/[a-z_]+$/);
    }
  });

  test("a malformed frame is treated as no vision instead of throwing", () => {
    const frame = { ...STATIC[0].frame, luminance: new Float32Array(10) };
    const out = new FlowBaselineController().step(baseInput(frame, 0));
    assert.equal(out.features.frameStatus, FRAME_STATUS.invalid);
    assert.equal(out.request.velocityBody.x, 0);
  });

  test("a calibration change restarts the frame pair instead of comparing incompatible frames", () => {
    const controller = new FlowBaselineController();
    const recalibrated = staticSequence({ frames: 2, noiseSigma: 0.005, startTick: 2 * STATIC.length, calibrationId: "synthetic-pinhole-v2" });
    const statuses = [...STATIC, ...recalibrated].map(({ frame }) => controller.step(baseInput(frame, frame.captureTick)).features.frameStatus);
    assert.deepEqual(statuses.slice(-3), [FRAME_STATUS.flow, FRAME_STATUS.firstOfPair, FRAME_STATUS.flow]);
  });
});
