/**
 * Decision broker for the mission worker: pure TypeScript, no DOM, Next or network dependency.
 *
 * - The run asks one cloud decider (BrokerOptions.cloudDecider): OpenAI Decisions, Gemini or "consensus"
 *   (both over the same request). At most one request is in flight. A planning event that arrives meanwhile becomes the single
 *   pending set (the newest replaces any older one) and is sent when the in-flight request settles.
 * - Every request carries the run id, a request id and the evidence revision of the set it offers. A reply
 *   counts only if it answers the in-flight request of the current run, echoes those ids and names one of
 *   the offered candidates. Replies for another run, a superseded set, after the deadline or naming an
 *   unknown candidate are discarded and recorded.
 * - Refusal, an invalid or unknown choice, timeout, error, an unconfigured server or a `defer` answer all
 *   fall back to the local planner's choice. An "unconfigured" reply switches the run to local planning.
 * - Consensus: the broker re-derives agreement from the two per-provider proposals in the reply (never from
 *   its top-level choice). Only when OpenAI Decisions and Gemini chose the same offered id is the choice
 *   used, attributed to "consensus"; disagreement or any provider failure gives the local planner's choice,
 *   labelled "Local planner (consensus not reached: …)". Both proposals are kept in the record.
 * - A reply must name the decider that was asked; a cloud decider is credited only for a choice it made.
 * - Either way the chosen id resolves to the application's own immutable proposal, only re-attributed to
 *   its decider. It goes to the harness like any other proposal: the decider never changes risk class,
 *   approval requirements or authority.
 *
 * Wall-clock time is passed in (`nowMs`, monotonic) so deadlines are testable without timers; decision
 * content depends only on the candidate set, the belief and the reply.
 */
import type { ProposalInput, Proposer, RiskClass } from "../../contracts/actions.ts";
import type { Tick } from "../../contracts/clock.ts";
import type { MissionEventInput } from "../../contracts/events.ts";
import type { BeliefSnapshot } from "../../contracts/evidence.ts";
import type { RunId } from "../../contracts/ids.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import type { HarnessPolicy } from "../../harness/policy.ts";
import { DEFAULT_POLICY, riskClassOf } from "../../harness/policy.ts";
import { resolveCandidate } from "./candidates.ts";
import { summarizeEvidence } from "./evidence-summary.ts";
import { consensusOf, parseGatewayResponse } from "./gateway.ts";
import type { LocalPlan } from "./local-planner.ts";
import { rankCandidates } from "./local-planner.ts";
import { clip } from "./text.ts";
import type { CandidateSet, CandidateTool, CloudDecider, ConsensusAgreement, Decider, DecisionGatewayRequest, DecisionGatewayResponse, DecisionProvider, DecisionStatus, MissionCandidate, ProviderProposal, ProviderStatus } from "./types.ts";
import { DECIDER_LABELS, DECISION_DEADLINE_MS, MAX_OFFERED_CANDIDATES } from "./types.ts";

/** One decision, ready for the event log and for submission of its proposal to the harness. */
export interface DecisionRecord {
  readonly runId: RunId;
  /** The request this decision answers (a local-only decision gets its own id). */
  readonly requestId: string;
  readonly evidenceRevision: number;
  /** Tick of the candidate set. */
  readonly tick: Tick;
  readonly decider: Decider;
  readonly candidateId: string;
  readonly tool: CandidateTool;
  readonly description: string;
  /** The application's proposal for the candidate, attributed to the decider; null for defer and review. */
  readonly proposal: ProposalInput | null;
  /** Harness classification of the action kind (riskClassOf). Informative: the harness decides again. */
  readonly risk: RiskClass | null;
  /** Glass, water and payload actions wait for the commander's individual approval, whoever chose them. */
  readonly requiresCommanderApproval: boolean;
  /** Status of the cloud request, or null when none was made. */
  readonly gatewayStatus: DecisionStatus | null;
  /** Why the local planner decided; null when a cloud decider's choice was used. */
  readonly fallbackReason: string | null;
  /**
   * The cloud request behind this decision, for the commander and the decisions collection: the decider
   * asked, each provider's own proposal (both for consensus; empty when no reply carried any) and, for
   * consensus, whether they agreed. Null (or absent in older records) when no cloud request was made.
   */
  readonly cloud?: CloudAudit | null;
  /** The local planner's choice for the same set, kept for audit. */
  readonly localChoiceId: string;
  readonly latencyMs: number | null;
}

