/**
 * Trained FlyVis readout (MotionSource "fly_readout", label "FlyVis flow/0000/000 + trained readout v1").
 *
 * Model file (models/readout/trained-readout-v1.json, schema flyfirefighter.trained-readout/1)
 * and the input-vector builder shared by dataset recording and deployment, so training and inference see
 * exactly the same columns in the same order.
 *
 * Inputs (all truth-free): FlyVis T4a–d / T5a–d mean rectified voltage per sector (24), the opponent
 * horizontal motion per sector and the expansion signal (4), their exponential moving averages (4), the
 * efference copy (previous executed forward speed and yaw rate), the goal relative to the estimated pose
 * (sin/cos/bearing, capped distance) and explicit frame quality and pose uncertainty. No ranges, no true
 * distances. The model is a small MLP (or a single linear layer for ridge) over z-scored inputs; outputs are
 * de-normalized forward speed (m/s) and yaw rate (rad/s).
 */
import type { MotionRequest, MotionSource } from "../../contracts/actions.ts";
import type { NeuralFeatures } from "../../contracts/neural.ts";
import type { CommandConfig } from "./command.ts";
import { DEFAULT_COMMAND_CONFIG, holdFaceBearing, holdTranslation } from "./command.ts";
import type { ControllerInput, ControllerOutput, MotionController, RangeAssist } from "./types.ts";

export const READOUT_SCHEMA = "flyfirefighter.trained-readout/1";
export const FLYVIS_MOTION_TYPES = ["T4a", "T4b", "T4c", "T4d", "T5a", "T5b", "T5c", "T5d"] as const;
const SECTORS = ["L", "C", "R"] as const;

export type ReadoutFeatureSource = Pick<NeuralFeatures, "horizontalMotion" | "expansion" | "responses">;

export interface ReadoutFeatureConfig {
  readonly emaAlpha: number;
  readonly goalDistanceCapM: number;
}

export const DEFAULT_FEATURE_CONFIG: ReadoutFeatureConfig = Object.freeze({ emaAlpha: 0.25, goalDistanceCapM: 4 });

export const READOUT_INPUT_NAMES: readonly string[] = Object.freeze([
  ...FLYVIS_MOTION_TYPES.flatMap(t => SECTORS.map(s => `r_${t}_${s}`)),
  "hm_L", "hm_C", "hm_R", "expansion",
  "hm_ema_L", "hm_ema_C", "hm_ema_R", "expansion_ema",
  "prev_forward", "prev_yaw",
  "goal_sin", "goal_cos", "goal_bearing", "goal_dist",
  "quality_frame", "pose_sigma",
]);

export const READOUT_OUTPUT_NAMES = Object.freeze(["forwardMps", "yawRateRadps"] as const);

