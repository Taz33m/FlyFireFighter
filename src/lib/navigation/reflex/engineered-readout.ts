/**
 * Engineered readout (MotionSource "engineered_readout"): the PRD's hand-set bootstrap that maps a generic
 * motion feature vector to a MotionRequest before any readout is trained. It is NOT a trained readout and
 * NOT fly-model inference by itself; when its features come from FlyVis, the label still names this
 * engineered mapping, never "fly_readout".
 *
 * Feature convention (services/flyvis features.py): leftMotion/centerMotion/rightMotion are signed
 * horizontal motion per image sector, positive = rightward image motion; expansion = (right − left)/2,
 * positive when the sectors move outward. Units are uncalibrated, so the hand-set weights below are
 * written to be scale-free where possible.
 *
 * Cue derivation (hand-set):
 * - Derotation: subtract rotationGain × (efference yaw rate) from each sector (yawing left moves the image
 *   right, i.e. positive). rotationGain must be calibrated from pure-yaw responses of the actual model.
 * - Centering: outward motion left = max(0, −L'), right = max(0, R'); imbalance (oL − oR)/(oL + oR + floor),
 *   trusted fully once oL + oR ≥ centeringFullScale.
 * - Looming: expansion ∝ speed/distance, so 1/τ = d ln(expansion)/dt − d ln(speed)/dt over tauWindowS.
 *   This is unit-free and stays ~0 in a steady corridor, where (right − left)/2 is large but constant.
 * - Avoidance hint: derotated centre-sector motion; net leftward motion (an obstacle left of the heading
 *   expanding outward) turns right.
 * The shared ReflexCommandMapper then applies goal steering, quality, range assistance and caps.
 */
import type { MotionSource } from "../../contracts/actions.ts";
import { TICK_S } from "../../contracts/clock.ts";
import type { CommandConfig } from "./command.ts";
import { DEFAULT_COMMAND_CONFIG, ReflexCommandMapper } from "./command.ts";
import type { ControllerInput, ControllerOutput, MotionController, ReflexCues } from "./types.ts";

export interface MotionFeatureVector {
  readonly leftMotion: number;
  readonly centerMotion: number;
  readonly rightMotion: number;
  readonly expansion: number;
  /** Optional reliability of these features, 0..1 (default 1). */
  readonly confidence?: number;
}

/** Supplies features for the frame in this input (e.g. an adapter over services/flyvis); null when unavailable. */
export type MotionFeatureProvider = (input: ControllerInput) => MotionFeatureVector | null;

export interface EngineeredWeights {
  /** Feature response per rad/s of yaw (positive yaw → positive features). Calibrate from pure-yaw stimuli. */
  readonly rotationGain: number;
  /** Floor added to the centering denominator (feature units). */
  readonly centeringFloor: number;
  /** Outward-motion sum at which the centering cue is fully trusted (feature units). */
  readonly centeringFullScale: number;
  /** Expansion below this is too weak for a time-to-contact estimate (feature units). */
  readonly expansionFloor: number;
  /** Window for the logarithmic expansion derivative (s). */
  readonly tauWindowS: number;
  /** EMA weight of each new feature vector. */
  readonly featureAlpha: number;
  /** Centre-sector motion that saturates the avoidance hint (feature units). */
  readonly avoidScale: number;
  /** Forward speed below which d ln(speed)/dt is unusable and looming is not reported (m/s). */
  readonly minSpeedMps: number;
}

export const DEFAULT_ENGINEERED_WEIGHTS: EngineeredWeights = Object.freeze({
  rotationGain: 1.0, centeringFloor: 0.02, centeringFullScale: 0.3, expansionFloor: 0.05, tauWindowS: 0.1, featureAlpha: 0.5, avoidScale: 0.1, minSpeedMps: 0.2,
});

export interface EngineeredReadoutOptions {
  readonly id?: string;
  readonly features: MotionFeatureProvider;
  readonly weights?: EngineeredWeights;
  readonly command?: CommandConfig;
}

