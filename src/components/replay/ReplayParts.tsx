"use client";

/**
 * Pieces shared by the results page's replay panel and the projector replay page: playback controls, the
 * playhead-following outcome, the truth-free frame summary and the recorded-replay labels. All of them read
 * the replay model (events and truth-free summaries); none reads frame.render.
 */
import { formatClock } from "@/components/mission/format";
import { Outcome } from "@/components/mission/RescueRecord";
import type { ReplayModel, ReplayMoment } from "./replay-model";
import { gateFrameFrom } from "./replay-model";
import styles from "./ReplayStage.module.css";
import type { Playback } from "./usePlayback";
import { SPEEDS } from "./usePlayback";

export const REPLAY_BANNER = "Recorded replay — not live inference";
export const SCENE_LABEL = "Troy training scene — real exterior reference; fictional interior and incident";
export const TWIN_LABEL = "Digital-twin simulation";

const ACTION_WORDS: Readonly<Record<string, string>> = {
  breach_opening: "break glass", spray: "spray water", release_payload: "release payload", move: "move", scan: "scan", hold: "hold", return: "return", land: "land", speak: "speak", guide: "guide occupant",
};

const CONTINGENCY_WORDS: Readonly<Record<string, string>> = {
  return: "Returning", alternate_route: "Returning by an alternate route", hold: "Bounded hold", land: "Landing", failure: "No supported manoeuvre",
};

/** How the rail placed "search": from a recorded estimated pose, or not at all when the bundle has none. */
export function poseNote(moment: ReplayMoment): string {
  return moment.summary.estimatedPosition === null
    ? "The phase rail is rebuilt from the recorded events; this recording has no estimated pose, so the rail never infers entry from position."
    : "The phase rail is rebuilt from the recorded events and the recorded estimated pose (never the true position).";
}

export function ReplayControls({ playback, model, className }: { readonly playback: Playback; readonly model: ReplayModel; readonly className?: string }) {
  const { index, playing, speed } = playback;
  const ticks = model.frameTicks;
  const tick = ticks[index] ?? 0;
  const lastTick = ticks[ticks.length - 1] ?? 0;
  const previousGate = gateFrameFrom(model, index, -1);
  const nextGate = gateFrameFrom(model, index, 1);
  return <div className={className === undefined ? "replay-controls" : `replay-controls ${className}`} role="group" aria-label="Replay playback">
    <button type="button" className="primary" onClick={playback.toggle} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Pause" : "Play"}</button>
    <button type="button" onClick={() => playback.seek(index - 1)} aria-label="Previous frame" title="Previous frame">◀</button>
    <button type="button" onClick={() => playback.seek(index + 1)} aria-label="Next frame" title="Next frame">▶</button>
    <button type="button" disabled={previousGate === null} onClick={() => previousGate !== null && playback.seek(previousGate)} title="Previous glass, water or payload approval event">◆ Previous gate</button>
    <button type="button" disabled={nextGate === null} onClick={() => nextGate !== null && playback.seek(nextGate)} title="Next glass, water or payload approval event">Next gate ◆</button>
    <input className="scrubber" type="range" min={0} max={Math.max(0, ticks.length - 1)} value={index} aria-label="Replay position" aria-valuetext={`${formatClock(tick)} of ${formatClock(lastTick)}`} onChange={e => playback.seek(Number(e.target.value))} />
    <span className="num replay-time">{formatClock(tick)} <span className="muted">/ {formatClock(lastTick)}</span></span>
    <label>Speed <select value={speed} onChange={e => playback.setSpeed(Number(e.target.value))}>{SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}</select></label>
  </div>;
}

/** The truth-free frame summary, with the recorded controller and planner labels (fallbacks keep their own names). */
export function ReplaySummaryFacts({ moment }: { readonly moment: ReplayMoment }) {
  const { summary } = moment;
  const pending = moment.view.pendingApproval;
  return <dl className={`facts ${styles.summary}`}>
    <dt>Status</dt><dd>{moment.view.status.replace(/_/g, " ")}</dd>
    <dt>Controller</dt><dd>{summary.controllerLabel ?? <span className="muted">not recorded</span>}</dd>
    <dt>Mission planner</dt><dd>{summary.deciderLabel ?? <span className="muted">not recorded</span>}</dd>
    <dt>Water</dt><dd className="num">{summary.waterRemainingL === null ? "—" : `${summary.waterRemainingL.toFixed(2)} L left`}</dd>
    <dt>Awaiting approval</dt><dd>{summary.pendingApprovalId === null ? "nothing" : pending === null ? summary.pendingApprovalId : ACTION_WORDS[pending.proposal.action.kind] ?? pending.proposal.action.kind}</dd>
    {summary.contingency !== null && <><dt>Contingency</dt><dd className="warn">{CONTINGENCY_WORDS[summary.contingency] ?? summary.contingency}</dd></>}
  </dl>;
}

/**
 * The outcome at the playhead: "Exterior arrival not confirmed" until the recording reaches its outcome, then
 * the validated evaluator result worded by rescueLabel. Below it, apart and labelled, how the recording ends.
 */
export function ReplayOutcome({ model, moment, live = true }: { readonly model: ReplayModel; readonly moment: ReplayMoment; readonly live?: boolean }) {
  return <div className={styles.outcome}>
    <Outcome outcome={moment.outcome} source="recording" live={live} />
    {moment.outcomeReached && moment.outcome === null && <p className="warn small">The recording reached its outcome, but the bundle has no usable evaluator result (see bundle problems); the run reads as not scored.</p>}
    <FinalOutcome model={model} />
  </div>;
}

function FinalOutcome({ model }: { readonly model: ReplayModel }) {
  const { finalOutcome, outcomeTick } = model;
  const when = outcomeTick === null ? "" : model.outcomeRecorded ? ` at ${formatClock(outcomeTick)}` : " at the end of the recording";
  return <p className={styles.finalOutcome}>
    <span className={styles.finalLabel}>Presenter note — this recording ends with</span>
    <span>{finalOutcome.words}{when}</span>
    <span className="muted">{finalOutcome.scored ? "simulation evaluator result from the bundle" : "not scored by the evaluator"}</span>
  </p>;
}
