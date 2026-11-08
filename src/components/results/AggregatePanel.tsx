"use client";

import { DRONE_RETURN_WORDS } from "@/components/mission/outcome-words";
import type { RunFigures } from "./metrics";
import { aggregate, pairs } from "./metrics";
import { seconds } from "./RunDetail";

const count = (n: number, of: number) => <><span className="num">{n}</span><span className="muted"> / {of}</span></>;

function median(m: { readonly count: number; readonly medianS: number | null }, of: number) {
  return <>{seconds(m.medianS)}<span className="muted"> (n = {m.count} of {of})</span></>;
}

/** Every loaded run, selectable; the outcome uses the only permitted wording. */
export function RunList({ figures, selected, onSelect }: { readonly figures: readonly (RunFigures & { readonly key: string })[]; readonly selected: string | null; readonly onSelect: (key: string) => void }) {
  return <div className="table-wrap">
    <table className="data-table run-table">
      <caption className="sr-only">Loaded runs</caption>
      <thead><tr><th scope="col">Run</th><th scope="col">Outcome</th><th scope="col">Condition</th><th scope="col">Seed</th><th scope="col">Collisions</th><th scope="col">Drone</th></tr></thead>
      <tbody>
        {figures.map(f => <tr key={f.key} aria-selected={f.key === selected}>
          <th scope="row"><button type="button" className="link-button" aria-pressed={f.key === selected} onClick={() => onSelect(f.key)}>{f.runId}</button></th>
          <td className={f.outcome.completed ? "ok" : "warn"}>{f.outcome.words}{!f.outcome.scored && <span className="muted"> · not scored</span>}</td>
          <td>{f.condition}</td>
          <td><code>{f.pairKey?.split(" · seed ")[1] ?? "—"}</code></td>
          <td className="num">{f.collisions}</td>
          <td>{f.droneReturn === null ? "—" : DRONE_RETURN_WORDS[f.droneReturn]}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

/** Counts per condition with denominators, then paired seeds side by side. No improvement figure. */
export function AggregatePanel({ figures }: { readonly figures: readonly RunFigures[] }) {
  const rows = aggregate(figures);
  const paired = pairs(figures);
  return <section className="panel aggregate" aria-label="Aggregate results">
    <h2>Aggregate <span className="muted">{figures.length} run{figures.length === 1 ? "" : "s"} loaded, grouped by controller and mission planner</span></h2>
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">Results per condition</caption>
        <thead><tr>
          <th scope="col">Condition</th><th scope="col">Simulated evacuation completed</th><th scope="col">Incomplete</th><th scope="col">Scored by evaluator</th>
          <th scope="col">Runs with a collision</th><th scope="col">Runs with any violation</th><th scope="col">Aborts</th><th scope="col">Drone returned</th>
          <th scope="col">Water used</th><th scope="col">Median time to evidence</th><th scope="col">Median time to exit</th>
        </tr></thead>
        <tbody>
          {rows.map(r => <tr key={r.condition}>
            <th scope="row">{r.condition}</th>
            <td>{count(r.completed, r.runs)}</td>
            <td>{count(r.incomplete, r.runs)}</td>
            <td>{count(r.scored, r.runs)}</td>
            <td>{count(r.runsWithCollision, r.runs)}<span className="muted"> · {r.collisions} total</span></td>
            <td>{count(r.runsWithViolation, r.runs)}</td>
            <td className="num">{r.aborts}</td>
            <td>{count(r.returned, r.runs)}</td>
            <td className="num">{r.waterDischargedL.toFixed(2)} L</td>
            <td>{median(r.evidence, r.runs)}</td>
            <td>{median(r.exit, r.runs)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {paired.rows.length > 0 && <>
      <h3>Paired seeds <span className="muted">same scenario and seed under each condition</span></h3>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">Outcomes by paired seed</caption>
          <thead><tr><th scope="col">Scenario and seed</th>{paired.conditions.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {paired.rows.map(row => <tr key={row.pairKey}>
              <th scope="row">{row.pairKey}</th>
              {row.cells.map((cell, i) => <td key={i} className={cell === null ? "muted" : cell.outcome.completed ? "ok" : "warn"}>{cell === null ? "not run" : `${cell.outcome.words}${cell.collisions > 0 ? `, ${cell.collisions} collision(s)` : ""}`}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
    </>}
    <p className="caption">Counts are shown with their denominators; incomplete and unscored runs stay in the totals. This page computes no improvement percentage. Results come from one simulated house and do not establish field performance. Times are simulated seconds after the commander authorized the mission.</p>
  </section>;
}
