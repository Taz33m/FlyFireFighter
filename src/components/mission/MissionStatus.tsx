"use client";

import { useEffect, useState } from "react";
import type { MissionNotice, MissionUiState } from "@/hooks/useMissionWorker";
import type { MissionView } from "@/lib/mission/protocol";
import { formatSeconds } from "./format";

const CONTINGENCY_WORDS = { return: "Returning", alternate_route: "Alternate route", hold: "Bounded hold", land: "Landing", failure: "No supported maneuver" } as const;

const SOURCE_WORDS: Readonly<Record<MissionUiState["source"], string>> = { fixture: "UI fixture driver", worker: "Mission worker", starting: "Starting the mission worker" };

function Item({ label, value, detail, tone }: { readonly label: string; readonly value: string; readonly detail?: string | null; readonly tone?: string }) {
  return <div className="status-item">
    <span className="muted">{label}</span>
    <strong className={tone}>{value}</strong>
    {detail != null && <span className="muted small">{detail}</span>}
  </div>;
}

function waterText(view: MissionView | null): [string, string | null] {
  const water = view?.water;
  if (water == null || water.remainingL === null) return ["—", null];
  return [`${water.remainingL.toFixed(2)} L left`, water.dischargedL > 0 ? `${water.dischargedL.toFixed(2)} L discharged` : null];
}

function poseText(view: MissionView | null): [string, string | undefined] {
  const pose = view?.belief.pose;
  if (pose == null) return ["—", undefined];
  return pose.supported ? [`±${pose.sigmaM.toFixed(2)} m`, undefined] : [`Not supported (±${pose.sigmaM.toFixed(2)} m)`, "warn"];
}

export function StatusStrip({ view, source }: { readonly view: MissionView | null; readonly source: MissionUiState["source"] }) {
  const [water, discharged] = waterText(view);
  const [pose, poseTone] = poseText(view);
  const envelope = view?.envelope ?? null;
  return <div id="status-strip" tabIndex={-1} className="status-strip" role="group" aria-label="Mission status">
    <Item label="Run source" value={SOURCE_WORDS[source]} tone={source === "fixture" ? "fixture-text" : undefined} />
    <Item label="Mission planner" value={view?.decider.label ?? "—"} detail={view?.decider.status ?? null} />
    <Item label="Water" value={water} detail={discharged} tone="num" />
    <Item label="Position estimate" value={pose} tone={poseTone} />
    <Item label="Mission envelope" value={envelope === null ? "Not authorized" : `Revision ${envelope.revision}, until ${formatSeconds(envelope.endTick)}`} />
  </div>;
}

export function ContingencyBanner({ view }: { readonly view: MissionView | null }) {
  const contingency = view?.contingency ?? null;
  if (contingency === null) return null;
  return <div className="banner contingency" role="alert">
    <strong>{CONTINGENCY_WORDS[contingency.kind]}</strong>
    <span>{contingency.reason}</span>
    <span className="muted">{contingency.termination}</span>
  </div>;
}

export function Notices({ notices, dismiss }: { readonly notices: readonly MissionNotice[]; readonly dismiss: (id: number) => void }) {
  if (notices.length === 0) return null;
  return <div className="notices" role="status">
    {notices.map(n => <div key={n.id} className="notice">
      <strong>{n.origin === "worker" ? "Mission worker" : "Command UI"}</strong>
      <span>{n.message}</span>
      <button type="button" onClick={() => dismiss(n.id)} aria-label="Dismiss notice">Dismiss</button>
    </div>)}
  </div>;
}

/** Download links for an export_run reply; blob URLs are revoked when the export changes or unmounts. */
export function ExportLinks({ exportFiles }: { readonly exportFiles: MissionUiState["exportFiles"] }) {
  const [links, setLinks] = useState<readonly { readonly name: string; readonly url: string }[]>([]);
  useEffect(() => {
    if (exportFiles === null) return;
    const created = Object.entries(exportFiles.files).map(([name, text]) => ({ name, url: URL.createObjectURL(new Blob([text], { type: name.endsWith(".json") || name.endsWith(".jsonl") ? "application/json" : "text/plain" })) }));
    queueMicrotask(() => setLinks(created));
    return () => created.forEach(link => URL.revokeObjectURL(link.url));
  }, [exportFiles]);
  if (exportFiles === null || links.length === 0) return null;
  return <div className="banner export">
    <strong>Export ready</strong>
    <span className="muted">Run {exportFiles.runId}</span>
    {links.map(link => <a key={link.name} href={link.url} download={`${exportFiles.runId}-${link.name}`}>{link.name}</a>)}
  </div>;
}
