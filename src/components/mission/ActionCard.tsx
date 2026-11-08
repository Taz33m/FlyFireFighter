"use client";

import { useEffect, useRef, useState } from "react";
import type { ActionSpec, Proposer, ProposalRecord } from "@/lib/contracts/actions";
import { AIRCRAFT_PROFILES } from "@/lib/contracts/aircraft";
import { secondsFromTicks } from "@/lib/contracts/clock";
import type { MissionView, UiCommand } from "@/lib/mission/protocol";
import { actionTarget, actionTitle, describeRegion, formatSeconds, formatVec, openingName, statusWord } from "./format";
import { APPROVAL_ARMING_MS, approveCommand, rejectCommand } from "./approval";
import { COMMANDER_KEYS } from "./commander-keys";
import { decisionSummary } from "./presenter";

const PROPOSER_LABEL: Readonly<Record<Proposer, string>> = { decisions_planner: "OpenAI Decisions", gemini_planner: "Gemini", consensus_planner: "Consensus: OpenAI Decisions + Gemini", local_planner: "Local planner", operator: "Operator", contingency: "Contingency" };

function modeledEffect(action: ActionSpec, view: MissionView): string {
  const profile = AIRCRAFT_PROFILES.find(p => p.id === view.config.aircraftId);
  switch (action.kind) {
    case "breach_opening": {
      const debris = profile?.modules.glassBreaker?.debrisRadiusM;
      return `Breaks the glass of the ${openingName(view.belief.mapPrior, action.openingId)}. Glass debris may land within ${debris === undefined ? "the harness-derived radius" : `${debris} m`} of the strike point. The opening stays broken after an abort and changes the modeled ventilation.`;
    }
    case "spray": {
      const seconds = secondsFromTicks(action.durationTicks);
      const nozzle = profile?.modules.water?.nozzleDiameterMm ?? null;
      const reaction = nozzle === null ? null : 1000 * (action.flowLps / 1000) * ((action.flowLps / 1000) / (Math.PI * ((nozzle / 2000) ** 2)));
      return `Discharges ${(action.flowLps * seconds).toFixed(2)} L (${action.flowLps} L/s for ${seconds.toFixed(1)} s) toward ${formatVec(action.aimPoint)}${reaction === null ? "" : `, with about ${reaction.toFixed(1)} N of jet reaction`}. The simulated fire changes only through the suppression model, and the exit route must be reassessed afterwards.`;
    }
    case "release_payload": return `Releases ${action.payloadId} at ${formatVec(action.releasePoint)}. Release does not establish that anyone received or used it.`;
    default: return "Routine action inside the approved mission envelope.";
  }
}

function payloadCost(action: ActionSpec, view: MissionView): string {
  if (action.kind === "spray") {
    const dose = action.flowLps * secondsFromTicks(action.durationTicks);
    const remaining = view.water.remainingL;
    return remaining === null ? `${dose.toFixed(2)} L of water; remaining water is unknown` : `${dose.toFixed(2)} L of ${remaining.toFixed(2)} L remaining (leaves ${Math.max(0, remaining - dose).toFixed(2)} L)`;
  }
  if (action.kind === "breach_opening") return "No consumables. Broken glass cannot be restored.";
  if (action.kind === "release_payload") return `Payload ${action.payloadId}`;
  return "None";
}

function Evidence({ record, view }: { readonly record: ProposalRecord; readonly view: MissionView }) {
  const cited = record.proposal.citedEvidence;
  if (cited.length === 0) return <p className="empty">No observations cited.</p>;
  return <ul className="evidence-list">
    {cited.map(id => {
      const obs = view.belief.observations.find(o => o.id === id);
      if (obs === undefined) return <li key={id}><code>{id}</code> <span className="warn">not in the current evidence window</span></li>;
      const age = secondsFromTicks(view.tick - obs.captureTick);
      return <li key={id}>
        <span className="evidence-age num">{age.toFixed(1)} s old</span>
        <span>{obs.modality} <span className="muted">quality {obs.quality.toFixed(2)}</span></span>
        <span className={obs.provenance === "simulated_sensor" ? "tag sim" : "tag fixture"}>{obs.provenance === "simulated_sensor" ? "simulated sensor" : obs.provenance}</span>
        <code className="muted">{id}</code>
      </li>;
    })}
  </ul>;
}

