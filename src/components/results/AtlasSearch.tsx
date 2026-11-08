"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { formatClock } from "@/components/mission/format";
import type { AtlasSearchReply, SearchHighlight } from "./atlas-wire";
import { SEARCH_QUERY_MAX } from "./atlas-wire";
import { searchAtlas } from "./atlas-client";

type State = { readonly state: "idle" } | { readonly state: "searching" } | AtlasSearchReply;

/** Atlas Search highlights when present; otherwise the query's words marked in the plain text. */
function Marked({ text, query, highlights }: { readonly text: string; readonly query: string; readonly highlights: readonly SearchHighlight[] }): ReactNode {
  const texts = highlights[0]?.texts;
  if (texts !== undefined && texts.length > 0) return <>{texts.map((t, i) => (t.type === "hit" ? <mark key={i}>{t.value}</mark> : <span key={i}>{t.value}</span>))}</>;
  const words = query.split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.join("|")})`, "gi");
  return <>{text.split(pattern).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>;
}

function modeLine(reply: Extract<AtlasSearchReply, { status: "ok" }>): string {
  const how = reply.mode === "atlas_search" ? "Atlas Search (fuzzy full text, ranked by relevance)" : "plain text match (Atlas Search index not in use)";
  return `${reply.events.length} event${reply.events.length === 1 ? "" : "s"} and ${reply.decisions.length} planner decision${reply.decisions.length === 1 ? "" : "s"} · ${how}${reply.note === null ? "" : `. ${reply.note}`}`;
}

function Results({ reply, query, onOpen }: { readonly reply: Extract<AtlasSearchReply, { status: "ok" }>; readonly query: string; readonly onOpen: (runId: string) => void }) {
  return <>
    <p className="small muted" role="status">{modeLine(reply)}</p>
    {reply.decisions.length > 0 && <><h4>Planner decisions</h4>
      <ol className="event-list">{reply.decisions.map(d => <li key={`${d.runId}:${d.seq}`} data-source="planner">
        <span className="event-head"><span className="event-time num">{formatClock(d.tick)}</span><button type="button" className="link-button" onClick={() => onOpen(d.runId)}>{d.runId}</button><span className="muted">{d.decider ?? "planner"}{d.candidateId === null ? "" : ` → ${d.candidateId}`}</span></span>
        <span className="event-reason"><Marked text={d.rationale} query={query} highlights={d.highlights} /></span>
      </li>)}</ol></>}
    {reply.events.length > 0 && <><h4>Mission events</h4>
      <ol className="event-list">{reply.events.map(e => <li key={`${e.runId}:${e.seq}`} data-source={e.source}>
        <span className="event-head"><span className="event-time num">{formatClock(e.tick)}</span><button type="button" className="link-button" onClick={() => onOpen(e.runId)}>{e.runId}</button><strong>{e.source.replace(/_/g, " ")}</strong><span className="muted">{e.kind}</span></span>
        <span className="event-reason"><Marked text={e.reason} query={query} highlights={e.highlights} /></span>
      </li>)}</ol></>}
  </>;
}

/** Search the saved mission logs (event reasons and planner rationales) across all Atlas runs. */
export function AtlasSearch({ onOpen }: { readonly onOpen: (runId: string) => void }) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [state, setState] = useState<State>({ state: "idle" });
  const submit = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setAsked(q);
    setState({ state: "searching" });
    setState(await searchAtlas(q, null));
  };
  return <div className="atlas-search">
    <h3>Search mission logs <span className="muted">event reasons and planner rationales in every saved simulation run</span></h3>
    <form role="search" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input type="search" value={query} maxLength={SEARCH_QUERY_MAX} placeholder="e.g. kitchen fire, breach, smoke" aria-label="Search mission logs" onChange={e => setQuery(e.target.value)} />
      <button type="submit" disabled={query.trim().length < 2 || ("state" in state && state.state === "searching")}>Search</button>
    </form>
    {"state" in state && state.state === "searching" && <p className="small muted" role="status">Searching…</p>}
    {"status" in state && state.status === "ok" && <Results reply={state} query={asked} onOpen={onOpen} />}
    {"status" in state && state.status !== "ok" && <p className="small warn" role="status">{state.message}</p>}
  </div>;
}
