/**
 * Queries over the run store, written as MongoDB aggregation pipelines so Atlas does the work:
 *
 * - statsPipeline: one $facet pass over `runs` that groups by controller, decider, scenario and the full
 *   condition (controller · decider · scenario), with completion counts and rate, violations and collisions,
 *   and the $median (approximate method, MongoDB 7.0+) of every stage time over the runs that reached it;
 *   plus violation counts by kind via $unwind. Denominators travel with every figure.
 * - searchPipeline: Atlas Search ($search with fuzzy text matching and highlights) over events.reason or
 *   decisions.rationale, optionally restricted to one run with an `equals` filter on the token-indexed runId.
 * - regexSearchPipeline: the fallback while the Search index does not exist or is still building: an
 *   escaped, case-insensitive $regex over the same field (no relevance score).
 *
 * Pure data; the repository runs them (on Atlas, or on the offline fake in tests).
 */
import type { AtlasRunFilter, AtlasRunSummary, AtlasStats, AtlasStatsRow, DecisionHit, EventHit, SearchHighlight, StageName } from "../../components/results/atlas-wire.ts";
import { STAGES } from "../../components/results/atlas-wire.ts";
import type { Doc } from "./model.ts";
import { SEARCH_INDEX_NAMES } from "./search-indexes.ts";

export const MEDIAN_METHOD = "approximate";
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** The $match for a run filter. Only exact values are matched; nothing from the caller becomes an operator. */
export function runMatch(filter: AtlasRunFilter): Doc {
  const match: Doc = {};
  if (filter.controller !== undefined) match["config.controller"] = filter.controller;
  if (filter.decider !== undefined) match["config.decider"] = filter.decider;
  if (filter.scenarioId !== undefined) match["config.scenarioId"] = filter.scenarioId;
  if (filter.outcome !== undefined) match["outcome.completed"] = filter.outcome === "completed";
  return match;
}

const isOne = (condition: unknown): Doc => ({ $cond: [condition, 1, 0] });

function stageAccumulators(): Doc {
  const acc: Doc = {};
  for (const stage of STAGES) {
    const path = `$metrics.stageSeconds.${stage}`;
    acc[`median_${stage}`] = { $median: { input: path, method: MEDIAN_METHOD } };
    acc[`count_${stage}`] = { $sum: isOne({ $isNumber: path }) };
  }
  return acc;
}

function stageProjection(): Doc {
  const median: Doc = {};
  const counts: Doc = {};
  for (const stage of STAGES) {
    median[stage] = `$median_${stage}`;
    counts[stage] = `$count_${stage}`;
  }
  return { medianStageS: median, stageCounts: counts };
}

/** Group runs by `key` (a field path, an object of paths, or null for totals) into AtlasStatsRow shape. */
export function groupStages(key: unknown): Doc[] {
  return [
    {
      $group: {
        _id: key,
        runs: { $sum: 1 },
        scored: { $sum: isOne("$outcome.scored") },
        completed: { $sum: isOne("$outcome.completed") },
        runsWithViolation: { $sum: isOne({ $gt: ["$outcome.violationCount", 0] }) },
        violations: { $sum: "$outcome.violationCount" },
        collisions: { $sum: "$outcome.collisions" },
        ...stageAccumulators(),
      },
    },
    { $sort: { runs: -1, _id: 1 } },
    {
      $project: {
        _id: 0,
        key: "$_id",
        runs: 1,
        scored: 1,
        completed: 1,
        completionRate: { $cond: [{ $gt: ["$runs", 0] }, { $divide: ["$completed", "$runs"] }, null] },
        runsWithViolation: 1,
        violations: 1,
        collisions: 1,
        ...stageProjection(),
      },
    },
  ];
}

