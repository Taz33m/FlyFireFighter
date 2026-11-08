/**
 * Mission worker ("flyfirefighter.mission/1", src/lib/mission/protocol.ts). It owns the run: clock, world,
 * evidence, planner, harness and event log, all inside MissionRuntime. The UI sends commands and camera
 * frames and renders what is posted here.
 *
 * - Startup posts { type: "ready", protocol }. `reset` tears the run down without starting another;
 *   `start_run` tears down, starts a run with a new runId and confirms with `run_started`.
 * - Scenario ids are "troy-training/<variant>" for the presets in scenario.ts; anything else is refused
 *   with an error message. Scene metadata comes from /scenes/troy-training/scene.meta.json (its SHA-256 goes
 *   into results.json).
 * - Lockstep camera: on every visual tick the runtime posts a render_request for the TRUE pose and waits for
 *   the matching camera_frame (run, tick, frame id, calibration "rgb-front/v1", size, renderer). The clock
 *   never advances a visual tick without its frame; after CAMERA_TIMEOUT_MS the run pauses with an error and
 *   `resume` retries the same tick.
 * - Pacing: ticks are stepped as simulated time falls due at config.speed simulated seconds per wall second;
 *   the achieved simulated:wall ratio is measured over a sliding second and reported in the view. Physics
 *   always steps at 100 Hz; slow frames slow the whole simulation instead of skipping it.
 * - view (+ render snapshot) is posted at most VIEW_HZ times per wall second; events and the outcome as
 *   they occur. The render snapshot's waterJet is the TRUE jet (view.ts).
 * - engineered_readout connects the FlyVis service over the real WebSocket transport; a failure starts the
 *   run in the labelled optical-flow fallback. Deciders "decisions", "gemini" and "consensus" send planning
 *   sets to POST /api/decisions (with ?provider=gemini or ?provider=consensus) through the decision loop;
 *   the local planner continues meanwhile and on any failure.
 */
import type { CameraCalibration } from "../lib/contracts/camera.ts";
import { sha256Hex } from "../lib/contracts/canonical.ts";
import type { RunId } from "../lib/contracts/ids.ts";
import type { SceneMetaJson } from "../lib/contracts/scene.ts";
import type { CameraSource, CapturedFrame } from "../lib/mission/camera-source.ts";
import { frameProblem } from "../lib/mission/camera-source.ts";
import type { CameraFrameMessage, RenderRequest, RunConfig, UiCommand, WorkerMessage } from "../lib/mission/protocol.ts";
import { MISSION_PROTOCOL } from "../lib/mission/protocol.ts";
import { MissionRuntime } from "../lib/mission/runtime.ts";
import { PRESET_VARIANTS, variantOfScenarioId } from "../lib/mission/scenario.ts";
import { RatioMeter } from "../lib/mission/stats.ts";
import { NeuralClient } from "../lib/navigation/neural/client.ts";
import { connectWebSocketTransport } from "../lib/navigation/neural/transport.ts";
import { DecisionLoop, decisionUrl, httpDecisionTransport } from "../lib/navigation/planner/client.ts";
import { parseSceneMeta } from "../lib/simulation/scene.ts";

const SCENE_ID = "troy-training";
const SCENE_BASE_URL = `/scenes/${SCENE_ID}/`;
const SCENE_META_URL = `${SCENE_BASE_URL}scene.meta.json`;
const CALIBRATION_ID = "rgb-front/v1";
const CAMERA_TIMEOUT_MS = 5000;
const VIEW_HZ = 30;
/** Longest stretch of stepping before yielding to the message loop. */
const SLICE_MS = 12;
/** Idle poll while nothing is due (awaiting a report, authorization, paused or ended). */
const IDLE_MS = 50;

interface Scope {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<UiCommand>) => void) | null;
}

const scope = globalThis as unknown as Scope;
const post = (message: WorkerMessage) => scope.postMessage(message);

/** Render requests answered by the UI's camera_frame messages. */
class UiCameraSource implements CameraSource {
  private pending: { readonly request: RenderRequest; readonly resolve: (frame: CapturedFrame) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout>; readonly started: number } | null = null;
  private readonly calibration: CameraCalibration;

