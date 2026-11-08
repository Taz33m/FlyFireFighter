"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PhaseRail } from "@/components/mission/PhaseRail";
import { ThermalView } from "@/components/mission/ThermalView";
import { formatClock } from "@/components/mission/format";
import { createReplayModel, frameIndexAt, momentAt } from "@/components/replay/replay-model";
import { poseNote, REPLAY_BANNER, ReplayControls, ReplayOutcome, ReplaySummaryFacts } from "@/components/replay/ReplayParts";
import styles from "@/components/replay/ReplayStage.module.css";
import { usePlayback } from "@/components/replay/usePlayback";
import { SCENE_URL, SCENE_WORDS, useSceneMeta } from "@/components/replay/useSceneMeta";
import { TwinView } from "@/components/twin/TwinView";
import { RenderSnapshotStore } from "@/hooks/mission-stores";
import type { FrameRenderer } from "@/hooks/useMissionWorker";
import type { TwinRenderer } from "@/lib/render/twin-renderer";
import type { RunBundle } from "./bundle";
import { publishedId } from "./loaders";

const VISIBLE_EVENTS = 60;
const DECISION_SOURCES = new Set(["commander", "harness", "planner", "decisions_gateway", "evaluator"]);
/** A replay never answers render requests: the controller is not running. */
const NO_FRAME_RENDERER = (renderer: FrameRenderer | null) => void renderer;

function ReplayEvents({ events, onSeek }: { readonly events: RunBundle["events"]; readonly onSeek: (tick: number) => void }) {
  const [decisionsOnly, setDecisionsOnly] = useState(false);
  const shown = events.filter(e => !decisionsOnly || DECISION_SOURCES.has(e.source)).slice(-VISIBLE_EVENTS).reverse();
  return <>
    <div className="section-head">
      <h3>Event log at this time <span className="muted">{shown.length < VISIBLE_EVENTS ? shown.length : `latest ${VISIBLE_EVENTS}`}</span></h3>
      <label className="check"><input type="checkbox" checked={decisionsOnly} onChange={e => setDecisionsOnly(e.target.checked)} />Decisions and outcomes</label>
    </div>
    <ol className="event-list replay-events">
      {shown.length === 0 ? <li className="muted">No events yet at this time.</li> : shown.map((e, i) => <li key={e.seq} data-source={e.source} data-current={i === 0}>
        <button type="button" className="event-seek" onClick={() => onSeek(e.tick)} aria-label={`Go to ${formatClock(e.tick)}: ${e.kind}`}>
          <span className="event-head"><span className="event-time num">{formatClock(e.tick)}</span><strong>{e.source.replace(/_/g, " ")}</strong><span className="muted">{e.kind}</span></span>
          <span className="event-reason">{e.reason}</span>
        </button>
      </li>)}
    </ol>
  </>;
}

/** Where the projector replay page can open this bundle: published bundles by id; chosen files only in this tab. */
function StageLink({ bundle }: { readonly bundle: RunBundle }) {
  if (bundle.origin.kind === "atlas") return <Link className={styles.stageLink} href={`/replay?atlas=${encodeURIComponent(bundle.origin.runId)}`}>Open on stage</Link>;
  const id = publishedId(bundle);
  if (id !== null) return <Link className={styles.stageLink} href={`/replay?run=${encodeURIComponent(id)}`}>Open on stage</Link>;
  return <span className="muted small">Stage view: open <Link href="/replay">/replay</Link> and choose these files again there; files stay in this tab only.</span>;
}

/**
 * Plays replay.jsonl through the twin renderer, synced with the run's event log, with the phase rail and the
 * outcome rebuilt at the playhead from recorded events (replay-model.ts). Mount with key={bundle.key}.
 */
export function ReplayPanel({ bundle }: { readonly bundle: RunBundle }) {
  const model = useMemo(() => createReplayModel(bundle), [bundle]);
  const frames = model.frames;
  const store = useMemo(() => new RenderSnapshotStore(), []);
  const playback = usePlayback(frames);
  const [twin, setTwin] = useState<TwinRenderer | null>(null);
  const scene = useSceneMeta(bundle.results?.scene?.metaSha256);
  const moment = useMemo(() => momentAt(model, playback.index, scene.prior), [model, playback.index, scene.prior]);
  const frame = frames[playback.index] ?? null;
  const aircraftId = bundle.results?.config?.aircraftId ?? "tender-t1";

  // The renderer alone reads the recorded simulation truth; every panel reads the model.
  useEffect(() => { store.set(frame?.render ?? null); }, [store, frame]);
  useEffect(() => () => store.set(null), [store]);

  const events = model.events.slice(0, moment.eventCount);

  return <section className="panel replay" aria-label="Recorded replay">
    <div className="replay-banner" role="note"><strong>{REPLAY_BANNER}</strong><span>Recorded world snapshots played back. No simulator, controller, planner, harness or cloud call runs; the camera and thermal panels are re-rendered from the recorded snapshots, not the frames the controller received.</span><StageLink bundle={bundle} /></div>
    {frames.length === 0 ? <p className="empty">This bundle has no replay frames.</p> : <>
      <PhaseRail state={moment.rail} size="compact" />
      <div className="replay-grid">
        <div className="replay-main">
          <div className="replay-stage">
            <TwinView renderStore={store} setFrameRenderer={NO_FRAME_RENDERER} sceneBaseUrl={SCENE_URL} aircraftId={aircraftId} view={null} onRenderer={setTwin} />
            <span className="replay-badge" aria-hidden="true">Recorded replay</span>
          </div>
          <ReplayControls playback={playback} model={model} />
          <p className="caption">{SCENE_WORDS[scene.check]} · frame {playback.index + 1} of {frames.length} · tick {moment.tick}{scene.priorProblem === null ? "" : ` · ${scene.priorProblem}`} · {poseNote(moment)}</p>
        </div>
        <aside className="replay-side">
          <ReplayOutcome model={model} moment={moment} />
          <ReplaySummaryFacts moment={moment} />
          <ReplayEvents events={events} onSeek={tick => playback.seek(frameIndexAt(model, tick))} />
          <ThermalView renderer={twin} aircraftId={aircraftId} />
        </aside>
      </div>
    </>}
  </section>;
}