export function statsPipeline(filter: AtlasRunFilter): Doc[] {
  return [
    { $match: runMatch(filter) },
    {
      $facet: {
        totals: groupStages(null),
        byController: groupStages("$config.controller"),
        byDecider: groupStages("$config.decider"),
        byScenario: groupStages("$config.scenarioId"),
        byCondition: groupStages({ controller: "$config.controller", decider: "$config.decider", scenarioId: "$config.scenarioId" }),
        violationKinds: [
          { $unwind: "$violations" },
          { $group: { _id: "$violations.kind", count: { $sum: 1 }, runIds: { $addToSet: "$runId" } } },
          { $project: { _id: 0, kind: "$_id", count: 1, runs: { $size: "$runIds" } } },
          { $sort: { count: -1, kind: 1 } },
        ],
      },
    },
  ];
}

/** Fields the run list needs (the stored results.json, violations and code hashes stay in Atlas). */
export const LIST_PROJECTION: Doc = {
  _id: 0, runId: 1, savedAt: 1, createdAt: 1, source: 1, label: 1, conditionId: 1, status: 1, config: 1, controllerLabel: 1, deciderLabel: 1,
  outcome: 1, "metrics.stageSeconds": 1, "metrics.events": 1, "metrics.decisions": 1, "metrics.replayFrames": 1, "timing.simulatedS": 1, "code.gitCommit": 1, problems: 1,
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => num(v) ?? 0;
const rec = (v: unknown): Doc => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {});
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : new Date(0).toISOString());

function stageValues(v: unknown): Record<StageName, number | null> {
  const r = rec(v);
  return Object.fromEntries(STAGES.map(s => [s, num(r[s])])) as Record<StageName, number | null>;
}

function stageCounts(v: unknown): Record<StageName, number> {
  const r = rec(v);
  return Object.fromEntries(STAGES.map(s => [s, count(r[s])])) as Record<StageName, number>;
}

function outcomeSummary(v: unknown): AtlasRunSummary["outcome"] {
  const o = rec(v);
  return { scored: o.scored === true, completed: o.completed === true, words: str(o.words) ?? "Incomplete: human assistance needed", droneReturn: str(o.droneReturn), violationCount: count(o.violationCount), collisions: count(o.collisions) };
}

/** A stored run document (LIST_PROJECTION fields) as a list row. */
export function toRunSummary(doc: Doc): AtlasRunSummary {
  const config = rec(doc.config);
  const metrics = rec(doc.metrics);
  return {
    runId: str(doc.runId) ?? "unknown",
    savedAt: iso(doc.savedAt),
    createdAt: iso(doc.createdAt),
    source: doc.source === "batch" ? "batch" : "workspace",
    label: str(doc.label) ?? "simulation",
    scenarioId: str(config.scenarioId),
    seed: str(config.seed),
    controller: str(config.controller),
    controllerLabel: str(doc.controllerLabel) ?? "Unknown controller",
    decider: str(config.decider),
    deciderLabel: str(doc.deciderLabel) ?? "Unknown planner",
    conditionId: str(doc.conditionId),
    status: str(doc.status),
    outcome: outcomeSummary(doc.outcome),
    stageSeconds: stageValues(metrics.stageSeconds),
    counts: { events: count(metrics.events), decisions: count(metrics.decisions), replayFrames: count(metrics.replayFrames) },
    simulatedS: num(rec(doc.timing).simulatedS),
    gitCommit: str(rec(doc.code).gitCommit),
    problems: Array.isArray(doc.problems) ? doc.problems.length : 0,
  };
}

function statsKey(v: unknown): AtlasStatsRow["key"] {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  const k = rec(v);
  return { controller: str(k.controller), decider: str(k.decider), scenarioId: str(k.scenarioId) };
}

function statsRow(v: unknown): AtlasStatsRow {
  const r = rec(v);
  return {
    key: statsKey(r.key),
    runs: count(r.runs),
    scored: count(r.scored),
    completed: count(r.completed),
    completionRate: num(r.completionRate),
    runsWithViolation: count(r.runsWithViolation),
    violations: count(r.violations),
    collisions: count(r.collisions),
    medianStageS: stageValues(r.medianStageS),
    stageCounts: stageCounts(r.stageCounts),
  };
}

