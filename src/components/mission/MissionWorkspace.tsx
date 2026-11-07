"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { AtlasSaveNote } from "@/components/results/AtlasSaveNote";
import { TwinView } from "@/components/twin/TwinView";
import { useAtlasAutoSave } from "@/hooks/useAtlasAutoSave";
import { useCommanderConsole } from "@/hooks/useCommanderConsole";
import { useFoldTop } from "@/hooks/useFoldTop";
import { useMissionWorker } from "@/hooks/useMissionWorker";
import type { TwinRenderer } from "@/lib/render/twin-renderer";
import { ActionCard } from "./ActionCard";
import { CommanderConsole } from "./console/CommanderConsole";
import { ExperimentControls } from "./ExperimentControls";
import { FlyReflexPanel } from "./FlyReflexPanel";
import { ContingencyBanner, ExportLinks, Notices, StatusStrip } from "./MissionStatus";
import { MissionTimeline } from "./MissionTimeline";
import { PhaseRail } from "./PhaseRail";
import { derivePhaseRail } from "./phases";
import { PresenterBar } from "./PresenterBar";
import { QaDrawer } from "./QaDrawer";
import { ReportIntake } from "./ReportIntake";
import { Outcome, RescueRecord } from "./RescueRecord";
import { AbortButton, DEFAULT_CONFIG, RunControls } from "./RunControls";
import { uiScenario } from "./scenarios";
import { ThermalView } from "./ThermalView";
import { useCommanderKeys } from "./useCommanderKeys";
import { useGuidanceVoice } from "./useGuidanceVoice";
import { WordmarkContent } from "./Wordmark";

const DEFAULT_SCENE_URL = "/scenes/troy-training/";

function SourceBanner({ source, reason }: { readonly source: string; readonly reason: string | null }) {
  if (source !== "fixture") return null;
  return <div className="fixture-banner" role="status">
    <strong>UI fixture — not a simulation run</strong>
    <span>{reason ?? "The mission worker is unavailable."} Panels show hand-authored states so the interface can be checked; no simulator, planner, harness, controller or evaluator is running.</span>
  </div>;
}

/** The mission workspace: where the drone is going, what it wants to do, and whether the occupant has reached the exit. */
export function MissionWorkspace() {
  const mission = useMissionWorker();
  const { state, send } = mission;
  const view = state.view;
  const [twin, setTwin] = useState<TwinRenderer | null>(null);
  const [presenter, setPresenter] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const aircraftId = state.config?.aircraftId ?? DEFAULT_CONFIG.aircraftId;
  // Presentation reading aids: derived from the truth-free view and this run's evaluator outcome only.
  const rail = useMemo(() => derivePhaseRail({ view, outcome: state.outcome }), [view, state.outcome]);
  const commanderId = state.config?.commanderId ?? DEFAULT_CONFIG.commanderId;
  const { abortPrimed } = useCommanderKeys({ state, send, commanderId });
  // Free-WiLi console: an input device for the same commander; its gestures become the action card's commands.
  const commanderConsole = useCommanderConsole({ state, send, commanderId, rail: view === null ? null : rail });
  const voice = useGuidanceVoice(view, voiceOn);
  const awaitingReport = view?.status === "awaiting_report";
  // A finished simulation run is saved to MongoDB Atlas when persistence is configured (never a UI fixture).
  const atlasSave = useAtlasAutoSave(state, send);
  // Projector stage: the 3D view fills the viewport below the head, rail and status strip (globals.css).
  const workspaceRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  useFoldTop(workspaceRef, gridRef, presenter);

  return <div ref={workspaceRef} className="workspace" data-source={state.source} data-presenter={presenter}>
    {/* Sticky: Abort, the simulation labels and pacing, the fixture banner and any contingency stay visible while the page scrolls. */}
    <div className="sticky-head">
      <header className="topbar">
        <h1 className="wordmark"><WordmarkContent /></h1>
        <span className="masthead-label">Mission console</span>
        <div className="masthead-actions">
          <nav className="site-nav" aria-label="Pages">
            <Link href="/results">Results</Link>
            <Link href="/about">About</Link>
          </nav>
          <button type="button" className="stage-toggle" aria-pressed={presenter} aria-controls="mission-stage" onClick={() => setPresenter(!presenter)}>Presenter view</button>
          <span className="abort-hint warn small" role="status">{abortPrimed ? "Press Esc again to abort" : ""}</span>
          <AbortButton state={state} send={send} />
        </div>
      </header>
      <div className="run-toolbar"><RunControls state={state} send={send} /></div>
      <PresenterBar state={state} send={send} onOpenQa={() => setQaOpen(true)} voice={voice} onVoiceChange={setVoiceOn} />
      <SourceBanner source={state.source} reason={state.fixtureReason} />
      <ContingencyBanner view={view} />
    </div>
    <Notices notices={state.notices} dismiss={mission.dismissNotice} />
    <ExportLinks exportFiles={state.exportFiles} />
    <AtlasSaveNote note={atlasSave} />
    <PhaseRail state={rail} size={presenter ? "stage" : "compact"} className="mission-rail" />
    <StatusStrip view={view} source={state.source} />
    <main id="mission-stage" ref={gridRef} className="mission-grid">
      <TwinView renderStore={mission.renderStore} setFrameRenderer={mission.setFrameRenderer} sceneBaseUrl={state.scene?.baseUrl ?? DEFAULT_SCENE_URL} aircraftId={aircraftId} view={view} onRenderer={setTwin} phase={rail.current} halt={rail.halt} />
      <aside className="decision-column" aria-label="Command and sensors">
        <ActionCard view={view} send={send} />
        {state.runId !== null && <details className="panel report-panel" open={awaitingReport}>
          <summary>Incident report</summary>
          <ReportIntake runId={state.runId} send={send} example={uiScenario(state.config?.scenarioId).exampleReport} />
        </details>}
        {presenter && <section className="panel presenter-outcome" aria-label="Outcome (presenter copy)">
          <Outcome outcome={state.outcome} source={state.source} live={false} />
        </section>}
        <FlyReflexPanel view={view} frames={mission.frames} />
        <ThermalView renderer={twin} aircraftId={aircraftId} />
        <CommanderConsole state={commanderConsole} />
      </aside>
      <div className="record-row">
        <RescueRecord view={view} outcome={state.outcome} source={state.source} />
        <MissionTimeline events={state.events} />
        <section className="panel inputs" aria-label="Experiments">
          <ExperimentControls view={view} send={send} />
        </section>
      </div>
    </main>
    <QaDrawer open={qaOpen} onClose={() => setQaOpen(false)} />
  </div>;
}
