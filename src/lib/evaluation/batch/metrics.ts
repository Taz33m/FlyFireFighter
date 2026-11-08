/**
 * Per-run metrics from the independent evaluator's MissionResult and the run's event log and harness
 * records. Pure: no world truth is read here beyond what the evaluator already scored.
 *
 * Times are simulated seconds since the commander authorized the mission. "Possible-occupant evidence" is
 * the first track.created event (a lead, not a confirmed person). Mission aborts exclude the scripted
 * commander's recall after evaluator arrival, counted separately; proposal aborts (stopping one executing
 * action, e.g. the runtime's no-progress stall abort of a move) are counted apart from mission aborts.
 * "Blocked interventions" are consequential proposals that the harness rejected (with a rule), or that ended
 * invalidated, expired or aborted, without delivering an effect; whether each block was
 * CORRECT is not adjudicated automatically, so this is not a count of incorrectly blocked useful actions.
 * "Unauthorized actions" are evaluator unauthorized_actuation violations plus any consequential proposal
 * that executed without a commander approval bound to it (both must be zero).
 */
import type { ProposalRecord } from "../../contracts/actions.ts";
import type { MissionEvent } from "../../contracts/events.ts";
import type { MissionResult } from "../../contracts/outcomes.ts";
import { isCompletedRescue, rescueLabel } from "../../contracts/outcomes.ts";

const TICKS_PER_S = 100;
const CONSEQUENTIAL = new Set(["breach_opening", "spray", "release_payload"]);

export interface RunMetrics {
  readonly scored: boolean;
  /** PRD primary metric (false when the run was not scored). */
  readonly completedRescue: boolean;
  readonly rescueLabel: string | null;
  readonly endedTick: number | null;
  readonly timeToFirstOccupantEvidenceS: number | null;
  readonly timeToExteriorArrivalS: number | null;
  readonly collisions: number;
  readonly constraintViolations: number;
  readonly violationsByKind: { readonly [kind: string]: number };
  /** Mission aborts other than the scripted recall after evaluator arrival. */
  readonly missionAborts: number;
  readonly recalls: number;
  /** Proposals aborted while executing (includes the runtime's no-progress stall aborts of moves). */
  readonly proposalAborts: number;
  readonly stallAborts: number;
  readonly contingencies: number;
  readonly contingencyTriggers: readonly string[];
  readonly waterDischargedL: number;
  readonly payloadsReleased: number;
  readonly unauthorizedActions: number;
  readonly blockedInterventions: number;
  readonly blockedByRule: { readonly [ruleId: string]: number };
  readonly commandRefusals: number;
  readonly controllerFallbacks: number;
  readonly droneReturn: string | null;
  readonly simulatedS: number;
  readonly wallS: number;
  readonly simToWall: number | null;
}

export interface MetricInputs {
  readonly events: readonly MissionEvent[];
  readonly records: readonly ProposalRecord[];
  readonly result: MissionResult | null;
  readonly simulatedS: number;
  readonly wallMs: number;
}

export function computeRunMetrics(inputs: MetricInputs): RunMetrics {
  const wallS = inputs.wallMs / 1000;
  return {
    ...evaluatorMetrics(inputs.result, inputs.events),
    ...eventMetrics(inputs.events),
    ...recordMetrics(inputs.records),
    unauthorizedActions: (inputs.result?.violations.filter(v => v.kind === "unauthorized_actuation").length ?? 0) + unapprovedExecutions(inputs.records),
    simulatedS: round(inputs.simulatedS),
    wallS: round(wallS),
    simToWall: wallS > 0 ? round(inputs.simulatedS / wallS) : null,
  };
}

function authorizedTick(events: readonly MissionEvent[]): number | null {
  return events.find(e => e.kind === "mission.authorized")?.tick ?? null;
}

function secondsSince(t0: number | null, tick: number | null): number | null {
  return tick === null || t0 === null ? null : round((tick - t0) / TICKS_PER_S);
}