export interface CloudAudit {
  readonly decider: CloudDecider;
  readonly proposals: readonly ProviderProposal[];
  readonly agreement: ConsensusAgreement | null;
}

export type DiscardReason = "other_run" | "superseded" | "late" | "unknown_request" | "mismatched_reply" | "unknown_candidate";

export interface DiscardedReply {
  readonly runId: RunId;
  readonly requestId: string;
  readonly reason: DiscardReason;
  readonly detail: string;
}

/** What the caller must do after a broker call. */
export interface BrokerStep {
  /** Transmit this request now; it is the only one in flight. */
  readonly send: DecisionGatewayRequest | null;
  /** Abort the transport of these requests; any reply to them will be discarded. */
  readonly abort: readonly string[];
  readonly decisions: readonly DecisionRecord[];
  readonly discarded: readonly DiscardedReply[];
}

export interface BrokerOptions {
  readonly runId: RunId;
  /** False keeps every decision local: no key configured, offline rehearsal or recorded batch evaluation. */
  readonly cloudEnabled: boolean;
  /** Which cloud decider requests go to when cloud planning is enabled; defaults to OpenAI Decisions. */
  readonly cloudDecider?: CloudDecider;
  readonly deadlineMs?: number;
  readonly policy?: HarnessPolicy;
}

interface Planned {
  readonly set: CandidateSet;
  readonly belief: BeliefSnapshot;
  readonly plan: LocalPlan;
}

interface InFlight extends Planned {
  readonly request: DecisionGatewayRequest;
  readonly offered: ReadonlySet<string>;
  readonly sentAtMs: number;
  readonly deadlineAtMs: number;
}

interface Retired {
  readonly runId: RunId;
  readonly reason: "answered" | "timeout" | "reset";
}

const MAX_RETIRED = 32;
const EMPTY_STEP: BrokerStep = deepFreeze({ send: null, abort: [], decisions: [], discarded: [] });

export class DecisionBroker {
  readonly deadlineMs: number;
  readonly cloudDecider: CloudDecider;
  private readonly policy: HarnessPolicy;
  private readonly configuredCloud: boolean;
  private currentRunId: RunId;
  private cloudEnabled: boolean;
  private sequence = 0;
  private inFlight: InFlight | null = null;
  private pending: Planned | null = null;
  private latestRevision = -1;
  private readonly retired = new Map<string, Retired>();

  constructor(options: BrokerOptions) {
    this.currentRunId = options.runId;
    this.configuredCloud = options.cloudEnabled;
    this.cloudEnabled = options.cloudEnabled;
    this.cloudDecider = options.cloudDecider ?? "openai_decisions";
    this.deadlineMs = options.deadlineMs ?? DECISION_DEADLINE_MS;
    this.policy = options.policy ?? DEFAULT_POLICY;
  }

  get runId(): RunId {
    return this.currentRunId;
  }

  /** Whether planning events are currently sent to the cloud decider. */
  get cloudActive(): boolean {
    return this.cloudEnabled;
  }

  get requestInFlight(): string | null {
    return this.inFlight?.request.requestId ?? null;
  }

  get deadlineAtMs(): number | null {
    return this.inFlight?.deadlineAtMs ?? null;
  }

  /** A planning event: a fresh candidate set built from `belief`. */
  plan(set: CandidateSet, belief: BeliefSnapshot, nowMs: number): BrokerStep {
    if (set.runId !== this.currentRunId || belief.runId !== this.currentRunId) {
      throw new RangeError(`Planning for run ${set.runId} reached the broker for run ${this.currentRunId}; reset the broker for a new run first.`);
    }
    if (set.evidenceRevision < this.latestRevision) return EMPTY_STEP;
    this.latestRevision = set.evidenceRevision;
    const planned: Planned = { set, belief, plan: rankCandidates(set, belief, this.policy) };
    if (!this.cloudEnabled) {
      return step({ decisions: [this.localDecision(planned, this.nextId(), null, `${CLOUD_SUBJECTS[this.cloudDecider]} is not active for this run; the local planner decided.`, null, null)] });
    }
    if (this.inFlight !== null) {
      // The newest planning call wins: it either repeats the in-flight set or replaces any older pending one.
      this.pending = sameSet(this.inFlight.set, set) ? null : planned;
      return EMPTY_STEP;
    }
    return this.start(planned, nowMs, EMPTY_STEP);
  }

