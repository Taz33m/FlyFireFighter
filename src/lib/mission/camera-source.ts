/**
 * Camera frames for the visual controller.
 *
 * A CameraSource renders the TRUE aircraft pose of a render request with the locked calibration: the headless
 * collider renderer in Node tests and batch runs, or the browser's Three.js GLB renderer through the worker's
 * render_request → camera_frame round trip. Both return noiseless display-encoded luminance; the mission
 * runtime then adds the calibration's read noise from a per-frame generator keyed by (seed, noise stream,
 * tick), so the same run always sees the same noise whichever renderer produced the frame.
 */
import type { CameraCalibration, CameraFrame } from "../contracts/camera.ts";
import type { Tick } from "../contracts/clock.ts";
import { keyedUniform } from "../simulation/random.ts";
import type { WorldState } from "../simulation/world-state.ts";
import { HEADLESS_RENDERER_ID, HeadlessColliderRenderer } from "./headless-camera.ts";
import type { CameraFrameMessage, RenderRequest } from "./protocol.ts";

/** A rendered frame plus its renderer identity and measured render time (wall clock; metrics only). */
export interface CapturedFrame extends CameraFrame {
  readonly renderer: string;
  readonly renderMs: number | null;
}

export interface CameraSource {
  capture(request: RenderRequest): Promise<CapturedFrame>;
}

/** Renders requests on the CPU from the live world (the request's world snapshot is derived from the same tick). */
export class HeadlessCameraSource implements CameraSource {
  readonly renderer: HeadlessColliderRenderer;
  private readonly world: () => WorldState;

  constructor(world: () => WorldState, calibration: CameraCalibration) {
    this.world = world;
    this.renderer = new HeadlessColliderRenderer(calibration);
  }

  capture(request: RenderRequest): Promise<CapturedFrame> {
    const world = this.world();
    if (world.tick !== request.tick || world.runId !== request.runId) {
      return Promise.reject(new Error(`Render request for ${request.runId}@${request.tick} does not match the world at ${world.runId}@${world.tick}.`));
    }
    const frame = this.renderer.render(world, { frameId: request.frameId, tick: request.tick, pose: request.pose });
    return Promise.resolve({ ...frame, renderer: HEADLESS_RENDERER_ID, renderMs: this.renderer.lastStats.ms });
  }
}

/** Why a camera_frame cannot answer a render request, or null when it does. */
export function frameProblem(message: CameraFrameMessage, request: RenderRequest, calibration: CameraCalibration): string | null {
  if (message.runId !== request.runId || message.tick !== request.tick || message.frameId !== request.frameId) {
    return `frame ${message.frameId}@${message.tick} of run ${message.runId} does not answer ${request.frameId}@${request.tick}`;
  }
  if (message.calibrationId !== calibration.id) return `frame calibration ${message.calibrationId} is not the locked ${calibration.id}`;
  if (message.width !== calibration.width || message.height !== calibration.height) return `frame is ${message.width}x${message.height}, not ${calibration.width}x${calibration.height}`;
  if (!(message.luminance instanceof Float32Array) || message.luminance.length !== calibration.width * calibration.height) return "frame luminance has the wrong length";
  if (typeof message.renderer !== "string" || message.renderer.length === 0) return "frame carries no renderer identity";
  return null;
}

/**
 * Additive Gaussian read noise (calibration.noise.readSigma, frame units), clamped to [0, 1]. The generator
 * is seeded by keyedUniform(seed, noise stream, tick), so noise is a pure function of the run seed and tick.
 * Each pixel draws one 32-bit value whose top 16 bits index a table of standard-normal quantiles at
 * (k + 0.5)/65536 (a 65 536-level discretisation of the normal, |z| ≤ 4.3). Non-finite input pixels become
 * 0. Returns a new frame; the input is not modified.
 */
export function withReadNoise<T extends CameraFrame>(frame: T, calibration: CameraCalibration, seed: string, tick: Tick): T {
  const sigma = calibration.noise.readSigma;
  let state = Math.floor(keyedUniform(seed, calibration.noise.stream, tick) * 4294967296) >>> 0;
  const out = new Float32Array(frame.luminance.length);
  const table = normalQuantiles();
  for (let i = 0; i < out.length; i++) {
    // mulberry32 step, inlined.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = clamp01(frame.luminance[i] + sigma * table[((t ^ (t >>> 14)) >>> 16) & 0xffff]);
  }
  return { ...frame, luminance: out };
}

let quantiles: Float64Array | null = null;

/** Standard-normal quantiles at (k + 0.5)/65536, k = 0 … 65535 (Acklam's rational approximation). */
function normalQuantiles(): Float64Array {
  if (quantiles !== null) return quantiles;
  const table = new Float64Array(65536);
  for (let k = 0; k < table.length; k++) table[k] = inverseNormal((k + 0.5) / 65536);
  quantiles = table;
  return table;
}

function inverseNormal(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -inverseNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value >= 1 ? 1 : value;
}
