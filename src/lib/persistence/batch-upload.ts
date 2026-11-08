/**
 * Upload finished batch bundles (evaluation/runs/<batch>/<run>/{results.json, events.jsonl, replay.jsonl,
 * run.json}) to the run store. Used by `scripts/evaluate-missions.ts --save-atlas` and `--upload-dir`.
 * Each bundle is validated and saved like a workspace save; the batch condition id comes from run.json.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { publicErrorMessage, redactSecrets } from "./config.ts";
import type { CodeState } from "./model.ts";
import type { RunRepository } from "./repository.ts";
import type { SaveResult } from "./service.ts";
import { saveBundle } from "./service.ts";
import { MAX_FILE_BYTES, isPlainObject } from "./validate.ts";

export interface UploadReport {
  readonly dir: string;
  readonly result: SaveResult | { readonly status: "skipped"; readonly reason: string } | { readonly status: "error"; readonly message: string };
}

function readOptional(path: string, limit: number): string | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > limit) throw new Error(`${path} is larger than ${limit / 1024 / 1024} MB`);
  return readFileSync(path, "utf8");
}

function conditionIdOf(dir: string): string | null {
  try {
    const run: unknown = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    const condition = isPlainObject(run) && isPlainObject(run.condition) ? run.condition.id : null;
    return typeof condition === "string" ? condition : null;
  } catch {
    return null;
  }
}

/** Directories under `root` (and `root` itself) that hold a results.json. */
export function findBundleDirs(root: string): string[] {
  if (existsSync(join(root, "results.json"))) return [root];
  return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(root, e.name, "results.json"))).map(e => join(root, e.name)).sort();
}

export async function uploadBundleDirs(repo: RunRepository, dirs: readonly string[], ctx: { readonly code: CodeState; readonly now: () => Date }, log: (line: string) => void): Promise<UploadReport[]> {
  const reports: UploadReport[] = [];
  for (const dir of dirs) {
    let report: UploadReport;
    try {
      const results = readOptional(join(dir, "results.json"), MAX_FILE_BYTES["results.json"]);
      const events = readOptional(join(dir, "events.jsonl"), MAX_FILE_BYTES["events.jsonl"]);
      const replay = readOptional(join(dir, "replay.jsonl"), MAX_FILE_BYTES["replay.jsonl"]);
      report = results === undefined || events === undefined ? { dir, result: { status: "skipped", reason: "results.json or events.jsonl is missing" } }
        : { dir, result: await saveBundle(repo, replay === undefined ? { "results.json": results, "events.jsonl": events } : { "results.json": results, "events.jsonl": events, "replay.jsonl": replay }, { source: "batch", savedAt: ctx.now(), code: ctx.code, conditionId: conditionIdOf(dir) }) };
    } catch (error) {
      report = { dir, result: { status: "error", message: error instanceof Error && !error.name.startsWith("Mongo") ? redactSecrets(error.message) : publicErrorMessage(error) } };
    }
    reports.push(report);
    log(`Atlas: ${dir} → ${describe(report.result)}`);
  }
  return reports;
}

function describe(result: UploadReport["result"]): string {
  switch (result.status) {
    case "saved": return `saved (${result.counts.events} events, ${result.counts.decisions} decisions, ${result.counts.replayFrames} replay frames)`;
    case "exists": return "already stored";
    case "conflict": return result.message;
    case "invalid": return `not stored: ${result.errors.slice(0, 3).join("; ")}`;
    case "skipped": return `skipped: ${result.reason}`;
    case "error": return `failed: ${result.message}`;
  }
}
