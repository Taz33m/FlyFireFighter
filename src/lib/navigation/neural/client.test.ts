import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { CameraFrame } from "../../contracts/camera.ts";
import { calibrationFromSensor } from "../../contracts/camera.ts";
import type { NeuralStepHeader } from "../../contracts/neural.ts";
import { encodeLuminanceU8, NEURAL_PROTOCOL } from "../../contracts/neural.ts";
import type { NeuralClientOptions, NeuralScheduler } from "./client.ts";
import { NeuralClient } from "./client.ts";
import type { NeuralClientErrorCode } from "./errors.ts";
import { NeuralClientError, NeuralTimeoutError } from "./errors.ts";
import type { NeuralTransport, NeuralTransportEvents } from "./transport.ts";

// Scope: NeuralClient over a fake transport and a fake clock. No service, network or sockets.

const rgb = TENDER_T1.sensors.find(s => s.id === "rgb-front");
if (rgb === undefined) throw new Error("fixture: rgb-front sensor missing");
const calibration = calibrationFromSensor(rgb, 1);

class FakeTransport implements NeuralTransport {
  readonly sent: (string | Uint8Array)[] = [];
  open = true;
  #events: NeuralTransportEvents | null = null;

  send(message: string | Uint8Array): void {
    if (!this.open) throw new Error("fake transport closed");
    this.sent.push(message);
  }

  listen(events: NeuralTransportEvents): void {
    this.#events = events;
  }

  close(): void {
    this.open = false;
  }

  /** Deliver a reply; objects are JSON-encoded, strings and ArrayBuffers are delivered raw. */
  deliver(message: unknown): void {
    const wire = typeof message === "string" || message instanceof ArrayBuffer ? message : JSON.stringify(message);
    this.#events?.onMessage(wire);
  }

  serverClose(code: number, reason: string): void {
    this.open = false;
    this.#events?.onClose({ code, reason });
  }

  json(index: number): Record<string, unknown> {
    const message = this.sent[index];
    assert.equal(typeof message, "string");
    return JSON.parse(message as string) as Record<string, unknown>;
  }

  lastStep(): { header: NeuralStepHeader; payload: Uint8Array } {
    const payload = this.sent.at(-1);
    assert.ok(payload instanceof Uint8Array, "a step ends with the binary payload");
    return { header: this.json(this.sent.length - 2) as unknown as NeuralStepHeader, payload };
  }
}

class FakeScheduler implements NeuralScheduler {
  now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = [...this.#timers].filter(([, timer]) => timer.at <= this.now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.callback();
    }
  }

  get pending(): number {
    return this.#timers.size;
  }
}

function frame(index: number, overrides: Partial<CameraFrame> = {}): CameraFrame {
  const luminance = new Float32Array(calibration.width * calibration.height);
  for (let i = 0; i < luminance.length; i++) luminance[i] = ((i + 7 * index) % 97) / 96;
  return { frameId: `f-${index}`, captureTick: 2 * index, calibrationId: calibration.id, width: calibration.width, height: calibration.height, luminance, ...overrides };
}

function readyReply(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ready",
    protocol: NEURAL_PROTOCOL,
    runId,
    model: {
      name: "flow/0000/000",
      checkpoint: "results/flow/0000/000/chkpts/chkpt_00000",
      checkpointSha256: "d0e42857e738d0315897c2d50fde9eb3fb1a3fb1f071d55dfc13d53d72bccc3f",
      upstreamCommit: "0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa",
      weightsLicenseStatus: "UNCLEAR - no explicit license or terms found for the downloaded weights",
    },
    eye: { extent: 15, hexals: 721 },
    warmupSteps: 50,
    ...overrides,
  };
}

function featuresFor(header: NeuralStepHeader, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "features", runId: header.runId, seq: header.seq, tick: header.tick, frameId: header.frameId,
    horizontalMotion: [0.2, 0.1, -0.05], expansion: -0.125, responses: { T4a: [0.1, 0.2, 0.3], T4b: [0.3, 0.2, 0.1] }, latencyMs: 4.1,
    ...overrides,
  };
}

/** Observe a promise without leaving a rejection unhandled. */
function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(value => Object.assign(state, { settled: true, value }), error => Object.assign(state, { settled: true, error }));
  return state;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function isClientError(code: NeuralClientErrorCode) {
  return (error: unknown) => error instanceof NeuralClientError && error.code === code;
}

async function readyClient(options: NeuralClientOptions = {}, runId = "run-1") {
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  const client = new NeuralClient(transport, { scheduler, ...options });
  const ready = client.reset(runId, calibration);
  transport.deliver(readyReply(runId));
  await ready;
  return { transport, scheduler, client };
}

