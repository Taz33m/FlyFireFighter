"use client";

import Link from "next/link";
import { useState } from "react";
import type { MissionUiState } from "@/hooks/useMissionWorker";
import type { FloorPlanPrior } from "@/lib/contracts/evidence";
import type { RunId } from "@/lib/contracts/ids";
import type { UiCommand } from "@/lib/mission/protocol";
import { formatClock, formatVec, roomName, statusWord } from "./format";
import type { GuidanceVoiceStatus } from "./guidance-voice";
import type { ChallengeTarget } from "./presenter";
import { LOCALIZATION_LOSS_SIGMA_M, challengeTarget, pacingLabel } from "./presenter";

export const SCENE_LABEL = "Troy training scene — real exterior reference; fictional interior and incident";
export const VOICE_DISCLOSURE = "Simulated drone guidance, spoken by this computer's built-in voice (local; network voices are never used).";

interface Props {
  readonly state: MissionUiState;
  readonly send: (command: UiCommand) => void;
  readonly onOpenQa: () => void;
  readonly voice: GuidanceVoiceStatus;
  readonly onVoiceChange: (enabled: boolean) => void;
}

/** Fallback when a live stage stalls: leaves this run (its worker stops) for the labelled recorded replay. */
export const REPLAY_TITLE = "Cut to the saved replay: leaves this live run and plays a labelled recording (no simulator, planner, harness or cloud call runs).";

const FIXTURE_NOTE = " UI fixture: no sensors, planner or harness will respond.";

/** Persistent badge: simulated vs wall time. Not a live region; it changes every second. */
export function PacingBadge({ state }: { readonly state: MissionUiState }) {
  const label = pacingLabel({ source: state.source, status: state.view?.status ?? null, setSpeed: state.config?.speed ?? null, ratio: state.view?.simToWallRatio ?? null });
  return <span className="pacing-badge" data-tone={label.tone} title={label.detail}>
    <span aria-hidden="true" className="pacing-dot" />
    {label.text}
    <span className="sr-only">. {label.detail}</span>
  </span>;
}

type Feedback = { readonly runId: RunId | null; readonly text: string } | null;
type ShowFeedback = (feedback: Feedback) => void;

function challengeHintText(target: ChallengeTarget | null, alreadySent: boolean, prior: FloorPlanPrior | undefined): string {
  if (target === null) return "Start a run first.";
  if (!target.available) return target.reason;
  if (alreadySent) return `A person was already placed for ${target.proposalId}.`;
  return `Places a simulated person in ${roomName(prior, target.roomId)}, inside the affected region of ${target.proposalId} (${statusWord(target.proposalStatus).toLowerCase()}). Command learns of them only through its sensors.`;
}

/** Judge challenge: the ordinary add_occupant experiment at a point inside the spray's harness-derived region. */
function JudgeChallenge({ state, send, show }: { readonly state: MissionUiState; readonly send: Props["send"]; readonly show: ShowFeedback }) {
  const view = state.view;
  // Per-run memory of challenged proposals, so one press places one person.
  const [challenged, setChallenged] = useState<{ readonly runId: RunId | null; readonly ids: readonly string[] }>({ runId: null, ids: [] });
  const challengedIds = challenged.runId === state.runId ? challenged.ids : [];
  const target = view === null ? null : challengeTarget(view);
  const alreadySent = target !== null && target.available && challengedIds.includes(target.proposalId);
  const prior = view?.belief.mapPrior;
  const hint = challengeHintText(target, alreadySent, prior);
  const run = () => {
    if (view === null || target === null || !target.available || alreadySent) {
      show({ runId: state.runId, text: `Judge challenge not available: ${hint}` });
      return;
    }
    send({ type: "experiment", runId: view.runId, experiment: { kind: "add_occupant", position: target.position } });
    setChallenged({ runId: view.runId, ids: [...challengedIds, target.proposalId] });
    show({
      runId: view.runId,
      text: `Judge challenge at ${formatClock(view.tick)}: a simulated person stepped into ${roomName(prior, target.roomId)} at ${formatVec(target.position)}, inside the spray region of ${target.proposalId} while it was ${statusWord(target.proposalStatus).toLowerCase()}. The harness is not told; it must find them through normal sensing and refuse or stop the spray. Watch the action card and timeline.${state.source === "fixture" ? FIXTURE_NOTE : ""}`,
    });
  };
  const ready = target !== null && target.available && !alreadySent;
  return <>
    <button type="button" className="challenge" aria-disabled={!ready} aria-describedby="challenge-hint" title={hint} onClick={run}>{alreadySent ? "Challenge sent" : "Judge challenge"}</button>
    <span id="challenge-hint" className="sr-only">{hint}</span>
  </>;
}

