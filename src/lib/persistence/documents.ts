/**
 * Run bundle ⇄ Atlas documents.
 *
 * bundleToDocuments validates an uploaded bundle and builds the `runs`, `events` and `decisions` documents
 * plus the gzip-compressed replay for GridFS. It reuses the results page's bundle reading
 * (components/results/bundle.ts and metrics.ts), so the outcome words, figures and validation notes stored
 * in Atlas are exactly what the results page would show for the same files. The stored outcome is
 * recomputed from the evaluator result; a client-supplied label is never trusted.
 *
 * Hard rejections (nothing is written): results.json missing, unreadable, of another schema, without a
 * usable run id or not labelled as a simulation; any malformed event line; events.jsonl or replay.jsonl not
 * matching the SHA-256 recorded in results.json. Softer findings (an unusable evaluator result, a label
 * disagreement) are stored with the run as problems and shown wherever the run is shown.
 *
 * documentsToBundle rebuilds the three files. events.jsonl is canonical JSON per event, as the event log
 * writes it, so the rebuilt file is byte-identical and its SHA-256 is checked again on the way out.
 */
import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JsonValue } from "../contracts/canonical.ts";
import { canonicalJson, sha256Hex } from "../contracts/canonical.ts";
import type { MissionEvent } from "../contracts/events.ts";
import type { MissionResult } from "../contracts/outcomes.ts";
import { rescueLabel } from "../contracts/outcomes.ts";
import type { AtlasBundleFiles, RunSource, StageName, StageValues } from "../../components/results/atlas-wire.ts";
import { RUN_ID_PATTERN, STAGES } from "../../components/results/atlas-wire.ts";
import type { ResultsJson } from "../../components/results/bundle.ts";
import { RESULTS_SCHEMA, buildBundle, parseJsonl, scoredResult } from "../../components/results/bundle.ts";
import type { RunFigures } from "../../components/results/metrics.ts";
import { runFigures } from "../../components/results/metrics.ts";
import type { CodeState, DecisionDocument, EventDocument, ReplayFileMetadata, RunDocument, RunDocuments } from "./model.ts";
import { RUN_DOCUMENT_SCHEMA } from "./model.ts";
import type { UploadFiles } from "./validate.ts";
import { MAX_FILE_BYTES, eventProblems, isPlainObject } from "./validate.ts";

const TICKS_PER_S = 100;

export interface SaveContext {
  readonly source: RunSource;
  readonly savedAt: Date;
  readonly code: CodeState;
  /** Batch condition id (from the batch runner's run.json), when known. */
  readonly conditionId?: string | null;
}

export type Conversion = { readonly ok: true; readonly docs: RunDocuments } | { readonly ok: false; readonly errors: readonly string[] };

type Header = { readonly ok: true; readonly results: ResultsJson } | { readonly ok: false; readonly errors: readonly string[] };

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function parseHeader(text: string): Header {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["results.json is not valid JSON"] };
  }
  if (!isPlainObject(parsed)) return { ok: false, errors: ["results.json is not an object"] };
  const errors: string[] = [];
  if (parsed.schema !== RESULTS_SCHEMA) errors.push(`results.json schema must be ${RESULTS_SCHEMA}`);
  if (typeof parsed.runId !== "string" || !RUN_ID_PATTERN.test(parsed.runId)) errors.push("results.json runId is missing or not a usable run id");
  if (typeof parsed.label !== "string" || !parsed.label.toLowerCase().startsWith("simulation")) errors.push("results.json is not labelled as a simulation run; only simulation bundles are stored");
  return errors.length === 0 ? { ok: true, results: parsed as unknown as ResultsJson } : { ok: false, errors };
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function replayLineOk(line: string | undefined): boolean {
  if (line === undefined) return false;
  try {
    const frame: unknown = JSON.parse(line);
    return isPlainObject(frame) && Number.isSafeInteger(frame.tick) && isPlainObject(frame.render) && isPlainObject(frame.summary);
  } catch {
    return false;
  }
}

