"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AtlasListReply, AtlasRunFilter, AtlasRunSummary, AtlasStats, AtlasStatsRow, StageName } from "./atlas-wire";
import { STAGE_WORDS } from "./atlas-wire";
import { fetchAtlasRuns } from "./atlas-client";
import { AtlasSearch } from "./AtlasSearch";
import { seconds } from "./RunDetail";

type Grouping = "byCondition" | "byController" | "byDecider" | "byScenario";
const GROUPINGS: readonly { readonly id: Grouping; readonly label: string }[] = [
  { id: "byCondition", label: "Condition" }, { id: "byController", label: "Controller" }, { id: "byDecider", label: "Mission planner" }, { id: "byScenario", label: "Scenario" },
];
const SHOWN_STAGES: readonly StageName[] = ["evidence", "breach", "spray", "exit"];

type Load = { readonly state: "loading" } | { readonly state: "done"; readonly reply: AtlasListReply };
type Options = { readonly controller: readonly string[]; readonly decider: readonly string[]; readonly scenarioId: readonly string[] };

const count = (n: number, of: number) => <><span className="num">{n}</span><span className="muted"> / {of}</span></>;

function keyText(key: AtlasStatsRow["key"]): string {
  if (key === null) return "All runs";
  if (typeof key === "string") return key;
  return [key.controller ?? "unknown controller", key.decider ?? "unknown planner", key.scenarioId ?? "unknown scenario"].join(" · ");
}

function optionsOf(stats: AtlasStats): Options {
  const keys = (rows: readonly AtlasStatsRow[]) => rows.map(r => r.key).filter((k): k is string => typeof k === "string");
  return { controller: keys(stats.byController), decider: keys(stats.byDecider), scenarioId: keys(stats.byScenario) };
}