  /** A reply body for `requestId`, as received from the transport. */
  receive(requestId: string, body: unknown, nowMs: number): BrokerStep {
    const flight = this.inFlight;
    if (flight === null || flight.request.requestId !== requestId) return step({ discarded: [this.unexpectedReply(requestId, body)] });
    return this.settle(flight, parseGatewayResponse(body), nowMs);
  }

  /** The transport failed (network error, unreadable reply) for `requestId`. */
  fail(requestId: string, nowMs: number): BrokerStep {
    const flight = this.inFlight;
    if (flight === null || flight.request.requestId !== requestId) return EMPTY_STEP;
    return this.settle(flight, "transport_error", nowMs);
  }

  /** Enforce the deadline. Call when the deadline timer fires (calling early is harmless). */
  poll(nowMs: number): BrokerStep {
    const flight = this.inFlight;
    if (flight === null || nowMs < flight.deadlineAtMs) return EMPTY_STEP;
    this.inFlight = null;
    this.retire(flight.request.requestId, "timeout");
    const abort = [flight.request.requestId];
    if (this.pending !== null) return this.startPending(nowMs, step({ abort }));
    const reason = this.why(`${CLOUD_SUBJECTS[this.cloudDecider]} did not answer within ${this.deadlineMs} ms`, `no reply within ${this.deadlineMs} ms`);
    return step({ abort, decisions: [this.localDecision(flight, flight.request.requestId, "timeout", reason, nowMs - flight.sentAtMs, this.audit([]))] });
  }

  /** A new run: every outstanding request, pending set and late reply of the old run is void. */
  reset(runId: RunId): BrokerStep {
    const abort: string[] = [];
    if (this.inFlight !== null) {
      abort.push(this.inFlight.request.requestId);
      this.retire(this.inFlight.request.requestId, "reset");
    }
    this.inFlight = null;
    this.pending = null;
    this.latestRevision = -1;
    this.currentRunId = runId;
    this.cloudEnabled = this.configuredCloud;
    return step({ abort });
  }

  private settle(flight: InFlight, reply: DecisionGatewayResponse | null | "transport_error", nowMs: number): BrokerStep {
    this.inFlight = null;
    this.retire(flight.request.requestId, "answered");
    if (this.pending !== null) {
      const detail = `The candidate set of evidence revision ${flight.set.evidenceRevision} was superseded while the request was in flight.`;
      return this.startPending(nowMs, step({ discarded: [this.discard(flight.request.requestId, "superseded", detail)] }));
    }
    return this.judge(flight, reply, nowMs - flight.sentAtMs);
  }

  private judge(flight: InFlight, reply: DecisionGatewayResponse | null | "transport_error", latencyMs: number): BrokerStep {
    const requestId = flight.request.requestId;
    const fallback = (status: DecisionStatus, reason: string, discarded: DiscardedReply[] = [], cloud: CloudAudit = this.audit([])): BrokerStep =>
      step({ decisions: [this.localDecision(flight, requestId, status, reason, latencyMs, cloud)], discarded });
    const subject = CLOUD_SUBJECTS[this.cloudDecider];
    if (reply === "transport_error") return fallback("error", this.why(`The ${subject} request failed`, "the request failed"));
    if (reply === null) return fallback("error", this.why(`The ${subject} reply was malformed`, "the reply was malformed"));
    if (reply.runId !== flight.request.runId) {
      return fallback("error", this.why(`The ${subject} reply named another run`, "the reply named another run"), [this.discard(requestId, "other_run", `The reply named run ${clip(reply.runId, 64)}.`)]);
    }
    if (reply.requestId !== requestId || reply.evidenceRevision !== flight.request.evidenceRevision) {
      return fallback("error", this.why(`The ${subject} reply did not echo this request`, "the reply did not echo this request"), [this.discard(requestId, "mismatched_reply", "The reply's request id or evidence revision differs from the request.")]);
    }
    if (reply.decider !== this.cloudDecider) {
      const detail = `The reply came from ${clip(reply.decider, 32)}, not the requested ${this.cloudDecider}.`;
      return fallback("error", this.why(`The ${subject} reply came from another decider`, "the reply came from another decider"), [this.discard(requestId, "mismatched_reply", detail)]);
    }
    return this.cloudDecider === "consensus" ? this.judgeConsensus(flight, reply, latencyMs, fallback) : this.judgeStatus(flight, reply, this.cloudDecider, latencyMs, fallback);
  }

