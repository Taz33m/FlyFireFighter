"use client";

import { secondsFromTicks } from "@/lib/contracts/clock";
import type { FloorPlanPrior, RouteAssessment } from "@/lib/contracts/evidence";
import type { MissionResult } from "@/lib/contracts/outcomes";
import { rescueLabel } from "@/lib/contracts/outcomes";
import type { OccupancySummary } from "@/lib/evidence/summary";
import type { MissionView } from "@/lib/mission/protocol";
import type { MissionSource } from "@/hooks/useMissionWorker";
import { formatClock, formatSeconds, roomName } from "./format";
import { DRONE_RETURN_WORDS, OCCUPANT_OUTCOME_WORDS, PENDING_OUTCOME_WORDS, rescueWords } from "./outcome-words";
import { ORACLE_FIXTURE_TAG, trackMethodsText } from "./presenter";

/** Where an outcome came from: a live run, the UI fixture driver, or a recorded run bundle played back. */
export type OutcomeSource = MissionSource | "recording";

const SOURCE_TAG: Readonly<Record<OutcomeSource, string>> = {
  starting: "Simulation evaluator",
  worker: "Simulation evaluator",
  fixture: "UI fixture outcome, not an evaluator result",
  recording: "Simulation evaluator, recorded in the run bundle",
};

/**
 * The evaluator outcome, worded only from rescueLabel (outcome-words.ts). `live` is false for a second copy
 * (presenter view) so screen readers hear it once.
 */
export function Outcome({ outcome, source, live = true }: { readonly outcome: MissionResult | null; readonly source: OutcomeSource; readonly live?: boolean }) {
  if (outcome === null) {
    return <div className="outcome pending"><strong>{PENDING_OUTCOME_WORDS}</strong><span className="muted">Only the simulation evaluator can confirm that the occupant reached the assembly point.</span></div>;
  }
  const label = rescueLabel(outcome);
  return <div className={label === "simulated_evacuation_completed" ? "outcome done" : "outcome incomplete"} role={live ? "status" : undefined}>
    <span className={source === "fixture" ? "tag fixture" : "tag sim"}>{SOURCE_TAG[source]}</span>
    <strong>{rescueWords(label)}</strong>
    <ul>
      {outcome.occupants.map((o, i) => <li key={o.occupantKey}>Simulated occupant {i + 1} {OCCUPANT_OUTCOME_WORDS[o.outcome]}{o.arrivalTick !== null ? ` at ${formatClock(o.arrivalTick)}` : ""}</li>)}
      <li>{DRONE_RETURN_WORDS[outcome.droneReturn]}</li>
      <li>{outcome.violations.length === 0 ? "No scored constraint violations" : `${outcome.violations.length} scored constraint violation(s): ${outcome.violations.map(v => v.kind).join(", ")}`}</li>
    </ul>
  </div>;
}

function Reports({ occupancy, prior }: { readonly occupancy: OccupancySummary; readonly prior: FloorPlanPrior }) {
  if (occupancy.reports.length === 0) return <p className="empty">No reports yet.</p>;
  return <ul className="record-list">
    {occupancy.reports.map(r => <li key={r.reportId}>
      <q>{r.originalText}</q>
      <span className="muted">{r.source}, {r.channel}, received {formatSeconds(r.receivedTick)}{r.roomHint !== null ? `; room hint ${roomName(prior, r.roomHint)}` : "; no room recognised"}</span>
    </li>)}
  </ul>;
}

function Tracks({ occupancy, prior, tick }: { readonly occupancy: OccupancySummary; readonly prior: FloorPlanPrior; readonly tick: number }) {
  if (occupancy.possibleTracks.length === 0) return <p className="empty">None detected.</p>;
  return <ul className="record-list">
    {occupancy.possibleTracks.map(t => <li key={t.trackId}>
      <strong>{roomName(prior, t.roomId)}</strong>
      <span className="num">±{t.uncertaintyM.toFixed(2)} m, confidence {t.confidence.toFixed(2)}, last seen {secondsFromTicks(tick - t.lastSeenTick).toFixed(1)} s ago, {t.observationIds.length} observation{t.observationIds.length === 1 ? "" : "s"}</span>
      <span className="track-method">
        <span className={t.detectionMethods.length === 0 ? "muted" : undefined}>{trackMethodsText(t)}</span>
        {t.includesOracleFixture && <span className="tag fixture">{ORACLE_FIXTURE_TAG}</span>}
      </span>
      {t.ambiguousWith.length > 0 && <span className="warn">May be the same person as {t.ambiguousWith.join(", ")}</span>}
    </li>)}
  </ul>;
}

function Crew({ occupancy, prior }: { readonly occupancy: OccupancySummary; readonly prior: FloorPlanPrior }) {
  if (occupancy.crewLocated.length === 0) return <p className="empty">No crew confirmations.</p>;
  return <ul className="record-list">
    {occupancy.crewLocated.map(c => <li key={c.id}><q>{c.text}</q><span className="muted">{c.crewId}, {roomName(prior, c.roomId)}, {formatSeconds(c.tick)}</span></li>)}
  </ul>;
}

function Coverage({ occupancy, prior }: { readonly occupancy: OccupancySummary; readonly prior: FloorPlanPrior }) {
  const names = (ids: readonly string[]) => ids.map(id => roomName(prior, id)).join(", ") || "—";
  return <dl className="facts coverage">
    <dt>Observed</dt><dd>{names(occupancy.roomsByCoverage.observed)}</dd>
    <dt>Degraded</dt><dd>{names(occupancy.roomsByCoverage.degraded)}</dd>
    <dt>Unobserved</dt><dd>{names(occupancy.roomsByCoverage.unobserved)}</dd>
  </dl>;
}

function Routes({ routes, tick }: { readonly routes: readonly RouteAssessment[]; readonly tick: number }) {
  if (routes.length === 0) return null;
  return <>
    <h3>Route assessments</h3>
    <ul className="record-list">
      {routes.map(r => <li key={r.id}>
        <strong className={r.status === "supported" ? "ok" : "warn"}>{r.purpose} route {r.status}</strong>
        <span className="muted">assessed {secondsFromTicks(tick - r.assessedTick).toFixed(1)} s ago: {r.reason}</span>
      </li>)}
    </ul>
  </>;
}

function Evidence({ view }: { readonly view: MissionView }) {
  const prior = view.belief.mapPrior;
  return <>
    <h3>Reports, in the reporter&apos;s words</h3>
    <Reports occupancy={view.occupancy} prior={prior} />
    <h3>Possible occupants <span className="muted">detections, not confirmed people</span></h3>
    <Tracks occupancy={view.occupancy} prior={prior} tick={view.tick} />
    <h3>Crew-located</h3>
    <Crew occupancy={view.occupancy} prior={prior} />
    <h3>Rooms by observation coverage <span className="muted">an observed room is not an empty room</span></h3>
    <Coverage occupancy={view.occupancy} prior={prior} />
    <Routes routes={view.belief.routes} tick={view.tick} />
  </>;
}

export function RescueRecord({ view, outcome, source }: { readonly view: MissionView | null; readonly outcome: MissionResult | null; readonly source: MissionSource }) {
  return <section id="rescue-record" tabIndex={-1} className="panel rescue" aria-label="Rescue record">
    <h2>Rescue record</h2>
    <p className="unresolved">Occupancy unresolved — no automatic all-clear</p>
    <Outcome outcome={outcome} source={source} />
    {view === null ? <p className="empty">Reports, possible occupants and coverage appear once a run starts.</p> : <Evidence view={view} />}
  </section>;
}
