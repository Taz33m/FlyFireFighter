/**
 * Paired seeded mission evaluation (headless, local planner, scripted commander).
 *
 *   node scripts/evaluate-missions.ts --smoke
 *   node scripts/evaluate-missions.ts --seeds 5 [--conditions main.flow,main.readout] [--concurrency N] [--out evaluation/runs/<name>]
 *   node scripts/evaluate-missions.ts --list
 *   node scripts/evaluate-missions.ts --smoke --save-atlas          also upload each finished bundle to MongoDB Atlas
 *   node scripts/evaluate-missions.ts --upload-dir evaluation/runs/<name>   upload bundles already on disk; runs nothing
 *
 * One command; missions run in parallel worker threads (default min(4, cores − 2); --concurrency 1 runs
 * them inline, one at a time). Each run is isolated and deterministic regardless of scheduling. Bundles and summary.json go to the
 * git-ignored evaluation/runs/ directory. The engineered-readout arm needs the FlyVis service on
 * ws://127.0.0.1:3201; without it that arm is recorded as not run.
 *
 * Atlas upload (--save-atlas, --upload-dir) reads MONGODB_URI/MONGODB_DB from the environment or .env.local
 * (never printed), validates each bundle like the app's POST /api/runs, stores it once per run id (a repeat
 * is reported as already stored) and records the git commit and dirty flag. See docs/persistence.md.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONDITIONS } from "../src/lib/evaluation/batch/conditions.ts";
import { parseEvaluationCommand } from "../src/lib/evaluation/batch/cli-options.ts";
import { connectNeural, detectCapabilities } from "../src/lib/evaluation/batch/capabilities.ts";
import { defaultConcurrency, runBatch } from "../src/lib/evaluation/batch/batch.ts";
import { findBundleDirs, uploadBundleDirs } from "../src/lib/persistence/batch-upload.ts";
import { gitCodeState } from "../src/lib/persistence/code-state.ts";
import { atlasRepository, closeAtlas } from "../src/lib/persistence/server.ts";

const command = parseEvaluationCommand(process.argv.slice(2));

/** Upload bundle directories to Atlas; returns false when persistence is not configured or any upload failed. */
async function saveToAtlas(dirs: readonly string[]): Promise<boolean> {
  if (process.env.MONGODB_URI === undefined && existsSync(".env.local")) process.loadEnvFile(".env.local");
  const { repository, config } = atlasRepository(process.env);
  if (repository === null || !config.configured) {
    console.error(`Atlas upload skipped: ${config.configured ? "no repository" : config.reason}`);
    return false;
  }
  try {
    const reports = await uploadBundleDirs(repository, dirs, { code: gitCodeState(process.cwd()), now: () => new Date() }, line => console.log(line));
    const tally = (status: string) => reports.filter(r => r.result.status === status).length;
    console.log(`Atlas (${config.dbName}): ${tally("saved")} saved, ${tally("exists")} already stored, ${reports.length - tally("saved") - tally("exists")} not stored, of ${reports.length}.`);
    return reports.every(r => r.result.status === "saved" || r.result.status === "exists");
  } finally {
    await closeAtlas();
  }
}

if (command.mode === "upload") {
  const dirs = findBundleDirs(command.directory);
  console.log(`Uploading ${dirs.length} bundle(s) from ${command.directory} to Atlas.`);
  process.exit((await saveToAtlas(dirs)) ? 0 : 1);
}

if (command.mode === "list") {
  for (const c of CONDITIONS) console.log(`${c.id.padEnd(26)} ${c.pair ? c.pair.factor : "reference"}${c.requires.length ? `  [requires ${c.requires.join(", ")}]` : ""}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = command.outDir ?? join("evaluation", "runs", `${command.smoke ? "smoke" : "batch"}-${stamp}`);

const capabilities = await detectCapabilities({ probeService: command.probeService });
console.log(`Capabilities: FlyVis ${capabilities.flyvisService.available ? "available" : "unavailable"} (${capabilities.flyvisService.detail}); runtime rangeAssist option ${capabilities.runtimeRangeAssistOption}; runtime initialWaterL option ${capabilities.runtimeInitialWaterOption}`);
const { specs } = command;
const concurrency = command.concurrency ?? defaultConcurrency();
console.log(`Planned ${specs.length} run(s): ${command.seedCount} seed(s) × ${command.conditionCount} condition(s), concurrency ${concurrency} → ${outDir}`);

const started = performance.now();
const { summary, records: summaryRecords } = await runBatch(specs, {
  outDir,
  capabilities,
  connectNeural,
  concurrency,
  maxTicks: command.maxTicks,
  log: (line: string) => console.log(line),
});
const wallS = (performance.now() - started) / 1000;

console.log(`\nDone in ${wallS.toFixed(1)} s wall. Totals: ${JSON.stringify(summary.totals)}`);
for (const c of summary.conditions) {
  const r = c.completedRescue;
  console.log(`${c.conditionId.padEnd(26)} completed ${r.completed}/${r.of}${r.wilson95 ? ` [${r.wilson95.join(", ")}]` : ""}; not run ${c.notRun.length}; invalid ${c.invalid.length}; errors ${c.errors.length}; unscored ${c.unscored.length}; collisions ${c.collisions}; unauthorized ${c.unauthorizedActions}; median wall ${c.wallS.median ?? "—"} s; median sim:wall ${c.simToWall.median ?? "—"}`);
}
console.log(`Summary: ${join(outDir, "summary.json")}`);

if (command.saveAtlas) {
  const dirs = summaryRecords.map(r => r.bundleDir).filter((d): d is string => d !== null);
  if (!(await saveToAtlas(dirs))) process.exitCode = 1;
}