  constructor(calibration: CameraCalibration) {
    this.calibration = calibration;
  }

  capture(request: RenderRequest): Promise<CapturedFrame> {
    this.cancel("superseded by a newer render request");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.request !== request) return;
        this.pending = null;
        reject(new Error(`no camera frame for ${request.frameId} within ${CAMERA_TIMEOUT_MS} ms`));
      }, CAMERA_TIMEOUT_MS);
      this.pending = { request, resolve, reject, timer, started: performance.now() };
      post(request);
    });
  }

  /** A camera_frame from the UI; frames that do not answer the pending request are discarded. */
  deliver(message: CameraFrameMessage): void {
    const pending = this.pending;
    if (pending === null || frameProblem(message, pending.request, this.calibration) !== null) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve({ frameId: message.frameId, captureTick: message.tick, calibrationId: message.calibrationId, width: message.width, height: message.height, luminance: message.luminance, renderer: message.renderer, renderMs: performance.now() - pending.started });
  }

  cancel(reason: string): void {
    const pending = this.pending;
    if (pending === null) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(new Error(reason));
  }
}

interface Run {
  readonly generation: number;
  readonly runtime: MissionRuntime;
  readonly camera: UiCameraSource;
  readonly decisions: DecisionLoop | null;
  readonly ratio: RatioMeter;
  readonly metaSha256: string;
  lastSeq: number;
  lastViewMs: number;
  outcomePosted: boolean;
  /** Wall time and tick from which pacing counts simulated time owed. */
  pace: { wallMs: number; tick: number; speed: number };
}

let generation = 0;
let run: Run | null = null;
let starting: Promise<void> | null = null;
let sceneCache: { readonly meta: SceneMetaJson; readonly sha256: string } | null = null;

async function loadScene(): Promise<{ readonly meta: SceneMetaJson; readonly sha256: string }> {
  if (sceneCache !== null) return sceneCache;
  const response = await fetch(SCENE_META_URL);
  if (!response.ok) throw new Error(`Scene metadata ${SCENE_META_URL} returned HTTP ${response.status}.`);
  const text = await response.text();
  sceneCache = { meta: parseSceneMeta(JSON.parse(text)), sha256: sha256Hex(text) };
  return sceneCache;
}

function newRunId(): RunId {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `run-${Date.now().toString(36)}-${random}`;
}

function teardown(): void {
  generation += 1;
  const current = run;
  run = null;
  if (current === null) return;
  current.camera.cancel("the run was reset");
  current.decisions?.reset(current.runtime.runId);
  current.runtime.close();
}

