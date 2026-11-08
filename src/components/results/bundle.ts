/**
 * Run bundles for the results page: parse exported files (results.json, events.jsonl, replay.jsonl), derive
 * per-run figures and aggregate them. Pure and browser-safe.
 *
 * Outcome wording follows the contracts and the shared words (mission/outcome-words.ts): the words come only
 * from rescueLabel(result), so only an evaluator-scored run that satisfies isCompletedRescue reads "Simulated
 * evacuation completed"; every other run — including unscored ones — reads "Incomplete: human assistance
 * needed". The stored label is never trusted on its own: it is recomputed from the stored
 * MissionResult and any disagreement is reported. A stored result that is malformed or names another run is
 * reported and dropped (the run reads as not scored). Times are simulated seconds since mission.authorized.
 */
import { isTick } from "../../lib/contracts/clock.ts";
import type { MissionEvent } from "../../lib/contracts/events.ts";
import type { ConstraintViolation, DroneReturnResult, MissionResult } from "../../lib/contracts/outcomes.ts";
import { rescueLabel } from "../../lib/contracts/outcomes.ts";
import type { ReplayFrame } from "../../lib/mission/protocol.ts";
import type { RescueWords } from "../mission/outcome-words.ts";
import { DRONE_RETURN_WORDS, OCCUPANT_OUTCOME_WORDS, RESCUE_WORDS, rescueWords } from "../mission/outcome-words.ts";

export const RESULTS_SCHEMA = "flyfirefighter.results/1";
export const BUNDLE_FILES = ["results.json", "events.jsonl", "replay.jsonl"] as const;
export type BundleFile = (typeof BUNDLE_FILES)[number];

export const COMPLETED_WORDS = RESCUE_WORDS.simulated_evacuation_completed;
export const INCOMPLETE_WORDS = RESCUE_WORDS.incomplete_human_assistance_needed;

/** The fields of results.json the page reads; everything else is shown raw. */
export interface ResultsJson {
  readonly schema: string;
  readonly label?: string;
  readonly runId: string;
  readonly status?: string;
  readonly scenarioId?: string;
  readonly seed?: string;
  readonly config?: { readonly controller?: string; readonly decider?: string; readonly aircraftId?: string; readonly commanderId?: string; readonly speed?: number };
  readonly scene?: { readonly sceneId?: string; readonly revision?: number; readonly metaSha256?: string | null; readonly metaCanonicalSha256?: string; readonly assets?: { readonly [name: string]: { readonly sha256?: string; readonly bytes?: number } } };
  readonly controller?: { readonly mode?: string; readonly label?: string; readonly source?: string; readonly model?: string | null; readonly checkpointSha256?: string | null; readonly neuralStatus?: string | null };
  readonly decider?: { readonly label?: string; readonly status?: string };
  readonly camera?: { readonly calibrationId?: string; readonly renderers?: readonly string[] };
  readonly events?: { readonly sha256?: string; readonly count?: number };
  readonly replay?: { readonly sha256?: string; readonly frames?: number };
  readonly outcome?: { readonly rescueLabel?: string } | null;
  readonly result?: MissionResult | null;
  readonly timing?: { readonly simulatedS?: number; readonly wallMs?: number; readonly simToWallRatio?: number | null };
}

export interface RunBundle {
  /** Stable key for React lists: origin plus run id. */
  readonly key: string;
  readonly origin:
    | { readonly kind: "file"; readonly names: readonly string[] }
    | { readonly kind: "published"; readonly url: string; readonly label: string | null }
    /** A simulation run saved in MongoDB Atlas and read back through /api/runs/<runId>. */
    | { readonly kind: "atlas"; readonly runId: string; readonly savedAt: string | null };
  readonly results: ResultsJson | null;
  readonly events: readonly MissionEvent[];
  readonly replay: readonly ReplayFrame[];
  /** Missing files, unparseable lines, run-id mismatches and label disagreements. Shown, never hidden. */
  readonly problems: readonly string[];
}

export interface JsonlParse<T> {
  readonly items: T[];
  readonly badLines: number[];
}

/** One JSON value per non-empty line; unparseable lines are reported by 1-based number. */
export function parseJsonl<T>(text: string): JsonlParse<T> {
  const items: T[] = [];
  const badLines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { items, badLines };
}

