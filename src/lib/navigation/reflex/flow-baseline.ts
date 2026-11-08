/**
 * Conventional optical-flow baseline controller (MotionSource "flow_baseline").
 *
 * Camera luminance → 80×45 area-averaged grid → dense pyramidal Lucas–Kanade flow between consecutive
 * frames → derotated centering / looming / avoidance cues → shared cue → command mapping. It is the named
 * conventional comparison condition and classical fallback; its output is never fly-model inference.
 *
 * Efference copy: the executed command over the two frames' capture interval (EfferenceHistory), not the
 * latest command, both seeds the flow solver with the predicted rotation and derotates the cues; its
 * forward speed converts 1/τ into a free distance.
 *
 * Temporal state: the previous frame's pyramid, the efference history, smoothed centering/avoidance cues
 * and the mapper's free-distance memory. reset() clears all of it. A changed calibration, a non-increasing
 * capture tick or a capture gap above maxFrameGapTicks restarts the frame pair instead of comparing
 * incompatible frames. Every output carries the same feature keys (frameStatus says what happened).
 */
import type { MotionSource } from "../../contracts/actions.ts";
import { TICK_S, VISUAL_PERIOD_TICKS, isTick } from "../../contracts/clock.ts";
import type { CommandConfig } from "./command.ts";
import { DEFAULT_COMMAND_CONFIG, ReflexCommandMapper } from "./command.ts";
import { EfferenceHistory } from "./efference.ts";
import type { FlowConfig } from "./flow.ts";
import { DEFAULT_FLOW_CONFIG, DenseFlow } from "./flow.ts";
import type { FlowCueConfig } from "./flow-cues.ts";
import { DEFAULT_FLOW_CUE_CONFIG, computeFlowCues, predictedRotationFlow } from "./flow-cues.ts";
import type { Pyramid } from "./image.ts";
import { buildPyramid, resampleToGrid } from "./image.ts";
import type { CameraFrame, CameraModel, ControllerInput, ControllerOutput, MotionController, ReflexCues } from "./types.ts";
import { RGB_FRONT_CAMERA } from "./types.ts";

export interface FlowBaselineOptions {
  readonly id?: string;
  readonly camera?: CameraModel;
  readonly flow?: FlowConfig;
  readonly cues?: FlowCueConfig;
  readonly command?: CommandConfig;
  /** Largest capture gap in ticks across which two frames are still compared (default 4 visual periods). */
  readonly maxFrameGapTicks?: number;
  /** EMA weight of each new flow field in the centering and avoidance cues. */
  readonly cueAlpha?: number;
}

/** frameStatus feature codes. */
export const FRAME_STATUS = Object.freeze({ none: 0, invalid: 1, duplicate: 2, firstOfPair: 3, flow: 4 });

/** Flow features reported when no flow field was computed this step, so every output has the same keys. */
const NO_FLOW_FEATURES = Object.freeze({ frameGapTicks: 0, efferenceAligned: 0, validFraction: 0, contrast: 0, flowLeftHz: 0, flowRightHz: 0, centralWeight: 0, divergenceHz: 0, tauS: 100, loomLeftHz: 0, loomRightHz: 0 });

interface StoredFrame {
  readonly pyramid: Pyramid;
  readonly captureTick: number;
  readonly frameId: string;
  readonly calibrationId: string;
}

interface Observation {
  readonly cues: ReflexCues | null;
  readonly features: Readonly<Record<string, number>>;
  /** Forward speed during the measured frame interval (aligned efference copy). */
  readonly cueSpeedMps?: number;
}

export function isUsableFrame(frame: CameraFrame, minWidth: number, minHeight: number): boolean {
  return frame.width >= minWidth && frame.height >= minHeight && frame.luminance instanceof Float32Array
    && frame.luminance.length === frame.width * frame.height && isTick(frame.captureTick) && frame.calibrationId.length > 0;
}

export class FlowBaselineController implements MotionController {
  readonly id: string;
  readonly source: MotionSource = "flow_baseline";
  readonly camera: CameraModel;
  private readonly flow: DenseFlow;
  private readonly cueConfig: FlowCueConfig;
  private readonly mapper: ReflexCommandMapper;
  private readonly maxFrameGapTicks: number;
  private readonly cueAlpha: number;
  private readonly efference = new EfferenceHistory();
  private stored: StoredFrame | null = null;
  private smoothed: ReflexCues | null = null;

  constructor(options: FlowBaselineOptions = {}) {
    this.id = options.id ?? "flow-baseline-lk80x45";
    this.camera = options.camera ?? RGB_FRONT_CAMERA;
    this.flow = new DenseFlow(options.flow ?? DEFAULT_FLOW_CONFIG);
    this.cueConfig = options.cues ?? DEFAULT_FLOW_CUE_CONFIG;
    this.mapper = new ReflexCommandMapper(this.source, options.command ?? DEFAULT_COMMAND_CONFIG);
    this.maxFrameGapTicks = options.maxFrameGapTicks ?? 4 * VISUAL_PERIOD_TICKS;
    this.cueAlpha = options.cueAlpha ?? 0.5;
  }