  private judgeStatus(flight: InFlight, reply: DecisionGatewayResponse, provider: DecisionProvider, latencyMs: number, fallback: Fallback): BrokerStep {
    // The record keeps what this reply said for the asked provider; a single-provider reply cannot claim "no_consensus".
    const status: ProviderStatus = reply.status === "no_consensus" ? "error" : reply.status;
    const cloud = this.audit([{ provider, choice: status === "ok" ? reply.choice : null, status }]);
    const name = DECIDER_LABELS[provider];
    if (status !== "ok") {
      if (status === "unconfigured") this.cloudEnabled = false;
      return fallback(status, providerFallbackReason(name, status), [], cloud);
    }
    const candidate = reply.choice !== null && flight.offered.has(reply.choice) ? resolveCandidate(flight.set, reply.choice) : null;
    if (candidate === null) {
      const discard = this.discard(flight.request.requestId, "unknown_candidate", `The reply chose ${JSON.stringify(clip(reply.choice ?? "", 64))}, which was not offered.`);
      return fallback("invalid", `${name} chose a candidate that was not offered; the local planner decided.`, [discard], this.audit([{ provider, choice: null, status: "invalid" }]));
    }
    if (candidate.tool === "defer") return fallback("ok", `${name} deferred; the local planner decided.`, [], cloud);
    return step({ decisions: [decisionRecord(flight, flight.request.requestId, candidate, provider, { gatewayStatus: "ok", fallbackReason: null, latencyMs, cloud })] });
  }

  private judgeConsensus(flight: InFlight, reply: DecisionGatewayResponse, latencyMs: number, fallback: Fallback): BrokerStep {
    const requestId = flight.request.requestId;
    if (reply.proposals.length === 0) {
      // Refused or throttled before any upstream call: the reply carries no proposal to judge.
      return fallback("error", this.why("", "the decisions route answered without proposals"), [], this.audit([], "incomplete"));
    }
    const discarded: DiscardedReply[] = [];
    // A proposal naming an id that was not offered is recorded as invalid, never as a choice.
    const proposals = reply.proposals.map((proposal): ProviderProposal => {
      if (proposal.status !== "ok") return { provider: proposal.provider, choice: null, status: proposal.status };
      if (proposal.choice !== null && flight.offered.has(proposal.choice)) return proposal;
      discarded.push(this.discard(requestId, "unknown_candidate", `${DECIDER_LABELS[proposal.provider]} chose ${JSON.stringify(clip(proposal.choice ?? "", 64))}, which was not offered.`));
      return { provider: proposal.provider, choice: null, status: "invalid" };
    });
    if (proposals.some(proposal => proposal.status === "unconfigured")) this.cloudEnabled = false;
    const consensus = consensusOf(proposals, flight.offered);
    const cloud = this.audit(proposals, consensus.agreement);
    const candidate = consensus.choice === null ? null : resolveCandidate(flight.set, consensus.choice);
    if (candidate === null) return fallback("no_consensus", `Local planner (consensus not reached: ${consensusDetail(proposals, consensus.agreement)}).`, discarded, cloud);
    if (candidate.tool === "defer") return fallback("ok", "Local planner (OpenAI Decisions and Gemini both deferred).", discarded, cloud);
    return step({ decisions: [decisionRecord(flight, requestId, candidate, "consensus", { gatewayStatus: "ok", fallbackReason: null, latencyMs, cloud })], discarded });
  }

  /** A fallback reason: the single-provider sentence, or the consensus label "Local planner (consensus not reached: …)". */
  private why(single: string, consensus: string): string {
    return this.cloudDecider === "consensus" ? `Local planner (consensus not reached: ${consensus}).` : `${single}; the local planner decided.`;
  }

  private audit(proposals: readonly ProviderProposal[], agreement: ConsensusAgreement | null = this.cloudDecider === "consensus" ? "incomplete" : null): CloudAudit {
    return { decider: this.cloudDecider, proposals, agreement };
  }

  private start(planned: Planned, nowMs: number, base: BrokerStep): BrokerStep {
    const request = buildGatewayRequest(planned.set, planned.plan, planned.belief, this.nextId(), this.policy);
    this.inFlight = { ...planned, request, offered: new Set(request.candidates.map(candidate => candidate.id)), sentAtMs: nowMs, deadlineAtMs: nowMs + this.deadlineMs };
    return deepFreeze({ ...base, send: request });
  }