describe("NeuralClient reset", () => {
  test("sends the calibration-derived reset and resolves with the validated ready", async () => {
    const transport = new FakeTransport();
    const client = new NeuralClient(transport, { scheduler: new FakeScheduler() });
    const ready = client.reset("run-1", calibration);
    const request = transport.json(0);
    assert.deepEqual({ ...request, horizontalFovDeg: Math.round(request.horizontalFovDeg as number) }, {
      type: "reset", protocol: NEURAL_PROTOCOL, runId: "run-1", calibrationId: "rgb-front/v1",
      width: 320, height: 180, horizontalFovDeg: 90, dtS: 0.02,
    });
    assert.ok(Math.abs((request.horizontalFovDeg as number) - 90) < 1e-9);
    transport.deliver(readyReply("run-1"));
    assert.equal((await ready).model.checkpointSha256.slice(0, 8), "d0e42857");
    assert.equal(client.phase, "ready");
    assert.equal(client.ready?.warmupSteps, 50);
  });

  for (const [label, mutate] of [
    ["another protocol", (r: Record<string, unknown>) => ({ ...r, protocol: "flyfirefighter.neural/2" })],
    ["an extra field", (r: Record<string, unknown>) => ({ ...r, motionCommand: { forwardMps: 3 } })],
    ["a missing licence status", (r: Record<string, unknown>) => ({ ...r, model: { ...(r.model as object), weightsLicenseStatus: undefined } })],
    ["a malformed checkpoint hash", (r: Record<string, unknown>) => ({ ...r, model: { ...(r.model as object), checkpointSha256: "D0E4".repeat(16) } })],
    ["a hexal count that does not fit the extent", (r: Record<string, unknown>) => ({ ...r, eye: { extent: 15, hexals: 720 } })],
  ] as const) {
    test(`rejects a ready with ${label} and leaves no usable run`, async () => {
      const transport = new FakeTransport();
      const client = new NeuralClient(transport, { scheduler: new FakeScheduler() });
      const ready = client.reset("run-1", calibration);
      transport.deliver(mutate(readyReply("run-1")));
      await assert.rejects(ready, isClientError("invalid_reply"));
      assert.equal(client.phase, "idle");
      await assert.rejects(client.step(frame(0), 0), isClientError("not_ready"));
      assert.equal(transport.sent.length, 1, "no step was sent");
    });
  }

  test("a reset without ready times out with a typed error", async () => {
    const scheduler = new FakeScheduler();
    const client = new NeuralClient(new FakeTransport(), { scheduler, resetDeadlineMs: 250 });
    const ready = track(client.reset("run-1", calibration));
    scheduler.advance(249);
    await flush();
    assert.equal(ready.settled, false);
    scheduler.advance(1);
    await flush();
    assert.ok(ready.error instanceof NeuralTimeoutError);
    assert.equal(ready.error.operation, "reset");
    assert.equal(client.phase, "idle");
  });

  test("a service error during reset carries the contract code", async () => {
    const transport = new FakeTransport();
    const client = new NeuralClient(transport, { scheduler: new FakeScheduler() });
    const ready = client.reset("run-1", calibration);
    transport.deliver({ type: "error", runId: "run-1", seq: null, code: "model_unavailable", message: "weights missing" });
    await assert.rejects(ready, (error: unknown) => error instanceof NeuralClientError && error.code === "service" && error.serviceCode === "model_unavailable");
  });

  test("a busy refusal and close are reported, and later calls say why", async () => {
    const transport = new FakeTransport();
    const client = new NeuralClient(transport, { scheduler: new FakeScheduler() });
    const ready = client.reset("run-1", calibration);
    // runId null cannot be told apart from a stale step's catch-all error, so the close carries the reason.
    transport.deliver({ type: "error", runId: null, seq: null, code: "bad_request", message: "service busy: one client at a time" });
    transport.serverClose(1013, "busy");
    await assert.rejects(ready, (error: unknown) => isClientError("closed")(error) && (error as Error).message.includes("1013: busy"));
    assert.equal(client.phase, "closed");
    await assert.rejects(client.reset("run-2", calibration), (error: unknown) => isClientError("closed")(error) && (error as Error).message.includes("1013: busy"));
  });

  test("rejects an unusable run id before sending anything", async () => {
    const transport = new FakeTransport();
    const client = new NeuralClient(transport, { scheduler: new FakeScheduler() });
    await assert.rejects(client.reset("", calibration), isClientError("invalid_request"));
    await assert.rejects(client.reset("r".repeat(65), calibration), isClientError("invalid_request"));
    assert.equal(transport.sent.length, 0);
  });
});