/** The replay must be the one results.json describes; its first and last frames are spot-checked. */
function replayProblems(results: ResultsJson, replay: string | undefined): string[] {
  if (replay === undefined || replay === "") return [];
  const problems: string[] = [];
  const listed = results.replay?.sha256;
  if (typeof listed !== "string") problems.push("results.json records no replay SHA-256, so replay.jsonl cannot be checked");
  else if (listed !== sha256Hex(replay)) problems.push("replay.jsonl does not match the SHA-256 recorded in results.json");
  const lines = replay.split("\n").filter(line => line.trim() !== "");
  if (!replayLineOk(lines[0]) || !replayLineOk(lines[lines.length - 1])) problems.push("replay.jsonl frames are not replay frames ({tick, render, summary})");
  return problems;
}

function integrityProblems(results: ResultsJson, files: UploadFiles): string[] {
  const listed = results.events?.sha256;
  const events = typeof listed !== "string" ? ["results.json records no events SHA-256, so events.jsonl cannot be checked"]
    : listed !== sha256Hex(files["events.jsonl"]) ? ["events.jsonl does not match the SHA-256 recorded in results.json"] : [];
  return [...events, ...replayProblems(results, files["replay.jsonl"])];
}

/** First tick of each stage. Exit comes from the evaluator result only; end from the result or outcome.recorded. */
export function stageTicks(events: readonly MissionEvent[], result: MissionResult | null): StageValues {
  const firstKind = (kind: string) => events.find(e => e.kind === kind)?.tick ?? null;
  const firstAction = (action: string) => events.find(e => e.kind === "proposal.executing" && e.data.actionKind === action)?.tick ?? null;
  const arrivals = (result?.occupants ?? []).filter(o => o.outcome === "reached_assembly_point" && o.arrivalTick !== null).map(o => o.arrivalTick as number);
  return {
    evidence: firstKind("track.created"),
    breach: firstAction("breach_opening"),
    spray: firstAction("spray"),
    guide: firstAction("guide"),
    exit: arrivals.length === 0 ? null : Math.min(...arrivals),
    end: result?.endedTick ?? firstKind("outcome.recorded"),
  };
}

/** Simulated seconds after mission.authorized; null when either tick is unknown. */
export function stageSeconds(ticks: StageValues, authorizedTick: number | null): StageValues {
  const out: Partial<Record<StageName, number | null>> = {};
  for (const stage of STAGES) {
    const tick = ticks[stage];
    out[stage] = tick === null || authorizedTick === null ? null : round3((tick - authorizedTick) / TICKS_PER_S);
  }
  return out as StageValues;
}

function eventDocument(e: MissionEvent): EventDocument {
  return { runId: e.runId, seq: e.seq, tick: e.tick, source: e.source, kind: e.kind, subject: e.subject, ruleIds: [...e.ruleIds], reason: e.reason, data: e.data };
}

function decisionChoice(e: MissionEvent): { readonly candidateId: string | null; readonly matchesLocalChoice: boolean | null } {
  const candidateId = str(e.data.candidateId) ?? (e.kind === "decision.selected" ? e.subject : null);
  const local = str(e.data.localChoiceId);
  return { candidateId, matchesLocalChoice: candidateId === null || local === null ? null : candidateId === local };
}

function decisionAgreement(data: MissionEvent["data"]): JsonValue | null {
  return data.agreement ?? data.agreementStatus ?? null;
}

/** Planner decision events (decision.*) with the fields the planner recorded; nothing is inferred. */
export function decisionDocuments(events: readonly MissionEvent[]): DecisionDocument[] {
  return events.filter(e => e.kind.startsWith("decision.")).map(e => ({
    runId: e.runId,
    seq: e.seq,
    tick: e.tick,
    kind: e.kind,
    source: e.source,
    decider: str(e.data.decider),
    deciderLabel: str(e.data.deciderLabel),
    model: str(e.data.model),
    ...decisionChoice(e),
    rationale: str(e.data.rationale) ?? e.reason,
    latencyMs: num(e.data.latencyMs),
    agreement: decisionAgreement(e.data),
    gatewayStatus: str(e.data.gatewayStatus),
    fallbackReason: str(e.data.fallbackReason),
    risk: str(e.data.risk),
    tool: str(e.data.tool),
  }));
}

/** Workspace run ids are run-<Date.now() in base 36>-<random>; anything else (batch ids) has no creation time. */
export function createdAtFromRunId(runId: string): Date | null {
  const match = /^run-([0-9a-z]{6,10})-/.exec(runId);
  if (match === null) return null;
  const ms = parseInt(match[1], 36);
  return ms >= Date.UTC(2020, 0, 1) && ms <= Date.UTC(2100, 0, 1) ? new Date(ms) : null;
}

