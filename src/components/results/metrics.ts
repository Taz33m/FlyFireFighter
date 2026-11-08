/**
 * Per-run figures, action/approval history and multi-run aggregates for the results page, computed from
 * bundle contents only (the evaluator's MissionResult and the event log). Definitions match the batch
 * evaluator's metrics: times are simulated seconds since mission.authorized; "possible-occupant evidence" is
 * the first track.created event (a lead, not a confirmed person); aborts exclude the commander's recall
 * after the evaluator reported arrival, which is counted separately. No improvement figure is computed:
 * aggregates are counts with their denominators, side by side.
 */
import type { JsonValue } from "../../lib/contracts/canonical.ts";
import type { MissionEvent } from "../../lib/contracts/events.ts";
import type { ConstraintViolation, DroneReturnResult, MissionResult } from "../../lib/contracts/outcomes.ts";
import type { Outcome, ResultsJson, RunBundle } from "./bundle.ts";
import { outcomeOf, scoredResult } from "./bundle.ts";

const TICKS_PER_S = 100;
const CONSEQUENTIAL = new Set(["breach_opening", "spray", "release_payload"]);

export interface ActionStep {
  readonly tick: number;
  readonly status: string;
  readonly reason: string;
  readonly ruleIds: readonly string[];
  readonly commanderId: string | null;
}

export interface ActionHistory {
  readonly proposalId: string;
  readonly actionKind: string;
  readonly proposer: string;
  readonly consequential: boolean;
  readonly steps: readonly ActionStep[];
  readonly finalStatus: string;
  readonly approvedBy: string | null;
  readonly effects: { readonly waterDischargedL: number; readonly strikeDelivered: boolean; readonly payloadReleased: boolean } | null;
}

const str = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);
const obj = (v: JsonValue | undefined): { readonly [k: string]: JsonValue } | null => (v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) ? (v as { readonly [k: string]: JsonValue }) : null);

/** Proposals in order of first appearance, each with its status transitions and recorded effects. */
export function actionHistory(events: readonly MissionEvent[]): ActionHistory[] {
  const byId = new Map<string, { kind: string; proposer: string; steps: ActionStep[]; approvedBy: string | null; effects: ActionHistory["effects"] }>();
  for (const e of events) {
    if (!e.kind.startsWith("proposal.")) continue;
    const id = str(e.data.proposalId) ?? e.subject;
    if (id === null) continue;
    const entry = byId.get(id) ?? { kind: str(e.data.actionKind) ?? "unknown", proposer: str(e.data.proposer) ?? "unknown", steps: [], approvedBy: null, effects: null };
    const status = e.kind.slice("proposal.".length);
    const approval = obj(e.data.approval);
    const commanderId = str(e.data.commanderId) ?? str(approval?.commanderId);
    if (status === "approved") entry.approvedBy = commanderId;
    const effects = obj(e.data.effects);
    if (effects !== null) {
      entry.effects = {
        waterDischargedL: typeof effects.waterDischargedL === "number" ? effects.waterDischargedL : 0,
        strikeDelivered: effects.strikeDelivered === true,
        payloadReleased: effects.payloadReleased === true,
      };
    }
    entry.steps.push({ tick: e.tick, status, reason: e.reason, ruleIds: e.ruleIds, commanderId });
    byId.set(id, entry);
  }
  return [...byId].map(([proposalId, h]) => ({
    proposalId,
    actionKind: h.kind,
    proposer: h.proposer,
    consequential: CONSEQUENTIAL.has(h.kind),
    steps: h.steps,
    finalStatus: h.steps[h.steps.length - 1]?.status ?? "unknown",
    approvedBy: h.approvedBy,
    effects: h.effects,
  }));
}