  reset(): void {
    this.stored = null;
    this.smoothed = null;
    this.efference.clear();
    this.mapper.reset();
  }

  step(input: ControllerInput): ControllerOutput {
    this.efference.record(input.tick, input.previous);
    const observation = this.observe(input);
    const result = this.mapper.map(input, observation.cues, observation.cueSpeedMps);
    const cues = observation.cues;
    const cueFeatures = cues
      ? { visualConfidence: cues.visualConfidence, centering: cues.centering, centeringWeight: cues.centeringWeight, loomingRateHz: cues.loomingRateHz ?? 0, loomingValid: cues.loomingRateHz === null ? 0 : 1, avoidTurn: cues.avoidTurn }
      : { visualConfidence: 0, centering: 0, centeringWeight: 0, loomingRateHz: 0, loomingValid: 0, avoidTurn: 0 };
    return { request: result.request, label: `${this.source}/${result.mode}`, features: { ...observation.features, ...cueFeatures, ...result.features } };
  }

  private observe(input: ControllerInput): Observation {
    const frame = input.frame;
    const { gridWidth, gridHeight, levels } = this.flow.config;
    if (!frame) return { cues: null, features: { frameStatus: FRAME_STATUS.none, ...NO_FLOW_FEATURES } };
    if (!isUsableFrame(frame, gridWidth, gridHeight)) {
      this.stored = null;
      return { cues: null, features: { frameStatus: FRAME_STATUS.invalid, ...NO_FLOW_FEATURES } };
    }
    const previous = this.stored;
    if (previous && previous.frameId === frame.frameId && previous.captureTick === frame.captureTick) {
      // Same frame again: no new motion measurement; keep the smoothed lateral cues only.
      return { cues: this.smoothed && { ...this.smoothed, loomingRateHz: null }, features: { frameStatus: FRAME_STATUS.duplicate, ...NO_FLOW_FEATURES } };
    }
    const pyramid = buildPyramid(resampleToGrid(frame, gridWidth, gridHeight), gridWidth, gridHeight, levels);
    const current: StoredFrame = { pyramid, captureTick: frame.captureTick, frameId: frame.frameId, calibrationId: frame.calibrationId };
    this.stored = current;
    if (!previous || !this.comparable(previous, current)) {
      this.smoothed = null;
      return { cues: null, features: { frameStatus: FRAME_STATUS.firstOfPair, ...NO_FLOW_FEATURES } };
    }
    return this.measure(previous, current, input);
  }

  /** Same calibration and a capture gap in (0, maxFrameGapTicks]. */
  private comparable(previous: StoredFrame, current: StoredFrame): boolean {
    const gap = current.captureTick - previous.captureTick;
    return previous.calibrationId === current.calibrationId && gap > 0 && gap <= this.maxFrameGapTicks;
  }

  private measure(previous: StoredFrame, current: StoredFrame, input: ControllerInput): Observation {
    const gap = current.captureTick - previous.captureTick;
    // Efference copy for the interval between the two captures, not the latest command (frames arrive late).
    const aligned = this.efference.mean(previous.captureTick, current.captureTick);
    const latestYaw = Number.isFinite(input.previous.yawRateRadps) ? input.previous.yawRateRadps : 0;
    const yawRate = aligned?.yawRateRadps ?? latestYaw;
    const { gridWidth, gridHeight } = this.flow.config;
    // Efference-aided flow: start from the predicted rotation so the solver only estimates the residual.
    const prior = predictedRotationFlow(gridWidth, gridHeight, this.camera, gap * TICK_S, yawRate);
    const field = this.flow.compute(previous.pyramid, current.pyramid, prior);
    const measured = computeFlowCues(field, this.camera, gap * TICK_S, yawRate, this.cueConfig);
    this.smoothed = this.smooth(measured.cues);
    return { cues: this.smoothed, cueSpeedMps: aligned?.forwardMps, features: { frameStatus: FRAME_STATUS.flow, frameGapTicks: gap, efferenceAligned: aligned ? 1 : 0, ...measured.features } };
  }

  /** EMA on the noisy lateral cues; looming is filtered (as nearness) by the mapper, visual confidence is used as measured. */
  private smooth(next: ReflexCues): ReflexCues {
    const prev = this.smoothed;
    if (!prev) return next;
    const a = this.cueAlpha;
    const mix = (old: number, now: number) => old + a * (now - old);
    return { ...next, centering: mix(prev.centering, next.centering), centeringWeight: mix(prev.centeringWeight, next.centeringWeight), avoidTurn: mix(prev.avoidTurn, next.avoidTurn) };
  }
}