export function gzipText(text: string): Uint8Array {
  return gzipSync(Buffer.from(text, "utf8"), { level: 6 });
}

/** Bounded decompression, so a damaged or hostile stored file cannot expand without limit. */
export function gunzipText(bytes: Uint8Array): string {
  return gunzipSync(bytes, { maxOutputLength: MAX_FILE_BYTES["replay.jsonl"] + 1024 * 1024 }).toString("utf8");
}

function configOf(results: ResultsJson): RunDocument["config"] {
  const c = results.config ?? {};
  return {
    scenarioId: str(results.scenarioId),
    seed: str(results.seed),
    controller: str(c.controller) ?? str(results.controller?.mode),
    decider: str(c.decider),
    aircraftId: str(c.aircraftId),
    commanderId: str(c.commanderId),
    speed: num(c.speed),
  };
}

function outcomeOfRun(results: ResultsJson, figures: RunFigures): RunDocument["outcome"] {
  const result = scoredResult(results);
  return {
    scored: figures.outcome.scored,
    completed: figures.outcome.completed,
    rescueLabel: result === null ? null : rescueLabel(result),
    words: figures.outcome.words,
    droneReturn: figures.droneReturn,
    violationCount: figures.violations.length,
    collisions: figures.collisions,
  };
}

function codeOf(results: ResultsJson, ctx: SaveContext, files: UploadFiles): RunDocument["code"] {
  return {
    ...ctx.code,
    sceneId: str(results.scene?.sceneId),
    sceneRevision: num(results.scene?.revision),
    sceneMetaSha256: str(results.scene?.metaSha256),
    controllerCheckpointSha256: str(results.controller?.checkpointSha256),
    eventsSha256: sha256Hex(files["events.jsonl"]),
    replaySha256: files["replay.jsonl"] ? sha256Hex(files["replay.jsonl"]) : null,
  };
}

function timingOf(results: ResultsJson): RunDocument["timing"] {
  return { simulatedS: num(results.timing?.simulatedS), wallMs: num(results.timing?.wallMs), simToWallRatio: num(results.timing?.simToWallRatio) };
}

/** Identity of a bundle: one hash over the hashes of its files (a missing replay hashes as empty). */
export function bundleDigest(files: UploadFiles): string {
  return sha256Hex(`${sha256Hex(files["results.json"])}\n${sha256Hex(files["events.jsonl"])}\n${files["replay.jsonl"] ? sha256Hex(files["replay.jsonl"]) : ""}`);
}

interface Parts {
  readonly results: ResultsJson;
  readonly events: readonly MissionEvent[];
  readonly decisions: number;
  readonly figures: RunFigures;
  readonly problems: readonly string[];
  readonly replay: RunDocuments["replay"];
}

function runDocument(files: UploadFiles, ctx: SaveContext, p: Parts): RunDocument {
  const { results, events, figures } = p;
  const authorized = events.find(e => e.kind === "mission.authorized")?.tick ?? null;
  const ticks = stageTicks(events, scoredResult(results));
  const createdAt = createdAtFromRunId(results.runId);
  return {
    schema: RUN_DOCUMENT_SCHEMA,
    runId: results.runId,
    label: results.label ?? "simulation",
    evidence: "simulation",
    source: ctx.source,
    createdAt: createdAt ?? ctx.savedAt,
    createdAtSource: createdAt === null ? "saved_at" : "run_id",
    savedAt: ctx.savedAt,
    bundleSha256: bundleDigest(files),
    conditionId: ctx.conditionId ?? null,
    config: configOf(results),
    controllerLabel: figures.controllerLabel,
    deciderLabel: figures.deciderLabel,
    deciderStatus: str(results.decider?.status),
    status: str(results.status),
    outcome: outcomeOfRun(results, figures),
    violations: figures.violations.map(v => ({ tick: v.tick, kind: v.kind, detail: v.detail.slice(0, 600) })),
    timing: timingOf(results),
    code: codeOf(results, ctx, files),
    metrics: {
      events: events.length,
      decisions: p.decisions,
      replayFrames: p.replay?.metadata.frames ?? 0,
      stageTicks: ticks,
      stageSeconds: stageSeconds(ticks, authorized),
      approvals: figures.approvals,
      rejections: figures.rejections,
      aborts: figures.aborts,
      waterDischargedL: figures.waterDischargedL,
    },
    replay: p.replay === null ? { stored: false, bytes: 0, gzipBytes: 0, sha256: null, frames: 0 }
      : { stored: true, bytes: p.replay.metadata.bytes, gzipBytes: p.replay.gzip.byteLength, sha256: p.replay.metadata.sha256, frames: p.replay.metadata.frames },
    resultsJson: files["results.json"],
    problems: p.problems,
  };
}