/** The harness's own validation note: it carries the breach coverage and the spray's extinguishing-agent (H19) disclosures. */
function HarnessNote({ record }: { readonly record: ProposalRecord }) {
  const validation = [...record.history].reverse().find(entry => entry.status === "awaiting_approval")?.reason ?? null;
  return validation === null ? null : <><dt>Harness</dt><dd>{validation}</dd></>;
}

interface Props {
  readonly view: MissionView | null;
  readonly send: (command: UiCommand) => void;
}

function PendingDecision({ record, view, send }: { readonly record: ProposalRecord; readonly view: MissionView; readonly send: Props["send"] }) {
  const { proposal } = record;
  const [armedDigest, setArmedDigest] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setArmedDigest(proposal.digest), APPROVAL_ARMING_MS);
    return () => clearTimeout(timer);
  }, [proposal.digest]);
  const armed = armedDigest === proposal.digest;
  const region = view.affectedRegions.find(r => r.proposalId === proposal.id)?.region ?? null;
  const target = actionTarget(proposal.action);
  const remaining = proposal.expiresTick - view.tick;

  return <article className="decision" aria-labelledby="decision-title">
    <div className="decision-meta">
      <span className={record.risk === "consequential" ? "tag warn" : "tag"}>{record.risk === "consequential" ? "Needs your approval" : "Routine"}</span>
      <span className="muted">Proposed by {PROPOSER_LABEL[proposal.proposer]} at {formatSeconds(proposal.createdTick)}</span>
    </div>
    <h3 id="decision-title" className="decision-title">{actionTitle(proposal.action, view.belief.mapPrior)}</h3>
    <dl className="facts">
      <dt>Target</dt><dd>{target === null ? "—" : formatVec(target)}</dd>
      <dt>Why</dt><dd>{proposal.rationale}</dd>
      <dt>Evidence</dt><dd><Evidence record={record} view={view} /></dd>
      <dt>Modeled effect</dt><dd>{modeledEffect(proposal.action, view)}</dd>
      <dt>Payload cost</dt><dd>{payloadCost(proposal.action, view)}</dd>
      <dt>Affected region</dt><dd>{region === null ? "Not reported by the harness" : describeRegion(region)}</dd>
      <dt>Constraints</dt>
      <dd>
        <span className={remaining < 1000 ? "warn" : undefined}>Proposal expires in {formatSeconds(Math.max(0, remaining))} of mission time.</span>{" "}
        {record.findings.length === 0 ? "No harness findings at submission; checks repeat before and during execution." : null}
        {record.findings.length > 0 && <ul className="findings">{record.findings.map((f, i) => <li key={i}><code>{f.ruleId}</code> {f.reason}</li>)}</ul>}
      </dd>
      <HarnessNote record={record} />
      <dt>Digest</dt><dd><code title={proposal.digest}>{proposal.digest.slice(0, 16)}…</code> <span className="muted">your approval binds to this exact proposal</span></dd>
    </dl>
    <div className="decision-actions">
      {/* aria-disabled (not disabled) while arming, so the button keeps its place in the tab order. */}
      <button type="button" className="primary approve" aria-disabled={!armed} aria-describedby={armed ? undefined : "approve-arming"} aria-keyshortcuts={COMMANDER_KEYS.approve} onClick={() => armed && send(approveCommand(view, record))}>
        {armed ? "Approve" : "Review…"}
      </button>
      {!armed && <span id="approve-arming" className="sr-only">Approve becomes available after a short review delay.</span>}
      <button type="button" className="reject" aria-keyshortcuts={COMMANDER_KEYS.reject} onClick={() => send(rejectCommand(view, record, reason))}>Reject</button>
      <input aria-label="Reason for rejecting (optional)" placeholder="Reason for rejecting (optional)" value={reason} onChange={e => setReason(e.target.value)} />
    </div>
  </article>;
}