  private startPending(nowMs: number, base: BrokerStep): BrokerStep {
    const next = this.pending;
    this.pending = null;
    return next === null ? base : this.start(next, nowMs, base);
  }

  private localDecision(planned: Planned, requestId: string, gatewayStatus: DecisionStatus | null, fallbackReason: string, latencyMs: number | null, cloud: CloudAudit | null): DecisionRecord {
    const candidate = resolveCandidate(planned.set, planned.plan.choiceId) ?? resolveCandidate(planned.set, "defer");
    if (candidate === null) throw new RangeError("A candidate set must include the defer choice.");
    return decisionRecord(planned, requestId, candidate, "local_planner", { gatewayStatus, fallbackReason, latencyMs, cloud });
  }

  private unexpectedReply(requestId: string, body: unknown): DiscardedReply {
    const retired = this.retired.get(requestId);
    const replyRun = parseGatewayResponse(body)?.runId;
    if ((retired !== undefined && retired.runId !== this.currentRunId) || (replyRun !== undefined && replyRun !== this.currentRunId)) {
      return this.discard(requestId, "other_run", "The reply belongs to an earlier run; reset invalidated it.");
    }
    if (retired?.reason === "timeout") return this.discard(requestId, "late", `The reply arrived after the ${this.deadlineMs} ms deadline; the local planner had already decided.`);
    if (retired?.reason === "answered") return this.discard(requestId, "late", "The request was already settled.");
    return this.discard(requestId, "unknown_request", "No request with this id is in flight.");
  }

  private discard(requestId: string, reason: DiscardReason, detail: string): DiscardedReply {
    return deepFreeze({ runId: this.currentRunId, requestId, reason, detail });
  }

  private retire(requestId: string, reason: Retired["reason"]): void {
    this.retired.set(requestId, { runId: this.currentRunId, reason });
    while (this.retired.size > MAX_RETIRED) {
      const oldest = this.retired.keys().next();
      if (oldest.done) break;
      this.retired.delete(oldest.value);
    }
  }

  private nextId(): string {
    this.sequence += 1;
    return `${this.currentRunId}#${this.sequence}`;
  }
}

type Fallback = (status: DecisionStatus, reason: string, discarded?: DiscardedReply[], cloud?: CloudAudit) => BrokerStep;

/** How the cloud decider is named in fallback reasons. */
const CLOUD_SUBJECTS: { readonly [decider in CloudDecider]: string } = {
  openai_decisions: "OpenAI Decisions",
  gemini: "Gemini",
  consensus: "Consensus (OpenAI Decisions + Gemini)",
};

/** What a provider status means, as a clause after the provider's name. */
const STATUS_CLAUSES: { readonly [status in ProviderStatus]: string } = {
  ok: "answered",
  refused: "declined to choose",
  invalid: "returned no offered candidate",
  timeout: "timed out",
  unconfigured: "is not configured on the server",
  error: "was unavailable",
};

function providerFallbackReason(name: string, status: ProviderStatus): string {
  if (status === "unconfigured") return `${name} is not configured on the server; the local planner decides for this run.`;
  return `${name} ${STATUS_CLAUSES[status]}; the local planner decided.`;
}

/** Why consensus failed, naming each provider's outcome, e.g. `OpenAI Decisions chose "a", Gemini timed out`. */
function consensusDetail(proposals: readonly ProviderProposal[], agreement: ConsensusAgreement): string {
  const DECISION_ORDER: readonly DecisionProvider[] = ["openai_decisions", "gemini"];
  const parts = DECISION_ORDER.map(provider => {
    const proposal = proposals.find(p => p.provider === provider);
    const name = DECIDER_LABELS[provider];
    if (proposal === undefined) return `${name} gave no proposal`;
    return proposal.status === "ok" && proposal.choice !== null ? `${name} chose ${JSON.stringify(clip(proposal.choice, 64))}` : `${name} ${STATUS_CLAUSES[proposal.status]}`;
  });
  return agreement === "disagreed" ? `the models disagreed: ${parts.join(", ")}` : parts.join(", ");
}

/**
 * The Decisions request for a set: the compact evidence summary plus at most MAX_OFFERED_CANDIDATES
 * choices (the best proposals by local rank, listed in canonical order so the local preference is not
 * revealed, then `defer` and `request_human_review`).
 */
