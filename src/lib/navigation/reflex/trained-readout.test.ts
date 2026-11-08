import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { NeuralFeatures } from "../../contracts/neural.ts";
import type { ReadoutFeatureSource, TrainedReadoutModel } from "./trained-readout.ts";
import { evaluateReadout, FLYVIS_MOTION_TYPES, parseTrainedReadout, READOUT_INPUT_NAMES, READOUT_SCHEMA, ReadoutFeatureBuilder, TrainedReadoutController } from "./trained-readout.ts";
import { DEFAULT_COMMAND_CONFIG } from "./command.ts";
import type { ControllerInput, RangeAssist } from "./types.ts";

// Scope: model-file validation, the forward pass against hand-computed values, input-vector construction
// and reset, the controller's shared caps (hold, arrival, quality, range assistance) around a fixture
// model, and — when models/readout/trained-readout-v1.json exists — that TypeScript inference reproduces
// the numpy self-check rows exported by services/flyvis/training/train_readout.py.

const n = READOUT_INPUT_NAMES.length;
const idx = (name: string): number => READOUT_INPUT_NAMES.indexOf(name);

/** Linear fixture: forward = 0.9 + 0.5·hm_C, yaw = 1.0·goal_bearing − 2·expansion (inputs not normalized). */
function fixtureModel(overrides: Partial<TrainedReadoutModel> = {}): TrainedReadoutModel {
  const fwd = new Array<number>(n).fill(0);
  const yaw = new Array<number>(n).fill(0);
  fwd[idx("hm_C")] = 0.5;
  yaw[idx("goal_bearing")] = 1.0;
  yaw[idx("expansion")] = -2.0;
  return {
    schema: READOUT_SCHEMA, id: "fixture-readout", label: "fixture readout", checkpoint: { name: "flow/0000/000", sha256: "d".repeat(64) },
    inputs: READOUT_INPUT_NAMES, outputs: ["forwardMps", "yawRateRadps"], featureConfig: { emaAlpha: 0.25, goalDistanceCapM: 4 },
    normalization: { mean: new Array(n).fill(0), std: new Array(n).fill(1) }, outputScale: { mean: [0, 0], std: [1, 1] },
    layers: [{ weights: [fwd, yaw], bias: [0.9, 0], activation: "linear" }], training: {}, ...overrides,
  };
}

function features(hm: [number, number, number] = [0, 0, 0], expansion = 0): ReadoutFeatureSource {
  const responses: Record<string, [number, number, number]> = {};
  for (const t of FLYVIS_MOTION_TYPES) responses[t] = [0.1, 0.2, 0.3];
  return { horizontalMotion: hm, expansion, responses } as Pick<NeuralFeatures, "horizontalMotion" | "expansion" | "responses">;
}

function input(overrides: Partial<ControllerInput> = {}): ControllerInput {
  return {
    tick: 10, frame: null, goal: { bearingRad: 0.2, distanceM: 5, heightErrorM: 0 }, previous: { velocityBody: { x: 0.5, y: 0, z: 0 }, yawRateRadps: 0.1 },
    quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null, ...overrides,
  };
}

describe("trained readout model file", () => {
  test("accepts a well-formed model and rejects wrong inputs, outputs, shapes, digests and non-finite weights", () => {
    assert.doesNotThrow(() => parseTrainedReadout(fixtureModel()));
    const bad: [string, Partial<TrainedReadoutModel>][] = [
      ["reordered inputs", { inputs: [...READOUT_INPUT_NAMES].reverse() }],
      ["three outputs", { outputs: ["forwardMps", "yawRateRadps", "lateral"] }],
      ["short digest", { checkpoint: { name: "flow/0000/000", sha256: "abc" } }],
      ["zero std", { normalization: { mean: new Array(n).fill(0), std: new Array(n).fill(0) } }],
      ["NaN weight", { layers: [{ weights: [new Array(n).fill(Number.NaN), new Array(n).fill(0)], bias: [0, 0], activation: "linear" }] }],
      ["nonlinear output layer", { layers: [{ weights: [new Array(n).fill(0), new Array(n).fill(0)], bias: [0, 0], activation: "tanh" }] }],
    ];
    for (const [why, override] of bad) assert.throws(() => parseTrainedReadout(fixtureModel(override)), RangeError, why);
  });

  test("the forward pass equals the hand-computed affine map, including normalization and an MLP layer", () => {
    const x = new Float64Array(n);
    x[idx("hm_C")] = 0.4;
    x[idx("goal_bearing")] = -0.3;
    x[idx("expansion")] = 0.05;
    assert.deepEqual(evaluateReadout(fixtureModel(), x).map(v => +v.toFixed(12)), [1.1, -0.4]);
    const hiddenRow = new Array<number>(n).fill(0);
    hiddenRow[idx("hm_C")] = 1;
    const mlp = fixtureModel({ normalization: { mean: new Array(n).fill(0.1), std: new Array(n).fill(2) }, outputScale: { mean: [0.5, 0], std: [2, 1] }, layers: [{ weights: [hiddenRow], bias: [0], activation: "tanh" }, { weights: [[1], [-1]], bias: [0, 0], activation: "linear" }] });
    const h = Math.tanh((0.4 - 0.1) / 2);
    const [f, y] = evaluateReadout(parseTrainedReadout(mlp), x);
    assert.ok(Math.abs(f - (h * 2 + 0.5)) < 1e-12 && Math.abs(y + h) < 1e-12);
  });
});

