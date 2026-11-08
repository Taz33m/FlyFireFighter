/**
 * Client-side wiring for the decision broker: a transport to the app's own POST /api/decisions route and
 * a small driver that sends requests, arms the deadline timer, aborts timed-out or reset requests and feeds
 * replies back to the broker. Timers, the clock and the transport are injected, so tests run without a
 * network or real time. The browser never holds the OpenAI or Gemini key; only the Next server does.
 */
import type { BeliefSnapshot } from "../../contracts/evidence.ts";
import type { RunId } from "../../contracts/ids.ts";
import type { BrokerStep, DecisionBroker } from "./broker.ts";
import type { FetchLike } from "./gateway.ts";
import { PROVIDER_PARAMETER, readBoundedText } from "./gateway.ts";
import type { CandidateSet, CloudDecider, DecisionGatewayRequest } from "./types.ts";
import { MAX_RESPONSE_BYTES } from "./types.ts";

/** Sends one request and resolves with the reply body; rejects on transport failure. */
export type DecisionTransport = (request: DecisionGatewayRequest, signal: AbortSignal) => Promise<unknown>;

/** The app's gateway route for a cloud decider: OpenAI Decisions keeps the plain path; Gemini and consensus add `?provider=`. */
export function decisionUrl(decider: CloudDecider, base = "/api/decisions"): string {
  return decider === "openai_decisions" ? base : `${base}?${PROVIDER_PARAMETER}=${decider}`;
}

/** Transport to the app's gateway route. Any HTTP status with a JSON body resolves; the broker judges it. */
export function httpDecisionTransport(fetchImpl: FetchLike, url = "/api/decisions"): DecisionTransport {
  return async (request, signal) => {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal });
    const text = await readBoundedText(response.body, MAX_RESPONSE_BYTES);
    if (!text.ok) throw new Error(`Decision reply was ${text.reason === "too_large" ? "too large" : "unreadable"}.`);
    return JSON.parse(text.text) as unknown;
  };
}

export interface DecisionLoopOptions {
  readonly broker: DecisionBroker;
  readonly transport: DecisionTransport;
  /** Monotonic wall clock in milliseconds, e.g. performance.now. */
  readonly nowMs: () => number;
  /** Schedule a callback; returns a cancel function. */
  readonly setTimer: (callback: () => void, delayMs: number) => () => void;
  /** Receives every step with a decision, a discard, a send or an abort. */
  readonly onStep: (step: BrokerStep) => void;
}

export class DecisionLoop {
  private readonly options: DecisionLoopOptions;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelTimers = new Map<string, () => void>();

  constructor(options: DecisionLoopOptions) {
    this.options = options;
  }

  plan(set: CandidateSet, belief: BeliefSnapshot): void {
    this.handle(this.options.broker.plan(set, belief, this.options.nowMs()));
  }

  reset(runId: RunId): void {
    this.handle(this.options.broker.reset(runId));
  }

  private handle(step: BrokerStep): void {
    for (const requestId of step.abort) this.cancel(requestId);
    if (step.send !== null) this.dispatch(step.send);
    if (step.send !== null || step.abort.length > 0 || step.decisions.length > 0 || step.discarded.length > 0) this.options.onStep(step);
  }

  private dispatch(request: DecisionGatewayRequest): void {
    const { broker, transport, nowMs } = this.options;
    const requestId = request.requestId;
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    this.armDeadline(requestId);
    send(transport, request, controller.signal).then(
      body => this.settle(requestId, () => broker.receive(requestId, body, nowMs())),
      () => {
        // A rejection after our own abort is expected and carries no reply.
        if (this.controllers.has(requestId)) this.settle(requestId, () => broker.fail(requestId, nowMs()));
      },
    );
  }

  private armDeadline(requestId: string): void {
    const { broker, nowMs, setTimer } = this.options;
    const deadline = broker.deadlineAtMs ?? nowMs() + broker.deadlineMs;
    this.cancelTimers.set(requestId, setTimer(() => {
      this.cancelTimers.delete(requestId);
      const step = broker.poll(nowMs());
      // A timer that fired early leaves the request in flight: re-arm it for the remaining time.
      if (broker.requestInFlight === requestId) this.armDeadline(requestId);
      this.handle(step);
    }, Math.max(0, deadline - nowMs())));
  }

  private settle(requestId: string, next: () => BrokerStep): void {
    this.forget(requestId);
    this.handle(next());
  }

  private cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort();
    this.forget(requestId);
  }

  private forget(requestId: string): void {
    this.cancelTimers.get(requestId)?.();
    this.cancelTimers.delete(requestId);
    this.controllers.delete(requestId);
  }
}

/** Start the transport now; a synchronous throw becomes a rejection like any other transport failure. */
function send(transport: DecisionTransport, request: DecisionGatewayRequest, signal: AbortSignal): Promise<unknown> {
  try {
    return Promise.resolve(transport(request, signal));
  } catch (error) {
    return Promise.reject(error);
  }
}
