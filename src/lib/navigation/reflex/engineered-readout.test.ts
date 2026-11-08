/**
 * Engineered readout on synthetic motion features. Scope: the hand-set feature → cue → command mapping
 * with a kinematic stand-in for FlyVis T4/T5 sector features (outward motion = k·speed/distance plus
 * rotationGain·yaw, expansion = (right − left)/2 as in services/flyvis). The real features arrive later;
 * nothing here measures the fly model.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MotionCommand } from "../../contracts/actions.ts";
import { vec3 } from "../../contracts/frames.ts";
import { DEFAULT_COMMAND_CONFIG } from "./command.ts";
import type { MotionFeatureVector } from "./engineered-readout.ts";
import { EngineeredReadoutController } from "./engineered-readout.ts";
import { mulberry32 } from "./synthetic.ts";
import type { ControllerInput, ControllerOutput, GoalEstimate } from "./types.ts";

const AHEAD: GoalEstimate = { bearingRad: 0, distanceM: 10, heightErrorM: 0 };
const command = (vx: number, yaw = 0): MotionCommand => ({ velocityBody: vec3(vx, 0, 0), yawRateRadps: yaw });

interface Kinematics { v: number; frontM?: number; leftM?: number; rightM?: number; yaw?: number; centerBias?: number }

/** Synthetic sector features: outward motion k·v/distance per side (the nearer of side and front), rotation adds rightward motion. */
function features(o: Kinematics, k = 0.8): MotionFeatureVector {
  const rotation = o.yaw ?? 0;
  const front = o.frontM ? (k * o.v) / o.frontM : 0;
  const outLeft = Math.max(front, o.leftM ? (k * o.v) / o.leftM : 0);
  const outRight = Math.max(front, o.rightM ? (k * o.v) / o.rightM : 0);
  const leftMotion = -outLeft + rotation;
  const rightMotion = outRight + rotation;
  return { leftMotion, centerMotion: rotation + (o.centerBias ?? 0), rightMotion, expansion: (rightMotion - leftMotion) / 2 };
}

interface Step { readonly f: MotionFeatureVector | null; readonly input?: Partial<ControllerInput> }

function run(steps: readonly Step[], controller?: EngineeredReadoutController): ControllerOutput[] {
  let current: MotionFeatureVector | null = null;
  const c = controller ?? new EngineeredReadoutController({ features: () => current });
  return steps.map((s, k) => {
    current = s.f;
    return c.step({ tick: 2 * k, frame: null, goal: AHEAD, previous: command(0), quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null, ...s.input });
  });
}

/** Frame quality is the sensor adapter's estimate for the frame the features came from. */
const withQuality = (frame: number): Partial<ControllerInput> => ({ quality: { frame, poseSigmaM: 0.1 } });

describe("engineered readout: looming from expansion", () => {
  const speed = 1.2;
  const approach: Step[] = Array.from({ length: 100 }, (_, k) => ({ f: features({ v: speed, frontM: 4 - speed * k * 0.02 }), input: { previous: command(speed) } }));
  const outputs = run(approach);
  const truth = (k: number) => speed / (4 - speed * k * 0.02);

  test("1/τ from d ln(expansion)/dt is within ±15% of the kinematic truth", () => {
    for (let k = 10; k < outputs.length; k++) {
      const ratio = outputs[k].features.loomingRateHz / truth(k);
      assert.ok(ratio > 0.85 && ratio < 1.15, `step ${k}: ratio ${ratio.toFixed(3)}`);
    }
  });

  test("brakes once τ falls below the braking threshold", () => {
    for (let k = 10; k <= 25; k++) assert.ok(outputs[k].request.velocityBody.x > 1.19, `early step ${k}: ${outputs[k].label}`);
    const late = outputs.filter((_, k) => 1 / truth(k) < 1.5);
    assert.ok(late.length > 5);
    for (const out of late) {
      assert.equal(out.label, "engineered_readout/brake_looming");
      assert.ok(out.request.velocityBody.x < 1.0);
    }
  });

  test("compensates its own deceleration through the efference copy", () => {
    let z = 4;
    const steps: Step[] = [];
    for (let k = 0; k < 80; k++) {
      const v = 1.2 - 0.01 * k;
      steps.push({ f: features({ v, frontM: z }), input: { previous: command(v) } });
      z -= v * 0.02;
    }
    const outs = run(steps);
    let zz = 4;
    steps.forEach((s, k) => {
      const v = 1.2 - 0.01 * k;
      if (k >= 10) assert.ok(Math.abs(outs[k].features.loomingRateHz / (v / zz) - 1) < 0.2, `step ${k}`);
      zz -= v * 0.02;
    });
  });

  test("steady corridor expansion is not mistaken for looming", () => {
    const corridor = run(Array.from({ length: 50 }, () => ({ f: features({ v: speed, leftM: 1.0, rightM: 1.0 }), input: { previous: command(speed) } }))).slice(10);
    for (const out of corridor) {
      assert.ok(out.features.loomingRateHz < 0.05);
      assert.notEqual(out.label, "engineered_readout/brake_looming");
      assert.ok(out.request.velocityBody.x > 1.19);
    }
  });
});

