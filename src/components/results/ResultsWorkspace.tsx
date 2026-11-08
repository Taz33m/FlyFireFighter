"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SiteHeader } from "@/components/about/SiteHeader";
import type { RunBundle } from "./bundle";
import { COMPLETED_WORDS, INCOMPLETE_WORDS } from "./bundle";
import { AggregatePanel, RunList } from "./AggregatePanel";
import { fetchAtlasBundle } from "./atlas-client";
import { AtlasPanel } from "./AtlasPanel";
import { loadDroppedFiles, loadPublished } from "./loaders";
import { runFigures } from "./metrics";
import { ReplayPanel } from "./ReplayPanel";
import { RunDetail } from "./RunDetail";

type Published = { readonly state: "loading" } | { readonly state: "none" } | { readonly state: "loaded"; readonly listed: number } | { readonly state: "error"; readonly message: string };

/** Results and replay: load exported run bundles, read each outcome and history, aggregate and replay. */
export function ResultsWorkspace() {
  const [bundles, setBundles] = useState<readonly RunBundle[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notes, setNotes] = useState<readonly string[]>([]);
  const [published, setPublished] = useState<Published>({ state: "loading" });
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (incoming: readonly RunBundle[]) => {
    setBundles(current => [...current.filter(b => !incoming.some(n => n.key === b.key)), ...incoming]);
    setSelected(current => current ?? incoming[0]?.key ?? null);
  };

  useEffect(() => {
    const controller = new AbortController();
    loadPublished(controller.signal).then(report => {
      setPublished(report.listed === null ? { state: "none" } : { state: "loaded", listed: report.listed });
      if (report.notes.length > 0) setNotes(n => [...n, ...report.notes]);
      if (report.bundles.length > 0) add(report.bundles);
    }).catch(error => {
      if (!controller.signal.aborted) setPublished({ state: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, []);

  const readFiles = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    const report = await loadDroppedFiles(files);
    setNotes(report.notes);
    add(report.bundles);
    if (report.bundles.length > 0) setSelected(report.bundles[0].key);
  };

  /** Load a run saved in Atlas into the list below, like a dropped bundle. */
  const openAtlasRun = async (runId: string) => {
    setOpening(runId);
    const load = await fetchAtlasBundle(runId);
    setOpening(null);
    if (!load.ok) {
      setNotes(n => [...n, `Atlas run ${runId}: ${load.message}`]);
      return;
    }
    add([load.bundle]);
    setSelected(load.bundle.key);
  };

  const figures = useMemo(() => bundles.map(b => ({ ...runFigures(b), key: b.key })), [bundles]);
  const current = bundles.find(b => b.key === selected) ?? null;
  const currentFigures = figures.find(f => f.key === selected) ?? null;

  return <div className="workspace results-page">
    <SiteHeader current="/results" />
    <main className="page-body">
      <div className="page-intro">
        <h1>Results and replay</h1>
        <p className="muted">Outcomes come from the independent simulation evaluator recorded in each bundle. Only an evaluator-verified exterior arrival reads “{COMPLETED_WORDS}”; every other run, including unscored ones, reads “{INCOMPLETE_WORDS}”.</p>
      </div>
      <section className={dragging ? "panel loader dragging" : "panel loader"} aria-label="Load run bundles"
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); void readFiles(e.dataTransfer.files); }}>
        <div className="loader-body">
          <div>
            <h2>Load run bundles</h2>
            <p className="muted">Drop or choose the files exported from the workspace: <code>results.json</code>, <code>events.jsonl</code> and <code>replay.jsonl</code> (optionally prefixed with the run id). Several runs can be loaded together. Files stay in this browser tab.</p>
          </div>
          <div className="loader-actions">
            <input ref={inputRef} id="bundle-files" className="sr-only" type="file" multiple accept=".json,.jsonl,application/json" onChange={e => { void readFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" className="primary" onClick={() => inputRef.current?.click()}>Choose files</button>
            {bundles.length > 0 && <button type="button" onClick={() => { setBundles([]); setSelected(null); setNotes([]); }}>Clear</button>}
          </div>
        </div>
        <p className="small muted" role="status">
          {published.state === "loading" && "Looking for published bundles under /runs/…"}
          {published.state === "none" && "No published bundles (public/runs/index.json is absent)."}
          {published.state === "loaded" && `${published.listed} published bundle${published.listed === 1 ? "" : "s"} listed in public/runs/index.json.`}
          {published.state === "error" && `Published bundles could not be loaded: ${published.message}`}
        </p>
        {notes.length > 0 && <ul className="problems">{notes.map(n => <li key={n}>{n}</li>)}</ul>}
      </section>
      <AtlasPanel onOpen={runId => void openAtlasRun(runId)} opening={opening} />
      {bundles.length === 0 ? <section className="panel"><p className="empty">No runs loaded. Export a run from the mission workspace (“Export run” in the run controls), then load its three files here.</p></section> : <>
        <section className="panel" aria-label="Loaded runs">
          <h2>Runs <span className="muted">select one for its record and replay</span></h2>
          <RunList figures={figures} selected={selected} onSelect={setSelected} />
        </section>
        <AggregatePanel figures={figures} />
        {current !== null && currentFigures !== null && <>
          <RunDetail bundle={current} figures={currentFigures} />
          <ReplayPanel key={current.key} bundle={current} />
        </>}
      </>}
    </main>
  </div>;
}