/** Which bundle file a name refers to, and the prefix before it ("run-7-events.jsonl" → "run-7"). */
export function classifyFileName(name: string): { readonly file: BundleFile; readonly prefix: string } | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  for (const file of BUNDLE_FILES) {
    if (base === file) return { file, prefix: "" };
    if (base.endsWith(`-${file}`)) return { file, prefix: base.slice(0, -file.length - 1) };
  }
  return null;
}

/** Group files by directory and prefix (the workspace's export names files `<runId>-<file>`). */
export function groupFiles(files: readonly { readonly name: string; readonly text: string }[]): { readonly groups: ReadonlyMap<string, Partial<Record<BundleFile, { readonly name: string; readonly text: string }>>>; readonly ignored: readonly string[] } {
  const groups = new Map<string, Partial<Record<BundleFile, { name: string; text: string }>>>();
  const ignored: string[] = [];
  for (const f of files) {
    const kind = classifyFileName(f.name);
    if (kind === null) {
      ignored.push(f.name);
      continue;
    }
    // Folder selections carry webkitRelativePath. Keep its parent, otherwise every plain results.json
    // across a batch shares the empty prefix and subsequent runs are discarded as duplicate files.
    const parts = f.name.replaceAll("\\", "/").split("/");
    parts.pop();
    const key = parts.length === 0 ? kind.prefix : `${parts.join("/")}/${kind.prefix}`;
    const group = groups.get(key) ?? {};
    if (group[kind.file] !== undefined) ignored.push(`${f.name} (duplicate ${kind.file})`);
    else group[kind.file] = { name: f.name, text: f.text };
    groups.set(key, group);
  }
  return { groups, ignored };
}

function parseResults(text: string | undefined, problems: string[]): ResultsJson | null {
  if (text === undefined) {
    problems.push("results.json is missing: no outcome, configuration or hashes.");
    return null;
  }
  try {
    const parsed = JSON.parse(text) as ResultsJson;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.runId !== "string") throw new Error("no runId");
    if (parsed.schema !== RESULTS_SCHEMA) problems.push(`results.json schema is ${String(parsed.schema)}, expected ${RESULTS_SCHEMA}.`);
    return parsed;
  } catch (error) {
    problems.push(`results.json could not be read (${error instanceof Error ? error.message : String(error)}).`);
    return null;
  }
}

function parseLines<T>(file: "events.jsonl" | "replay.jsonl", text: string | undefined, missing: string, problems: string[]): T[] {
  if (text === undefined) {
    problems.push(`${file} is missing: ${missing}.`);
    return [];
  }
  const parsed = parseJsonl<T>(text);
  if (parsed.badLines.length > 0) problems.push(`${file}: ${parsed.badLines.length} unreadable line(s), first at line ${parsed.badLines[0]}.`);
  return parsed.items;
}

function countProblem(file: string, listed: number | undefined, actual: number, present: boolean): string | null {
  return listed === undefined || !present || listed === actual ? null : `results.json lists ${listed} ${file} but the file has ${actual}.`;
}

/* Known values, from the exhaustive word tables (a value added to the contract without words fails to compile). */
const OCCUPANT_OUTCOMES: readonly unknown[] = Object.keys(OCCUPANT_OUTCOME_WORDS);
const VIOLATION_KIND_SET: Readonly<Record<ConstraintViolation["kind"], true>> = { collision: true, hazardous_discharge: true, unauthorized_actuation: true, envelope_breach: true, hard_limit: true };
const VIOLATION_KINDS: readonly unknown[] = Object.keys(VIOLATION_KIND_SET);
export const DRONE_RETURNS: readonly DroneReturnResult[] = Object.keys(DRONE_RETURN_WORDS) as DroneReturnResult[];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Why a stored evaluator result cannot be scored as this run's, or null when it can. */
export function resultProblem(result: unknown, runId: string): string | null {
  if (!isObject(result)) return "it is not an object";
  if (result.label !== "simulation_evaluator") return "its label is not simulation_evaluator";
  if (typeof result.runId !== "string") return "it has no runId";
  if (result.runId !== runId) return `it belongs to another run (${result.runId})`;
  if (typeof result.seed !== "string") return "seed is not a string";
  if (!isTick(result.endedTick) || !isTick(result.budgetTick)) return "endedTick/budgetTick are not ticks";
  if (!Array.isArray(result.occupants)) return "occupants is not a list";
  const occupantOk = (o: unknown) => isObject(o) && typeof o.occupantKey === "string" && OCCUPANT_OUTCOMES.includes(o.outcome) && (o.arrivalTick === null || isTick(o.arrivalTick));
  if (!result.occupants.every(occupantOk)) return "an occupant entry is malformed";
  if (!Array.isArray(result.violations)) return "violations is not a list";
  const violationOk = (v: unknown) => isObject(v) && isTick(v.tick) && VIOLATION_KINDS.includes(v.kind) && typeof v.detail === "string";
  if (!result.violations.every(violationOk)) return "a violation entry is malformed";
  if (!(DRONE_RETURNS as readonly unknown[]).includes(result.droneReturn)) return "droneReturn is not a known value";
  return null;
}