/** Localization-loss preset: the ordinary degrade_localization experiment with the evaluation's loss size. */
function LocalizationLoss({ state, send, show }: { readonly state: MissionUiState; readonly send: Props["send"]; readonly show: ShowFeedback }) {
  const view = state.view;
  const live = view !== null && view.status !== "aborted" && view.status !== "ended";
  const run = () => {
    if (view === null || !live) return;
    send({ type: "experiment", runId: view.runId, experiment: { kind: "degrade_localization", sigmaIncreaseM: LOCALIZATION_LOSS_SIGMA_M } });
    show({
      runId: view.runId,
      text: `Localization loss at ${formatClock(view.tick)}: position uncertainty increased by ${LOCALIZATION_LOSS_SIGMA_M} m in the simulator. Without a supported position estimate the drone must stop advancing the mission and select a supported contingency; if none exists, the run fails. Watch the position estimate and the contingency banner.${state.source === "fixture" ? FIXTURE_NOTE : ""}`,
    });
  };
  return <button type="button" disabled={!live} onClick={run} title={`Preset: adds ${LOCALIZATION_LOSS_SIGMA_M} m to the simulated localization error`}>Localization loss</button>;
}

/** Guidance-voice toggle: off by default; says which local voice speaks, or why it is silent. */
function VoiceToggle({ voice, onChange }: { readonly voice: GuidanceVoiceStatus; readonly onChange: (enabled: boolean) => void }) {
  const detail = voice.enabled ? (voice.voiceLabel === null ? voice.reason : `${voice.voiceLabel}. ${voice.reason}`) : "Off";
  return <button type="button" className="presenter-toggle" aria-pressed={voice.enabled} aria-describedby="voice-detail" title={`${VOICE_DISCLOSURE} ${detail}`} onClick={() => onChange(!voice.enabled)}>
    Guidance voice
    <span id="voice-detail" className="sr-only">{VOICE_DISCLOSURE} {detail}</span>
  </button>;
}

/**
 * Scene provenance, simulation pacing and tools for the live demo.
 */
export function PresenterBar({ state, send, onOpenQa, voice, onVoiceChange }: Props) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const shownFeedback = feedback !== null && feedback.runId === state.runId ? feedback.text : null;
  return <div className="presenter-bar">
    <div className="presenter-row">
      <ul className="scene-labels" aria-label="Scene labels">
        <li className="scene-label sim">Digital-twin simulation</li>
        <li className="scene-label">{SCENE_LABEL}</li>
        <li><PacingBadge state={state} /></li>
      </ul>
      <div className="presenter-actions" role="group" aria-label="Presenter controls">
        <Link className="button-link" href="/replay" title={REPLAY_TITLE}>Saved replay</Link>
        <button type="button" aria-haspopup="dialog" onClick={onOpenQa}>Q&amp;A</button>
        <details className="demo-tools">
          <summary className="button-link">Demo tools</summary>
          <div className="demo-tools-menu">
            <JudgeChallenge state={state} send={send} show={setFeedback} />
            <LocalizationLoss state={state} send={send} show={setFeedback} />
            <VoiceToggle voice={voice} onChange={onVoiceChange} />
          </div>
        </details>
      </div>
    </div>
    <div className="presenter-feedback" role="status">
      {shownFeedback !== null && <>
        <span>{shownFeedback}</span>
        <button type="button" className="small-button" onClick={() => setFeedback(null)}>Dismiss</button>
      </>}
    </div>
  </div>;
}