function replayOf(runId: string, text: string | undefined): RunDocuments["replay"] {
  if (text === undefined || text === "") return null;
  const metadata: ReplayFileMetadata = {
    runId, encoding: "gzip", contentType: "application/x-ndjson", bytes: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text), frames: countLines(text), label: "simulation truth for the labelled replay view",
  };
  return { gzip: gzipText(text), metadata };
}

/** Validate an uploaded bundle and build its documents; nothing is half-built on failure. */
export function bundleToDocuments(files: UploadFiles, ctx: SaveContext): Conversion {
  const header = parseHeader(files["results.json"]);
  if (!header.ok) return header;
  const { results } = header;
  const parsed = parseJsonl<unknown>(files["events.jsonl"]);
  const errors = [
    ...(parsed.badLines.length > 0 ? [`events.jsonl: ${parsed.badLines.length} unreadable line(s), first at line ${parsed.badLines[0]}`] : []),
    ...(parsed.items.length === 0 ? ["events.jsonl holds no events"] : []),
    ...eventProblems(parsed.items, results.runId),
    ...integrityProblems(results, files),
  ];
  if (errors.length > 0) return { ok: false, errors };
  const events = parsed.items as MissionEvent[];
  // The results page's reading of the same files: outcome words, figures and validation notes.
  const bundle = buildBundle({ "results.json": files["results.json"], "events.jsonl": files["events.jsonl"] }, { kind: "file", names: ["results.json", "events.jsonl"] });
  const problems = bundle.problems.filter(p => !p.startsWith("replay.jsonl is missing"));
  const decisions = decisionDocuments(events);
  const replay = replayOf(results.runId, files["replay.jsonl"]);
  const run = runDocument(files, ctx, { results: bundle.results ?? results, events, decisions: decisions.length, figures: runFigures(bundle), problems, replay });
  return { ok: true, docs: { run, events: events.map(eventDocument), decisions, replay } };
}

function eventLine(e: EventDocument): MissionEvent {
  return { seq: e.seq, runId: e.runId, tick: e.tick, source: e.source as MissionEvent["source"], kind: e.kind, subject: e.subject, ruleIds: e.ruleIds, reason: e.reason, data: e.data };
}

/** Rebuild the bundle files from stored documents, re-checking both hashes. */
export function documentsToBundle(run: RunDocument, events: readonly EventDocument[], replayGzip: Uint8Array | null): { readonly files: AtlasBundleFiles; readonly problems: readonly string[] } {
  const problems = [...run.problems];
  const eventsText = [...events].sort((a, b) => a.seq - b.seq).map(e => `${canonicalJson(eventLine(e))}\n`).join("");
  if (events.length !== run.metrics.events) problems.push(`Atlas holds ${events.length} of the ${run.metrics.events} events saved for this run.`);
  if (sha256Hex(eventsText) !== run.code.eventsSha256) problems.push("The events rebuilt from Atlas do not match the SHA-256 recorded when the run was saved.");
  let replay: string | null = null;
  if (run.replay.stored && replayGzip === null) problems.push("The replay file for this run is missing from GridFS.");
  if (replayGzip !== null) {
    replay = gunzipText(replayGzip);
    if (sha256Hex(replay) !== run.replay.sha256) problems.push("The replay read from GridFS does not match the SHA-256 recorded when the run was saved.");
  }
  const files: AtlasBundleFiles = replay === null ? { "results.json": run.resultsJson, "events.jsonl": eventsText } : { "results.json": run.resultsJson, "events.jsonl": eventsText, "replay.jsonl": replay };
  return { files, problems };
}