export function buildGatewayRequest(set: CandidateSet, plan: LocalPlan, belief: BeliefSnapshot, requestId: string, policy: HarnessPolicy = DEFAULT_POLICY): DecisionGatewayRequest {
  const best = new Set(plan.ranked.filter(entry => entry.score !== null).slice(0, MAX_OFFERED_CANDIDATES - 2).map(entry => entry.id));
  const candidates = set.candidates.filter(candidate => candidate.proposal === null || best.has(candidate.id)).map(candidate => ({ id: candidate.id, description: candidate.description }));
  return deepFreeze({ runId: set.runId, requestId, evidenceRevision: set.evidenceRevision, evidence: summarizeEvidence(belief, policy), candidates });
}

const PROPOSER_OF: { readonly [decider in Decider]: Proposer } = {
  openai_decisions: "decisions_planner",
  gemini: "gemini_planner",
  consensus: "consensus_planner",
  local_planner: "local_planner",
};

/** The candidate's proposal attributed to its decider. Nothing else changes: same action, basis and expiry. */
export function attributeProposal(candidate: MissionCandidate, decider: Decider): ProposalInput | null {
  if (candidate.proposal === null) return null;
  return deepFreeze({ ...candidate.proposal, proposer: PROPOSER_OF[decider] });
}

function decisionRecord(
  planned: Planned,
  requestId: string,
  candidate: MissionCandidate,
  decider: Decider,
  outcome: { readonly gatewayStatus: DecisionStatus | null; readonly fallbackReason: string | null; readonly latencyMs: number | null; readonly cloud: CloudAudit | null },
): DecisionRecord {
  const risk = candidate.proposal === null ? null : riskClassOf(candidate.proposal.action.kind);
  return deepFreeze({
    runId: planned.set.runId,
    requestId,
    evidenceRevision: planned.set.evidenceRevision,
    tick: planned.set.tick,
    decider,
    candidateId: candidate.id,
    tool: candidate.tool,
    description: candidate.description,
    proposal: attributeProposal(candidate, decider),
    risk,
    requiresCommanderApproval: risk === "consequential",
    gatewayStatus: outcome.gatewayStatus,
    fallbackReason: outcome.fallbackReason,
    localChoiceId: planned.plan.choiceId,
    latencyMs: outcome.latencyMs,
    cloud: outcome.cloud,
  });
}

function sameSet(a: CandidateSet, b: CandidateSet): boolean {
  return a.evidenceRevision === b.evidenceRevision && a.candidates.length === b.candidates.length && a.candidates.every((candidate, i) => candidate.id === b.candidates[i].id);
}

function step(parts: Partial<BrokerStep>): BrokerStep {
  return deepFreeze({ send: null, abort: [], decisions: [], discarded: [], ...parts });
}

/* Event-ready records: command names the cloud decider whose choice was used and the local planner otherwise. */

export function decisionEvent(record: DecisionRecord, tick: Tick): MissionEventInput {
  const label = DECIDER_LABELS[record.decider];
  const why = record.fallbackReason === null ? "" : ` ${record.fallbackReason}`;
  const approval = record.requiresCommanderApproval ? " It waits for the commander's individual approval." : "";
  return {
    tick,
    source: record.decider === "local_planner" ? "planner" : "decisions_gateway",
    kind: "decision.selected",
    subject: record.candidateId,
    reason: clip(`${label} selected: ${record.description}${approval}${why}`, 600),
    data: {
      decider: record.decider,
      deciderLabel: label,
      requestId: record.requestId,
      evidenceRevision: record.evidenceRevision,
      candidateId: record.candidateId,
      tool: record.tool,
      risk: record.risk,
      requiresCommanderApproval: record.requiresCommanderApproval,
      gatewayStatus: record.gatewayStatus,
      fallbackReason: record.fallbackReason,
      localChoiceId: record.localChoiceId,
      latencyMs: record.latencyMs,
      cloudDecider: record.cloud?.decider ?? null,
      proposals: (record.cloud?.proposals ?? []).map(proposal => ({ provider: proposal.provider, choice: proposal.choice, status: proposal.status })),
      agreement: record.cloud?.agreement ?? null,
    },
  };
}

export function discardEvent(discarded: DiscardedReply, tick: Tick): MissionEventInput {
  return {
    tick,
    source: "planner",
    kind: "decision.reply_discarded",
    subject: discarded.requestId,
    reason: clip(`A decision reply was discarded (${discarded.reason}): ${discarded.detail}`, 600),
    data: { requestId: discarded.requestId, reason: discarded.reason },
  };
}
