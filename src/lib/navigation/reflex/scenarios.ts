/**
 * Synthetic open-loop test scenarios with known ground truth. Labelled fixtures for unit tests, not
 * benchmark evidence: the held-out comparison runs later in the 3D twin.
 *
 * Frame k is captured at tick startTick + k·VISUAL_PERIOD_TICKS (50 Hz, t = k·0.02 s). The camera follows
 * a scripted path regardless of what a controller requests.
 */
import { TICK_S, VISUAL_PERIOD_TICKS } from "../../contracts/clock.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { RenderOptions, Surface } from "./synthetic.ts";
import { boxRoom, floorAt, renderFrame, wallAtX, wallAtY } from "./synthetic.ts";
import type { CameraFrame, CameraModel } from "./types.ts";
import { RGB_FRONT_CAMERA } from "./types.ts";

export interface ScenarioFrame {
  readonly frame: CameraFrame;
  /** Ground truth for assertions only; never passed to a controller. */
  readonly truth: { readonly timeS: number; readonly tauS: number | null; readonly distanceAheadM: number | null };
}

export interface SequenceOptions {
  readonly frames: number;
  readonly width?: number;
  readonly height?: number;
  readonly camera?: CameraModel;
  readonly noiseSigma?: number;
  readonly seed?: number;
  readonly startTick?: number;
  readonly calibrationId?: string;
  readonly mean?: number;
  readonly gain?: number;
}

/** Height of the camera above the floor in the scenarios (m). */
export const CAMERA_HEIGHT_M = 1.2;

type Path = (timeS: number) => { readonly position: Vec3; readonly yawRad: number };
type Truth = (timeS: number) => { readonly tauS: number | null; readonly distanceAheadM: number | null };

const NO_TRUTH: Truth = () => ({ tauS: null, distanceAheadM: null });

function sequence(surfaces: readonly Surface[], path: Path, o: SequenceOptions, truth: Truth = NO_TRUTH, prefix = "syn"): ScenarioFrame[] {
  const render: RenderOptions = {
    width: o.width ?? 320,
    height: o.height ?? 180,
    camera: o.camera ?? RGB_FRONT_CAMERA,
    noiseSigma: o.noiseSigma ?? 0.005,
    mean: o.mean,
    gain: o.gain,
  };
  const startTick = o.startTick ?? 0;
  const seed = o.seed ?? 1;
  const out: ScenarioFrame[] = [];
  for (let k = 0; k < o.frames; k++) {
    const tick = startTick + k * VISUAL_PERIOD_TICKS;
    const timeS = k * VISUAL_PERIOD_TICKS * TICK_S;
    const frame = renderFrame(surfaces, path(timeS), { ...render, noiseSeed: seed * 7919 + k }, { frameId: `${prefix}-${seed}-${tick}`, captureTick: tick, calibrationId: o.calibrationId });
    out.push({ frame, truth: { timeS, ...truth(timeS) } });
  }
  return out;
}

/** Textured wall ahead approached head-on at constant speed; τ = remaining distance / speed at each capture. */
export function approachSequence(o: SequenceOptions & { readonly speedMps: number; readonly wallDistanceM: number }): ScenarioFrame[] {
  const path: Path = t => ({ position: vec3(o.speedMps * t, 0, CAMERA_HEIGHT_M), yawRad: 0 });
  const truth: Truth = t => {
    const remaining = o.wallDistanceM - o.speedMps * t;
    return { tauS: remaining / o.speedMps, distanceAheadM: remaining };
  };
  return sequence([wallAtX(o.wallDistanceM, 3)], path, o, truth, "approach");
}

/** Wall parallel to the path at lateral offset (positive = left of the camera), floor and a backdrop 40 m ahead. */
export function lateralWallSequence(o: SequenceOptions & { readonly speedMps: number; readonly lateralOffsetM: number }): ScenarioFrame[] {
  const surfaces = [wallAtY(o.lateralOffsetM, 5), wallAtX(40, 6), floorAt(0, 7)];
  return sequence(surfaces, t => ({ position: vec3(o.speedMps * t, 0, CAMERA_HEIGHT_M), yawRad: 0 }), o, NO_TRUTH, "lateral");
}

/** Rotation in place at a constant yaw rate (positive = left) inside a textured 6 m × 6 m room. */
export function yawSequence(o: SequenceOptions & { readonly yawRateRadps: number }): ScenarioFrame[] {
  return sequence(boxRoom(3, 3, 2.6, 11), t => ({ position: vec3(0, 0, CAMERA_HEIGHT_M), yawRad: o.yawRateRadps * t }), o, NO_TRUTH, "yaw");
}

/** Static camera in a textured room; consecutive frames differ only by sensor noise. */
export function staticSequence(o: SequenceOptions): ScenarioFrame[] {
  return sequence(boxRoom(3, 3, 2.6, 11), () => ({ position: vec3(0, 0, CAMERA_HEIGHT_M), yawRad: 0.3 }), { noiseSigma: 0.02, ...o }, NO_TRUTH, "static");
}

/** Dark, low-contrast room (mean luminance 0.03, contrast gain 0.02) with sensor noise: flow is uninformative. */
export function darkSequence(o: SequenceOptions): ScenarioFrame[] {
  return sequence(boxRoom(3, 3, 2.6, 13), t => ({ position: vec3(0.8 * t, 0, CAMERA_HEIGHT_M), yawRad: 0 }), { noiseSigma: 0.01, mean: 0.03, gain: 0.02, ...o }, NO_TRUTH, "dark");
}
