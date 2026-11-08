/**
 * The mission worker (src/workers/mission.worker.ts) in Node with stubbed worker globals: postMessage
 * collects WorkerMessages, fetch serves the scene metadata from public/, and camera frames are answered by
 * the test with a uniform frame tagged "test-uniform/v1". Scope: the protocol lifecycle and the lockstep
 * camera rule, not flight quality.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { CameraFrameMessage, RenderRequest, RunConfig, UiCommand, WorkerMessage } from "./protocol.ts";
import { MISSION_PROTOCOL } from "./protocol.ts";

const messages: WorkerMessage[] = [];
const g = globalThis as unknown as { postMessage?: unknown; onmessage?: ((event: { data: UiCommand }) => void) | null; fetch: typeof fetch };
const originalFetch = g.fetch;
const send = (command: UiCommand) => g.onmessage?.({ data: command });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T extends WorkerMessage>(test: (m: WorkerMessage) => m is T, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(test);
    if (found) return found;
    await wait(5);
  }
  throw new Error("timed out waiting for a worker message");
}

function frameFor(request: RenderRequest): CameraFrameMessage {
  return { type: "camera_frame", runId: request.runId, tick: request.tick, frameId: request.frameId, calibrationId: request.calibrationId, width: 320, height: 180, renderer: "test-uniform/v1", luminance: new Float32Array(320 * 180).fill(0.4) };
}

const CONFIG: RunConfig = { scenarioId: "troy-training/main", seed: "w-seed", aircraftId: "tender-t1", controller: "flow_baseline", decider: "local", commanderId: "commander", speed: 64 };

describe("mission worker protocol", () => {
  before(async () => {
    g.postMessage = (message: WorkerMessage) => messages.push(message);
    const meta = readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8");
    g.fetch = (async (url: string) => (String(url).endsWith("/scenes/troy-training/scene.meta.json") ? new Response(meta, { status: 200 }) : new Response("{}", { status: 404 }))) as typeof fetch;
    await import("../../workers/mission.worker.ts");
  });

  after(() => {
    send({ type: "reset" });
    g.fetch = originalFetch;
    delete g.postMessage;
  });

  test("posts ready, refuses unknown scenarios, starts a run and steps only with answered camera frames", async () => {
    assert.deepEqual(messages[0], { type: "ready", protocol: MISSION_PROTOCOL });
    send({ type: "start_run", config: { ...CONFIG, scenarioId: "troy-training/moon" } });
    const error = await waitFor((m): m is Extract<WorkerMessage, { type: "error" }> => m.type === "error");
    assert.match(error.message, /Unknown scenario "troy-training\/moon"/);
    assert.match(error.message, /kitchen_grease_fire/, "the refusal lists every preset variant");

    send({ type: "start_run", config: CONFIG });
    const started = await waitFor((m): m is Extract<WorkerMessage, { type: "run_started" }> => m.type === "run_started");
    assert.deepEqual(started.scene, { sceneId: "troy-training", revision: 1, baseUrl: "/scenes/troy-training/" });
    const runId = started.runId;
    send({ type: "report", runId, text: "Someone may be in the upstairs rear bedroom.", channel: "typed", source: "judge" });
    send({ type: "authorize_mission", runId, commanderId: "commander" });

    // Answer the first 20 render requests, then stop answering: the clock must not pass the unanswered frame.
    const answered: RenderRequest[] = [];
    while (answered.length < 20) {
      const request = await waitFor((m): m is RenderRequest => m.type === "render_request" && !answered.includes(m as RenderRequest));
      assert.equal(request.runId, runId);
      assert.equal(request.calibrationId, "rgb-front/v1");
      assert.equal(request.frameId, `${runId}/rgb-front/frame/${request.tick}`);
      assert.equal(request.world.label, "simulation_truth_for_rendering");
      answered.push(request);
      send(frameFor(request));
    }
    await wait(300);
    const lastAnswered = answered[answered.length - 1].tick;
    const views = messages.filter((m): m is Extract<WorkerMessage, { type: "view" }> => m.type === "view" && m.runId === runId);
    const maxTick = Math.max(...views.map(v => v.view.tick));
    assert.ok(maxTick <= lastAnswered + 2, `view tick ${maxTick} ran past the unanswered frame after ${lastAnswered}`);
    const latest = views[views.length - 1].view;
    assert.equal(latest.controller.inputFrameId, `${runId}/rgb-front/frame/${lastAnswered}`);
    const events = messages.filter((m): m is Extract<WorkerMessage, { type: "events" }> => m.type === "events").flatMap(m => m.events);
    assert.ok(events.some(e => e.kind === "camera.renderer" && e.subject === "test-uniform/v1"), "the frame renderer is recorded");

    // A frame for another tick is discarded rather than consumed.
    const pending = messages.filter((m): m is RenderRequest => m.type === "render_request").pop() as RenderRequest;
    send({ ...frameFor(pending), tick: pending.tick + 2 });
    await wait(100);
    const after = messages.filter((m): m is Extract<WorkerMessage, { type: "view" }> => m.type === "view" && m.runId === runId);
    assert.ok(Math.max(...after.map(v => v.view.tick)) <= pending.tick, "a mismatched frame does not advance the clock");

    // Export while running, then reset: nothing of the old run is accepted afterwards.
    send({ type: "export_run", runId });
    const exported = await waitFor((m): m is Extract<WorkerMessage, { type: "export" }> => m.type === "export");
    assert.deepEqual(Object.keys(exported.files).sort(), ["events.jsonl", "replay.jsonl", "results.json"]);
    const results = JSON.parse(exported.files["results.json"]) as { scene: { metaSha256: string | null }; camera: { renderers: string[] } };
    assert.match(String(results.scene.metaSha256), /^[0-9a-f]{64}$/);
    assert.deepEqual(results.camera.renderers, ["test-uniform/v1"]);
    send({ type: "reset" });
    const count = messages.length;
    send({ type: "approve", runId, proposalId: `${runId}/p1`, digest: "x", commanderId: "commander", tick: 1 });
    await wait(50);
    const late = messages.slice(count);
    assert.ok(late.every(m => m.type === "error"), JSON.stringify(late.map(m => m.type)));
    assert.match((late[0] as Extract<WorkerMessage, { type: "error" }>).message, /No run is active/);
  });
});