describe("NeuralClient step", () => {
  test("sends header then u8 payload, one step at a time, with seq 0, 1, 2", async () => {
    const { transport, client } = await readyClient();
    const first = client.step(frame(0), 10);
    const { header, payload } = transport.lastStep();
    assert.deepEqual(header, { type: "step", runId: "run-1", seq: 0, tick: 10, frameId: "f-0", width: 320, height: 180, encoding: "u8" });
    assert.deepEqual(payload, encodeLuminanceU8(frame(0).luminance));
    const sentBefore = transport.sent.length;
    await assert.rejects(client.step(frame(1), 12), isClientError("busy"));
    assert.equal(transport.sent.length, sentBefore, "a refused step sends nothing");

    transport.deliver(featuresFor(header));
    assert.deepEqual(await first, featuresFor(header));
    for (const seq of [1, 2]) {
      const next = client.step(frame(seq), 10 + 2 * seq);
      const sent = transport.lastStep().header;
      assert.equal(sent.seq, seq);
      transport.deliver(featuresFor(sent));
      assert.equal((await next).seq, seq);
    }
    assert.equal(client.stats.nextSeq, 3);
  });

  test("replies for another run or seq are discarded", async () => {
    const { transport, client } = await readyClient();
    const pending = track(client.step(frame(0), 0));
    const header = transport.lastStep().header;
    transport.deliver(featuresFor(header, { runId: "run-0" }));
    transport.deliver(featuresFor(header, { seq: 7 }));
    transport.deliver({ type: "error", runId: "run-0", seq: 0, code: "out_of_order", message: "stale" });
    transport.deliver(readyReply("run-1"));
    await flush();
    assert.equal(pending.settled, false);
    assert.equal(client.stats.discardedReplies, 4);
    transport.deliver(featuresFor(header));
    await flush();
    assert.equal((pending.value as { seq: number }).seq, 0);
  });

  test("a missed deadline rejects with NeuralTimeoutError and the run needs a reset", async () => {
    const { transport, scheduler, client } = await readyClient({ stepDeadlineMs: 30, firstStepDeadlineMs: 500 });
    const first = track(client.step(frame(0), 0));
    scheduler.advance(499); // the first step also covers the service's warm-up
    transport.deliver(featuresFor(transport.lastStep().header));
    await flush();
    assert.equal(first.error, undefined);

    const late = track(client.step(frame(1), 2));
    const header = transport.lastStep().header;
    scheduler.advance(30);
    await flush();
    assert.ok(late.error instanceof NeuralTimeoutError);
    assert.deepEqual([late.error.code, late.error.operation, late.error.deadlineMs, late.error.runId, late.error.seq], ["timeout", "step", 30, "run-1", 1]);
    assert.equal(client.phase, "desynchronized");

    transport.deliver(featuresFor(header)); // the late reply is not used
    assert.equal(client.stats.discardedReplies, 1);
    await assert.rejects(client.step(frame(2), 4), isClientError("desynchronized"));

    const ready = client.reset("run-2", calibration);
    transport.deliver(readyReply("run-2"));
    await ready;
    void client.step(frame(3), 6).catch(() => undefined);
    assert.deepEqual([transport.lastStep().header.runId, transport.lastStep().header.seq], ["run-2", 0]);
  });

  for (const [label, override] of [
    ["a smuggled motion-command field", { motionCommand: { forwardMps: 4, yawRateRadS: 1 } }],
    ["a two-sector horizontalMotion", { horizontalMotion: [0.1, 0.2] }],
    ["a non-finite response", { responses: { T4a: [0, null, 0] } }],
    ["a frameId that is not the request's", { frameId: "f-99" }],
  ] as const) {
    test(`rejects features with ${label}`, async () => {
      const { transport, client } = await readyClient();
      const step = client.step(frame(0), 0);
      transport.deliver(featuresFor(transport.lastStep().header, override));
      await assert.rejects(step, isClientError("invalid_reply"));
      assert.equal(client.phase, "desynchronized");
    });
  }

  test("an unparseable reply fails the step instead of being ignored", async () => {
    const { transport, client } = await readyClient();
    const step = client.step(frame(0), 0);
    transport.deliver("{not json");
    await assert.rejects(step, isClientError("invalid_reply"));
  });

  test("a service error for the in-flight step carries the contract code", async () => {
    const { transport, client } = await readyClient();
    const step = client.step(frame(0), 0);
    transport.deliver({ type: "error", runId: "run-1", seq: 0, code: "out_of_order", message: "expected seq 0" });
    await assert.rejects(step, (error: unknown) => error instanceof NeuralClientError && error.code === "service" && error.serviceCode === "out_of_order" && error.seq === 0);
    assert.equal(client.phase, "desynchronized");
  });

  test("frames must match the calibration the run was reset with", async () => {
    const { transport, client } = await readyClient();
    const sent = transport.sent.length;
    await assert.rejects(client.step(frame(0, { width: 319, luminance: new Float32Array(319 * 180) }), 0), isClientError("invalid_frame"));
    await assert.rejects(client.step(frame(0, { calibrationId: "rgb-front/v2" }), 0), isClientError("invalid_frame"));
    await assert.rejects(client.step(frame(0, { luminance: new Float32Array(10) }), 0), isClientError("invalid_frame"));
    await assert.rejects(client.step(frame(0), -1), isClientError("invalid_frame"));
    assert.equal(transport.sent.length, sent);
    assert.equal(client.phase, "ready", "a refused frame does not break the run");
  });
});

