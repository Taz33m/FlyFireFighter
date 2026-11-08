import type { RunId } from "../../contracts/ids.ts";
import type { NeuralError } from "../../contracts/neural.ts";

/**
 * Why a NeuralClient request failed. Every failure is surfaced to the caller; the mission runtime
 * switches to a named classical fallback and labels it rather than reusing stale features.
 */
export type NeuralClientErrorCode =
  /** No matching reply before the deadline (see NeuralTimeoutError). The run must be reset. */
  | "timeout"
  /** The service answered with an error reply; `serviceCode` holds the contract code. */
  | "service"
  /** A reply failed schema validation or contradicted the request (tick, frameId, protocol). */
  | "invalid_reply"
  /** The run id or calibration passed to reset() is unusable. */
  | "invalid_request"
  /** step() was called before a successful reset(). */
  | "not_ready"
  /** step() was called while another step was in flight (strictly one at a time). */
  | "busy"
  /** The frame does not match the calibration the run was reset with, or the tick is invalid. */
  | "invalid_frame"
  /** An earlier step of this run failed, so service and client state may differ; reset() first. */
  | "desynchronized"
  /** A newer reset() replaced this request before it completed. */
  | "superseded"
  /** The transport is closed or could not be opened. */
  | "closed";

export interface NeuralClientErrorDetails {
  readonly runId?: RunId | null;
  readonly seq?: number | null;
  readonly serviceCode?: NeuralError["code"] | null;
}

export class NeuralClientError extends Error {
  readonly code: NeuralClientErrorCode;
  readonly runId: RunId | null;
  readonly seq: number | null;
  readonly serviceCode: NeuralError["code"] | null;

  constructor(code: NeuralClientErrorCode, message: string, details: NeuralClientErrorDetails = {}) {
    super(message);
    this.name = "NeuralClientError";
    this.code = code;
    this.runId = details.runId ?? null;
    this.seq = details.seq ?? null;
    this.serviceCode = details.serviceCode ?? null;
  }
}

/** The per-request deadline passed without a matching reply. */
export class NeuralTimeoutError extends NeuralClientError {
  readonly operation: "reset" | "step";
  readonly deadlineMs: number;

  constructor(operation: "reset" | "step", deadlineMs: number, details: NeuralClientErrorDetails) {
    super("timeout", `neural ${operation} timed out after ${deadlineMs} ms`, details);
    this.name = "NeuralTimeoutError";
    this.operation = operation;
    this.deadlineMs = deadlineMs;
  }
}
