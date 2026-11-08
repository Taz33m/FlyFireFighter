"use client";

/**
 * Projector replay page (/replay): plays a saved run bundle in the 3D twin with the stage-size phase rail,
 * the outcome at the playhead and the recorded timeline, so the presenter can cut to it if a live stage
 * stalls. Bundles come from `?run=<id>` (published under public/runs/), `?atlas=<runId>` (a simulation run
 * saved in MongoDB Atlas), the first published bundle when no run is named, or files chosen/dropped here
 * (they stay in this tab).
 *
 * Replay plays recorded frames and events only: no simulator, planner, harness, controller or cloud call
 * runs. Only the twin renderer reads frame.render (recorded simulation truth); the rail, captions, outcome
 * and timeline come from replay-model.ts (events up to the playhead and the truth-free frame summary).
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MissionTimeline } from "@/components/mission/MissionTimeline";
import { PhaseRail } from "@/components/mission/PhaseRail";
import { ThermalView } from "@/components/mission/ThermalView";
import { WordmarkContent } from "@/components/mission/Wordmark";
import type { RunBundle } from "@/components/results/bundle";
import type { IndexEntry, PublishedIndex } from "@/components/results/loaders";
import { loadDroppedFiles, loadPublishedBundle, loadPublishedIndex } from "@/components/results/loaders";
import { TwinView } from "@/components/twin/TwinView";
import { RenderSnapshotStore } from "@/hooks/mission-stores";
import type { FrameRenderer } from "@/hooks/useMissionWorker";
import type { TwinRenderer } from "@/lib/render/twin-renderer";
import { createReplayModel, frameIndexAt, momentAt } from "./replay-model";
import { poseNote, REPLAY_BANNER, ReplayControls, ReplayOutcome, ReplaySummaryFacts, SCENE_LABEL, TWIN_LABEL } from "./ReplayParts";
import styles from "./ReplayStage.module.css";
import type { AtlasReplay, AtlasRunList } from "./useAtlasReplay";
import { useAtlasReplay } from "./useAtlasReplay";
import { usePlayback } from "./usePlayback";
import { SCENE_URL, SCENE_WORDS, useSceneMeta } from "./useSceneMeta";

/** A replay never answers render requests: the controller is not running. */
const NO_FRAME_RENDERER = (renderer: FrameRenderer | null) => void renderer;

