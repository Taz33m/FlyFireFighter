/**
 * Mission-worker client for the FlyVis service (protocol flyfirefighter.neural/1, see
 * src/lib/contracts/neural.ts).
 *
 * - reset(runId, calibration) starts a run and resolves with the validated `ready` reply.
 * - step(frame, tick) sends the step header and the u8 luminance payload and resolves with features
 *   validated by parseNeuralFeatures. Strictly one step is in flight; seq is 0, 1, 2, ... per run.
 * - Replies for another run or seq are discarded (counted in `stats`). Everything that arrives before a
 *   reset's `ready` belongs to an earlier request, because the service answers in order on one socket;
 *   while a reset is pending only an error with the reset's runId and a null seq fails it.
 * - Every failure rejects with a NeuralClientError. A failed or timed-out step leaves service and client
 *   state possibly different, so the run is marked desynchronized until the next reset. The caller
 *   decides what to do instead (the mission runtime switches to a named classical fallback).
 * - The first step of a run also runs the service's warm-up, so it has its own, longer deadline.
 */
import type { CameraCalibration, CameraFrame } from "../../contracts/camera.ts";
import { isTick } from "../../contracts/clock.ts";
import type { Tick } from "../../contracts/clock.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { NeuralFeatures, NeuralReady, NeuralResetRequest, NeuralStepHeader } from "../../contracts/neural.ts";
import { encodeLuminanceU8, parseNeuralFeatures } from "../../contracts/neural.ts";
import type { NeuralClientErrorCode, NeuralClientErrorDetails } from "./errors.ts";
import { NeuralClientError, NeuralTimeoutError } from "./errors.ts";
import { parseNeuralError, parseNeuralReady, resetRequestFor } from "./messages.ts";
import type { NeuralTransport, NeuralWireMessage } from "./transport.ts";

export interface NeuralScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NeuralClientOptions {
  /** Deadline for each step after the first, in wall-clock ms. Default 50 (2.5 visual frames). */
  readonly stepDeadlineMs?: number;
  /** Deadline for a run's first step, which includes the service's warm-up. Default 2000. */
  readonly firstStepDeadlineMs?: number;
  /** Deadline for `ready` after a reset. Default 5000. */
  readonly resetDeadlineMs?: number;
  /** Timer source; injectable for tests. Defaults to the global setTimeout/clearTimeout. */
  readonly scheduler?: NeuralScheduler;
}

export const NEURAL_CLIENT_DEFAULTS = Object.freeze({ stepDeadlineMs: 50, firstStepDeadlineMs: 2000, resetDeadlineMs: 5000 });

/** idle: no run (never reset, or the last reset failed); desynchronized: the run failed, reset required. */
export type NeuralClientPhase = "idle" | "resetting" | "ready" | "desynchronized" | "closed";

interface Pending<T> {
  readonly runId: RunId;
  readonly resolve: (value: T) => void;
  readonly reject: (error: NeuralClientError) => void;
  timer: unknown;
}

interface InFlightStep extends Pending<NeuralFeatures> {
  readonly seq: number;
  readonly tick: Tick;
  readonly frameId: string;
}

const defaultScheduler: NeuralScheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

export class NeuralClient {
  readonly #transport: NeuralTransport;
  readonly #scheduler: NeuralScheduler;
  readonly #deadlines: { readonly step: number; readonly firstStep: number; readonly reset: number };
  #phase: NeuralClientPhase = "idle";
  #runId: RunId | null = null;
  #calibration: CameraCalibration | null = null;
  #ready: NeuralReady | null = null;
  #nextSeq = 0;
  #reset: Pending<NeuralReady> | null = null;
  #step: InFlightStep | null = null;
  #discarded = 0;
  #closeReason = "";
  readonly #closed: Promise<{ readonly code: number; readonly reason: string }>;
  #markTransportClosed: (event: { readonly code: number; readonly reason: string }) => void = () => undefined;

