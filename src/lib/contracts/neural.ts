/**
 * Mission worker ↔ local FlyVis service protocol ("flyfirefighter.neural/1"), over a WebSocket on
 * 127.0.0.1:3201.
 *
 * The service runs the pretrained visual network with recurrent state carried across frames and returns
 * named-cell motion features. Readouts (engineered or trained) map those features to motion requests in
 * the worker, so every controller shares the same interface, harness path and causal trace.
 *
 * Exchange: reset → ready; then strictly one step in flight: a JSON `step` header immediately followed
 * by one binary message of width × height bytes (u8 luminance, row-major from the top-left pixel) →
 * `features`. Replies carrying another runId or an unexpected seq are discarded by the client. Reset
 * starts a new run: the service reinitializes network state, then warms up once using the run's first
 * frame as a static stimulus (a mid-grey warm-up would spike on dark interiors). Step seq starts at 0
 * for each run and increments by one; frames are integrated in exactly that order.
 */
import type { Tick } from "./clock.ts";
import type { RunId } from "./ids.ts";
import type { Schema } from "./schema.ts";
import { int, lit, num, obj, parseWith, str } from "./schema.ts";
import type { ParseResult } from "./schema.ts";

export const NEURAL_PROTOCOL = "flyfirefighter.neural/1";
export const NEURAL_SERVICE_PORT = 3201;
/** Visual-model integration step (50 Hz). */
export const NEURAL_DT_S = 0.02;

export interface NeuralResetRequest {
  readonly type: "reset";
  readonly protocol: typeof NEURAL_PROTOCOL;
  readonly runId: RunId;
  readonly calibrationId: string;
  readonly width: number;
  readonly height: number;
  readonly horizontalFovDeg: number;
  readonly dtS: number;
}

export interface NeuralReady {
  readonly type: "ready";
  readonly protocol: typeof NEURAL_PROTOCOL;
  readonly runId: RunId;
  readonly model: {
    readonly name: string;
    readonly checkpoint: string;
    readonly checkpointSha256: string;
    readonly upstreamCommit: string;
    /** Exact licence status recorded in services/flyvis/weights.manifest.json. */
    readonly weightsLicenseStatus: string;
  };
  readonly eye: { readonly extent: number; readonly hexals: number };
  readonly warmupSteps: number;
}

export interface NeuralStepHeader {
  readonly type: "step";
  readonly runId: RunId;
  readonly seq: number;
  readonly tick: Tick;
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly encoding: "u8";
}

export type SectorTriple = readonly [number, number, number];

/** Features from one stateful network step. Sector order is always [left, center, right]. */
export interface NeuralFeatures {
  readonly type: "features";
  readonly runId: RunId;
  readonly seq: number;
  readonly tick: Tick;
  readonly frameId: string;
  /** Opponent rightward-minus-leftward T4/T5 signal relative to the run's warm-up baseline. */
  readonly horizontalMotion: SectorTriple;
  /** (right − left) / 2 of horizontalMotion: a heuristic expansion signal, not a calibrated time-to-contact. */
  readonly expansion: number;
  /** Mean rectified voltage per named cell type and sector. */
  readonly responses: { readonly [cellType: string]: SectorTriple };
  /** Service-side wall time for this step, measured by the service. */
  readonly latencyMs: number;
}

export interface NeuralError {
  readonly type: "error";
  readonly runId: RunId | null;
  readonly seq: number | null;
  readonly code: "bad_request" | "wrong_run" | "out_of_order" | "model_unavailable" | "internal";
  readonly message: string;
}

export type NeuralReply = NeuralReady | NeuralFeatures | NeuralError;

const triple: Schema = { type: "array", items: num(), minItems: 3, maxItems: 3 };

const featuresSchema: Schema = obj({
  type: lit("features"),
  runId: str(),
  seq: int(),
  tick: int(),
  frameId: str(128),
  horizontalMotion: triple,
  expansion: num(),
  responses: { type: "object", fields: {}, optional: [] },
  latencyMs: num(0),
});

/**
 * Validate a features reply. `responses` is checked separately because its keys are cell-type names
 * from the checkpoint's connectome metadata.
 */
export function parseNeuralFeatures(value: unknown): ParseResult<NeuralFeatures> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["$: expected object"] };
  const { responses, ...rest } = value as Record<string, unknown>;
  const errors = parseWith<unknown>(featuresSchema, { ...rest, responses: {} });
  const responseErrors = validateResponses(responses);
  const all = [...(errors.ok ? [] : errors.errors), ...responseErrors];
  return all.length === 0 ? { ok: true, value: value as NeuralFeatures } : { ok: false, errors: all };
}

function validateResponses(responses: unknown): string[] {
  if (responses === null || typeof responses !== "object" || Array.isArray(responses)) return ["$.responses: expected object"];
  const errors: string[] = [];
  for (const [cellType, values] of Object.entries(responses)) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(cellType)) errors.push(`$.responses: invalid cell type name ${JSON.stringify(cellType)}`);
    if (!Array.isArray(values) || values.length !== 3 || !values.every(v => typeof v === "number" && Number.isFinite(v))) errors.push(`$.responses.${cellType}: expected three finite numbers`);
  }
  return errors;
}

/** Quantize a [0, 1] luminance frame to the u8 wire encoding. */
export function encodeLuminanceU8(luminance: Float32Array): Uint8Array {
  const out = new Uint8Array(luminance.length);
  for (let i = 0; i < luminance.length; i++) {
    const v = luminance[i];
    out[i] = v <= 0 || Number.isNaN(v) ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}