type IndexState = { readonly state: "loading" } | PublishedIndex | { readonly state: "error"; readonly message: string };
type Loaded = { readonly state: "loaded"; readonly bundle: RunBundle } | { readonly state: "error"; readonly message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Space plays or pauses, unless a control has focus (it handles its own keys). */
function usePlayKey(toggle: () => void) {
  const toggleRef = useRef(toggle);
  useEffect(() => { toggleRef.current = toggle; }, [toggle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target !== null && target.closest("button, input, select, textarea, a, [contenteditable='true']") !== null) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Problems({ bundle, notes }: { readonly bundle: RunBundle | null; readonly notes: readonly string[] }) {
  const problems = [...notes, ...(bundle?.problems ?? [])];
  return <section className={`panel ${styles.problemsPanel}`} aria-label="Bundle validation">
    <h2>Bundle validation <span className="muted">checked before any outcome is shown</span></h2>
    {problems.length === 0 ? <p className="ok">{bundle === null ? "No bundle loaded." : "No problems found: the files agree with each other and the evaluator result belongs to this run."}</p> : <ul className="problems">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
  </section>;
}

function originText(origin: RunBundle["origin"]): string {
  if (origin.kind === "file") return `Files chosen in this tab: ${origin.names.join(", ")}`;
  if (origin.kind === "atlas") return `Simulation run saved in MongoDB Atlas (${origin.runId}${origin.savedAt === null ? "" : `, saved ${origin.savedAt}`})`;
  return `Published bundle ${origin.url}${origin.label === null ? "" : ` (${origin.label})`}`;
}

function recordedLabels(r: RunBundle["results"]): { readonly controller: string; readonly planner: string } {
  const controller = r?.controller?.label ?? r?.config?.controller;
  const planner = r?.decider?.label ?? r?.config?.decider;
  const status = r?.decider?.status;
  return { controller: controller ?? "not recorded", planner: [planner ?? "not recorded", status].filter(Boolean).join(" · ") };
}

function Provenance({ bundle }: { readonly bundle: RunBundle }) {
  const r = bundle.results;
  const labels = recordedLabels(r);
  return <dl className="facts">
    <dt>Run</dt><dd>{r?.runId ?? "unknown (results.json missing)"}</dd>
    <dt>Source</dt><dd>{originText(bundle.origin)}</dd>
    {r?.label !== undefined && <><dt>Label</dt><dd>{r.label}</dd></>}
    <dt>Recorded controller</dt><dd>{labels.controller}</dd>
    <dt>Recorded planner</dt><dd>{labels.planner}</dd>
    <dt>Frames / events</dt><dd className="num">{bundle.replay.length} / {bundle.events.length}</dd>
  </dl>;
}

/** One bundle on stage. Mount with key={bundle.key}: a new bundle gets a fresh twin, store and playhead. */
function StageView({ bundle, header, notes }: { readonly bundle: RunBundle; readonly header: ReactNode; readonly notes: readonly string[] }) {
  const model = useMemo(() => createReplayModel(bundle), [bundle]);
  const store = useMemo(() => new RenderSnapshotStore(), []);
  const playback = usePlayback(model.frames);
  const [twin, setTwin] = useState<TwinRenderer | null>(null);
  const scene = useSceneMeta(bundle.results?.scene?.metaSha256);
  const moment = useMemo(() => momentAt(model, playback.index, scene.prior), [model, playback.index, scene.prior]);
  const frame = model.frames[playback.index] ?? null;
  const aircraftId = bundle.results?.config?.aircraftId ?? "tender-t1";
  usePlayKey(playback.toggle);

  // The renderer alone reads the recorded simulation truth; every panel reads the model.
  useEffect(() => { store.set(frame?.render ?? null); }, [store, frame]);
  useEffect(() => () => store.set(null), [store]);

  const seekTick = (tick: number) => playback.seek(frameIndexAt(model, tick));
  const empty = model.frames.length === 0;

  return <>
    <div className={styles.fold}>
      {header}
      <PhaseRail state={moment.rail} size="stage" className={styles.rail} />
      <div className={styles.stageGrid}>
        <div className={styles.twinColumn}>
          <div className={styles.twinFrame}>
            {empty ? <p className={styles.emptyTwin}>This bundle has no replay frames; the rail and timeline follow the events only.</p>
              : <TwinView renderStore={store} setFrameRenderer={NO_FRAME_RENDERER} sceneBaseUrl={SCENE_URL} aircraftId={aircraftId} view={null} onRenderer={setTwin} />}
            <span className={styles.twinBadge} aria-hidden="true">{REPLAY_BANNER}</span>
          </div>
          {!empty && <ReplayControls playback={playback} model={model} className={styles.controls} />}
        </div>
        <aside className={styles.side} aria-label="Outcome and recorded timeline">
          <ReplayOutcome model={model} moment={moment} />
          <ReplaySummaryFacts moment={moment} />
          <p className={styles.sideNote}>{SCENE_WORDS[scene.check]}. {poseNote(moment)}{scene.priorProblem === null ? "" : ` ${scene.priorProblem}`}</p>
          <MissionTimeline events={model.events.slice(0, moment.eventCount)} onSeek={seekTick} />
        </aside>
      </div>
    </div>
    <div className={styles.belowFold}>
      <section className={`panel ${styles.thermalPanel}`} aria-label="Thermal view">
        <ThermalView renderer={twin} aircraftId={aircraftId} />
      </section>
      <Problems bundle={bundle} notes={notes} />
      <section className="panel" aria-label="Recording">
        <h2>Recording</h2>
        <Provenance bundle={bundle} />
        <p className="caption">Frame {playback.index + 1} of {model.frames.length} · tick {moment.tick}{model.excludedEvents > 0 ? ` · ${model.excludedEvents} event(s) from another run or malformed lines are left out of the replay` : ""}</p>
      </section>
    </div>
  </>;
}

function RunPicker({ index, current }: { readonly index: IndexState; readonly current: string | null }) {
  const router = useRouter();
  if (index.state !== "listed" || index.entries.length === 0) return null;
  return <label className={styles.picker}>Saved run
    <select value={current ?? ""} onChange={e => router.replace(`/replay?run=${encodeURIComponent(e.target.value)}`)}>
      {current === null && <option value="">Choose…</option>}
      {index.entries.map(entry => <option key={entry.id} value={entry.id}>{entry.label ?? entry.id}</option>)}
    </select>
  </label>;
}

function AtlasRunPicker({ runs, current }: { readonly runs: AtlasRunList; readonly current: string | null }) {
  const router = useRouter();
  if (runs.state !== "listed" || runs.runs.length === 0) return null;
  return <label className={styles.picker}>Atlas run
    <select value={current ?? ""} onChange={e => router.replace(`/replay?atlas=${encodeURIComponent(e.target.value)}`)}>
      {current === null && <option value="">Choose…</option>}
      {current !== null && !runs.runs.some(r => r.runId === current) && <option value={current}>{current}</option>}
      {runs.runs.map(r => <option key={r.runId} value={r.runId}>{r.runId} · {r.outcome.words}</option>)}
    </select>
  </label>;
}

/** What to say while an Atlas run is requested and not on stage. */
function atlasLine(replay: AtlasReplay): string | null {
  if (replay.state === "loading") return `Loading simulation run ${replay.runId} from MongoDB Atlas…`;
  if (replay.state === "error") return `Atlas run ${replay.runId} could not be loaded: ${replay.message}`;
  return null;
}

function indexLine(index: IndexState): string {
  switch (index.state) {
    case "loading": return "Looking for published bundles under /runs/…";
    case "none": return "No published bundles (public/runs/index.json is absent).";
    case "unreadable": return index.note;
    case "error": return `Published bundles could not be listed: ${index.message}`;
    case "listed": return `${index.entries.length} published bundle${index.entries.length === 1 ? "" : "s"}.`;
  }
}

/** A ?run that names no published bundle, said plainly (no other run is picked in its place). */
function missingRun(index: IndexState, runParam: string | null, wanted: IndexEntry | null): string | null {
  if (runParam === null || index.state === "loading" || wanted !== null) return null;
  return `“${runParam}” is not a published run in public/runs/index.json. Choose a listed run or load bundle files.`;
}

/** What to show when no bundle is on stage yet: loading, a missing ?run, or how to load one. */
function emptyLine(index: IndexState, runParam: string | null, wanted: IndexEntry | null, loaded: Loaded | undefined): string {
  const missing = missingRun(index, runParam, wanted);
  if (missing !== null) return missing;
  if (loaded?.state === "error") return `The saved run could not be loaded: ${loaded.message}`;
  if (wanted !== null || index.state === "loading") return "Loading the saved replay…";
  return "No saved replay is published. Choose or drop a run bundle (results.json, events.jsonl, replay.jsonl).";
}

type FileSelection = { readonly bundles: readonly RunBundle[]; readonly key: string; readonly forRun: string | null };

interface HeaderProps {
  readonly index: IndexState;
  readonly current: string | null;
  readonly atlasRuns: AtlasRunList;
  readonly atlasCurrent: string | null;
  readonly files: FileSelection | null;
  readonly showFilePicker: boolean;
  readonly onFilesKey: (key: string) => void;
  readonly onFiles: (list: FileList | null) => void;
}

/** Wordmark, the recorded-replay and scene labels, the run picker, file loading and page links. */
function StageHeader({ index, current, atlasRuns, atlasCurrent, files, showFilePicker, onFilesKey, onFiles }: HeaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <header className={styles.header}>
    <Link href="/" className={`wordmark ${styles.wordmark}`} aria-label="FlyFireFighter mission workspace"><WordmarkContent /></Link>
    <strong className={styles.banner} role="note">{REPLAY_BANNER}</strong>
    <span className={styles.labels}><span>{TWIN_LABEL}</span><span>{SCENE_LABEL}</span></span>
    <span className={styles.headerTools}>
      <RunPicker index={index} current={current} />
      <AtlasRunPicker runs={atlasRuns} current={atlasCurrent} />
      {showFilePicker && files !== null && files.bundles.length > 1 && <label className={styles.picker}>File run
        <select value={files.key} onChange={e => onFilesKey(e.target.value)}>{files.bundles.map(b => <option key={b.key} value={b.key}>{b.results?.runId ?? b.key}</option>)}</select>
      </label>}
      <input ref={inputRef} className="sr-only" type="file" multiple accept=".json,.jsonl,application/json" aria-label="Choose run bundle files" onChange={e => { onFiles(e.target.files); e.target.value = ""; }} />
      <button type="button" onClick={() => inputRef.current?.click()} title="Choose results.json, events.jsonl and replay.jsonl; they stay in this tab">Choose files</button>
      <nav className={styles.nav} aria-label="Pages"><Link href="/">Live workspace</Link><Link href="/results">Results</Link></nav>
    </span>
  </header>;
}

/** The published index and the published bundle the URL names (none while ?atlas names an Atlas run). */
function usePublishedReplay(runParam: string | null, atlasParam: string | null) {
  const [index, setIndex] = useState<IndexState>({ state: "loading" });
  const [published, setPublished] = useState<Readonly<Record<string, Loaded>>>({});

  useEffect(() => {
    const controller = new AbortController();
    loadPublishedIndex(controller.signal).then(setIndex).catch(error => {
      if (!controller.signal.aborted) setIndex({ state: "error", message: message(error) });
    });
    return () => controller.abort();
  }, []);

  const entries = index.state === "listed" ? index.entries : [];
  // ?run names the run; without it, the first published run, so the live workspace's link lands on it. ?atlas wins over both.
  const wanted = atlasParam !== null ? null : (runParam === null ? entries[0] : entries.find(e => e.id === runParam)) ?? null;
  const loaded = wanted === null ? undefined : published[wanted.id];

  useEffect(() => {
    if (wanted === null || loaded !== undefined) return;
    const controller = new AbortController();
    loadPublishedBundle(wanted, controller.signal)
      // Only the bundle on stage is kept: a recording can be tens of megabytes once parsed (shared 16 GB Mac).
      .then(bundle => setPublished({ [wanted.id]: { state: "loaded", bundle } }))
      .catch(error => { if (!controller.signal.aborted) setPublished(p => ({ ...p, [wanted.id]: { state: "error", message: message(error) } })); });
    return () => controller.abort();
  }, [wanted, loaded]);

  return { index, wanted, loaded };
}

/** Chosen files win until the URL names another run; then an Atlas run; then the published one. */
function stageBundle(fileBundle: RunBundle | null, atlas: AtlasReplay, loaded: Loaded | undefined): RunBundle | null {
  if (fileBundle !== null) return fileBundle;
  if (atlas.state === "loaded") return atlas.bundle;
  return loaded?.state === "loaded" ? loaded.bundle : null;
}

/** The page. Reads ?run and ?atlas with useSearchParams, so the server page wraps it in <Suspense>. */
export function ReplayStage() {
  const params = useSearchParams();
  const runParam = params.get("run");
  const atlasParam = params.get("atlas");
  // Chosen files belong to the route they were chosen on (a published run or an Atlas run).
  const routeKey = atlasParam === null ? runParam : `atlas:${atlasParam}`;
  const atlas = useAtlasReplay(atlasParam);
  const { index, wanted, loaded } = usePublishedReplay(runParam, atlasParam);
  const [files, setFiles] = useState<FileSelection | null>(null);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [dragging, setDragging] = useState(false);

  const readFiles = async (list: FileList | null) => {
    if (list === null || list.length === 0) return;
    const report = await loadDroppedFiles(list);
    setNotes(report.notes);
    if (report.bundles.length > 0) setFiles({ bundles: report.bundles, key: report.bundles[0].key, forRun: routeKey });
  };

  // Chosen files win until the URL names another run (picking a saved run navigates).
  const fileBundle = files !== null && files.forRun === routeKey ? files.bundles.find(b => b.key === files.key) ?? null : null;
  const bundle = stageBundle(fileBundle, atlas.replay, loaded);

  const header = <StageHeader index={index} current={fileBundle === null ? wanted?.id ?? null : null} atlasRuns={atlas.runs} atlasCurrent={fileBundle === null ? atlasParam : null} files={files} onFilesKey={key => files !== null && setFiles({ ...files, key })} onFiles={list => void readFiles(list)} showFilePicker={fileBundle !== null} />;

  return <div className={styles.page} data-dragging={dragging}
    onDragOver={e => { e.preventDefault(); setDragging(true); }}
    onDragLeave={e => { if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
    onDrop={e => { e.preventDefault(); setDragging(false); void readFiles(e.dataTransfer.files); }}>
    {bundle !== null ? <StageView key={bundle.key} bundle={bundle} header={header} notes={[missingRun(index, runParam, wanted), ...notes].filter((n): n is string => n !== null)} /> : <>
      <div className={styles.fold}>
        {header}
        <div className={styles.emptyStage} role="status">
          <p className={styles.emptyLead}>{atlasLine(atlas.replay) ?? emptyLine(index, runParam, wanted, loaded)}</p>
          <p className="muted">{indexLine(index)} Files you choose or drop here stay in this browser tab.</p>
        </div>
      </div>
      <div className={styles.belowFold}><Problems bundle={null} notes={notes} /></div>
    </>}
  </div>;
}