  constructor(transport: NeuralTransport, options: NeuralClientOptions = {}) {
    this.#transport = transport;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#deadlines = {
      step: deadline(options.stepDeadlineMs ?? NEURAL_CLIENT_DEFAULTS.stepDeadlineMs, "stepDeadlineMs"),
      firstStep: deadline(options.firstStepDeadlineMs ?? NEURAL_CLIENT_DEFAULTS.firstStepDeadlineMs, "firstStepDeadlineMs"),
      reset: deadline(options.resetDeadlineMs ?? NEURAL_CLIENT_DEFAULTS.resetDeadlineMs, "resetDeadlineMs"),
    };
    this.#closed = new Promise(resolve => {
      this.#markTransportClosed = resolve;
    });
    transport.listen({
      onMessage: message => this.#onMessage(message),
      onClose: event => {
        this.#markTransportClosed(event);
        this.#onClose(event);
      },
    });
  }

  /** Resolves when the transport reports the connection closed (await it before reconnecting). */
  get closed(): Promise<{ readonly code: number; readonly reason: string }> {
    return this.#closed;
  }

  get phase(): NeuralClientPhase {
    return this.#phase;
  }

  /** The validated `ready` of the current run (model, checkpoint hash, licence status), if any. */
  get ready(): NeuralReady | null {
    return this.#ready;
  }

  get stats(): { readonly discardedReplies: number; readonly nextSeq: number; readonly runId: RunId | null } {
    return { discardedReplies: this.#discarded, nextSeq: this.#nextSeq, runId: this.#runId };
  }

  /** Start a new run. Any pending reset or step is rejected as superseded. */
  reset(runId: RunId, calibration: CameraCalibration): Promise<NeuralReady> {
    if (this.#phase === "closed") return Promise.reject(this.#error("closed", `transport is closed (${this.#closeReason})`, { runId }));
    let request: NeuralResetRequest;
    try {
      request = resetRequestFor(runId, calibration);
    } catch (error) {
      return Promise.reject(this.#error("invalid_request", (error as Error).message, { runId }));
    }
    this.#cancelPending("superseded", `superseded by reset of run ${runId}`);
    this.#phase = "resetting";
    this.#runId = runId;
    this.#calibration = calibration;
    this.#ready = null;
    this.#nextSeq = 0;
    return new Promise<NeuralReady>((resolve, reject) => {
      const pending: Pending<NeuralReady> = { runId, resolve, reject, timer: null };
      this.#reset = pending;
      pending.timer = this.#scheduler.setTimeout(() => this.#resetTimedOut(pending), this.#deadlines.reset);
      this.#send([JSON.stringify(request)]);
    });
  }

  /** Integrate one frame. Resolves with the validated features for exactly this run and seq. */
  step(frame: CameraFrame, tick: Tick): Promise<NeuralFeatures> {
    const refusal = this.#stepRefusal(frame, tick);
    if (refusal !== null) return Promise.reject(refusal);
    const runId = this.#runId as RunId;
    const seq = this.#nextSeq;
    const header: NeuralStepHeader = {
      type: "step", runId, seq, tick, frameId: frame.frameId, width: frame.width, height: frame.height, encoding: "u8",
    };
    const payload = encodeLuminanceU8(frame.luminance);
    return new Promise<NeuralFeatures>((resolve, reject) => {
      const step: InFlightStep = { runId, seq, tick, frameId: frame.frameId, resolve, reject, timer: null };
      this.#step = step;
      const ms = seq === 0 ? this.#deadlines.firstStep : this.#deadlines.step;
      step.timer = this.#scheduler.setTimeout(() => this.#stepTimedOut(step, ms), ms);
      this.#send([JSON.stringify(header), payload]);
    });
  }

  /** Close the connection now; pending requests reject as closed. See `closed` for completion. */
  close(): void {
    if (this.#phase === "closed") return;
    this.#transport.close();
    this.#onClose({ code: 1000, reason: "client closed" });
  }

  #stepRefusal(frame: CameraFrame, tick: Tick): NeuralClientError | null {
    const details = { runId: this.#runId, seq: this.#nextSeq };
    if (this.#phase === "closed") return this.#error("closed", `transport is closed (${this.#closeReason})`, details);
    if (this.#phase === "desynchronized") return this.#error("desynchronized", "an earlier step failed; reset the run", details);
    if (this.#phase !== "ready") return this.#error("not_ready", "no ready run; call reset() first", details);
    if (this.#step !== null) return this.#error("busy", `step ${this.#step.seq} is still in flight`, details);
    const problem = frameProblem(frame, tick, this.#calibration as CameraCalibration);
    return problem === null ? null : this.#error("invalid_frame", problem, details);
  }

  /** A failed send means the channel is gone: close, which rejects whatever is pending. */
  #send(messages: readonly (string | Uint8Array)[]): void {
    try {
      for (const message of messages) this.#transport.send(message);
    } catch (error) {
      this.#onClose({ code: 1006, reason: `send failed: ${(error as Error).message}` });
    }
  }

  #onMessage(message: NeuralWireMessage): void {
    if (typeof message !== "string") return this.#violation("unexpected binary message from the service");
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      return this.#violation("reply is not valid JSON");
    }
    const type = isRecord(value) ? value.type : undefined;
    if (type === "ready") return this.#onReady(value as Record<string, unknown>);
    if (type === "features") return this.#onFeatures(value as Record<string, unknown>);
    if (type === "error") return this.#onError(value);
    this.#violation(`unknown reply type ${JSON.stringify(type)}`);
  }

  #onReady(value: Record<string, unknown>): void {
    const pending = this.#reset;
    if (pending === null || value.runId !== pending.runId) {
      this.#discarded++;
      return;
    }
    this.#settle(pending);
    this.#reset = null;
    const parsed = parseNeuralReady(value);
    if (!parsed.ok) {
      this.#phase = "idle";
      pending.reject(this.#error("invalid_reply", `invalid ready: ${parsed.errors.join("; ")}`, { runId: pending.runId }));
      return;
    }
    this.#ready = parsed.value;
    this.#phase = "ready";
    pending.resolve(parsed.value);
  }

  #onFeatures(value: Record<string, unknown>): void {
    const step = this.#step;
    if (step === null || value.runId !== step.runId || value.seq !== step.seq) {
      this.#discarded++;
      return;
    }
    this.#settle(step);
    this.#step = null;
    const parsed = parseNeuralFeatures(value);
    if (!parsed.ok) return this.#failStep(step, "invalid_reply", `invalid features: ${parsed.errors.join("; ")}`);
    if (parsed.value.tick !== step.tick || parsed.value.frameId !== step.frameId) {
      return this.#failStep(step, "invalid_reply", "features tick/frameId do not match the step request");
    }
    this.#nextSeq = step.seq + 1;
    step.resolve(parsed.value);
  }

  #onError(value: unknown): void {
    const parsed = parseNeuralError(value);
    if (!parsed.ok) return this.#violation(`invalid error reply: ${parsed.errors.join("; ")}`);
    const reply = parsed.value;
    const reset = this.#reset;
    const step = this.#step;
    if (reset !== null) {
      // Everything before the reset's own reply answers an earlier request (in-order service). Only an
      // error naming this run and no seq is the reset's; a stale step error (seq set, or runId null from
      // the service's catch-all) must not fail the reset, or the genuine `ready` after it is discarded.
      if (reply.seq !== null || reply.runId !== reset.runId) {
        this.#discarded++;
        return;
      }
      this.#settle(reset);
      this.#reset = null;
      this.#phase = "idle";
      reset.reject(this.#error("service", `${reply.code}: ${reply.message}`, { runId: reset.runId, serviceCode: reply.code }));
    } else if (step !== null && (reply.runId === null || (reply.runId === step.runId && (reply.seq === null || reply.seq === step.seq)))) {
      this.#settle(step);
      this.#step = null;
      this.#failStep(step, "service", `${reply.code}: ${reply.message}`, reply.code);
    } else {
      this.#discarded++;
    }
  }

  /** A reply that cannot be attributed safely fails whatever is pending. */
  #violation(message: string): void {
    const reset = this.#reset;
    const step = this.#step;
    if (reset !== null) {
      this.#settle(reset);
      this.#reset = null;
      this.#phase = "idle";
      reset.reject(this.#error("invalid_reply", message, { runId: reset.runId }));
    } else if (step !== null) {
      this.#settle(step);
      this.#step = null;
      this.#failStep(step, "invalid_reply", message);
    } else {
      this.#discarded++;
    }
  }

  #failStep(step: InFlightStep, code: NeuralClientErrorCode, message: string, serviceCode: NeuralClientErrorDetails["serviceCode"] = null): void {
    if (this.#phase === "ready") this.#phase = "desynchronized";
    step.reject(this.#error(code, message, { runId: step.runId, seq: step.seq, serviceCode }));
  }

  #resetTimedOut(pending: Pending<NeuralReady>): void {
    if (this.#reset !== pending) return;
    this.#reset = null;
    this.#phase = "idle";
    pending.reject(new NeuralTimeoutError("reset", this.#deadlines.reset, { runId: pending.runId }));
  }

  #stepTimedOut(step: InFlightStep, ms: number): void {
    if (this.#step !== step) return;
    this.#step = null;
    if (this.#phase === "ready") this.#phase = "desynchronized";
    step.reject(new NeuralTimeoutError("step", ms, { runId: step.runId, seq: step.seq }));
  }

  #onClose(event: { readonly code: number; readonly reason: string }): void {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    this.#closeReason = `code ${event.code}${event.reason ? `: ${event.reason}` : ""}`;
    this.#cancelPending("closed", `connection closed (${this.#closeReason})`);
  }

  #cancelPending(code: NeuralClientErrorCode, message: string): void {
    const reset = this.#reset;
    const step = this.#step;
    this.#reset = null;
    this.#step = null;
    if (reset !== null) {
      this.#settle(reset);
      reset.reject(this.#error(code, message, { runId: reset.runId }));
    }
    if (step !== null) {
      this.#settle(step);
      step.reject(this.#error(code, message, { runId: step.runId, seq: step.seq }));
    }
  }

  #settle(pending: { readonly timer: unknown }): void {
    this.#scheduler.clearTimeout(pending.timer);
  }

  #error(code: NeuralClientErrorCode, message: string, details: NeuralClientErrorDetails): NeuralClientError {
    return new NeuralClientError(code, message, details);
  }
}

function deadline(ms: number, name: string): number {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`${name} must be a positive number of milliseconds`);
  return ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frameProblem(frame: CameraFrame, tick: Tick, calibration: CameraCalibration): string | null {
  if (!isTick(tick)) return `tick must be a non-negative integer, got ${tick}`;
  if (frame.calibrationId !== calibration.id) return `frame calibration ${frame.calibrationId} does not match ${calibration.id}`;
  if (frame.width !== calibration.width || frame.height !== calibration.height) {
    return `frame is ${frame.width}x${frame.height}, run is locked to ${calibration.width}x${calibration.height}`;
  }
  if (frame.luminance.length !== frame.width * frame.height) return `luminance has ${frame.luminance.length} values, expected ${frame.width * frame.height}`;
  if (typeof frame.frameId !== "string" || frame.frameId.length < 1 || frame.frameId.length > 128) return "frameId must be a 1..128 character string";
  return null;
}