describe("readout inputs", () => {
  test("columns follow READOUT_INPUT_NAMES, carry the EMA across steps and restart after reset; no goal or features gives null", () => {
    const b = new ReadoutFeatureBuilder();
    const first = b.build(features([0, 0.4, 0], 0.2), input());
    assert.ok(first);
    assert.equal(first.length, n);
    assert.equal(first[idx("r_T4a_C")], 0.2);
    assert.equal(first[idx("hm_ema_C")], 0.4);
    assert.equal(first[idx("prev_forward")], 0.5);
    const second = b.build(features([0, 0, 0], 0), input());
    assert.ok(second && Math.abs(second[idx("hm_ema_C")] - 0.3) < 1e-12);
    b.reset();
    assert.equal(b.build(features([0, 0, 0], 0), input())?.[idx("hm_ema_C")], 0);
    assert.equal(b.build(null, input()), null);
    assert.equal(b.build(features(), input({ goal: null })), null);
  });
});

describe("TrainedReadoutController", () => {
  const make = (f: ReadoutFeatureSource | null = features([0, 0.4, 0], 0)) => new TrainedReadoutController({ model: fixtureModel(), features: () => f });

  test("is labelled fly_readout and repeats exactly after reset (deterministic inference)", () => {
    const c = make();
    assert.equal(c.source, "fly_readout");
    const a = [c.step(input()), c.step(input({ tick: 12 }))];
    c.reset();
    const b = [c.step(input()), c.step(input({ tick: 12 }))];
    assert.deepEqual(b, a);
    assert.ok(Math.abs(a[0].request.velocityBody.x - 1.1) < 1e-12 && Math.abs(a[0].request.yawRateRadps - 0.2) < 1e-12);
  });

  test("holds without features or goal, stops inside the arrival radius and slows with frame quality and goal distance", () => {
    assert.equal(make(null).step(input()).label, "fly_readout/hold_no_features");
    assert.equal(make().step(input({ goal: null })).request.velocityBody.x, 0);
    assert.equal(make().step(input({ goal: { bearingRad: 0, distanceM: 0.2, heightErrorM: 0 } })).label, "fly_readout/hold_arrived");
    assert.equal(make().step(input({ quality: { frame: 0.05, poseSigmaM: 0.1 } })).request.velocityBody.x, 0);
    assert.ok(Math.abs(make().step(input({ goal: { bearingRad: 0, distanceM: 1, heightErrorM: 0 } })).request.velocityBody.x - 0.8) < 1e-12);
  });

  test("holding facing a focus replaces the model output with the conventional turn to face; range vetoes still apply", () => {
    const facing = make().step(input({ goal: { bearingRad: 0, distanceM: 0.2, heightErrorM: 0, faceBearingRad: 0.5 } }));
    assert.equal(facing.label, "fly_readout/hold_face");
    assert.ok(Math.abs(facing.request.yawRateRadps - DEFAULT_COMMAND_CONFIG.goalGain * 0.5) < 1e-12);
    assert.equal(facing.request.velocityBody.x, 0);
    const vetoed = make().step(input({ goal: { bearingRad: 0, distanceM: 0.2, heightErrorM: 0, faceBearingRad: 0.5 }, ranges: { forwardM: null, leftM: 0.3, rightM: null, downM: null } }));
    assert.ok(vetoed.request.yawRateRadps <= 0, "never turns toward a side inside the lateral clearance");
    const far = make().step(input({ goal: { bearingRad: 0, distanceM: 1, heightErrorM: 0, faceBearingRad: 0.5 } }));
    assert.deepEqual(far.request, make().step(input({ goal: { bearingRad: 0, distanceM: 1, heightErrorM: 0 } })).request, "outside the hold radius the face bearing is ignored");
  });

  test("range assistance limits and brakes but the model output itself does not depend on ranges", () => {
    const blocked: RangeAssist = { forwardM: 0.25, leftM: 2, rightM: 0.4, downM: 1.2 };
    const free = make().step(input());
    const assisted = make().step(input({ ranges: blocked }));
    assert.equal(assisted.features.modelForwardMps, free.features.modelForwardMps);
    assert.equal(assisted.label, "fly_readout/range_brake");
    assert.equal(assisted.request.velocityBody.x, -0.2);
    assert.ok(assisted.request.yawRateRadps > 0, "turns toward the open (left) side");
    assert.ok(assisted.request.velocityBody.y > 0, "lateral push away from the near right side");
    const slowed = make().step(input({ ranges: { forwardM: 1.0, leftM: null, rightM: null, downM: null } }));
    assert.ok(Math.abs(slowed.request.velocityBody.x - 0.4) < 1e-12);
  });
});

const committed = fileURLToPath(new URL("../../../../models/readout/trained-readout-v1.json", import.meta.url));

describe("committed trained readout", { skip: existsSync(committed) ? false : "models/readout/trained-readout-v1.json not present" }, () => {
  test("loads, names the pinned checkpoint and reproduces the numpy self-check outputs", () => {
    const model = parseTrainedReadout(JSON.parse(readFileSync(committed, "utf8")));
    assert.equal(model.checkpoint.name, "flow/0000/000");
    assert.equal(model.checkpoint.sha256, "d0e42857e738d0315897c2d50fde9eb3fb1a3fb1f071d55dfc13d53d72bccc3f");
    const check = model.training.selfCheck as { inputs: number[][]; outputs: number[][] };
    assert.ok(check.inputs.length >= 3);
    check.inputs.forEach((row, i) => {
      const [f, y] = evaluateReadout(model, Float64Array.from(row));
      assert.ok(Math.abs(f - check.outputs[i][0]) < 1e-9 && Math.abs(y - check.outputs[i][1]) < 1e-9, `row ${i}`);
    });
  });
});