function StatsTable({ stats }: { readonly stats: AtlasStats }) {
  const [grouping, setGrouping] = useState<Grouping>("byCondition");
  const rows = stats[grouping];
  return <>
    <div className="section-head">
      <h3>Aggregates <span className="muted">computed in Atlas by an aggregation pipeline ($facet, $group, $median)</span></h3>
      <label className="check">Group by <select value={grouping} onChange={e => setGrouping(e.target.value as Grouping)}>{GROUPINGS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
    </div>
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">Saved runs grouped by {GROUPINGS.find(g => g.id === grouping)?.label}</caption>
        <thead><tr>
          <th scope="col">{GROUPINGS.find(g => g.id === grouping)?.label}</th><th scope="col">Simulated evacuation completed</th><th scope="col">Scored by evaluator</th>
          <th scope="col">Runs with any violation</th><th scope="col">Violations · collisions</th>
          {SHOWN_STAGES.map(s => <th key={s} scope="col">Median: {STAGE_WORDS[s].toLowerCase()}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(r => <tr key={keyText(r.key)}>
            <th scope="row">{keyText(r.key)}</th>
            <td>{count(r.completed, r.runs)}{r.completionRate !== null && <span className="muted"> ({Math.round(r.completionRate * 100)}%)</span>}</td>
            <td>{count(r.scored, r.runs)}</td>
            <td>{count(r.runsWithViolation, r.runs)}</td>
            <td className="num">{r.violations} · {r.collisions}</td>
            {SHOWN_STAGES.map(s => <td key={s}>{seconds(r.medianStageS[s])}<span className="muted"> (n = {r.stageCounts[s]} of {r.runs})</span></td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    {stats.violationKinds.length > 0 && <p className="small">Violations by kind: {stats.violationKinds.map(v => `${v.kind.replace(/_/g, " ")} ${v.count} (in ${v.runs} run${v.runs === 1 ? "" : "s"})`).join(" · ")}</p>}
  </>;
}

function RunTable({ runs, onOpen, opening }: { readonly runs: readonly AtlasRunSummary[]; readonly onOpen: (runId: string) => void; readonly opening: string | null }) {
  return <div className="table-wrap">
    <table className="data-table run-table">
      <caption className="sr-only">Simulation runs saved in Atlas</caption>
      <thead><tr><th scope="col">Run</th><th scope="col">Saved</th><th scope="col">Outcome</th><th scope="col">Condition</th><th scope="col">Scenario · seed</th><th scope="col">Violations</th><th scope="col">Exterior arrival</th><th scope="col">Replay</th></tr></thead>
      <tbody>
        {runs.map(r => <tr key={r.runId}>
          <th scope="row"><button type="button" className="link-button" disabled={opening === r.runId} onClick={() => onOpen(r.runId)} title="Load this run's record and replay below">{r.runId}</button>{r.problems > 0 && <span className="warn small"> · {r.problems} note{r.problems === 1 ? "" : "s"}</span>}</th>
          <td className="small">{new Date(r.savedAt).toLocaleString()}<span className="muted"> · {r.source}</span></td>
          <td className={r.outcome.completed ? "ok" : "warn"}>{r.outcome.words}{!r.outcome.scored && <span className="muted"> · not scored</span>}</td>
          <td>{r.controllerLabel} · {r.deciderLabel}</td>
          <td><code>{r.scenarioId ?? "—"}</code> · <code>{r.seed ?? "—"}</code></td>
          <td className="num">{r.outcome.violationCount}</td>
          <td className="num">{seconds(r.stageSeconds.exit)}</td>
          <td><Link href={`/replay?atlas=${encodeURIComponent(r.runId)}`}>On stage</Link></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function Filters({ options, filter, onChange }: { readonly options: Options; readonly filter: AtlasRunFilter; readonly onChange: (filter: AtlasRunFilter) => void }) {
  const select = (name: "controller" | "decider" | "scenarioId", label: string) => <label className="check">{label}
    <select value={filter[name] ?? ""} onChange={e => onChange({ ...filter, [name]: e.target.value === "" ? undefined : e.target.value })}>
      <option value="">All</option>
      {options[name].map(v => <option key={v} value={v}>{v}</option>)}
    </select>
  </label>;
  return <div className="atlas-filters">
    {select("controller", "Controller")}
    {select("decider", "Planner")}
    {select("scenarioId", "Scenario")}
    <label className="check">Outcome
      <select value={filter.outcome ?? ""} onChange={e => onChange({ ...filter, outcome: e.target.value === "completed" || e.target.value === "incomplete" ? e.target.value : undefined })}>
        <option value="">All</option><option value="completed">Simulated evacuation completed</option><option value="incomplete">Incomplete</option>
      </select>
    </label>
  </div>;
}

function statusLine(load: Load): string | null {
  if (load.state === "loading") return "Reading saved runs from MongoDB Atlas…";
  const reply = load.reply;
  if (reply.status === "not_configured") return "Atlas persistence is not configured, so runs are kept only as local bundles. Set MONGODB_URI in .env.local (docs/persistence.md).";
  if (reply.status !== "ok") return `Saved runs could not be read: ${reply.message}`;
  return reply.runs.length === 0 ? "No simulation runs are saved in Atlas yet; a finished run in the mission workspace is saved automatically." : null;
}

/** Simulation runs saved in MongoDB Atlas: aggregates from the Atlas pipeline, the run list and log search. */
export function AtlasPanel({ onOpen, opening }: { readonly onOpen: (runId: string) => void; readonly opening: string | null }) {
  const [filter, setFilter] = useState<AtlasRunFilter>({});
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [options, setOptions] = useState<Options>({ controller: [], decider: [], scenarioId: [] });
  const [refresh, setRefresh] = useState(0);
  const unfiltered = useMemo(() => Object.values(filter).every(v => v === undefined), [filter]);

  useEffect(() => {
    const controller = new AbortController();
    fetchAtlasRuns(filter, controller.signal).then(reply => {
      setLoad({ state: "done", reply });
      if (reply.status === "ok" && unfiltered) setOptions(optionsOf(reply.stats));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [filter, unfiltered, refresh]);

  const line = statusLine(load);
  const ok = load.state === "done" && load.reply.status === "ok" ? load.reply : null;
  const configured = load.state === "loading" || load.reply.status !== "not_configured";
  return <section className="panel atlas" aria-label="Simulation runs saved in MongoDB Atlas">
    <div className="section-head">
      <h2>Saved in MongoDB Atlas <span className="muted">simulation runs, newest first</span></h2>
      {configured && <button type="button" onClick={() => { setLoad({ state: "loading" }); setRefresh(n => n + 1); }}>Refresh</button>}
    </div>
    {configured && <Filters options={options} filter={filter} onChange={next => { setLoad({ state: "loading" }); setFilter(next); }} />}
    {line !== null && <p className="small muted" role="status">{line}</p>}
    {ok !== null && ok.stats.totals !== null && <StatsTable stats={ok.stats} />}
    {ok !== null && ok.runs.length > 0 && <RunTable runs={ok.runs} onOpen={onOpen} opening={opening} />}
    {configured && <AtlasSearch onOpen={onOpen} />}
    <p className="caption">Every run here is a simulation of one fictional incident in the Troy training scene. Outcome words come from the evaluator result stored with each run and are recomputed when it is saved. Counts carry their denominators; medians use Atlas&apos;s approximate $median over the runs that reached each stage (simulated seconds after authorization). No improvement percentage is computed.</p>
  </section>;
}
