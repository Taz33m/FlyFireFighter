/**
 * Worker-thread entry for one batch run (pool.ts). The worker builds its own MissionRuntime from the run's
 * (condition id, seed, run id), so nothing is shared with other runs: each has its own world, event log,
 * keyed noise (by seed), camera and output directory. It posts log lines and finally the RunRecord.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { Capabilities } from "./capabilities.ts";
import { connectNeural } from "./capabilities.ts";
import { conditionById } from "./conditions.ts";
import { runOne } from "./runner.ts";

export interface WorkerJob {
  readonly conditionId: string;
  readonly seed: string;
  readonly runId: string;
  readonly outDir: string | null;
  readonly capabilities: Capabilities;
  readonly maxTicks: number | null;
}

export type WorkerReply =
  | { readonly type: "log"; readonly line: string }
  | { readonly type: "done"; readonly record: Awaited<ReturnType<typeof runOne>>["record"] };

const job = workerData as WorkerJob;
const port = parentPort;
if (port === null) throw new Error("run-worker.ts must run in a worker thread");
const outcome = await runOne(
  { runId: job.runId, seed: job.seed, condition: conditionById(job.conditionId) },
  {
    outDir: job.outDir,
    capabilities: job.capabilities,
    connectNeural,
    ...(job.maxTicks === null ? {} : { maxTicks: job.maxTicks }),
    log: line => port.postMessage({ type: "log", line } satisfies WorkerReply),
  },
);
port.postMessage({ type: "done", record: outcome.record } satisfies WorkerReply);
