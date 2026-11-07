"use client";

import { useState } from "react";
import type { ControllerMode, DeciderMode, MissionStatus, RunConfig, UiCommand } from "@/lib/mission/protocol";
import type { MissionUiState } from "@/hooks/useMissionWorker";
import { abortMissionCommand } from "./approval";
import { formatClock } from "./format";
import { DEFAULT_SCENARIO, UI_SCENARIOS, uiScenario } from "./scenarios";

export const DEFAULT_CONFIG: RunConfig = {
  scenarioId: DEFAULT_SCENARIO.id,
  seed: "demo-001",
  aircraftId: "tender-t1",
  controller: "engineered_readout",
  decider: "local",
  commanderId: "commander-1",
  speed: 1,
};

const CONTROLLERS: readonly { readonly value: ControllerMode; readonly label: string }[] = [
  { value: "engineered_readout", label: "FlyVis + engineered readout" },
  { value: "trained_readout", label: "FlyVis + trained readout" },
  { value: "flow_baseline", label: "Optical-flow baseline" },
];

const DECIDERS: readonly { readonly value: DeciderMode; readonly label: string }[] = [
  { value: "local", label: "Local planner" },
  { value: "decisions", label: "OpenAI Decisions (local fallback)" },
  { value: "gemini", label: "Gemini (local fallback)" },
  { value: "consensus", label: "Consensus: OpenAI + Gemini must agree (local fallback)" },
];

const SPEEDS = [0.25, 0.5, 1, 2, 4];

const STATUS_TEXT: Readonly<Record<MissionStatus, string>> = {
  awaiting_report: "Waiting for a report",
  awaiting_authorization: "Waiting for mission authorization",
  running: "Running",
  paused: "Paused",
  aborted: "Aborted",
  ended: "Ended",
};

interface Props {
  readonly state: MissionUiState;
  readonly send: (command: UiCommand) => void;
}

function RunSetup({ config, onChange }: { readonly config: RunConfig; readonly onChange: (config: RunConfig) => void }) {
  return <>
    <label>Scenario
      <select value={config.scenarioId} onChange={e => onChange({ ...config, scenarioId: e.target.value })}>
        {UI_SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </label>
    <label>Controller
      <select value={config.controller} onChange={e => onChange({ ...config, controller: e.target.value as ControllerMode })}>
        {CONTROLLERS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </label>
    <label>Mission planner
      <select value={config.decider} onChange={e => onChange({ ...config, decider: e.target.value as DeciderMode })}>
        {DECIDERS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
      </select>
    </label>
    <label>Seed
      <input value={config.seed} onChange={e => onChange({ ...config, seed: e.target.value })} size={9} spellCheck={false} />
    </label>
  </>;
}

function ActiveRun({ state, send, onNewRun }: Props & { readonly onNewRun: () => void }) {
  const { view } = state;
  const runId = state.runId ?? "";
  const config = state.config ?? DEFAULT_CONFIG;
  const status = view?.status ?? null;
  return <>
    <div className="run-identity">
      <span className="run-status" data-status={status ?? "starting"}>{status === null ? "Starting" : STATUS_TEXT[status]}</span>
      {/* The visible line also carries the ticking clock, so status changes are announced from a separate region. */}
      <span className="sr-only" role="status">{status === null ? "Starting the run" : `Mission ${STATUS_TEXT[status].toLowerCase()}`}</span>
      <span className="run-clock" title="Mission clock (simulated time)">{view === null ? "—" : formatClock(view.tick)}</span>
      <span className="run-id" title={`Run ${runId}, ${uiScenario(config.scenarioId).label}, seed ${config.seed}`}>Run {runId.slice(-6)}</span>
    </div>
    {status === "awaiting_authorization" && <button type="button" className="primary" onClick={() => send({ type: "authorize_mission", runId, commanderId: config.commanderId })}>Authorize mission</button>}
    {status === "running" && <button type="button" onClick={() => send({ type: "pause", runId })}>Pause</button>}
    {status === "paused" && <button type="button" onClick={() => send({ type: "resume", runId })}>Resume</button>}
    <label className="speed">Sim speed
      <select value={config.speed} onChange={e => send({ type: "set_speed", runId, speed: Number(e.target.value) })} title="Simulated seconds per wall second; physics keeps its fixed step">
        {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
      </select>
    </label>
    <button type="button" onClick={onNewRun} title="End this run and start a new run with a new run id and the settings below; old approvals are invalid">Reset as new run</button>
    <button type="button" onClick={() => send({ type: "export_run", runId })}>Export run</button>
  </>;
}

export function RunControls({ state, send }: Props) {
  // Settings for the next run: they follow the current run until the operator edits them.
  const [draft, setDraft] = useState<RunConfig | null>(null);
  const settings = draft ?? state.config ?? DEFAULT_CONFIG;
  // While the worker is still settling, a start command could be lost if it then fails over to the fixture.
  const ready = state.source !== "starting";
  const startWith = () => {
    send({ type: "start_run", config: { ...settings, seed: settings.seed.trim() || DEFAULT_CONFIG.seed } });
    setDraft(null);
  };
  const newRun = () => {
    send({ type: "reset" });
    startWith();
  };

  if (state.runId === null) {
    return <div className="run-controls" role="group" aria-label="Run setup">
      <RunSetup config={settings} onChange={setDraft} />
      <button type="button" className="primary" onClick={startWith} disabled={!ready}>Start run</button>
    </div>;
  }
  return <div className="run-controls" role="group" aria-label="Run controls">
    <ActiveRun state={state} send={send} onNewRun={newRun} />
    <details className="next-run">
      <summary>Next run settings</summary>
      <div className="next-run-body"><RunSetup config={settings} onChange={setDraft} /></div>
    </details>
  </div>;
}

export function AbortButton({ state, send }: Props) {
  const { runId, view } = state;
  const commanderId = state.config?.commanderId ?? DEFAULT_CONFIG.commanderId;
  const disabled = runId === null;
  return <button
    type="button"
    className="abort"
    aria-label="Abort mission"
    disabled={disabled}
    title={disabled ? "No run to abort" : "Stop remaining actuation now and select a supported contingency (keyboard: Esc twice)"}
    onClick={() => runId !== null && send(abortMissionCommand(runId, commanderId, view?.tick ?? 0))}
  >Abort</button>;
}
