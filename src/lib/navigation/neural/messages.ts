/**
 * Wire messages of flyfirefighter.neural/1 that the shared contract does not parse itself: the reset
 * request built from a camera calibration, and strict `ready` / `error` reply validation. Unknown members
 * are rejected, like every boundary schema in src/lib/contracts.
 */
import type { CameraCalibration } from "../../contracts/camera.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { NeuralError, NeuralReady, NeuralResetRequest } from "../../contracts/neural.ts";
import { NEURAL_DT_S, NEURAL_PROTOCOL, NEURAL_SERVICE_PORT } from "../../contracts/neural.ts";
import type { ParseResult, Schema } from "../../contracts/schema.ts";
import { int, lit, obj, parseWith, str } from "../../contracts/schema.ts";

export const NEURAL_SERVICE_URL = `ws://127.0.0.1:${NEURAL_SERVICE_PORT}`;

/** Error codes defined by the contract. */
export const NEURAL_ERROR_CODES: readonly NeuralError["code"][] = ["bad_request", "wrong_run", "out_of_order", "model_unavailable", "internal"];

const runIdSchema = str(64);

/** Horizontal field of view implied by the pinhole intrinsics. */
export function horizontalFovDeg(calibration: CameraCalibration): number {
  return (2 * Math.atan(calibration.width / 2 / calibration.fx) * 180) / Math.PI;
}

/** Reset request for a run; throws RangeError for an unusable run id or calibration. */
export function resetRequestFor(runId: RunId, calibration: CameraCalibration): NeuralResetRequest {
  const problems = [
    ...(parseWith<RunId>(runIdSchema, runId).ok ? [] : ["runId must be a 1..64 character string"]),
    ...(parseWith<string>(str(64), calibration.id).ok ? [] : ["calibration id must be a 1..64 character string"]),
    ...(isDimension(calibration.width) && isDimension(calibration.height) ? [] : ["calibration width/height must be integers in 2..4096"]),
    ...(Number.isFinite(calibration.fx) && calibration.fx > 0 ? [] : ["calibration fx must be positive"]),
  ];
  if (problems.length > 0) throw new RangeError(problems.join("; "));
  return {
    type: "reset",
    protocol: NEURAL_PROTOCOL,
    runId,
    calibrationId: calibration.id,
    width: calibration.width,
    height: calibration.height,
    horizontalFovDeg: horizontalFovDeg(calibration),
    dtS: NEURAL_DT_S,
  };
}

function isDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 2 && value <= 4096;
}

const readySchema: Schema = obj({
  type: lit("ready"),
  protocol: lit(NEURAL_PROTOCOL),
  runId: runIdSchema,
  model: obj({
    name: str(128),
    checkpoint: str(256),
    checkpointSha256: str(64, 64),
    upstreamCommit: str(40, 40),
    weightsLicenseStatus: str(500),
  }),
  eye: obj({ extent: int(1, 100), hexals: int(1, 30_301) }),
  warmupSteps: int(0, 100_000),
});

/** Validate a `ready` reply: exact fields, hex digests, and a hexal count consistent with the extent. */
export function parseNeuralReady(value: unknown): ParseResult<NeuralReady> {
  const parsed = parseWith<NeuralReady>(readySchema, value);
  if (!parsed.ok) return parsed;
  const { model, eye } = parsed.value;
  const errors = [
    ...(/^[0-9a-f]{64}$/.test(model.checkpointSha256) ? [] : ["$.model.checkpointSha256: expected 64 lowercase hex digits"]),
    ...(/^[0-9a-f]{40}$/.test(model.upstreamCommit) ? [] : ["$.model.upstreamCommit: expected a 40-digit git commit"]),
    ...(eye.hexals === 3 * eye.extent * (eye.extent + 1) + 1 ? [] : ["$.eye.hexals: inconsistent with a hexagonal lattice of this extent"]),
  ];
  return errors.length === 0 ? parsed : { ok: false, errors };
}

const errorSchema: Schema = obj({
  type: lit("error"),
  runId: { type: "nullable", inner: runIdSchema },
  seq: { type: "nullable", inner: int() },
  code: lit(...NEURAL_ERROR_CODES),
  message: str(500, 0),
});

export function parseNeuralError(value: unknown): ParseResult<NeuralError> {
  return parseWith<NeuralError>(errorSchema, value);
}