const rows = (v: unknown): AtlasStatsRow[] => (Array.isArray(v) ? v.map(statsRow) : []);

/** The single $facet output document as AtlasStats. */
export function toStats(output: readonly Doc[]): AtlasStats {
  const facet = rec(output[0]);
  const totals = rows(facet.totals);
  const kinds = Array.isArray(facet.violationKinds) ? facet.violationKinds.map(rec) : [];
  return {
    totals: totals[0] ?? null,
    byController: rows(facet.byController),
    byDecider: rows(facet.byDecider),
    byScenario: rows(facet.byScenario),
    byCondition: rows(facet.byCondition),
    violationKinds: kinds.map(k => ({ kind: str(k.kind) ?? "unknown", count: count(k.count), runs: count(k.runs) })),
  };
}

/* Search over mission logs. */

export type SearchTarget = "events" | "decisions";
export const SEARCH_FIELDS: Readonly<Record<SearchTarget, string>> = { events: "reason", decisions: "rationale" };

const HIT_FIELDS: Readonly<Record<SearchTarget, Doc>> = {
  events: { _id: 0, runId: 1, seq: 1, tick: 1, kind: 1, source: 1, reason: 1 },
  decisions: { _id: 0, runId: 1, seq: 1, tick: 1, decider: 1, candidateId: 1, rationale: 1 },
};

export interface SearchOptions {
  readonly runId?: string;
  readonly limit: number;
}

/** Atlas Search: fuzzy full-text over the log field, highest relevance first, with highlights. */
export function searchPipeline(target: SearchTarget, query: string, options: SearchOptions): Doc[] {
  const path = SEARCH_FIELDS[target];
  const compound: Doc = { must: [{ text: { query, path, fuzzy: { maxEdits: 1, prefixLength: 2 } } }] };
  if (options.runId !== undefined) compound.filter = [{ equals: { path: "runId", value: options.runId } }];
  return [
    { $search: { index: SEARCH_INDEX_NAMES[target], compound, highlight: { path } } },
    { $limit: options.limit },
    { $project: { ...HIT_FIELDS[target], score: { $meta: "searchScore" }, highlights: { $meta: "searchHighlights" } } },
  ];
}

/** Escape every regex metacharacter, so the query is matched literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Fallback: literal, case-insensitive substring match; newest runs' events are not ranked, only limited. */
export function regexSearchPipeline(target: SearchTarget, query: string, options: SearchOptions): Doc[] {
  const match: Doc = { [SEARCH_FIELDS[target]]: { $regex: escapeRegex(query), $options: "i" } };
  if (options.runId !== undefined) match.runId = options.runId;
  return [{ $match: match }, { $limit: options.limit }, { $project: HIT_FIELDS[target] }];
}

function highlights(v: unknown): SearchHighlight[] {
  if (!Array.isArray(v)) return [];
  return v.map(rec).map(h => ({
    texts: (Array.isArray(h.texts) ? h.texts.map(rec) : []).map(t => ({ value: str(t.value) ?? "", type: t.type === "hit" ? "hit" as const : "text" as const })),
  }));
}

export function toEventHit(doc: Doc): EventHit {
  return { runId: str(doc.runId) ?? "", seq: count(doc.seq), tick: count(doc.tick), kind: str(doc.kind) ?? "", source: str(doc.source) ?? "", reason: str(doc.reason) ?? "", score: num(doc.score), highlights: highlights(doc.highlights) };
}

export function toDecisionHit(doc: Doc): DecisionHit {
  return { runId: str(doc.runId) ?? "", seq: count(doc.seq), tick: count(doc.tick), decider: str(doc.decider), candidateId: str(doc.candidateId), rationale: str(doc.rationale) ?? "", score: num(doc.score), highlights: highlights(doc.highlights) };
}