describe("NeuralClient reset clears pending state", () => {
  test("an in-flight step is superseded and its late reply discarded", async () => {
    const { transport, scheduler, client } = await readyClient();
    const step = track(client.step(frame(0), 0));
    const oldHeader = transport.lastStep().header;
    const ready = client.reset("run-2", calibration);
    await flush();
    assert.ok(isClientError("superseded")(step.error));
    transport.deliver(featuresFor(oldHeader)); // answered before the service saw the reset
    transport.deliver(readyReply("run-2"));
    await ready;
    assert.equal(client.stats.discardedReplies, 1);
    assert.equal(scheduler.pending, 0, "no stale timers remain");
    const next = client.step(frame(1), 2);
    const header = transport.lastStep().header;
    assert.deepEqual([header.runId, header.seq], ["run-2", 0]);
    transport.deliver(featuresFor(header));
    assert.equal((await next).runId, "run-2");
  });

  // The service answers in order, so the superseded step's error reaches the client before the reset's ready.
  for (const [label, nextRun, staleError] of [
    ["the service's catch-all (runId null, seq null)", "run-2", { type: "error", runId: null, seq: null, code: "internal", message: "boom" }],
    ["the old step (same run id, seq 0)", "run-1", { type: "error", runId: "run-1", seq: 0, code: "internal", message: "step failed" }],
    ["a step of an earlier run", "run-2", { type: "error", runId: "run-1", seq: 0, code: "out_of_order", message: "expected seq 1" }],
  ] as const) {
    test(`a stale error from ${label} does not fail the reset that superseded it`, async () => {
      const { transport, scheduler, client } = await readyClient();
      const step = track(client.step(frame(0), 0));
      const ready = track(client.reset(nextRun, calibration));
      transport.deliver(staleError);
      await flush();
      assert.ok(isClientError("superseded")(step.error));
      assert.equal(ready.settled, false, "the stale error is not the reset's reply");
      assert.equal(client.phase, "resetting");
      assert.equal(client.stats.discardedReplies, 1);
      transport.deliver(readyReply(nextRun));
      await flush();
      assert.equal((ready.value as { runId: string }).runId, nextRun);
      assert.equal(client.phase, "ready");
      assert.equal(scheduler.pending, 0, "the reset deadline was cleared");
    });
  }

  test("an error for the reset itself (its run id, no seq) still fails it after a stale reply", async () => {
    const { transport, client } = await readyClient();
    track(client.step(frame(0), 0));
    const ready = client.reset("run-1", calibration);
    transport.deliver({ type: "error", runId: "run-1", seq: 0, code: "internal", message: "step failed" });
    transport.deliver({ type: "error", runId: "run-1", seq: null, code: "model_unavailable", message: "weights missing" });
    await assert.rejects(ready, (error: unknown) => isClientError("service")(error) && (error as NeuralClientError).serviceCode === "model_unavailable");
    assert.equal(client.phase, "idle");
    assert.equal(client.stats.discardedReplies, 1);
  });

  test("a second reset supersedes the first, whose ready is then ignored", async () => {
    const transport = new FakeTransport();
    const client = new NeuralClient(transport, { scheduler: new FakeScheduler() });
    const first = track(client.reset("run-a", calibration));
    const second = client.reset("run-b", calibration);
    await flush();
    assert.ok(isClientError("superseded")(first.error));
    transport.deliver(readyReply("run-a"));
    transport.deliver(readyReply("run-b"));
    assert.equal((await second).runId, "run-b");
    assert.equal(client.stats.discardedReplies, 1);
  });

  test("a closed connection rejects pending work", async () => {
    const { transport, client } = await readyClient();
    const step = client.step(frame(0), 0);
    transport.serverClose(1001, "going away");
    await assert.rejects(step, isClientError("closed"));
    assert.equal(client.phase, "closed");
    assert.deepEqual(await client.closed, { code: 1001, reason: "going away" });
  });
});
