"use client";

import { useEffect, useRef, useState } from "react";
import type { FrameRenderer } from "@/hooks/useMissionWorker";
import type { RenderSnapshotStore } from "@/hooks/mission-stores";
import type { StaticView } from "@/lib/render/scene-assets";
import type { TwinStatus } from "@/lib/render/twin-renderer";
import { TwinRenderer } from "@/lib/render/twin-renderer";
import type { CameraMode } from "@/lib/render/view-cameras";
import type { MissionView } from "@/lib/mission/protocol";
import type { MissionPhaseId, PhaseHalt } from "@/components/mission/phases";
import type { DirectorOutput, DirectorState } from "./director";
import { chooseManual, directorInput, directorOutput, enableAuto, initialDirector, stepDirector } from "./director";

interface Props {
  readonly renderStore: RenderSnapshotStore;
  readonly setFrameRenderer: (renderer: FrameRenderer | null) => void;
  readonly sceneBaseUrl: string;
  readonly aircraftId: string;
  /** Truth-free command state, drawn as overlays (affected region, estimated pose, routes). */
  readonly view: MissionView | null;
  /** Receives the renderer after construction (null on teardown), e.g. to add the thermal pass. */
  readonly onRenderer?: (renderer: TwinRenderer | null) => void;
  /**
   * Derived mission phase (phases.ts). When given, the toolbar offers Auto: the camera director frames each
   * phase and pending intervention from the truth-free view. Without it (replay) the camera is manual only.
   */
  readonly phase?: MissionPhaseId;
  readonly halt?: PhaseHalt | null;
}

/** How often Auto re-evaluates; its cuts depend on wall-clock dwell, not only on view updates. */
const DIRECTOR_TICK_MS = 250;

const MODES: readonly { readonly value: CameraMode; readonly label: string }[] = [
  { value: "exterior", label: "Exterior" },
  { value: "follow", label: "Follow drone" },
  { value: "cutaway", label: "Cutaway" },
];

function assetLine(status: TwinStatus | null, view: StaticView): string {
  if (status === null) return "Starting the 3D view";
  if (status.meta === "loading") return "Loading scene metadata";
  if (status.meta !== "loaded") return `Scene metadata unavailable (${status.message ?? status.meta}); nothing to draw`;
  if (view === "colliders") return "Collider view: boxes from scene.meta.json";
  if (status.glb === "loaded") return "Blender export (scene.glb)";
  if (status.glb === "loading") return "Collider view while scene.glb loads";
  return `Collider view: scene.glb ${status.glb === "missing" ? "not exported yet" : "failed to load"}`;
}

const INITIAL_DIRECTOR = initialDirector(0);

function sameShot(a: DirectorOutput, b: DirectorOutput): boolean {
  return a.key === b.key && a.mode === b.mode && a.reason === b.reason && a.auto === b.auto;
}

