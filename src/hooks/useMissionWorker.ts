/**
 * Connects the command UI to the mission worker over the "flyfirefighter.mission/1" protocol.
 *
 * The worker lives at src/workers/mission.worker.ts. If it cannot be constructed or fails to load before
 * it has sent anything, the hook switches to the in-page UI fixture driver and reports
 * `source: "fixture"` with the reason; the UI must then show "UI fixture — not a simulation run".
 *
 * Messages for another run are discarded. MissionView updates are committed to React at most every
 * 100 ms; RenderSnapshots go to a store the 3D view reads each animation frame. Each render_request is
 * answered synchronously by the registered frame renderer (the drone camera), and the luminance frame
 * that is posted back is also copied into the SentFrameStore for the fly reflex panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionPort } from "@/components/mission/fixture-driver";
import { FixtureDriver } from "@/components/mission/fixture-driver";
import type { MissionEvent } from "@/lib/contracts/events";
import type { RunId } from "@/lib/contracts/ids";
import type { MissionResult } from "@/lib/contracts/outcomes";
import type { CameraFrameMessage, MissionView, RenderRequest, RunConfig, UiCommand, WorkerMessage } from "@/lib/mission/protocol";
import { RenderSnapshotStore, SentFrameStore } from "./mission-stores";

export type MissionSource = "starting" | "worker" | "fixture";

export interface MissionNotice {
  readonly id: number;
  readonly runId: RunId | null;
  readonly origin: "worker" | "ui";
  readonly message: string;
}

export interface MissionUiState {
  readonly source: MissionSource;
  readonly fixtureReason: string | null;
  readonly runId: RunId | null;
  readonly config: RunConfig | null;
  readonly scene: { readonly sceneId: string; readonly revision: number; readonly baseUrl: string } | null;
  readonly view: MissionView | null;
  readonly events: readonly MissionEvent[];
  readonly outcome: MissionResult | null;
  readonly exportFiles: { readonly runId: RunId; readonly files: { readonly [name: string]: string } } | null;
  readonly notices: readonly MissionNotice[];
}

export type FrameRenderer = (request: RenderRequest) => { readonly frame: CameraFrameMessage; readonly renderMs: number };

export interface MissionConnection {
  readonly state: MissionUiState;
  readonly send: (command: UiCommand) => void;
  readonly renderStore: RenderSnapshotStore;
  readonly frames: SentFrameStore;
  readonly setFrameRenderer: (renderer: FrameRenderer | null) => void;
  readonly dismissNotice: (id: number) => void;
}

const INITIAL: MissionUiState = { source: "starting", fixtureReason: null, runId: null, config: null, scene: null, view: null, events: [], outcome: null, exportFiles: null, notices: [] };
const COMMIT_MS = 100;
const WORKER_SETTLE_MS = 1500;
const MAX_NOTICES = 6;

function describeWorkerError(event: Event): string {
  const message = event instanceof ErrorEvent && event.message ? event.message : "the script could not be loaded";
  return `The mission worker (src/workers/mission.worker.ts) failed before sending any message: ${message}.`;
}

export function useMissionWorker(): MissionConnection {
  const [state, setState] = useState<MissionUiState>(INITIAL);
  const [renderStore] = useState(() => new RenderSnapshotStore());
  const [frames] = useState(() => new SentFrameStore());
  const stateRef = useRef<MissionUiState>(INITIAL);
  const portRef = useRef<MissionPort | null>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeSeq = useRef(0);
  const cameraNoticeRun = useRef<RunId | null>(null);

  const commitSoon = useCallback((immediate = false) => {
    const flush = () => {
      commitTimer.current = null;
      setState(stateRef.current);
    };
    if (immediate) {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
      flush();
    } else if (commitTimer.current === null) {
      commitTimer.current = setTimeout(flush, COMMIT_MS);
    }
  }, []);

  const patch = useCallback((next: Partial<MissionUiState>, immediate = false) => {
    stateRef.current = { ...stateRef.current, ...next };
    commitSoon(immediate);
  }, [commitSoon]);

  const notify = useCallback((runId: RunId | null, origin: MissionNotice["origin"], message: string) => {
    noticeSeq.current += 1;
    const notices = [...stateRef.current.notices, { id: noticeSeq.current, runId, origin, message }].slice(-MAX_NOTICES);
    patch({ notices }, true);
  }, [patch]);

  const answerRenderRequest = useCallback((request: RenderRequest) => {
    const renderer = rendererRef.current;
    if (renderer === null) {
      if (cameraNoticeRun.current !== request.runId) {
        cameraNoticeRun.current = request.runId;
        notify(request.runId, "ui", "The drone camera is not ready (the 3D view has not started), so render requests are not being answered.");
      }
      return;
    }
    try {
      const { frame, renderMs } = renderer(request);
      frames.record({ runId: frame.runId, frameId: frame.frameId, tick: frame.tick, calibrationId: frame.calibrationId, width: frame.width, height: frame.height, renderMs }, frame.luminance);
      portRef.current?.post(frame, [frame.luminance.buffer]);
    } catch (error) {
      if (cameraNoticeRun.current !== request.runId) {
        cameraNoticeRun.current = request.runId;
        notify(request.runId, "ui", `The drone camera could not render frame ${request.frameId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [frames, notify]);

  const handleMessage = useCallback((message: WorkerMessage) => {
    const current = stateRef.current.runId;
    if (message.type === "run_started") {
      renderStore.set(null);
      frames.clear();
      cameraNoticeRun.current = null;
      patch({ runId: message.runId, config: message.config, scene: message.scene, view: null, events: [], outcome: null, exportFiles: null }, true);
      return;
    }
    if (message.type === "error") {
      if (message.runId === null || message.runId === current) notify(message.runId, "worker", message.message);
      return;
    }
    if (message.type === "ready") return; // Startup handshake: the worker is live (onmessage already recorded that).
    if (message.runId !== current) return; // Another (old or future) run: discard.
    switch (message.type) {
      case "view":
        renderStore.set(message.render);
        patch({ view: message.view, config: message.view.config });
        return;
      case "render_request":
        answerRenderRequest(message);
        return;
      case "events": {
        const known = new Set(stateRef.current.events.map(e => e.seq));
        const fresh = message.events.filter(e => !known.has(e.seq));
        if (fresh.length > 0) patch({ events: [...stateRef.current.events, ...fresh] });
        return;
      }
      case "outcome":
        patch({ outcome: message.result }, true);
        return;
      case "export":
        patch({ exportFiles: { runId: message.runId, files: message.files } }, true);
        return;
    }
  }, [answerRenderRequest, frames, notify, patch, renderStore]);

  useEffect(() => {
    let disposed = false;
    let received = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const deliver = (message: WorkerMessage) => {
      if (!disposed) handleMessage(message);
    };
    // Each mount owns its port: under React StrictMode the first mount's driver is terminated on cleanup.
    const switchToFixture = (reason: string) => {
      if (disposed) return;
      portRef.current?.terminate();
      portRef.current = new FixtureDriver(deliver);
      patch({ ...INITIAL, source: "fixture", fixtureReason: reason, notices: stateRef.current.notices }, true);
    };
    try {
      const worker = new Worker(/* turbopackOptional: true */ new URL("../workers/mission.worker.ts", import.meta.url), { type: "module", name: "flyfirefighter-mission" });
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        if (!received) patch({ source: "worker" });
        received = true;
        deliver(event.data);
      };
      worker.onerror = (event: Event) => {
        event.preventDefault();
        if (!received && stateRef.current.runId === null) switchToFixture(describeWorkerError(event));
        else notify(stateRef.current.runId, "ui", `Mission worker error: ${event instanceof ErrorEvent ? event.message : "unknown error"}`);
      };
      worker.onmessageerror = () => notify(stateRef.current.runId, "ui", "A mission worker message could not be decoded and was dropped.");
      portRef.current = { post: (command, transfer) => worker.postMessage(command, transfer ?? []), terminate: () => worker.terminate() };
      settleTimer = setTimeout(() => {
        if (!disposed && stateRef.current.source === "starting") patch({ source: "worker" }, true);
      }, WORKER_SETTLE_MS);
    } catch (error) {
      switchToFixture(`The mission worker could not be constructed: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return () => {
      disposed = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
      portRef.current?.terminate();
      portRef.current = null;
    };
  }, [handleMessage, notify, patch]);

  const send = useCallback((command: UiCommand) => {
    if (command.type === "reset") {
      // Old-run messages still in flight are discarded until the next run_started.
      renderStore.set(null);
      frames.clear();
      patch({ runId: null, view: null, events: [], outcome: null, exportFiles: null }, true);
    }
    portRef.current?.post(command);
  }, [frames, patch, renderStore]);

  const setFrameRenderer = useCallback((renderer: FrameRenderer | null) => {
    rendererRef.current = renderer;
  }, []);

  const dismissNotice = useCallback((id: number) => {
    patch({ notices: stateRef.current.notices.filter(n => n.id !== id) }, true);
  }, [patch]);

  return { state, send, renderStore, frames, setFrameRenderer, dismissNotice };
}