const NEXT_STEP: Readonly<Record<string, string>> = {
  awaiting_report: "Record the incident report to set the search priority.",
  awaiting_authorization: "Authorize the mission in the top bar to let the drone fly inside the approved envelope.",
  running: "No decision is waiting. Movement and scanning continue autonomously inside the envelope.",
  paused: "The run is paused; the mission clock is frozen.",
  aborted: "The mission was aborted. Completed effects stay recorded.",
  ended: "The run has ended.",
};

function RecentDecisions({ records, view }: { readonly records: readonly ProposalRecord[]; readonly view: MissionView | null }) {
  if (records.length === 0) return null;
  return <ul className="recent-decisions" aria-label="Recent decisions">
    {records.map(r => {
      const summary = decisionSummary(r);
      const stopped = r.status === "invalidated" || r.status === "aborted" || r.status === "expired" || r.status === "rejected";
      return <li key={r.proposal.id}>
        <div className="recent-head"><span>{actionTitle(r.proposal.action, view?.belief.mapPrior)}</span><span className={`tag status-${r.status}`}>{statusWord(r.status)}</span></div>
        {stopped && summary.reason !== null && <p className="recent-reason">{summary.ruleIds.map(rule => <code key={rule} className="rule">{rule}</code>)} {summary.reason}</p>}
        {r.proposal.action.kind === "spray" && summary.dischargedL !== null && <p className="recent-reason muted num">{summary.dischargedL.toFixed(2)} L discharged before execution ended</p>}
        {r.proposal.action.kind === "spray" && summary.dischargedL === null && stopped && <p className="recent-reason muted">No water discharged: execution never started.</p>}
      </li>;
    })}
  </ul>;
}

/** What a screen reader hears when the card changes: the waiting decision, else the latest decision's status. */
function announcement(view: MissionView | null, pending: ProposalRecord | null, latest: ProposalRecord | undefined): string {
  if (view === null) return "";
  if (pending !== null) return `Decision waiting for your approval: ${actionTitle(pending.proposal.action, view.belief.mapPrior)}. Proposed by ${PROPOSER_LABEL[pending.proposal.proposer]}.`;
  if (latest !== undefined) return `${actionTitle(latest.proposal.action, view.belief.mapPrior)}: ${statusWord(latest.status)}.`;
  return "";
}

export function ActionCard({ view, send }: Props) {
  const pending = view?.pendingApproval ?? null;
  const recent = (view?.proposals ?? []).filter(r => r.risk === "consequential" && r.status !== "awaiting_approval").slice(-3).reverse();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusInside = useRef(false);
  const pendingId = pending?.proposal.id ?? null;
  // When the decision the commander was working on resolves, its buttons disappear; keep focus in the card.
  useEffect(() => {
    if (focusInside.current && (document.activeElement === null || document.activeElement === document.body)) headingRef.current?.focus();
  }, [pendingId]);
  return <section
    id="action-card"
    tabIndex={-1}
    className="panel action-card"
    aria-labelledby="action-card-title"
    data-pending={pending !== null}
    onFocus={() => { focusInside.current = true; }}
    onBlur={e => { if (e.relatedTarget !== null && !e.currentTarget.contains(e.relatedTarget as Node)) focusInside.current = false; }}
  >
    <h2 id="action-card-title" ref={headingRef} tabIndex={-1}>Command decision</h2>
    <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement(view, pending, recent[0])}</p>
    {view === null && <p className="empty">Start a run to receive an incident report.</p>}
    {view !== null && pending !== null && <PendingDecision key={pending.proposal.id} record={pending} view={view} send={send} />}
    {view !== null && pending === null && <p className="empty">{NEXT_STEP[view.status]}</p>}
    <RecentDecisions records={recent} view={view} />
  </section>;
}
