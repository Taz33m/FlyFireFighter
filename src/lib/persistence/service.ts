/**
 * Persistence operations over a RunRepository: save a bundle, list runs with Atlas aggregates, load one
 * bundle back, and search the mission logs (Atlas Search, or a regex fallback while the Search index is
 * missing or building). Shared by the HTTP handlers and the batch uploader.
 */
import type { AtlasRunFilter, AtlasRunSummary, AtlasStats, DecisionHit, EventHit, SearchMode } from "../../components/results/atlas-wire.ts";
import type { SaveContext } from "./documents.ts";
import { bundleToDocuments, documentsToBundle } from "./documents.ts";
import type { CollectionName, Doc } from "./model.ts";
import { COLLECTIONS } from "./model.ts";
import type { SearchTarget } from "./pipelines.ts";
import { DEFAULT_LIST_LIMIT, LIST_PROJECTION, MAX_LIST_LIMIT, regexSearchPipeline, runMatch, searchPipeline, statsPipeline, toDecisionHit, toEventHit, toRunSummary, toStats } from "./pipelines.ts";
import type { RunRepository } from "./repository.ts";
import { DuplicateRunError } from "./repository.ts";
import { SEARCH_INDEX_NAMES } from "./search-indexes.ts";
import type { UploadFiles } from "./validate.ts";

export type SaveResult =
  | { readonly status: "saved" | "exists"; readonly runId: string; readonly counts: { readonly events: number; readonly decisions: number; readonly replayFrames: number } }
  | { readonly status: "conflict"; readonly runId: string; readonly message: string }
  | { readonly status: "invalid"; readonly errors: readonly string[] };

/**
 * Save once per run id. The same bundle again is "exists" (idempotent); a different bundle under a stored
 * run id is "conflict" and nothing is overwritten.
 */
export async function saveBundle(repo: RunRepository, files: UploadFiles, ctx: SaveContext): Promise<SaveResult> {
  const conversion = bundleToDocuments(files, ctx);
  if (!conversion.ok) return { status: "invalid", errors: conversion.errors };
  const { docs } = conversion;
  const runId = docs.run.runId;
  const counts = { events: docs.events.length, decisions: docs.decisions.length, replayFrames: docs.run.metrics.replayFrames };
  const compare = async (): Promise<SaveResult | null> => {
    const existing = await repo.findRunHeader(runId);
    if (existing === null) return null;
    return existing.bundleSha256 === docs.run.bundleSha256 ? { status: "exists", runId, counts }
      : { status: "conflict", runId, message: `A different bundle is already stored as run ${runId}; nothing was overwritten.` };
  };
  const before = await compare();
  if (before !== null) return before;
  await repo.ensureIndexes();
  try {
    await repo.insertRun(docs);
  } catch (error) {
    // A concurrent save of the same run won the race: report what is stored now.
    if (error instanceof DuplicateRunError) return (await compare()) ?? { status: "conflict", runId, message: `Run ${runId} could not be stored.` };
    throw error;
  }
  return { status: "saved", runId, counts };
}

export function clampLimit(limit: number | undefined): number {
  return limit === undefined || !Number.isSafeInteger(limit) ? DEFAULT_LIST_LIMIT : Math.min(MAX_LIST_LIMIT, Math.max(1, limit));
}

export async function listRuns(repo: RunRepository, filter: AtlasRunFilter): Promise<{ readonly runs: readonly AtlasRunSummary[]; readonly stats: AtlasStats }> {
  const [runs, stats] = await Promise.all([
    repo.findRuns(runMatch(filter), LIST_PROJECTION, clampLimit(filter.limit)),
    repo.aggregate(COLLECTIONS.runs, statsPipeline(filter)),
  ]);
  return { runs: runs.map(toRunSummary), stats: toStats(stats) };
}

export async function loadBundle(repo: RunRepository, runId: string) {
  const run = await repo.getRun(runId);
  if (run === null) return null;
  const [events, replay] = await Promise.all([repo.getEvents(runId), repo.getReplayGzip(runId)]);
  return { run, ...documentsToBundle(run, events, replay) };
}

export interface SearchResult {
  readonly mode: SearchMode;
  readonly note: string | null;
  readonly events: readonly EventHit[];
  readonly decisions: readonly DecisionHit[];
}

const TARGET_COLLECTION: Readonly<Record<SearchTarget, CollectionName>> = { events: COLLECTIONS.events, decisions: COLLECTIONS.decisions };

async function searchOne(repo: RunRepository, target: SearchTarget, query: string, options: { runId?: string; limit: number }): Promise<{ readonly mode: SearchMode; readonly docs: Doc[]; readonly note: string | null }> {
  const collection = TARGET_COLLECTION[target];
  const state = await repo.searchIndexState(collection, SEARCH_INDEX_NAMES[target]);
  if (state === "ready") {
    try {
      return { mode: "atlas_search", docs: await repo.aggregate(collection, searchPipeline(target, query, options)), note: null };
    } catch {
      // Fall through to the regex search, and say so.
      return { mode: "regex_fallback", docs: await repo.aggregate(collection, regexSearchPipeline(target, query, options)), note: `Atlas Search on ${collection} failed; showing a plain text match instead.` };
    }
  }
  const why = state === "pending" ? "is still building" : state === "missing" ? "has not been created (run scripts/atlas-setup.ts)" : "is not available on this deployment";
  return { mode: "regex_fallback", docs: await repo.aggregate(collection, regexSearchPipeline(target, query, options)), note: `The Atlas Search index ${SEARCH_INDEX_NAMES[target]} ${why}; showing a plain text match.` };
}

/** Search events.reason and decisions.rationale in parallel. Mode is atlas_search only when both used it. */
export async function searchLogs(repo: RunRepository, query: string, options: { runId?: string; limit: number }): Promise<SearchResult> {
  const [events, decisions] = await Promise.all([searchOne(repo, "events", query, options), searchOne(repo, "decisions", query, options)]);
  const notes = [...new Set([events.note, decisions.note].filter((n): n is string => n !== null))];
  return {
    mode: events.mode === "atlas_search" && decisions.mode === "atlas_search" ? "atlas_search" : "regex_fallback",
    note: notes.length === 0 ? null : notes.join(" "),
    events: events.docs.map(toEventHit),
    decisions: decisions.docs.map(toDecisionHit),
  };
}
