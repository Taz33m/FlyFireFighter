"use client";

import { useState } from "react";
import type { EventSource, MissionEvent } from "@/lib/contracts/events";
import { formatClock } from "./format";

const SOURCE_LABEL: Readonly<Record<EventSource, string>> = {
  commander: "Commander", harness: "Harness", planner: "Planner", decisions_gateway: "Decisions gateway", intake: "Report intake",
  evidence: "Evidence", sensor: "Sensor", motion: "Motion", simulator: "Simulator", evaluator: "Simulation evaluator", operator: "Operator", system: "System",
};

const VISIBLE = 80;

function kindWords(kind: string): string {
  const words = kind.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function EventBody({ event }: { readonly event: MissionEvent }) {
  return <>
    <div className="event-head">
      <span className="event-time num">{formatClock(event.tick)}</span>
      <strong>{SOURCE_LABEL[event.source]}</strong>
      <span className="muted">{kindWords(event.kind)}</span>
      {event.ruleIds.map(rule => <code key={rule} className="rule">{rule}</code>)}
    </div>
    <p>{event.reason}</p>
  </>;
}

/** Recorded replay: the same entry as a button that moves the playhead to it (phrasing content only, as a button requires). */
function SeekableEvent({ event, onSeek }: { readonly event: MissionEvent; readonly onSeek: (tick: number) => void }) {
  return <button type="button" className="event-seek" onClick={() => onSeek(event.tick)} aria-label={`Go to ${formatClock(event.tick)}: ${kindWords(event.kind)}`}>
    <span className="event-head">
      <span className="event-time num">{formatClock(event.tick)}</span>
      <strong>{SOURCE_LABEL[event.source] ?? event.source}</strong>
      <span className="muted">{kindWords(event.kind)}</span>
      {event.ruleIds.map(rule => <code key={rule} className="rule">{rule}</code>)}
    </span>
    <span className="event-reason">{event.reason}</span>
  </button>;
}

/**
 * The event log, newest first. Live, it shows the worker's events. A recorded replay passes the events up to
 * its playhead and `onSeek`, which makes each entry move the playhead to that event's tick.
 */
export function MissionTimeline({ events, onSeek }: { readonly events: readonly MissionEvent[]; readonly onSeek?: (tick: number) => void }) {
  const [filter, setFilter] = useState<"all" | "decisions">("all");
  const decisions = new Set<EventSource>(["commander", "harness", "planner", "decisions_gateway", "evaluator"]);
  const shown = events.filter(e => filter === "all" || decisions.has(e.source)).slice(-VISIBLE).reverse();
  return <section id="mission-timeline" tabIndex={-1} className="panel timeline" aria-label="Mission timeline">
    <h2>Mission timeline <span className="muted">{events.length} event{events.length === 1 ? "" : "s"}, newest first</span></h2>
    <div className="segmented small" role="radiogroup" aria-label="Show events">
      <button type="button" role="radio" aria-checked={filter === "all"} onClick={() => setFilter("all")}>All</button>
      <button type="button" role="radio" aria-checked={filter === "decisions"} onClick={() => setFilter("decisions")}>Decisions and outcomes</button>
    </div>
    {shown.length === 0 ? <p className="empty">Events appear here with the reason for each transition.</p> : <ol className="event-list">
      {shown.map((e, i) => <li key={e.seq} data-source={e.source} data-current={onSeek === undefined ? undefined : i === 0}>
        {onSeek === undefined ? <EventBody event={e} /> : <SeekableEvent event={e} onSeek={onSeek} />}
      </li>)}
    </ol>}
  </section>;
}