export interface RunFigures {
  readonly runId: string;
  readonly outcome: Outcome;
  readonly condition: string;
  readonly controllerLabel: string;
  readonly deciderLabel: string;
  readonly pairKey: string | null;
  readonly timeToEvidenceS: number | null;
  readonly timeToExitS: number | null;
  readonly collisions: number;
  readonly violations: readonly ConstraintViolation[];
  readonly aborts: number;
  readonly recalls: number;
  readonly waterDischargedL: number;
  readonly strikes: number;
  readonly payloadsReleased: number;
  readonly approvals: number;
  readonly rejections: number;
  readonly droneReturn: DroneReturnResult | null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function controllerOf(results: ResultsJson | null): string {
  return results?.controller?.label ?? results?.config?.controller ?? "Unknown controller";
}

function deciderOf(results: ResultsJson | null): string {
  return results?.decider?.label ?? results?.config?.decider ?? "Unknown planner";
}

function labels(results: ResultsJson | null): Pick<RunFigures, "controllerLabel" | "deciderLabel" | "condition" | "pairKey"> {
  const controllerLabel = controllerOf(results);
  const deciderLabel = deciderOf(results);
  const scenario = results?.scenarioId;
  const seed = results?.seed;
  return { controllerLabel, deciderLabel, condition: `${controllerLabel} · ${deciderLabel}`, pairKey: scenario == null || seed == null ? null : `${scenario} · seed ${seed}` };
}

/** Evaluator figures from the MissionResult; `since` converts a tick to seconds after authorization. */
function evaluatorFigures(result: MissionResult | null, since: (tick: number | null | undefined) => number | null): Pick<RunFigures, "timeToExitS" | "collisions" | "violations" | "droneReturn"> {
  if (result === null) return { timeToExitS: null, collisions: 0, violations: [], droneReturn: null };
  const arrivals = result.occupants.filter(o => o.outcome === "reached_assembly_point" && o.arrivalTick !== null).map(o => o.arrivalTick as number);
  return {
    timeToExitS: arrivals.length === 0 ? null : since(Math.min(...arrivals)),
    collisions: result.violations.filter(v => v.kind === "collision").length,
    violations: result.violations,
    droneReturn: result.droneReturn,
  };
}

function eventFigures(events: readonly MissionEvent[], since: (tick: number | null | undefined) => number | null): Pick<RunFigures, "timeToEvidenceS" | "aborts" | "recalls" | "waterDischargedL" | "strikes" | "payloadsReleased" | "approvals" | "rejections"> {
  const arrivalEvent = events.find(e => e.kind === "evaluator.occupant_arrived")?.tick ?? null;
  const missionAborts = events.filter(e => e.kind === "mission.aborted");
  const recalls = arrivalEvent === null ? 0 : missionAborts.filter(e => e.tick >= arrivalEvent).length;
  const history = actionHistory(events);
  return {
    timeToEvidenceS: since(events.find(e => e.kind === "track.created")?.tick),
    aborts: missionAborts.length - recalls + events.filter(e => e.kind === "proposal.aborted").length,
    recalls,
    waterDischargedL: round(history.reduce((sum, h) => sum + (h.effects?.waterDischargedL ?? 0), 0)),
    strikes: history.filter(h => h.effects?.strikeDelivered === true).length,
    payloadsReleased: history.filter(h => h.effects?.payloadReleased === true).length,
    approvals: events.filter(e => e.kind === "proposal.approved").length,
    rejections: events.filter(e => e.kind === "proposal.rejected" && e.data.commanderId !== undefined).length,
  };
}

export function runFigures(bundle: RunBundle): RunFigures {
  const { results, events } = bundle;
  const authorized = events.find(e => e.kind === "mission.authorized")?.tick ?? null;
  const since = (tick: number | null | undefined) => (tick == null || authorized === null ? null : round((tick - authorized) / TICKS_PER_S));
  return {
    runId: results?.runId ?? "unknown run",
    outcome: outcomeOf(bundle),
    ...labels(results),
    ...evaluatorFigures(scoredResult(results), since),
    ...eventFigures(events, since),
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface ConditionAggregate {
  readonly condition: string;
  readonly runs: number;
  readonly scored: number;
  readonly completed: number;
  readonly incomplete: number;
  readonly runsWithCollision: number;
  readonly collisions: number;
  readonly runsWithViolation: number;
  readonly aborts: number;
  readonly returned: number;
  readonly waterDischargedL: number;
  readonly evidence: { readonly count: number; readonly medianS: number | null };
  readonly exit: { readonly count: number; readonly medianS: number | null };
}

/** Counts per condition (controller · planner), each with its own denominator. */
export function aggregate(figures: readonly RunFigures[]): ConditionAggregate[] {
  const groups = new Map<string, RunFigures[]>();
  for (const f of figures) groups.set(f.condition, [...(groups.get(f.condition) ?? []), f]);
  return [...groups].map(([condition, runs]) => {
    const evidence = runs.flatMap(r => (r.timeToEvidenceS === null ? [] : [r.timeToEvidenceS]));
    const exit = runs.flatMap(r => (r.timeToExitS === null ? [] : [r.timeToExitS]));
    const completed = runs.filter(r => r.outcome.completed).length;
    return {
      condition,
      runs: runs.length,
      scored: runs.filter(r => r.outcome.scored).length,
      completed,
      incomplete: runs.length - completed,
      runsWithCollision: runs.filter(r => r.collisions > 0).length,
      collisions: runs.reduce((s, r) => s + r.collisions, 0),
      runsWithViolation: runs.filter(r => r.violations.length > 0).length,
      aborts: runs.reduce((s, r) => s + r.aborts, 0),
      returned: runs.filter(r => r.droneReturn === "returned").length,
      waterDischargedL: round(runs.reduce((s, r) => s + r.waterDischargedL, 0)),
      evidence: { count: evidence.length, medianS: median(evidence) },
      exit: { count: exit.length, medianS: median(exit) },
    };
  });
}

/** Scenario/seed pairs present under more than one condition, for side-by-side outcomes. */
export function pairs(figures: readonly RunFigures[]): { readonly conditions: readonly string[]; readonly rows: readonly { readonly pairKey: string; readonly cells: readonly (RunFigures | null)[] }[] } {
  const conditions = [...new Set(figures.map(f => f.condition))];
  const byKey = new Map<string, Map<string, RunFigures>>();
  for (const f of figures) {
    if (f.pairKey === null) continue;
    const row = byKey.get(f.pairKey) ?? new Map<string, RunFigures>();
    if (!row.has(f.condition)) row.set(f.condition, f);
    byKey.set(f.pairKey, row);
  }
  const rows = [...byKey].filter(([, row]) => row.size > 1).map(([pairKey, row]) => ({ pairKey, cells: conditions.map(c => row.get(c) ?? null) }));
  return { conditions, rows };
}
