/**
 * Flow baseline perception and steering on synthetic open-loop sequences (scenarios.ts). Scope: the
 * 80×45 Lucas–Kanade pipeline, derotation, centering, looming/τ braking and goal steering on rendered
 * fixture frames. Not a benchmark: the held-out comparison runs later in the 3D twin.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MotionCommand } from "../../contracts/actions.ts";
import { vec3 } from "../../contracts/frames.ts";
import { FlowBaselineController } from "./flow-baseline.ts";
import type { ScenarioFrame } from "./scenarios.ts";
import { approachSequence, lateralWallSequence, staticSequence, yawSequence } from "./scenarios.ts";
import type { ControllerInput, ControllerOutput, GoalEstimate } from "./types.ts";

const AHEAD: GoalEstimate = { bearingRad: 0, distanceM: 10, heightErrorM: 0 };
const command = (vx: number, yaw = 0): MotionCommand => ({ velocityBody: vec3(vx, 0, 0), yawRateRadps: yaw });

function run(frames: readonly ScenarioFrame[], overrides: Partial<ControllerInput> = {}, controller = new FlowBaselineController()): ControllerOutput[] {
  return frames.map(({ frame }) => controller.step({ tick: frame.captureTick, frame, goal: AHEAD, previous: command(0), quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null, ...overrides }));
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe("flow baseline: static scene with sensor noise", () => {
  const frames = staticSequence({ frames: 16, noiseSigma: 0.02 });

  test("measures near-zero flow and never brakes, even while its efference copy says it is moving", () => {
    const outputs = run(frames, { previous: command(1.0) }).slice(2);
    for (const out of outputs) {
      assert.ok(out.features.flowLeftHz < 0.05 && out.features.flowRightHz < 0.05, `lateral flow ${out.features.flowLeftHz}/${out.features.flowRightHz}`);
      assert.ok(Math.abs(out.features.divergenceHz) < 0.4, `divergence ${out.features.divergenceHz}`);
      assert.ok(out.features.tauS > 5, `tau ${out.features.tauS}`);
      assert.notEqual(out.label, "flow_baseline/brake_looming");
      assert.ok(out.request.velocityBody.x > 1.19, `forward ${out.request.velocityBody.x}`);
      assert.ok(Math.abs(out.request.yawRateRadps) < 0.1, `yaw ${out.request.yawRateRadps}`);
    }
  });
});

describe("flow baseline: approaching a textured wall (expansion with known τ)", () => {
  const speed = 1.2;
  const frames = approachSequence({ frames: 101, speedMps: speed, wallDistanceM: 4.0, noiseSigma: 0.01 });
  const outputs = run(frames, { previous: command(speed) });

  test("time-to-contact estimates stay within ±30% per frame and ±15% in median of the synthetic truth", () => {
    const ratios = outputs.slice(2).map((out, i) => out.features.tauS / (frames[i + 2].truth.tauS as number));
    for (const ratio of ratios) assert.ok(ratio > 0.7 && ratio < 1.3, `tau ratio ${ratio}`);
    const mid = median(ratios);
    assert.ok(mid > 0.85 && mid < 1.15, `median tau ratio ${mid}`);
  });

  test("the free distance from τ × efference-copy speed tracks the true distance within 30%", () => {
    for (let k = 20; k < frames.length; k++) {
      const truth = frames[k].truth.distanceAheadM as number;
      const free = outputs[k].features.freeDistanceM;
      assert.ok(Math.abs(free - truth) / truth < 0.3, `frame ${k}: free ${free} vs ${truth}`);
    }
  });

  test("cruises while τ is long and brakes progressively once τ falls below the braking threshold", () => {
    for (let k = 5; k <= 30; k++) assert.ok(outputs[k].request.velocityBody.x > 1.19, `early frame ${k} ${outputs[k].label}`);
    const late = outputs.filter((_, k) => (frames[k].truth.tauS as number) <= 1.6);
    assert.ok(late.length >= 10);
    for (const out of late) {
      assert.equal(out.label, "flow_baseline/brake_looming");
      assert.ok(out.request.velocityBody.x < 1.0, `late forward ${out.request.velocityBody.x}`);
    }
    assert.ok(late[late.length - 1].request.velocityBody.x < late[0].request.velocityBody.x - 0.15, "braking deepens as τ shrinks");
  });
});

describe("flow baseline: lateral wall passing on one side", () => {
  const steady = (outputs: readonly ControllerOutput[]) => outputs.slice(3);

  test("larger flow on the left yaws right (away from the wall)", () => {
    for (const out of steady(run(lateralWallSequence({ frames: 14, speedMps: 1.2, lateralOffsetM: 0.7 }), { previous: command(1.2) }))) {
      assert.ok(out.features.flowLeftHz > 2 * out.features.flowRightHz, `L ${out.features.flowLeftHz} R ${out.features.flowRightHz}`);
      assert.ok(out.features.centering > 0.3);
      assert.ok(out.request.yawRateRadps < -0.2, `yaw ${out.request.yawRateRadps}`);
    }
  });

  test("the mirrored wall on the right yaws left", () => {
    for (const out of steady(run(lateralWallSequence({ frames: 14, speedMps: 1.2, lateralOffsetM: -0.7 }), { previous: command(1.2) }))) {
      assert.ok(out.features.centering < -0.3);
      assert.ok(out.request.yawRateRadps > 0.2, `yaw ${out.request.yawRateRadps}`);
    }
  });
});

describe("flow baseline: rotation and goal steering", () => {
  test("derotation with the efference copy keeps a pure yaw from looking like a near wall", () => {
    const frames = yawSequence({ frames: 12, yawRateRadps: 1.0 });
    const compensated = run(frames, { previous: command(0, 1.0) }).slice(2);
    const uncompensated = run(frames, { previous: command(0, 0) }).slice(2);
    for (const out of compensated) assert.ok(Math.abs(out.features.centering * out.features.centeringWeight) < 0.35, `residual ${out.features.centering}`);
    for (const out of uncompensated) assert.ok(out.features.centering < -0.8, "without the efference copy the rotation reads as strong lateral flow");
  });

  test("steers toward the goal bearing when the view is clear", () => {
    const frames = staticSequence({ frames: 6, noiseSigma: 0.005 });
    const final = (bearingRad: number) => run(frames, { goal: { ...AHEAD, bearingRad } }).at(-1) as ControllerOutput;
    const left = final(0.6);
    const right = final(-0.6);
    const ahead = final(0);
    assert.ok(left.request.yawRateRadps > 0.5 && right.request.yawRateRadps < -0.5, `${left.request.yawRateRadps} ${right.request.yawRateRadps}`);
    assert.ok(Math.abs(ahead.request.yawRateRadps) < 0.1);
    assert.ok(left.request.velocityBody.x > 0.3, "advances while turning toward a goal ahead-left");
    const behind = final(2.6);
    assert.equal(behind.request.velocityBody.x, 0, "turns in place toward a goal behind");
    assert.ok(behind.request.yawRateRadps > 0.5);
  });
});