async function startRun(config: RunConfig): Promise<void> {
  teardown();
  const myGeneration = generation;
  const runId = newRunId();
  const variant = variantOfScenarioId(config.scenarioId);
  if (variant === null || !config.scenarioId.startsWith(`${SCENE_ID}/`)) {
    post({ type: "error", runId: null, message: `Unknown scenario "${config.scenarioId}". Use ${SCENE_ID}/<${PRESET_VARIANTS.join("|")}>.` });
    return;
  }
  try {
    const scene = await loadScene();
    if (myGeneration !== generation) return;
    let camera: UiCameraSource | null = null;
    const runtime = await MissionRuntime.create({
      runId,
      config,
      meta: scene.meta,
      camera: (_world, calibration) => (camera = new UiCameraSource(calibration)),
      neural: config.controller === "engineered_readout" ? async () => new NeuralClient(await connectWebSocketTransport()) : null,
    });
    if (myGeneration !== generation) {
      runtime.close();
      return;
    }
    if (runtime.calibration.id !== CALIBRATION_ID) throw new Error(`The aircraft camera calibration is ${runtime.calibration.id}, not the locked ${CALIBRATION_ID}.`);
    const decisions = runtime.planner.broker.cloudActive ? decisionLoop(runtime) : null;
    if (decisions !== null) runtime.planner.useRemote(decisions);
    run = { generation: myGeneration, runtime, camera: camera as unknown as UiCameraSource, decisions, ratio: new RatioMeter(), metaSha256: scene.sha256, lastSeq: 0, lastViewMs: -Infinity, outcomePosted: false, pace: { wallMs: performance.now(), tick: 0, speed: config.speed } };
    post({ type: "run_started", runId, config, scene: { sceneId: scene.meta.sceneId, revision: scene.meta.revision, baseUrl: SCENE_BASE_URL } });
    flush(run, true);
    void loop(run);
  } catch (error) {
    if (myGeneration === generation) post({ type: "error", runId, message: `The run could not start: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function decisionLoop(runtime: MissionRuntime): DecisionLoop {
  return new DecisionLoop({
    broker: runtime.planner.broker,
    transport: httpDecisionTransport((input, init) => fetch(input, init), decisionUrl(runtime.planner.broker.cloudDecider)),
    nowMs: () => performance.now(),
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
    onStep: step => runtime.planner.receive(step),
  });
}

/** Step ticks as they fall due, yielding every SLICE_MS; idle-poll when nothing advances. */
async function loop(current: Run): Promise<void> {
  const { runtime } = current;
  while (run === current && current.generation === generation) {
    const sliceStart = performance.now();
    let advanced = false;
    if (runtime.currentSpeed !== current.pace.speed || !runtime.advancing) current.pace = { wallMs: sliceStart, tick: runtime.world.tick, speed: runtime.currentSpeed };
    while (performance.now() - sliceStart < SLICE_MS) {
      const owed = Math.floor(((performance.now() - current.pace.wallMs) / 1000) * current.pace.speed * 100) - (runtime.world.tick - current.pace.tick);
      if (owed <= 0 && runtime.advancing) break;
      const result = await runtime.step();
      if (run !== current) return;
      if (!result.advanced) break;
      advanced = true;
      current.ratio.mark(performance.now(), runtime.world.tick / 100);
      if (result.ended) break;
    }
    runtime.simToWallRatio = current.ratio.ratio();
    flush(current, false);
    await delay(advanced ? 0 : runtime.advancing ? 1 : IDLE_MS);
  }
}

function flush(current: Run, forceView: boolean): void {
  const { runtime } = current;
  for (const message of runtime.drainErrors()) post({ type: "error", runId: runtime.runId, message });
  const events = runtime.eventsSince(current.lastSeq);
  if (events.length > 0) {
    current.lastSeq = events[events.length - 1].seq;
    post({ type: "events", runId: runtime.runId, events });
  }
  const now = performance.now();
  if (forceView || now - current.lastViewMs >= 1000 / VIEW_HZ) {
    current.lastViewMs = now;
    post({ type: "view", runId: runtime.runId, view: runtime.view(), render: runtime.render() });
  }
  const outcome = runtime.outcome();
  if (outcome !== null && !current.outcomePosted) {
    current.outcomePosted = true;
    post({ type: "view", runId: runtime.runId, view: runtime.view(), render: runtime.render() });
    post({ type: "outcome", runId: runtime.runId, result: outcome });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function handle(command: UiCommand): void {
  switch (command.type) {
    case "start_run":
      starting = (starting ?? Promise.resolve()).then(() => startRun(command.config));
      return;
    case "reset":
      teardown();
      return;
    case "camera_frame":
      run?.camera.deliver(command);
      return;
    case "export_run": {
      if (run === null || run.runtime.runId !== command.runId) {
        post({ type: "error", runId: command.runId, message: `Run ${command.runId} is not the current run; nothing to export.` });
        return;
      }
      post({ type: "export", runId: command.runId, files: run.runtime.exportRun(run.metaSha256) });
      return;
    }
    default:
      if (run === null) {
        post({ type: "error", runId: null, message: `No run is active; "${command.type}" was not applied.` });
        return;
      }
      run.runtime.command(command);
      if (command.type === "resume" || command.type === "report" || command.type === "authorize_mission") flush(run, true);
  }
}

// Views keep flowing (throttled to VIEW_HZ) while the loop waits on a camera frame or the decider.
const viewTimer: unknown = setInterval(() => {
  if (run !== null) flush(run, false);
}, Math.ceil(1000 / VIEW_HZ));
// Node (tests) only: do not keep the process alive for this timer.
(viewTimer as { unref?: () => void }).unref?.();

scope.onmessage = event => handle(event.data);
post({ type: "ready", protocol: MISSION_PROTOCOL });
