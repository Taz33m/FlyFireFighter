/**
 * Batch scheduling: runs a plan with up to `concurrency` missions at once, each in its own worker thread
 * (run-worker.ts) with its own MissionRuntime, world, seed-keyed noise and output directory, so a run's
 * events never depend on scheduling. Concurrency 1 runs inline in this thread. Runs that need the FlyVis
 * service (one client at a time) never overlap each other. summary.json and report.md are rewritten after
 * every completed run (records in plan order; written to a temporary file and renamed, so a reader never
 * sees a partial file) and once more at the end.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { BatchSummary, RunRecord } from "./aggregate.ts";
import { aggregate } from "./aggregate.ts";
import type { Condition, RunSpec } from "./conditions.ts";
import { CONDITIONS } from "./conditions.ts";
import { renderReport } from "./report.ts";
import type { WorkerJob, WorkerReply } from "./run-worker.ts";
import type { RunEnvironment } from "./runner.ts";
import { runOne } from "./runner.ts";

export const WORKER_URL = new URL("./run-worker.ts", import.meta.url);

/** min(4, available parallelism − 2), at least 1. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 2));
}

export interface BatchOptions extends RunEnvironment {
  readonly concurrency?: number;
}

export async function runBatch(specs: readonly RunSpec[], options: BatchOptions, conditions: readonly Condition[] = CONDITIONS): Promise<{ records: RunRecord[]; summary: BatchSummary }> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const done = new Map<string, RunRecord>();
  const pending = [...specs];
  let serviceBusy = false;
  const ordered = () => specs.flatMap(s => done.get(s.runId) ?? []);
  /** The first pending run in plan order that may start now (FlyVis runs never overlap). */
  const take = (): RunSpec | null => {
    const i = pending.findIndex(spec => !(serviceBusy && spec.condition.requires.includes("flyvis_service")));
    if (i < 0) return null;
    const [spec] = pending.splice(i, 1);
    if (spec.condition.requires.includes("flyvis_service")) serviceBusy = true;
    return spec;
  };
  const lane = async (): Promise<void> => {
    for (let spec = take(); spec !== null; spec = take()) {
      options.log?.(`[start ${done.size + 1}/${specs.length}] ${spec.runId}`);
      const record = concurrency === 1 ? (await runOne(spec, options)).record : await runInWorker(spec, options);
      if (spec.condition.requires.includes("flyvis_service")) serviceBusy = false;
      done.set(spec.runId, record);
      options.log?.(`  ${record.runId} → ${describe(record)}`);
      writeSummary(options, aggregate(ordered(), conditions), ordered());
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, lane));
  const records = ordered();
  const summary = aggregate(records, conditions);
  writeSummary(options, summary, records);
  return { records, summary };
}

function runInWorker(spec: RunSpec, options: BatchOptions): Promise<RunRecord> {
  const job: WorkerJob = { conditionId: spec.condition.id, seed: spec.seed, runId: spec.runId, outDir: options.outDir, capabilities: options.capabilities, maxTicks: options.maxTicks ?? null };
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, { workerData: job });
    let settled = false;
    const finish = (record: RunRecord) => {
      if (settled) return;
      settled = true;
      resolve(record);
    };
    worker.on("message", (reply: WorkerReply) => {
      if (reply.type === "log") options.log?.(reply.line);
      else finish(reply.record);
    });
    worker.on("error", error => finish(errorRecord(spec, `worker error: ${error.message}`)));
    worker.on("exit", code => finish(errorRecord(spec, `worker exited with code ${code} before reporting`)));
  });
}

function errorRecord(spec: RunSpec, reason: string): RunRecord {
  return { runId: spec.runId, seed: spec.seed, conditionId: spec.condition.id, status: "error", reason, metrics: null, injection: null, bundleDir: null, eventsSha256: null, controllerLabel: null };
}

function describe(record: RunRecord): string {
  const m = record.metrics;
  return `${record.status}${record.reason ? ` (${record.reason})` : ""}${m ? `; ${m.rescueLabel ?? "not scored"}; drone ${m.droneReturn}; ${m.constraintViolations} violation(s); ${m.simulatedS} s sim in ${m.wallS} s wall` : ""}`;
}

function writeSummary(options: BatchOptions, summary: BatchSummary, records: readonly RunRecord[]): void {
  if (options.outDir === null) return;
  mkdirSync(options.outDir, { recursive: true });
  atomicWrite(join(options.outDir, "summary.json"), `${JSON.stringify({ ...summary, capabilities: options.capabilities, runs: records }, null, 2)}\n`);
  atomicWrite(join(options.outDir, "report.md"), renderReport(summary, records));
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