export function TwinView({ renderStore, setFrameRenderer, sceneBaseUrl, aircraftId, view, onRenderer, phase, halt = null }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<TwinRenderer | null>(null);
  const [mode, setMode] = useState<CameraMode>("exterior");
  const [staticView, setStaticView] = useState<StaticView>("scene");
  const [preview, setPreview] = useState(true);
  const [status, setStatus] = useState<TwinStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const aircraftRef = useRef(aircraftId);
  const onRendererRef = useRef(onRenderer);
  useEffect(() => { onRendererRef.current = onRenderer; }, [onRenderer]);
  const directed = phase !== undefined;
  const directorRef = useRef<DirectorState>(INITIAL_DIRECTOR);
  const directorInputs = useRef({ view, phase: phase ?? "report", halt });
  useEffect(() => { directorInputs.current = { view, phase: phase ?? "report", halt }; }, [view, phase, halt]);
  const [shot, setShot] = useState<DirectorOutput>(() => directorOutput(INITIAL_DIRECTOR));
  const applyShot = (next: DirectorState) => {
    directorRef.current = next;
    const out = directorOutput(next);
    // Focus first: ViewCameras keeps it and the mode change then frames it.
    rendererRef.current?.setCameraFocus(out.focus);
    rendererRef.current?.setMode(out.mode);
    setMode(out.mode);
    setShot(previous => sameShot(previous, out) ? previous : out);
  };
  const currentInput = () => {
    const { view: v, phase: p, halt: h } = directorInputs.current;
    return directorInput(v, p, h, performance.now());
  };

  useEffect(() => {
    const container = containerRef.current;
    const labels = labelsRef.current;
    if (container === null || labels === null) return;
    let renderer: TwinRenderer;
    try {
      renderer = new TwinRenderer(
        { container, labels, previewFrame: previewRef.current, previewClock: clockRef.current },
        { reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches, aircraftId: aircraftRef.current, onStatus: setStatus },
      );
    } catch (error) {
      queueMicrotask(() => setFailure(error instanceof Error ? error.message : String(error)));
      return;
    }
    rendererRef.current = renderer;
    renderer.setSnapshotSource(() => renderStore.get());
    renderer.load(sceneBaseUrl);
    setFrameRenderer(request => renderer.captureFrame(request));
    onRendererRef.current?.(renderer);
    return () => {
      onRendererRef.current?.(null);
      setFrameRenderer(null);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [renderStore, setFrameRenderer, sceneBaseUrl]);

  useEffect(() => {
    aircraftRef.current = aircraftId;
    try {
      rendererRef.current?.setAircraft(aircraftId);
    } catch (error) {
      queueMicrotask(() => setFailure(error instanceof Error ? error.message : String(error)));
    }
  }, [aircraftId]);

  useEffect(() => rendererRef.current?.setMissionView(view), [view]);
  useEffect(() => rendererRef.current?.setMode(mode), [mode]);
  useEffect(() => rendererRef.current?.setStaticView(staticView), [staticView]);
  useEffect(() => {
    if (!directed) return;
    const timer = setInterval(() => {
      const next = stepDirector(directorRef.current, currentInput());
      if (next !== directorRef.current) applyShot(next);
    }, DIRECTOR_TICK_MS);
    return () => clearInterval(timer);
  }, [directed]);
  const pickMode = (next: CameraMode) => {
    if (directed) applyShot(chooseManual(directorRef.current, next, performance.now()));
    else setMode(next);
  };
  const auto = directed && shot.auto;
  useEffect(() => rendererRef.current?.setPreviewVisible(preview), [preview]);

  return <section className="twin" aria-label="Simulation view">
    <div className="twin-stage" ref={containerRef}>
      <div className="twin-labels" ref={labelsRef} aria-hidden="true" />
      <div className="twin-provenance">
        <p className="twin-location">Troy training scene</p>
        <p className="twin-view-kind">Simulation overview · ground truth</p>
      </div>
      <div className="twin-preview" ref={previewRef}>
        <span title={status?.calibrationId ?? "rgb-front/v1"}>Drone camera <span className="muted">· true pose</span></span>
        <span ref={clockRef} className="twin-preview-clock" />
      </div>
      {failure !== null && <p className="twin-failure" role="alert">3D view unavailable: {failure}. The drone camera cannot answer render requests.</p>}
    </div>
    <div className="twin-toolbar">
      <div className="segmented" role="radiogroup" aria-label="Camera">
        {directed && <button type="button" role="radio" aria-checked={auto} title="Camera director: frames each mission phase and any intervention awaiting approval, from the command view only" onClick={() => applyShot(enableAuto(directorRef.current, currentInput()))}>Auto</button>}
        {MODES.map(m => <button key={m.value} type="button" role="radio" aria-checked={!auto && mode === m.value} onClick={() => pickMode(m.value)}>{m.label}</button>)}
      </div>
      {directed && <span className="muted small twin-shot">{shot.reason}</span>}
      <label className="check"><input type="checkbox" checked={staticView === "colliders"} onChange={e => setStaticView(e.target.checked ? "colliders" : "scene")} />Collider view</label>
      <label className="check"><input type="checkbox" checked={preview} onChange={e => setPreview(e.target.checked)} />Drone camera</label>
      <span className="twin-assets">{assetLine(status, staticView)}{status !== null && <span className="muted">, drone-camera textures {status.textureSetVersion}</span>}</span>
      {status?.context === "lost" && <span className="warn">WebGL context lost; waiting for the browser to restore it</span>}
    </div>
  </section>;
}
