"use client";

import { useState } from "react";
import { formatClock } from "@/components/mission/format";
import { DRONE_RETURN_WORDS, OCCUPANT_OUTCOME_WORDS } from "@/components/mission/outcome-words";
import type { RunBundle } from "./bundle";
import type { ActionHistory, RunFigures } from "./metrics";
import { actionHistory } from "./metrics";

const ACTION_WORDS: Readonly<Record<string, string>> = {
  breach_opening: "Break glass", spray: "Spray water", release_payload: "Release payload", move: "Move", scan: "Scan", hold: "Hold", return: "Return", land: "Land", speak: "Speak", guide: "Guide occupant",
};

export function Hash({ value }: { readonly value: string | null | undefined }) {
  if (value == null || value === "") return <span className="muted">not recorded</span>;
  return <code className="hash" title={value}>{value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value}</code>;
}

export const seconds = (s: number | null) => (s === null ? "—" : `${s.toFixed(1)} s`);

function OutcomeCard({ bundle, figures }: { readonly bundle: RunBundle; readonly figures: RunFigures }) {
  const result = bundle.results?.result ?? null;
  const { outcome } = figures;
  return <div className={outcome.completed ? "outcome done" : "outcome incomplete"}>
    <span className={outcome.scored ? "tag sim" : "tag warn"}>{outcome.scored ? "Simulation evaluator" : "Not scored by the evaluator"}</span>
    <strong>{outcome.words}</strong>
    <ul>
      {result?.occupants.map((o, i) => <li key={o.occupantKey}>Simulated occupant {i + 1} {OCCUPANT_OUTCOME_WORDS[o.outcome]}{o.arrivalTick !== null ? ` at ${formatClock(o.arrivalTick)}` : ""}</li>)}
      {result !== null && <li>Budget {formatClock(result.budgetTick)}; run ended at {formatClock(result.endedTick)}</li>}
      <li>{figures.droneReturn === null ? "Drone return not scored" : DRONE_RETURN_WORDS[figures.droneReturn]} <span className="muted">(reported separately; it never changes the rescue outcome)</span></li>
      <li>{figures.violations.length === 0 ? (outcome.scored ? "No scored constraint violations" : "Violations not scored") : `${figures.violations.length} scored constraint violation(s)`}</li>
    </ul>
    {figures.violations.length > 0 && <ol className="violation-list">
      {figures.violations.map((v, i) => <li key={i}><span className="num">{formatClock(v.tick)}</span> <strong>{v.kind.replace(/_/g, " ")}</strong> <span className="muted">{v.detail}</span></li>)}
    </ol>}
  </div>;
}

type Results = NonNullable<RunBundle["results"]>;

function controllerText(r: Results): string {
  const c = r.controller;
  const parts = [c?.label ?? r.config?.controller ?? "—", c?.source == null ? null : `source ${c.source}`, c?.neuralStatus == null ? null : `neural ${c.neuralStatus}`];
  return parts.filter(Boolean).join(" · ");
}

function plannerText(r: Results): string {
  return [r.decider?.label ?? r.config?.decider ?? "—", r.decider?.status].filter(Boolean).join(" · ");
}

function timingText(r: Results): string {
  const t = r.timing;
  if (t?.simulatedS == null) return "—";
  return `${t.simulatedS.toFixed(1)} s simulated${t.wallMs == null ? "" : ` in ${(t.wallMs / 1000).toFixed(1)} s wall`}`;
}

function ConfigFacts({ r }: { readonly r: Results }) {
  const model = r.controller?.model ?? null;
  return <>
    <dt>Scenario</dt><dd>{r.scenarioId ?? "—"}</dd>
    <dt>Seed</dt><dd><code>{r.seed ?? "—"}</code></dd>
    <dt>Controller</dt><dd>{controllerText(r)}</dd>
    {model !== null && <><dt>Model</dt><dd>{model} · checkpoint <Hash value={r.controller?.checkpointSha256} /></dd></>}
    <dt>Mission planner</dt><dd>{plannerText(r)}</dd>
    <dt>Aircraft · commander</dt><dd>{r.config?.aircraftId ?? "—"} · {r.config?.commanderId ?? "—"}</dd>
  </>;
}

function AssetFacts({ r }: { readonly r: Results }) {
  const assets = Object.entries(r.scene?.assets ?? {});
  if (assets.length === 0) return null;
  return <><dt>Assets</dt><dd><details><summary>{assets.length} hashed file{assets.length === 1 ? "" : "s"}</summary><ul className="asset-list">{assets.map(([name, a]) => <li key={name}><code>{name}</code> <Hash value={a.sha256} /></li>)}</ul></details></dd></>;
}

function sceneText(r: Results): string {
  return `${r.scene?.sceneId ?? "—"} rev ${r.scene?.revision ?? "—"}`;
}