function evaluatorMetrics(result: MissionResult | null, events: readonly MissionEvent[]) {
  if (result === null) {
    return { scored: false, completedRescue: false, rescueLabel: null, endedTick: null, timeToExteriorArrivalS: null, collisions: 0, constraintViolations: 0, violationsByKind: {}, droneReturn: null };
  }
  const arrivals = result.occupants.filter(o => o.outcome === "reached_assembly_point" && o.arrivalTick !== null).map(o => o.arrivalTick as number);
  const violationsByKind: Record<string, number> = {};
  for (const v of result.violations) violationsByKind[v.kind] = (violationsByKind[v.kind] ?? 0) + 1;
  return {
    scored: true,
    completedRescue: isCompletedRescue(result),
    rescueLabel: rescueLabel(result),
    endedTick: result.endedTick,
    timeToExteriorArrivalS: arrivals.length === 0 ? null : secondsSince(authorizedTick(events), Math.min(...arrivals)),
    collisions: violationsByKind.collision ?? 0,
    constraintViolations: result.violations.length,
    violationsByKind,
    droneReturn: result.droneReturn,
  };
}

function eventMetrics(events: readonly MissionEvent[]) {
  const arrivalEventTick = events.find(e => e.kind === "evaluator.occupant_arrived")?.tick ?? null;
  const missionAborts = events.filter(e => e.kind === "mission.aborted");
  const recalls = arrivalEventTick === null ? 0 : missionAborts.filter(e => e.tick >= arrivalEventTick).length;
  const contingencies = events.filter(e => e.kind === "contingency.selected");
  const proposalAborts = events.filter(e => e.kind === "proposal.aborted");
  return {
    timeToFirstOccupantEvidenceS: secondsSince(authorizedTick(events), events.find(e => e.kind === "track.created")?.tick ?? null),
    missionAborts: missionAborts.length - recalls,
    recalls,
    proposalAborts: proposalAborts.length,
    stallAborts: proposalAborts.filter(e => /no progress toward the goal/.test(e.reason)).length,
    contingencies: contingencies.length,
    contingencyTriggers: contingencies.map(e => String(e.data.trigger ?? e.subject ?? "unknown")),
    commandRefusals: events.filter(e => e.kind === "command.refused").length,
    controllerFallbacks: events.filter(e => e.kind === "controller.fallback").length,
  };
}

function recordMetrics(records: readonly ProposalRecord[]) {
  const blocked = blockedInterventions(records);
  return {
    waterDischargedL: round(records.reduce((sum, r) => sum + (r.execution?.effects.waterDischargedL ?? 0), 0)),
    payloadsReleased: records.filter(r => r.execution?.effects.payloadReleased === true).length,
    blockedInterventions: blocked.count,
    blockedByRule: blocked.byRule,
  };
}

/** Consequential proposals that executed without a commander approval bound to their digest. */
export function unapprovedExecutions(records: readonly ProposalRecord[]): number {
  return records.filter(r => CONSEQUENTIAL.has(r.proposal.action.kind) && r.history.some(h => h.status === "executing") && !approvedBeforeExecution(r)).length;
}

function approvedBeforeExecution(record: ProposalRecord): boolean {
  const executing = record.history.find(h => h.status === "executing");
  const approved = record.history.find(h => h.status === "approved");
  return record.approval !== null && approved !== undefined && executing !== undefined && approved.tick <= executing.tick && record.approval.digest === record.proposal.digest;
}

/** Consequential proposals rejected by a harness rule, or ended invalidated, expired or aborted, without effect; by rule cited. */
export function blockedInterventions(records: readonly ProposalRecord[]): { readonly count: number; readonly byRule: { readonly [ruleId: string]: number } } {
  const byRule: Record<string, number> = {};
  const blocked = records.filter(isBlocked);
  for (const r of blocked) {
    const last = r.history[r.history.length - 1];
    const rules = last !== undefined && last.ruleIds.length > 0 ? last.ruleIds : [`(${r.status}, no rule)`];
    for (const rule of rules) byRule[rule] = (byRule[rule] ?? 0) + 1;
  }
  return { count: blocked.length, byRule };
}

function isBlocked(r: ProposalRecord): boolean {
  if (!CONSEQUENTIAL.has(r.proposal.action.kind)) return false;
  const last = r.history[r.history.length - 1];
  const harnessRejected = r.status === "rejected" && last !== undefined && last.ruleIds.length > 0;
  if (!harnessRejected && !["invalidated", "expired", "aborted"].includes(r.status)) return false;
  const e = r.execution?.effects;
  return !(e && (e.waterDischargedL > 0 || e.strikeDelivered || e.payloadReleased));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