interface HistoryPoint {
  readonly tick: number;
  readonly expansion: number;
  readonly speed: number;
}

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);
const finiteOr = (value: number | undefined, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function usable(f: MotionFeatureVector | null): f is MotionFeatureVector {
  return f !== null && [f.leftMotion, f.centerMotion, f.rightMotion, f.expansion].every(Number.isFinite);
}

/** Stable, finite diagnostic keys: the smoothed input features and the cues derived from them. */
function describe(f: MotionFeatureVector | null, cues: ReflexCues | null): Record<string, number> {
  if (!f || !cues) {
    return { featuresPresent: 0, leftMotion: 0, centerMotion: 0, rightMotion: 0, expansion: 0, visualConfidence: 0, centering: 0, centeringWeight: 0, loomingRateHz: 0, loomingValid: 0, avoidTurn: 0 };
  }
  return {
    featuresPresent: 1, leftMotion: f.leftMotion, centerMotion: f.centerMotion, rightMotion: f.rightMotion, expansion: f.expansion,
    visualConfidence: cues.visualConfidence, centering: cues.centering, centeringWeight: cues.centeringWeight,
    loomingRateHz: cues.loomingRateHz ?? 0, loomingValid: cues.loomingRateHz === null ? 0 : 1, avoidTurn: cues.avoidTurn,
  };
}

export class EngineeredReadoutController implements MotionController {
  readonly id: string;
  readonly source: MotionSource = "engineered_readout";
  readonly weights: EngineeredWeights;
  private readonly provider: MotionFeatureProvider;
  private readonly mapper: ReflexCommandMapper;
  private smoothed: MotionFeatureVector | null = null;
  /** Efference speed smoothed like the features, so d ln E/dt and d ln v/dt carry the same lag. */
  private smoothedSpeed: number | null = null;
  private history: HistoryPoint[] = [];

  constructor(options: EngineeredReadoutOptions) {
    this.id = options.id ?? "engineered-readout-v1";
    this.provider = options.features;
    this.weights = options.weights ?? DEFAULT_ENGINEERED_WEIGHTS;
    this.mapper = new ReflexCommandMapper(this.source, options.command ?? DEFAULT_COMMAND_CONFIG);
  }

  reset(): void {
    this.smoothed = null;
    this.smoothedSpeed = null;
    this.history = [];
    this.mapper.reset();
  }

  step(input: ControllerInput): ControllerOutput {
    const raw = this.provider(input);
    const features = usable(raw) ? this.smooth(raw) : null;
    if (!features) {
      this.smoothed = null;
      this.smoothedSpeed = null;
      this.history = [];
    }
    const cues = features ? this.cues(features, input) : null;
    const result = this.mapper.map(input, cues);
    return { request: result.request, label: `${this.source}/${result.mode}`, features: { ...describe(features, cues), ...result.features } };
  }

  private smooth(next: MotionFeatureVector): MotionFeatureVector {
    const prev = this.smoothed;
    const a = this.weights.featureAlpha;
    const mix = (old: number, now: number) => old + a * (now - old);
    const out = prev
      ? { leftMotion: mix(prev.leftMotion, next.leftMotion), centerMotion: mix(prev.centerMotion, next.centerMotion), rightMotion: mix(prev.rightMotion, next.rightMotion), expansion: mix(prev.expansion, next.expansion), confidence: next.confidence }
      : next;
    this.smoothed = out;
    return out;
  }

  private cues(f: MotionFeatureVector, input: ControllerInput): ReflexCues {
    const w = this.weights;
    const yaw = finiteOr(input.previous.yawRateRadps, 0);
    const rotation = w.rotationGain * yaw;
    const outLeft = Math.max(0, -(f.leftMotion - rotation));
    const outRight = Math.max(0, f.rightMotion - rotation);
    const sum = outLeft + outRight;
    const confidence = clamp(finiteOr(f.confidence, 1), 0, 1);
    return {
      visualConfidence: confidence,
      centering: (outLeft - outRight) / (sum + w.centeringFloor),
      centeringWeight: clamp(sum / w.centeringFullScale, 0, 1),
      loomingRateHz: this.looming(f.expansion, this.smoothSpeed(finiteOr(input.previous.velocityBody.x, 0)), input.tick),
      avoidTurn: Math.tanh((f.centerMotion - rotation) / w.avoidScale),
    };
  }

  private smoothSpeed(speed: number): number {
    const prev = this.smoothedSpeed;
    this.smoothedSpeed = prev === null ? speed : prev + this.weights.featureAlpha * (speed - prev);
    return this.smoothedSpeed;
  }

  /**
   * 1/τ = d ln E/dt − d ln v/dt over the window. Null only until the window has filled (no information);
   * weak expansion or low speed is a valid "nothing approaching" measurement (0), which the mapper ignores
   * for distance while slow, so a stopped aircraft keeps its obstacle memory.
   */
  private looming(expansion: number, speed: number, tick: number): number | null {
    const w = this.weights;
    if (this.history.length > 0 && tick <= this.history[this.history.length - 1].tick) this.history = [];
    this.history.push({ tick, expansion, speed });
    const windowTicks = w.tauWindowS / TICK_S;
    while (this.history.length > 2 && tick - this.history[1].tick >= windowTicks) this.history.shift();
    const old = this.history[0];
    const span = (tick - old.tick) * TICK_S;
    if (span < 0.5 * w.tauWindowS) return null;
    if (Math.min(expansion, old.expansion) <= w.expansionFloor || Math.min(speed, old.speed) < w.minSpeedMps) return 0;
    return Math.max(0, (Math.log(expansion / old.expansion) - Math.log(speed / old.speed)) / span);
  }
}
