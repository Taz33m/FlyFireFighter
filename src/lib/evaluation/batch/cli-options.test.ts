/** Scope: reject invalid evaluation requests before any service, simulator or output is touched. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEvaluationCommand } from "./cli-options.ts";

function run(args: readonly string[]) {
  const command = parseEvaluationCommand(args);
  assert.equal(command.mode, "run");
  if (command.mode !== "run") throw new Error("Expected a run request");
  return command;
}

describe("evaluation command validation", () => {
  test("a selected seed range preserves paired conditions and requested execution options", () => {
    const command = run(["--seeds", "2", "--first-seed", "7", "--seed-prefix", "held-out", "--conditions", "main.flow, main.readout", "--concurrency", "1", "--max-ticks", "1200", "--out", "evaluation/runs/test", "--save-atlas"]);
    assert.deepEqual(command.specs.map(s => [s.seed, s.condition.id]), [
      ["held-out-7", "main.flow"], ["held-out-7", "main.readout"],
      ["held-out-8", "main.flow"], ["held-out-8", "main.readout"],
    ]);
    assert.equal(command.seedCount, 2);
    assert.equal(command.conditionCount, 2);
    assert.equal(command.concurrency, 1);
    assert.equal(command.maxTicks, 1200);
    assert.equal(command.outDir, "evaluation/runs/test");
    assert.equal(command.saveAtlas, true);
    assert.equal(command.probeService, true);
  });

  test("zero seeds with an offset cannot become a successful empty batch", () => {
    assert.throws(() => run(["--seeds", "0", "--first-seed", "2"]), /--seeds/);
  });

  test("zero or negative first-seed cannot silently truncate the seed range", () => {
    for (const first of ["0", "-1"]) assert.throws(() => run(["--first-seed", first]), /--first-seed/);
  });

  test("counts, offsets, concurrency and tick caps reject nonpositive, fractional and nonfinite values", () => {
    for (const option of ["seeds", "first-seed", "concurrency", "max-ticks"]) {
      for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "not-a-number", "9007199254740992"]) {
        assert.throws(() => run([`--${option}`, value]), new RegExp(`--${option}`), `${option}=${value}`);
      }
    }
  });

  test("large offsets allocate only the requested seeds, and overflowing indices are refused", () => {
    const command = run(["--seeds", "2", "--first-seed", "1000000000000", "--conditions", "main.flow"]);
    assert.deepEqual(command.specs.map(s => s.seed), ["eval-seed-1000000000000", "eval-seed-1000000000001"]);
    assert.throws(() => run(["--seeds", "2", "--first-seed", String(Number.MAX_SAFE_INTEGER)]), /last seed index/);
  });

  test("empty, unknown and duplicate condition selections fail before execution", () => {
    for (const selection of ["", " , , "]) assert.throws(() => run(["--conditions", selection]), /at least one condition/);
    assert.throws(() => run(["--conditions", "missing"]), /Unknown condition/);
    assert.throws(() => run(["--conditions", "main.flow,main.flow"]), /distinct/);
  });

  test("smoke remains one baseline run; probing depends on actual selected conditions", () => {
    const smoke = run(["--smoke", "--conditions", "main.readout", "--first-seed", "3"]);
    assert.deepEqual(smoke.specs.map(s => [s.seed, s.condition.id]), [["eval-seed-3", "main.flow"]]);
    assert.equal(smoke.probeService, false);
    assert.equal(run(["--conditions", "main.flow"]).probeService, false);
    assert.equal(run(["--conditions", "main.readout", "--no-probe"]).probeService, false);
  });

  test("list and upload are separate from mission execution", () => {
    assert.deepEqual(parseEvaluationCommand(["--list"]), { mode: "list" });
    assert.deepEqual(parseEvaluationCommand(["--upload-dir", "evaluation/runs/saved"]), { mode: "upload", directory: "evaluation/runs/saved" });
    assert.throws(() => parseEvaluationCommand(["--upload-dir", ""]), /--upload-dir/);
    assert.throws(() => parseEvaluationCommand(["--unknown"]));
  });
});