function RecordFacts({ r }: { readonly r: Results }) {
  const { scene, events, replay, camera } = r;
  return <>
    <dt>Camera</dt><dd>{camera?.calibrationId ?? "—"}{(camera?.renderers ?? []).map(name => <code key={name} className="rule">{name}</code>)}</dd>
    <dt>Scene</dt><dd>{sceneText(r)} · meta <Hash value={scene?.metaSha256 ?? scene?.metaCanonicalSha256} /></dd>
    <dt>Event log</dt><dd>{events?.count ?? "—"} events · <Hash value={events?.sha256} /></dd>
    <dt>Replay</dt><dd>{replay?.frames ?? "—"} frames · <Hash value={replay?.sha256} /></dd>
    <dt>Wall clock</dt><dd>{timingText(r)}<span className="muted"> · this machine; never read by the simulation</span></dd>
    <AssetFacts r={r} />
  </>;
}

function Facts({ bundle }: { readonly bundle: RunBundle }) {
  const r = bundle.results;
  if (r === null) return <p className="empty">No results.json: configuration, labels and hashes are unknown.</p>;
  return <dl className="facts run-facts"><ConfigFacts r={r} /><RecordFacts r={r} /></dl>;
}

function effectText(h: ActionHistory): string {
  if (h.effects === null) return "No effect recorded";
  const parts = [h.effects.waterDischargedL > 0 ? `${h.effects.waterDischargedL.toFixed(2)} L discharged` : null, h.effects.strikeDelivered ? "strike delivered" : null, h.effects.payloadReleased ? "payload released" : null].filter(Boolean);
  return parts.length === 0 ? "No physical effect" : parts.join(", ");
}

function History({ events }: { readonly events: RunBundle["events"] }) {
  const [all, setAll] = useState(false);
  const history = actionHistory(events);
  const shown = history.filter(h => all || h.consequential);
  return <>
    <div className="section-head">
      <h3>Actions and approvals <span className="muted">{shown.length} of {history.length} proposals</span></h3>
      <label className="check"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />Include routine movement and scans</label>
    </div>
    {shown.length === 0 ? <p className="empty">{history.length === 0 ? "No proposals in the event log." : "No glass, spray or payload proposals in this run."}</p> : <ol className="action-history">
      {shown.map(h => <li key={h.proposalId} data-consequential={h.consequential}>
        <div className="event-head">
          <strong>{ACTION_WORDS[h.actionKind] ?? h.actionKind}</strong>
          <code className="muted">{h.proposalId}</code>
          <span className={`tag status-${h.finalStatus}`}>{h.finalStatus.replace(/_/g, " ")}</span>
          <span className="muted">{h.proposer.replace(/_/g, " ")}{h.approvedBy !== null ? ` · approved by ${h.approvedBy}` : h.consequential ? " · no approval recorded" : ""}</span>
        </div>
        <ol className="step-list">
          {h.steps.map((s, i) => <li key={i}><span className="num event-time">{formatClock(s.tick)}</span> <span className="step-status">{s.status.replace(/_/g, " ")}</span> {s.ruleIds.map(rule => <code key={rule} className="rule">{rule}</code>)} <span className="muted">{s.reason}</span></li>)}
        </ol>
        {h.consequential && <p className="small muted">{effectText(h)}</p>}
      </li>)}
    </ol>}
  </>;
}

function originWords(origin: RunBundle["origin"]): string {
  if (origin.kind === "published") return `Published bundle${origin.label === null ? "" : ` “${origin.label}”`} (${origin.url})`;
  if (origin.kind === "atlas") return `Simulation run saved in MongoDB Atlas${origin.savedAt === null ? "" : ` on ${new Date(origin.savedAt).toLocaleString()}`}`;
  return `Loaded from ${origin.names.join(", ")}`;
}

export function RunDetail({ bundle, figures }: { readonly bundle: RunBundle; readonly figures: RunFigures }) {
  const origin = originWords(bundle.origin);
  return <section className="panel run-detail" aria-label={`Run ${figures.runId}`}>
    <h2>Run <code>{figures.runId}</code> <span className="muted">{origin}</span></h2>
    {bundle.problems.length > 0 && <ul className="problems" role="status">{bundle.problems.map(p => <li key={p}>{p}</li>)}</ul>}
    <div className="run-columns">
      <div>
        <OutcomeCard bundle={bundle} figures={figures} />
        <dl className="facts figures">
          <dt>Possible-occupant evidence</dt><dd className="num">{seconds(figures.timeToEvidenceS)} <span className="muted">after authorization (a lead, not a confirmed person)</span></dd>
          <dt>Exterior arrival</dt><dd className="num">{seconds(figures.timeToExitS)}</dd>
          <dt>Approvals · rejections</dt><dd className="num">{figures.approvals} · {figures.rejections}</dd>
          <dt>Aborts</dt><dd className="num">{figures.aborts}{figures.recalls > 0 && <span className="muted"> (+{figures.recalls} recall after arrival)</span>}</dd>
          <dt>Payload used</dt><dd className="num">{figures.waterDischargedL.toFixed(2)} L water · {figures.strikes} glass strike{figures.strikes === 1 ? "" : "s"} · {figures.payloadsReleased} release{figures.payloadsReleased === 1 ? "" : "s"}</dd>
        </dl>
      </div>
      <Facts bundle={bundle} />
    </div>
    <History events={bundle.events} />
  </section>;
}