describe("engineered readout: steering", () => {
  const last = (steps: Step[]) => run(steps).at(-1) as ControllerOutput;
  const repeat = (step: Step, n = 12): Step[] => Array.from({ length: n }, () => step);

  test("larger outward motion on the left yaws right; the mirror yaws left", () => {
    assert.ok(last(repeat({ f: features({ v: 1.2, leftM: 0.6, rightM: 2.0 }), input: { previous: command(1.2) } })).request.yawRateRadps < -0.2);
    assert.ok(last(repeat({ f: features({ v: 1.2, leftM: 2.0, rightM: 0.6 }), input: { previous: command(1.2) } })).request.yawRateRadps > 0.2);
  });

  test("the efference copy cancels self-rotation", () => {
    const turning = { f: features({ v: 0, yaw: 0.8 }) };
    const compensated = last(repeat({ ...turning, input: { previous: command(0, 0.8) } }));
    const uncompensated = last(repeat({ ...turning, input: { previous: command(0, 0) } }));
    assert.ok(compensated.features.centeringWeight < 0.01 && Math.abs(compensated.features.avoidTurn) < 0.01);
    assert.ok(uncompensated.features.centeringWeight > 0.5, "without derotation the rotation reads as lateral motion");
  });

  test("steers toward the goal bearing when the view is clear", () => {
    const clear = (bearingRad: number) => last(repeat({ f: features({ v: 0 }), input: { goal: { ...AHEAD, bearingRad } } }));
    assert.ok(clear(0.6).request.yawRateRadps > 0.5 && clear(-0.6).request.yawRateRadps < -0.5);
    assert.ok(Math.abs(clear(0).request.yawRateRadps) < 1e-9);
    assert.ok(clear(0.6).request.velocityBody.x > 0.3);
  });
});

describe("engineered readout: quality, ranges, state and caps", () => {
  const corridor = (input: Partial<ControllerInput> = {}): Step[] => Array.from({ length: 30 }, () => ({ f: features({ v: 1.2, leftM: 1.2, rightM: 1.2 }), input: { previous: command(1.2), ...input } }));

  test("lower frame quality lowers speed; no usable features holds unless ranges are present", () => {
    const good = run(corridor(withQuality(1))).at(-1) as ControllerOutput;
    const poor = run(corridor(withQuality(0.35))).at(-1) as ControllerOutput;
    assert.ok(poor.request.velocityBody.x < 0.6 * good.request.velocityBody.x && poor.request.velocityBody.x > 0);
    const none = run(Array.from({ length: 5 }, () => ({ f: null, input: { previous: command(0.8) } }))).at(-1) as ControllerOutput;
    assert.equal(none.request.velocityBody.x, 0);
    assert.equal(none.label, "engineered_readout/hold_no_vision");
    const ranged = run(Array.from({ length: 5 }, () => ({ f: null, input: { previous: command(0.8), ranges: { forwardM: 0.3, leftM: 2, rightM: 0.8, downM: 1.2 } } }))).at(-1) as ControllerOutput;
    assert.equal(ranged.label, "engineered_readout/range_brake");
    assert.ok(ranged.request.velocityBody.x <= 0 && ranged.request.yawRateRadps > 0, "brakes and turns toward the open left");
  });

  test("reset clears temporal state, and identical inputs give identical outputs", () => {
    let current: MotionFeatureVector | null = null;
    const used = new EngineeredReadoutController({ features: () => current });
    run(Array.from({ length: 60 }, (_, k) => ({ f: features({ v: 1.2, frontM: 3 - 0.024 * k }), input: { previous: command(1.2) } })), used);
    used.reset();
    const sequence = corridor();
    const replay = sequence.map((s, k) => {
      current = s.f;
      return used.step({ tick: 2 * k, frame: null, goal: AHEAD, previous: command(1.2), quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null });
    });
    assert.deepEqual(replay, run(sequence));
    assert.deepEqual(run(sequence), run(sequence));
  });

  test("requests stay within the configured caps under hostile inputs and never claim fly-model inference", () => {
    const limits = { maxSpeedMps: 0.9, maxVerticalSpeedMps: 0.4, maxYawRateRadps: 0.7 };
    const random = mulberry32(7);
    const wild = () => [random() * 4 - 2, Number.NaN, Infinity, -Infinity, 0, 1e6][Math.floor(random() * 6)];
    let current: MotionFeatureVector | null = null;
    const controller = new EngineeredReadoutController({ features: () => current, command: { ...DEFAULT_COMMAND_CONFIG, limits } });
    for (let k = 0; k < 400; k++) {
      current = random() < 0.2 ? null : { leftMotion: wild(), centerMotion: wild(), rightMotion: wild(), expansion: wild(), confidence: wild() };
      const out = controller.step({ tick: 2 * k, frame: null, goal: { bearingRad: wild(), distanceM: wild(), heightErrorM: wild() }, previous: { velocityBody: vec3(wild(), wild(), wild()), yawRateRadps: wild() }, quality: { frame: wild(), poseSigmaM: wild() }, ranges: random() < 0.5 ? null : { forwardM: wild(), leftM: wild(), rightM: null, downM: wild() } });
      const v = out.request.velocityBody;
      assert.ok([v.x, v.y, v.z, out.request.yawRateRadps, ...Object.values(out.features)].every(Number.isFinite), `non-finite at step ${k}`);
      assert.ok(Math.hypot(v.x, v.y) <= limits.maxSpeedMps + 1e-9 && Math.abs(v.z) <= limits.maxVerticalSpeedMps + 1e-9 && Math.abs(out.request.yawRateRadps) <= limits.maxYawRateRadps + 1e-9);
      assert.equal(out.request.source, "engineered_readout");
      assert.match(out.label, /^engineered_readout\/[a-z_]+$/);
    }
  });
});
