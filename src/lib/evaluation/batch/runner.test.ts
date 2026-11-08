/**
 * Batch runner on short headless runs of the Troy main preset (collider camera, optical-flow baseline,
 * local planner, scripted commander). Scope: (1) a missing requirement records "not run" without starting
 * a substitute; (2) the same seed and condition give a byte-identical events.jsonl and identical results
 * apart from timing; (3) an injected localization loss (degrade_localization through the protocol) is
 * applied at its tick, a localization contingency is selected, and advancement stops: no planner move, scan
 * or intervention starts executing afterwards, and any planner proposal submitted afterwards is refused (by
 * H10 when the harness gives a rule). The exact event sequence of the contingency is deliberately not
 * asserted. The stale-evidence (H6) refusal needs the spray stage, which only a full mission reaches; the
 * batch's inject.stale_evidence arm covers it. Not the whole rescue (see mission.e2e.test.ts and the batch).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Capabilities } from "./capabilities.ts";
import { planRuns } from "./conditions.ts";
import { LOCALIZATION_LOSS_TICK } from "./injections.ts";
import { runOne } from "./runner.ts";

const CAPS: Capabilities = { flyvisService: { available: false, detail: "test: no service" }, runtimeRangeAssistOption: false, runtimeInitialWaterOption: false };

describe("batch runner (headless, short runs)", () => {
  test("a condition whose requirement is missing is recorded as not run, never substituted", async () => {
    const [readout] = planRuns(["s1"], ["main.readout"]);
    const out = await runOne(readout, { outDir: null, capabilities: CAPS, connectNeural: null });
    assert.equal(out.record.status, "not_run");
    assert.match(out.record.reason ?? "", /FlyVis service was unavailable.*test: no service/);
    assert.equal(out.runtime, null);
    assert.equal(out.record.metrics, null);
    const [noRange] = planRuns(["s1"], ["main.flow.no_range"]);
    assert.match((await runOne(noRange, { outDir: null, capabilities: CAPS, connectNeural: null })).record.reason ?? "", /gap/);
  });

  test("the same seed and condition export a byte-identical events.jsonl and the same results apart from timing", { timeout: 10 * 60_000 }, async () => {
    const [spec] = planRuns(["det-seed"], ["main.flow"]);
    const a = await runOne(spec, { outDir: null, capabilities: CAPS, connectNeural: null, maxTicks: 2500 });
    const b = await runOne(spec, { outDir: null, capabilities: CAPS, connectNeural: null, maxTicks: 2500 });
    assert.equal(a.record.status, "ran", a.record.reason ?? "");
    assert.ok(a.files !== null && b.files !== null);
    assert.ok(/"kind":"proposal\.proposed"/.test(a.files["events.jsonl"]) && /"kind":"decision\.selected"/.test(a.files["events.jsonl"]), "the run got as far as planning decisions and proposals");
    assert.equal(a.files["events.jsonl"], b.files["events.jsonl"]);
    assert.equal(a.record.eventsSha256, b.record.eventsSha256);
    const strip = (text: string) => {
      const json = JSON.parse(text) as Record<string, unknown>;
      delete json.timing;
      return json;
    };
    assert.deepEqual(strip(a.files["results.json"]), strip(b.files["results.json"]));
    const untimed = (m: object | null) => ({ ...m, wallS: null, simToWall: null });
    assert.deepEqual(untimed(a.record.metrics), untimed(b.record.metrics));
  });

  test("an injected localization loss selects a localization contingency and stops advancement", { timeout: 15 * 60_000 }, async () => {
    const [spec] = planRuns(["loc-seed"], ["inject.localization_loss"]);
    const out = await runOne(spec, { outDir: null, capabilities: CAPS, connectNeural: null, maxTicks: LOCALIZATION_LOSS_TICK + 1500 });
    assert.equal(out.record.status, "ran", out.record.reason ?? "");
    assert.equal(out.record.injection?.applied, true);
    assert.equal(out.record.injection?.tick, LOCALIZATION_LOSS_TICK);
    assert.ok(out.runtime !== null);
    const after = out.runtime.log.entries().filter(e => e.tick >= LOCALIZATION_LOSS_TICK);
    const applied = after.find(e => e.kind === "experiment.applied");
    assert.equal((applied?.data.experiment as { kind?: string } | undefined)?.kind, "degrade_localization");
    const contingency = after.find(e => e.kind === "contingency.selected");
    assert.equal(contingency?.data.trigger, "localization_lost", `harness events after the loss: ${after.filter(e => e.source === "harness").slice(0, 6).map(e => e.kind).join(", ")}`);
    const planned = out.runtime.harness.records().filter(r => r.proposal.proposer === "local_planner" || r.proposal.proposer === "decisions_planner");
    const startedAfter = planned.filter(r => r.history.some(h => h.status === "executing" && h.tick > LOCALIZATION_LOSS_TICK));
    assert.deepEqual(startedAfter.map(r => `${r.proposal.id} ${r.proposal.action.kind}`), [], "no planner action starts executing after the loss");
    const submittedAfter = planned.filter(r => r.proposal.createdTick > LOCALIZATION_LOSS_TICK);
    for (const r of submittedAfter) {
      assert.ok(["rejected", "invalidated", "expired", "aborted"].includes(r.status), `${r.proposal.id} (${r.proposal.action.kind}) is ${r.status} after the loss`);
      const rules = r.history.flatMap(h => h.ruleIds);
      if (rules.length > 0) assert.ok(rules.includes("H10"), `${r.proposal.id} refused under ${rules.join(",")} rather than H10`);
    }
    assert.equal(out.record.metrics?.unauthorizedActions, 0);
  });
});