/** The stored evaluator result when it is well formed and belongs to this run; otherwise null (not scored). */
export function scoredResult(results: ResultsJson | null): MissionResult | null {
  const result: unknown = results?.result ?? null;
  return result === null || results === null || resultProblem(result, results.runId) !== null ? null : (result as MissionResult);
}

/** Cross-file checks: foreign run ids, declared counts and the stored outcome label. */
function consistencyProblems(results: ResultsJson, events: readonly MissionEvent[], replayCount: number, texts: Partial<Record<BundleFile, string>>): string[] {
  const problems: string[] = [];
  const foreign = events.filter(e => e.runId !== results.runId);
  if (foreign.length > 0) problems.push(`${foreign.length} event(s) belong to another run (${foreign[0].runId}); this bundle mixes runs.`);
  const counts = [
    countProblem("events", results.events?.count, events.length, texts["events.jsonl"] !== undefined),
    countProblem("replay frames", results.replay?.frames, replayCount, texts["replay.jsonl"] !== undefined),
  ];
  problems.push(...counts.filter((p): p is string => p !== null));
  const result = scoredResult(results);
  const stored = results.outcome?.rescueLabel;
  if (result !== null && stored !== undefined && stored !== rescueLabel(result)) {
    problems.push(`Stored outcome label "${stored}" disagrees with the label recomputed from the evaluator result; the recomputed label is shown.`);
  }
  return problems;
}

/** Drop a stored evaluator result that cannot be this run's, so no view reads it; report why. */
function withCheckedResult(results: ResultsJson | null, problems: string[]): ResultsJson | null {
  const result: unknown = results?.result ?? null;
  if (results === null || result === null) return results;
  const problem = resultProblem(result, results.runId);
  if (problem === null) return results;
  problems.push(`results.json evaluator result is unusable: ${problem}. The run is shown as not scored.`);
  return { ...results, result: null };
}

/** Build a bundle from file texts (any may be missing). */
export function buildBundle(texts: Partial<Record<BundleFile, string>>, origin: RunBundle["origin"]): RunBundle {
  const problems: string[] = [];
  const results = withCheckedResult(parseResults(texts["results.json"], problems), problems);
  const events = parseLines<MissionEvent>("events.jsonl", texts["events.jsonl"], "no action or approval history", problems);
  const replay = parseLines<ReplayFrame>("replay.jsonl", texts["replay.jsonl"], "no replay", problems).sort((a, b) => a.tick - b.tick);
  if (results !== null) problems.push(...consistencyProblems(results, events, replay.length, texts));
  const key = `${origin.kind === "file" ? "file" : origin.kind === "atlas" ? "atlas" : origin.url}:${results?.runId ?? origin.kind}`;
  return { key, origin, results, events, replay, problems };
}

export interface Outcome {
  readonly words: RescueWords;
  readonly completed: boolean;
  readonly scored: boolean;
}

/** The run's final outcome from its validated evaluator result; `completed` and the words both follow rescueLabel. */
export function outcomeOf(bundle: RunBundle): Outcome {
  const result = scoredResult(bundle.results);
  if (result === null) return { words: INCOMPLETE_WORDS, completed: false, scored: false };
  const label = rescueLabel(result);
  return { words: rescueWords(label), completed: label === "simulated_evacuation_completed", scored: true };
}
