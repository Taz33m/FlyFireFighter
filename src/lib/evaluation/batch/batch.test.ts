/**
 * Batch scheduling. Scope: a 2-run batch (two seeds, Troy main, optical-flow baseline, short tick cap)
 * gives identical per-run events hashes inline (concurrency 1) and in two parallel worker threads
 * (concurrency 2), with summary.json listing the runs in plan order and each run's bundle in its own
 * directory; and the default concurrency stays within its bounds.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { defaultConcurrency, runBatch } from "./batch.ts";
import type { Capabilities } from "./capabilities.ts";
import { planRuns } from "./conditions.ts";

const CAPS: Capabilities = { flyvisService: { available: false, detail: "test: no service" }, runtimeRangeAssistOption: true, runtimeInitialWaterOption: true };

describe("batch scheduling", () => {
  test("default concurrency is between 1 and 4", () => {
    const n = defaultConcurrency();
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 4);
  });

  test("per-run events hashes are identical at concurrency 1 and 2", { timeout: 10 * 60_000 }, async () => {
    const dirs = [mkdtempSync(join(tmpdir(), "ffb-c1-")), mkdtempSync(join(tmpdir(), "ffb-c2-"))];
    try {
      const specs = planRuns(["par-seed-1", "par-seed-2"], ["main.flow"]);
      const one = await runBatch(specs, { outDir: dirs[0], capabilities: CAPS, connectNeural: null, maxTicks: 1500, concurrency: 1 });
      const two = await runBatch(specs, { outDir: dirs[1], capabilities: CAPS, connectNeural: null, maxTicks: 1500, concurrency: 2 });
      for (const batch of [one, two]) {
        assert.deepEqual(batch.records.map(r => r.runId), specs.map(s => s.runId), "records in plan order");
        assert.ok(batch.records.every(r => r.status === "ran" && r.eventsSha256 !== null), JSON.stringify(batch.records.map(r => [r.runId, r.status, r.reason])));
      }
      assert.deepEqual(two.records.map(r => r.eventsSha256), one.records.map(r => r.eventsSha256));
      assert.notEqual(one.records[0].eventsSha256, one.records[1].eventsSha256, "different seeds are different runs");
      for (const [i, dir] of dirs.entries()) {
        const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { runs: { runId: string; eventsSha256: string }[]; totals: { ran: number } };
        assert.equal(summary.totals.ran, 2);
        assert.deepEqual(summary.runs.map(r => r.eventsSha256), (i === 0 ? one : two).records.map(r => r.eventsSha256));
        for (const spec of specs) assert.ok(existsSync(join(dir, spec.runId, "events.jsonl")) && existsSync(join(dir, spec.runId, "run.json")));
        assert.ok(existsSync(join(dir, "report.md")));
      }
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
});