const finiteOr = (value: number | undefined | null, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Stateful (EMA) input builder. reset() at every run start; build() once per visual step. */
export class ReadoutFeatureBuilder {
  readonly config: ReadoutFeatureConfig;
  private ema: number[] | null = null;

  constructor(config: ReadoutFeatureConfig = DEFAULT_FEATURE_CONFIG) {
    this.config = config;
  }

  reset(): void {
    this.ema = null;
  }

  /** The input vector in READOUT_INPUT_NAMES order, or null without usable features or goal. */
  build(features: ReadoutFeatureSource | null, input: ControllerInput): Float64Array | null {
    if (features === null || input.goal === null) return null;
    const out = new Float64Array(READOUT_INPUT_NAMES.length);
    let k = 0;
    for (const type of FLYVIS_MOTION_TYPES) {
      const triple = features.responses[type];
      if (!triple || triple.length !== 3 || !triple.every(Number.isFinite)) return null;
      for (const v of triple) out[k++] = v;
    }
    const motion = [...features.horizontalMotion, features.expansion];
    if (!motion.every(Number.isFinite)) return null;
    const a = this.config.emaAlpha;
    this.ema = this.ema === null ? motion.slice() : this.ema.map((old, i) => old + a * (motion[i] - old));
    for (const v of motion) out[k++] = v;
    for (const v of this.ema) out[k++] = v;
    out[k++] = finiteOr(input.previous.velocityBody.x, 0);
    out[k++] = finiteOr(input.previous.yawRateRadps, 0);
    const bearing = finiteOr(input.goal.bearingRad, 0);
    out[k++] = Math.sin(bearing);
    out[k++] = Math.cos(bearing);
    out[k++] = bearing;
    out[k++] = Math.min(Math.max(0, finiteOr(input.goal.distanceM, 0)), this.config.goalDistanceCapM);
    out[k++] = Math.min(1, Math.max(0, finiteOr(input.quality.frame, 0)));
    out[k++] = Math.min(3, Math.max(0, finiteOr(input.quality.poseSigmaM, 3)));
    return out;
  }
}

export interface DenseLayer {
  readonly weights: readonly (readonly number[])[];
  readonly bias: readonly number[];
  readonly activation: "tanh" | "relu" | "linear";
}

export interface TrainedReadoutModel {
  readonly schema: typeof READOUT_SCHEMA;
  readonly id: string;
  readonly label: string;
  readonly checkpoint: { readonly name: string; readonly sha256: string };
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly featureConfig: ReadoutFeatureConfig;
  readonly normalization: { readonly mean: readonly number[]; readonly std: readonly number[] };
  readonly outputScale: { readonly mean: readonly number[]; readonly std: readonly number[] };
  readonly layers: readonly DenseLayer[];
  /** Provenance and metrics; not used for inference. */
  readonly training: { readonly [key: string]: unknown };
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(v => typeof v === "number" && Number.isFinite(v));
}

type Check = readonly [boolean, string];

const scaleOk = (scale: { mean?: unknown; std?: unknown } | undefined, length: number): boolean =>
  scale !== undefined && isNumberArray(scale.mean, length) && isNumberArray(scale.std, length) && scale.std.every(v => v > 0);

function headerChecks(m: Partial<TrainedReadoutModel>): Check[] {
  const n = READOUT_INPUT_NAMES.length;
  const fc = m.featureConfig;
  return [
    [m.schema === READOUT_SCHEMA, `schema must be ${READOUT_SCHEMA}`],
    [typeof m.id === "string" && typeof m.label === "string" && m.label.length > 0, "id and label must be strings"],
    [typeof m.checkpoint?.name === "string" && /^[0-9a-f]{64}$/.test(String(m.checkpoint?.sha256)), "checkpoint needs a name and a 64-hex sha256"],
    [Array.isArray(m.inputs) && m.inputs.length === n && m.inputs.every((name, i) => name === READOUT_INPUT_NAMES[i]), "inputs must equal READOUT_INPUT_NAMES in order"],
    [Array.isArray(m.outputs) && m.outputs.join(",") === READOUT_OUTPUT_NAMES.join(","), `outputs must be ${READOUT_OUTPUT_NAMES.join(",")}`],
    [fc !== undefined && fc.emaAlpha > 0 && fc.emaAlpha <= 1 && fc.goalDistanceCapM > 0, "featureConfig needs emaAlpha in (0, 1] and a positive goalDistanceCapM"],
    [scaleOk(m.normalization, n), `normalization needs ${n} means and positive stds`],
    [scaleOk(m.outputScale, 2), "outputScale needs 2 means and positive stds"],
  ];
}

function layerChecks(layers: unknown): Check[] {
  if (!Array.isArray(layers) || layers.length === 0) return [[false, "layers must be a non-empty array"]];
  const checks: Check[] = [];
  let width = READOUT_INPUT_NAMES.length;
  (layers as Partial<DenseLayer>[]).forEach((layer, i) => {
    const rows = layer?.weights;
    const out = Array.isArray(rows) ? rows.length : 0;
    checks.push([out > 0 && (rows as unknown[]).every(row => isNumberArray(row, width)), `layers[${i}].weights must be rows of ${width} finite numbers`]);
    checks.push([isNumberArray(layer?.bias, out), `layers[${i}].bias must have ${out} finite numbers`]);
    checks.push([["tanh", "relu", "linear"].includes(String(layer?.activation)), `layers[${i}].activation is unknown`]);
    width = out;
  });
  checks.push([width === 2, "the last layer must output 2 values"]);
  checks.push([(layers as Partial<DenseLayer>[])[layers.length - 1]?.activation === "linear", "the last layer must be linear"]);
  return checks;
}

/** Validate a parsed model file; throws RangeError listing every problem. Inputs must match this build exactly. */
export function parseTrainedReadout(value: unknown): TrainedReadoutModel {
  if (value === null || typeof value !== "object") throw new RangeError("Trained readout: not an object");
  const m = value as Partial<TrainedReadoutModel>;
  const errors = [...headerChecks(m), ...layerChecks(m.layers)].filter(([ok]) => !ok).map(([, why]) => why);
  if (errors.length > 0) throw new RangeError(`Trained readout invalid: ${errors.join("; ")}`);
  return m as TrainedReadoutModel;
}

/** Forward pass: z-score inputs, dense layers, de-normalize outputs. Deterministic, allocation-light. */
export function evaluateReadout(model: TrainedReadoutModel, x: Float64Array): [number, number] {
  let h: number[] = Array.from(x, (v, i) => (v - model.normalization.mean[i]) / model.normalization.std[i]);
  for (const layer of model.layers) {
    const next = new Array<number>(layer.weights.length);
    for (let o = 0; o < layer.weights.length; o++) {
      const row = layer.weights[o];
      let s = layer.bias[o];
      for (let i = 0; i < row.length; i++) s += row[i] * h[i];
      next[o] = layer.activation === "tanh" ? Math.tanh(s) : layer.activation === "relu" ? Math.max(0, s) : s;
    }
    h = next;
  }
  return [h[0] * model.outputScale.std[0] + model.outputScale.mean[0], h[1] * model.outputScale.std[1] + model.outputScale.mean[1]];
}

/**
 * Controller. The learned part maps the input vector to forward speed and yaw rate; obstacle braking and
 * turning come only from the model. Around it sit the conventional parts every controller in the
 * comparison shares, with the same CommandConfig values as the reflex mapper (command.ts):
 * - hold without features or goal, stop inside the arrival radius, forward ≤ approachGain × goal distance;
 * - holding facing a focus (the goal's face bearing, within holdRadiusM): the mapper's conventional
 *   turn-to-face and drift back toward the goal replace the model's output;
 * - frame-quality speed ceiling (cruise × smoothstep(quality, minVisualConfidence, fullVisualConfidence));
 * - range assistance when the condition provides it: forward-range speed limit and brake-and-turn, lateral
 *   push and yaw veto inside the lateral clearance, minimum height from the down range;
 * - conventional vertical stabilization toward the goal height; ReflexLimits caps.
 * The model never receives ranges, so the same weights run with and without range assistance.
 */
export interface TrainedReadoutOptions {
  readonly id?: string;
  readonly model: TrainedReadoutModel;
  /** Supplies the FlyVis features for the frame in this input; null when unavailable. */
  readonly features: (input: ControllerInput) => ReadoutFeatureSource | null;
  readonly command?: CommandConfig;
}

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);
const smoothstep = (value: number, lo: number, hi: number): number => {
  const t = clamp((value - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
const range = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export class TrainedReadoutController implements MotionController {
  readonly id: string;
  readonly source: MotionSource = "fly_readout";
  readonly label: string;
  readonly model: TrainedReadoutModel;
  private readonly provider: (input: ControllerInput) => ReadoutFeatureSource | null;
  private readonly builder: ReadoutFeatureBuilder;
  private readonly config: CommandConfig;

  constructor(options: TrainedReadoutOptions) {
    this.model = parseTrainedReadout(options.model);
    this.id = options.id ?? this.model.id;
    this.label = this.model.label;
    this.provider = options.features;
    this.builder = new ReadoutFeatureBuilder(this.model.featureConfig);
    this.config = options.command ?? DEFAULT_COMMAND_CONFIG;
  }

  reset(): void {
    this.builder.reset();
  }

  step(input: ControllerInput): ControllerOutput {
    const c = this.config;
    const x = this.builder.build(this.provider(input), input);
    const goal = input.goal;
    const ranges = sanitize(input.ranges);
    if (x === null || goal === null) return this.output(input, 0, 0, ranges, x === null ? "hold_no_features" : "hold_no_goal", 0, 0, 0);
    const [modelForward, modelYaw] = evaluateReadout(this.model, x);
    const face = holdFaceBearing(c, goal);
    if (face !== null) {
      const ceiling = this.visionCeiling(input, ranges);
      const hold = holdTranslation(c, goal, ceiling);
      let [forward, yaw, mode] = [hold.forward, c.goalGain * face, "hold_face"];
      if (ranges) [forward, yaw, mode] = applyRangeAssist(c, ranges, forward, yaw, mode, face || 1);
      return this.output(input, forward, yaw, ranges, mode, modelForward, modelYaw, ceiling, hold.lateral);
    }
    if (goal.distanceM <= c.arrivalRadiusM) return this.output(input, 0, 0, ranges, "hold_arrived", modelForward, modelYaw, 0);
    const ceiling = Math.min(this.visionCeiling(input, ranges), c.approachGain * goal.distanceM);
    let forward = clamp(modelForward, 0, ceiling);
    let yaw = modelYaw;
    let mode = forward < modelForward - 1e-9 ? "capped" : "readout";
    if (ranges) [forward, yaw, mode] = applyRangeAssist(c, ranges, forward, yaw, mode, modelYaw || goal.bearingRad || 1);
    return this.output(input, forward, yaw, ranges, mode, modelForward, modelYaw, ceiling);
  }

  /** Frame-quality speed ceiling (range-only floor when forward range assistance is present). */
  private visionCeiling(input: ControllerInput, ranges: Ranges | null): number {
    const c = this.config;
    const quality = clamp(Number.isFinite(input.quality.frame) ? input.quality.frame : 0, 0, 1);
    return Math.max(c.cruiseSpeedMps * smoothstep(quality, c.minVisualConfidence, c.fullVisualConfidence), ranges?.forward != null ? c.rangeOnlySpeedMps : 0);
  }

  private output(input: ControllerInput, forward: number, yaw: number, ranges: Ranges | null, mode: string, modelForward: number, modelYaw: number, ceiling: number, holdLateral = 0): ControllerOutput {
    const c = this.config;
    const { maxSpeedMps, maxVerticalSpeedMps, maxYawRateRadps } = c.limits;
    const intrusion = (r: number | null) => (r === null ? 0 : Math.max(0, c.lateralClearanceM - r));
    let lateral = (ranges ? c.lateralGain * (intrusion(ranges.right) - intrusion(ranges.left)) : 0) + holdLateral;
    let vx = forward;
    const horizontal = Math.hypot(vx, lateral);
    if (horizontal > maxSpeedMps) [vx, lateral] = [(vx * maxSpeedMps) / horizontal, (lateral * maxSpeedMps) / horizontal];
    let vz = input.goal ? c.heightGain * input.goal.heightErrorM : 0;
    if (ranges && ranges.down !== null && ranges.down < c.minHeightM) vz = Math.max(vz, c.heightGain * (c.minHeightM - ranges.down));
    const request: MotionRequest = {
      source: this.source, tick: input.tick,
      velocityBody: { x: finite(vx), y: finite(lateral), z: clamp(finite(vz), -maxVerticalSpeedMps, maxVerticalSpeedMps) },
      yawRateRadps: clamp(finite(yaw), -maxYawRateRadps, maxYawRateRadps),
    };
    return { request, label: `${this.source}/${mode}`, features: { modelForwardMps: finite(modelForward), modelYawRateRadps: finite(modelYaw), speedCeilingMps: finite(ceiling), rangeAssist: ranges ? 1 : 0 } };
  }
}

interface Ranges { forward: number | null; left: number | null; right: number | null; down: number | null }

/** The reflex mapper's range assistance (same CommandConfig values): speed limit, yaw veto and push, brake-and-turn. */
function applyRangeAssist(c: CommandConfig, r: Ranges, forward: number, yaw: number, mode: string, preferredTurn: number): [number, number, string] {
  let f = r.forward === null ? forward : Math.min(forward, Math.max(0, (r.forward - c.rangeClearanceM) / c.rangeBrakeTimeS));
  const leftIn = r.left === null ? 0 : Math.max(0, c.lateralClearanceM - r.left);
  const rightIn = r.right === null ? 0 : Math.max(0, c.lateralClearanceM - r.right);
  let w = yaw + c.lateralGain * (rightIn - leftIn);
  if (leftIn > 0) w = Math.min(w, 0);
  if (rightIn > 0) w = Math.max(w, 0);
  if (r.forward === null || r.forward >= c.rangeClearanceM) return [f, w, mode];
  f = r.forward < 0.5 * c.rangeClearanceM ? -0.2 : 0;
  const open = r.left !== null && r.right !== null && Math.abs(r.left - r.right) > 0.1 ? Math.sign(r.left - r.right) : Math.sign(preferredTurn);
  return [f, c.rangeTurnRateRadps * open, "range_brake"];
}

function sanitize(r: RangeAssist | null): Ranges | null {
  return r === null ? null : { forward: range(r.forwardM), left: range(r.leftM), right: range(r.rightM), down: range(r.downM) };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
