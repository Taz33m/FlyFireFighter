/**
 * MissionRuntime behaviour on the Troy main preset, headless (collider camera, optical-flow baseline, local
 * planner, scripted commander). Scope: the first seconds to minutes of a run, not the whole rescue (see
 * mission.e2e.test.ts): determinism of the exported event log, validity of every simulated observation,
 * isolation of a new run from an old run's approvals, and the localization-loss contingency.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256Hex } from "../contracts/canonical.ts";
import { observationProblems } from "../evidence/schemas.ts";
import { FALLBACK_LABEL } from "./controller-slot.ts";
import { driveMission, runConfig, troyMeta } from "./mission-driver.ts";
import { MissionRuntime } from "./runtime.ts";

describe("mission runtime (Troy main preset, headless)", () => {
  test("the same seed and configuration export a byte-identical events.jsonl and the same results apart from timing", async () => {
    const a = await driveMission({ runId: "run-det", seed: "det-seed", maxTicks: 1200 });
    const b = await driveMission({ runId: "run-det", seed: "det-seed", maxTicks: 1200 });
    const ja = a.runtime.log.toJsonl();
    assert.ok(a.events.length > 5, "the run produced events");
    assert.equal(sha256Hex(ja), sha256Hex(b.runtime.log.toJsonl()));
    const strip = (text: string) => {
      const json = JSON.parse(text) as Record<string, unknown>;
      delete json.timing;
      return json;
    };
    const fa = a.runtime.exportRun("meta-sha");
    const fb = b.runtime.exportRun("meta-sha");
    assert.equal(fa["events.jsonl"], ja);
    assert.equal(fa["replay.jsonl"], fb["replay.jsonl"], "replay frames are deterministic too");
    const frames = fa["replay.jsonl"].trim().split("\n").map(line => JSON.parse(line) as { tick: number; render: { label: string }; summary: { controllerLabel: string } });
    assert.ok(frames.length >= 100 && frames.every((f, i) => f.tick % 10 === 0 && (i === 0 || f.tick > frames[i - 1].tick)), "≤ 10 Hz of simulation time, in order");
    assert.ok(frames.every(f => f.render.label === "simulation_truth_for_rendering" && f.summary.controllerLabel === "Optical-flow baseline"));
    assert.deepEqual(strip(fa["results.json"]), strip(fb["results.json"]));
    const results = JSON.parse(fa["results.json"]) as { events: { sha256: string }; camera: { calibrationId: string; renderers: string[] }; controller: { label: string } };
    assert.equal(results.events.sha256, sha256Hex(ja));
    assert.deepEqual(results.camera, { calibrationId: "rgb-front/v1", renderers: ["headless-collider/v1"] });
    assert.equal(results.controller.label, "Optical-flow baseline");
    a.runtime.close();
    b.runtime.close();
  });

  test("every simulated observation passes the evidence schema and none is rejected by the store", async () => {
    const problems: string[] = [];
    let checked = 0;
    const run = await driveMission({
      runId: "run-obs",
      maxTicks: 2000,
      until: runtime => {
        if (runtime.world.tick % 500 !== 0) return false;
        for (const observation of runtime.currentBelief.observations) {
          checked += 1;
          for (const problem of observationProblems(observation)) problems.push(`${observation.id}: ${problem}`);
        }
        return false;
      },
    });
    const stats = run.runtime.sensingStats();
    assert.ok(checked > 100 && stats.ingested > 100, `checked ${checked}, ingested ${stats.ingested}`);
    assert.deepEqual(problems.slice(0, 5), []);
    assert.deepEqual(stats.rejections, []);
    run.runtime.close();
  });

  test("a new run refuses approvals and rejections addressed to the previous run", async () => {
    const old = await driveMission({ runId: "run-old", maxTicks: 300 });
    const record = old.runtime.harness.records()[0];
    assert.ok(record !== undefined);
    old.runtime.close();
    const fresh = await driveMission({
      runId: "run-new",
      maxTicks: 320,
      script: [
        { tick: 310, command: () => ({ type: "approve", runId: "run-old", proposalId: record.proposal.id, digest: record.proposal.digest, commanderId: "scripted-commander", tick: 310 }) },
        { tick: 310, command: () => ({ type: "reject", runId: "run-old", proposalId: record.proposal.id, commanderId: "scripted-commander", tick: 310, reason: "late" }) },
      ],
    });
    const refusals = fresh.events.filter(e => e.kind === "command.refused" && e.reason.includes("run-old"));
    assert.equal(refusals.length, 2, JSON.stringify(fresh.events.filter(e => e.tick >= 310).map(e => e.reason)));
    assert.ok(fresh.runtime.harness.records().every(r => r.approval === null && r.status !== "approved"));
    fresh.runtime.close();
  });

  test("localization loss stops mission advancement and starts a supported contingency (or records failure)", async () => {
    const lossTick = 1200;
    const run = await driveMission({
      runId: "run-loc",
      maxTicks: 3500,
      script: [{ tick: lossTick, command: runId => ({ type: "experiment", runId, experiment: { kind: "degrade_localization", sigmaIncreaseM: 3 } }) }],
    });
    const selected = run.events.find(e => e.kind === "contingency.selected" && e.tick >= lossTick);
    assert.ok(selected !== undefined, "a contingency was selected after the loss");
    assert.equal(selected.data.trigger, "localization_lost");
    const advancing = run.runtime.harness.records().filter(r => r.proposal.proposer === "local_planner" && ["move", "scan"].includes(r.proposal.action.kind) && r.history.some(h => h.status === "executing" && h.tick > selected.tick));
    assert.deepEqual(advancing.map(r => r.proposal.id), [], "no planner move or scan starts after the loss");
    const interventions = run.runtime.harness.records().filter(r => ["breach_opening", "spray", "release_payload"].includes(r.proposal.action.kind) && r.history.some(h => h.status === "executing" && h.tick > lossTick));
    assert.deepEqual(interventions, []);
    run.runtime.close();
  });

  test("conditions for paired runs: range assistance off withholds ranges from motion only; reduced water is validated and recorded", async () => {
    const off = await driveMission({ runId: "run-noassist", maxTicks: 300, rangeAssist: false, initialWaterL: 0.25 });
    const on = await driveMission({ runId: "run-assist", maxTicks: 300 });
    assert.equal(off.runtime.motionRanges(), null);
    assert.ok(on.runtime.motionRanges() !== null, "with assistance the controller gets the arrived readings");
    assert.ok(off.runtime.sensingStats().ingested > 0, "range sensors still feed evidence");
    assert.equal(off.runtime.currentBelief.aircraft.waterRemainingL, 0.25);
    const results = JSON.parse(off.runtime.exportRun()["results.json"]) as { conditions: unknown };
    assert.deepEqual(results.conditions, { rangeAssist: false, initialWaterL: 0.25 });
    assert.deepEqual((JSON.parse(on.runtime.exportRun()["results.json"]) as { conditions: unknown }).conditions, { rangeAssist: true, initialWaterL: 1 });
    await assert.rejects(driveMission({ runId: "run-bad-water", maxTicks: 1, initialWaterL: 1.5 }), RangeError);
    off.runtime.close();
    on.runtime.close();
  });

  test("an engineered-readout run whose FlyVis connection fails flies the labelled optical-flow fallback", async () => {
    const run = await driveMission({ runId: "run-neural-down", maxTicks: 200, controller: "engineered_readout", neural: () => Promise.reject(new Error("service not running")) });
    const view = run.runtime.view().controller;
    assert.equal(view.label, FALLBACK_LABEL);
    assert.equal(view.source, "classical_fallback");
    assert.equal(view.neural?.status, "fallback");
    assert.ok(run.events.some(e => e.kind === "controller.fallback" && e.reason.includes("service not running")));
    run.runtime.close();
  });

  test("before authorization a typed report moves the status to awaiting_authorization without advancing the clock", async () => {
    const { meta } = troyMeta();
    const runtime = await MissionRuntime.create({ runId: "run-status", config: runConfig(), meta });
    assert.equal(runtime.view().status, "awaiting_report");
    runtime.command({ type: "report", runId: "run-status", text: "Someone may be in the upstairs rear bedroom.", channel: "typed", source: "judge" });
    const step = await runtime.step();
    assert.equal(step.advanced, false);
    assert.equal(runtime.world.tick, 0);
    assert.equal(runtime.view().status, "awaiting_authorization");
    assert.equal(runtime.view().belief.reports.length, 1);
    runtime.command({ type: "authorize_mission", runId: "run-status", commanderId: "commander" });
    await runtime.step();
    assert.equal(runtime.view().status, "running");
    runtime.close();
  });
});

describe("evidence window and route evidence", () => {
  test("the belief keeps every observation an evacuation route may cite", async () => {
    const { DEFAULT_POLICY } = await import("../harness/policy.ts");
    const { EVIDENCE_DEFAULTS } = await import("../evidence/config.ts");
    // H15 refuses a guide whose route cites an observation no longer in the belief; the runtime's evidence
    // window therefore spans the route evidence age, which exceeds the default 30 s window.
    assert.ok(DEFAULT_POLICY.routeEvidenceMaxAgeTicks > EVIDENCE_DEFAULTS.observationWindowTicks);
    const { meta } = troyMeta();
    const runtime = await MissionRuntime.create({ runId: "run-window", config: runConfig(), meta });
    assert.equal(runtime.evidence.config.observationWindowTicks, DEFAULT_POLICY.routeEvidenceMaxAgeTicks);
  });
});
