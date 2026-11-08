/**
 * Results page logic: bundle file grouping and validation, the outcome wording rule, action/approval history
 * from the event log, per-run figures and per-condition aggregates. Uses small hand-built bundles in the
 * exported format; the page rendering itself is checked in the browser.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MissionEvent } from "../../lib/contracts/events.ts";
import type { MissionResult } from "../../lib/contracts/outcomes.ts";
import type { RunBundle } from "./bundle.ts";
import { COMPLETED_WORDS, DRONE_RETURNS, INCOMPLETE_WORDS, buildBundle, classifyFileName, groupFiles, outcomeOf, resultProblem } from "./bundle.ts";
import { actionHistory, aggregate, pairs, runFigures } from "./metrics.ts";

const RUN = "run-a";
let seq = 0;
function event(tick: number, kind: string, data: MissionEvent["data"] = {}, extra: Partial<MissionEvent> = {}): MissionEvent {
  seq += 1;
  return { seq, runId: RUN, tick, source: "harness", kind, subject: null, ruleIds: [], reason: kind, data, ...extra };
}

function result(overrides: Partial<MissionResult> = {}): MissionResult {
  return {
    label: "simulation_evaluator", runId: RUN, seed: "s1", endedTick: 9000, budgetTick: 12000,
    occupants: [{ label: "simulation_evaluator", occupantKey: "occ-1", outcome: "reached_assembly_point", arrivalTick: 8000 }],
    violations: [], droneReturn: "returned", ...overrides,
  };
}

function resultsText(r: MissionResult | null, extra: object = {}): string {
  return JSON.stringify({ schema: "flyfirefighter.results/1", runId: RUN, scenarioId: "troy-training/main", seed: "s1", controller: { label: "Optical-flow baseline" }, decider: { label: "Local planner" }, result: r, ...extra });
}

const jsonl = (items: readonly object[]) => items.map(i => `${JSON.stringify(i)}\n`).join("");
const fileOrigin = { kind: "file" as const, names: [] };

const EVENTS: MissionEvent[] = [
  event(100, "mission.authorized", {}, { source: "commander" }),
  event(1100, "track.created", {}, { source: "evidence" }),
  event(1200, "proposal.awaiting_approval", { proposalId: "p-glass", actionKind: "breach_opening", proposer: "local_planner" }),
  event(1500, "proposal.approved", { proposalId: "p-glass", actionKind: "breach_opening", proposer: "local_planner", approval: { commanderId: "judge" } }),
  event(1510, "proposal.executing", { proposalId: "p-glass", actionKind: "breach_opening", proposer: "local_planner" }),
  event(1520, "proposal.completed", { proposalId: "p-glass", actionKind: "breach_opening", proposer: "local_planner", effects: { waterDischargedL: 0, strikeDelivered: true, payloadReleased: false } }),
  event(3000, "proposal.approved", { proposalId: "p-spray", actionKind: "spray", proposer: "local_planner", approval: { commanderId: "judge" } }),
  event(3100, "proposal.aborted", { proposalId: "p-spray", actionKind: "spray", proposer: "local_planner", effects: { waterDischargedL: 0.42, strikeDelivered: false, payloadReleased: false } }, { ruleIds: ["H7"] }),
  event(3200, "proposal.rejected", { proposalId: "p-spray-2", actionKind: "spray", proposer: "local_planner", commanderId: "judge" }),
  event(8000, "evaluator.occupant_arrived", {}, { source: "evaluator" }),
  event(8200, "mission.aborted", {}, { source: "commander" }),
];

describe("bundle files", () => {
  test("recognises exported names with and without the run-id prefix", () => {
    assert.deepEqual(classifyFileName("run-7-events.jsonl"), { file: "events.jsonl", prefix: "run-7" });
    assert.deepEqual(classifyFileName("runs/run-7/results.json"), { file: "results.json", prefix: "" });
    assert.equal(classifyFileName("notes.txt"), null);
    assert.equal(classifyFileName("myevents.jsonl"), null);
  });

  test("groups two runs dropped together and flags duplicates and strays", () => {
    const { groups, ignored } = groupFiles([
      { name: "run-1-results.json", text: "{}" }, { name: "run-1-events.jsonl", text: "" },
      { name: "run-2-results.json", text: "{}" }, { name: "run-2-results.json", text: "{}" }, { name: "photo.png", text: "" },
    ]);
    assert.deepEqual([...groups.keys()].sort(), ["run-1", "run-2"]);
    assert.ok(groups.get("run-1")?.["events.jsonl"] !== undefined);
    assert.equal(ignored.length, 2);
  });

  for (const separator of ["/", "\\"]) {
    test(`keeps plain bundle files from separate directories together (${separator} paths)`, () => {
      const files = ["run-a", "run-b"].flatMap(runId => {
        const folder = ["batch", runId].join(separator);
        return [
          { name: `${folder}${separator}results.json`, text: resultsText(result({ runId }), { runId }) },
          { name: `${folder}${separator}events.jsonl`, text: jsonl([{ ...EVENTS[0], runId }]) },
          { name: `${folder}${separator}replay.jsonl`, text: jsonl([{ tick: runId === "run-a" ? 10 : 20 }]) },
        ];
      });
      const { groups, ignored } = groupFiles([...files, files[0]]);
      assert.equal(groups.size, 2, "both complete run bundles survive the selection");
      assert.deepEqual(ignored, [`${files[0].name} (duplicate results.json)`]);
      const bundles = [...groups.values()].map(group => buildBundle({
        "results.json": group["results.json"]?.text,
        "events.jsonl": group["events.jsonl"]?.text,
        "replay.jsonl": group["replay.jsonl"]?.text,
      }, fileOrigin));
      assert.deepEqual(bundles.map(bundle => bundle.results?.runId), ["run-a", "run-b"]);
      for (const bundle of bundles) {
        assert.deepEqual(bundle.problems, []);
        assert.equal(bundle.events[0].runId, bundle.results?.runId);
        assert.equal(bundle.replay[0].tick, bundle.results?.runId === "run-a" ? 10 : 20);
      }
    });
  }

  test("directory grouping cannot collide with a filename prefix and normalizes path separators", () => {
    const { groups, ignored } = groupFiles([
      { name: "run-a-results.json", text: "root" },
      { name: "run-a/results.json", text: "folder" },
      { name: "run-a\\events.jsonl", text: "folder events" },
      { name: "archive/run-a-results.json", text: "archive" },
    ]);
    assert.equal(groups.size, 3);
    assert.deepEqual(ignored, []);
    assert.equal(groups.get("run-a")?.["results.json"]?.text, "root");
    assert.equal(groups.get("run-a/")?.["results.json"]?.text, "folder");
    assert.equal(groups.get("run-a/")?.["events.jsonl"]?.text, "folder events");
    assert.equal(groups.get("archive/run-a")?.["results.json"]?.text, "archive");
  });

  test("reports missing files, unreadable lines and events from another run", () => {
    const bundle = buildBundle({ "results.json": resultsText(result()), "events.jsonl": `${jsonl([EVENTS[0], { ...EVENTS[1], runId: "run-b" }])}{oops\n` }, fileOrigin);
    assert.ok(bundle.problems.some(p => p.includes("replay.jsonl is missing")));
    assert.ok(bundle.problems.some(p => p.includes("unreadable line") && p.includes("line 3")));
    assert.ok(bundle.problems.some(p => p.includes("another run")));
    assert.equal(bundle.events.length, 2);
  });

  test("sorts replay frames by tick", () => {
    const bundle = buildBundle({ "replay.jsonl": jsonl([{ tick: 20 }, { tick: 10 }]) }, fileOrigin);
    assert.deepEqual(bundle.replay.map(f => f.tick), [10, 20]);
  });
});

describe("outcome wording", () => {
  const words = (r: MissionResult | null, extra?: object) => outcomeOf(buildBundle({ "results.json": resultsText(r, extra) }, fileOrigin));

  test("only an evaluator-verified arrival within budget and without violations is a completed evacuation", () => {
    assert.equal(words(result()).words, COMPLETED_WORDS);
    assert.equal(words(result({ violations: [{ tick: 50, kind: "collision", detail: "wall" }] })).words, INCOMPLETE_WORDS);
    assert.equal(words(result({ occupants: [{ label: "simulation_evaluator", occupantKey: "o", outcome: "reached_assembly_point", arrivalTick: 13000 }] })).words, INCOMPLETE_WORDS);
    assert.equal(words(result({ occupants: [{ label: "simulation_evaluator", occupantKey: "o", outcome: "outside_not_at_assembly_point", arrivalTick: null }] })).words, INCOMPLETE_WORDS);
  });

  test("an unscored run is incomplete, never completed", () => {
    const o = words(null);
    assert.equal(o.words, INCOMPLETE_WORDS);
    assert.equal(o.scored, false);
  });

  test("a stored label that disagrees with the evaluator result is reported and not used", () => {
    const r = result({ violations: [{ tick: 50, kind: "hazardous_discharge", detail: "x" }] });
    const bundle = buildBundle({ "results.json": resultsText(r, { outcome: { rescueLabel: "simulated_evacuation_completed" } }) }, fileOrigin);
    assert.equal(outcomeOf(bundle).words, INCOMPLETE_WORDS);
    assert.ok(bundle.problems.some(p => p.includes("disagrees")));
  });

  test("another run's evaluator result is reported and the run reads as not scored", () => {
    const foreign = result({ runId: "run-b" });
    const bundle = buildBundle({ "results.json": resultsText(foreign, { outcome: { rescueLabel: "simulated_evacuation_completed" } }), "events.jsonl": jsonl(EVENTS) }, fileOrigin);
    assert.ok(bundle.problems.some(p => p.includes("another run (run-b)") && p.includes("not scored")));
    assert.deepEqual(outcomeOf(bundle), { words: INCOMPLETE_WORDS, completed: false, scored: false });
    assert.equal(bundle.results?.result, null, "views reading the bundle never see the foreign result");
    const f = runFigures(bundle);
    assert.deepEqual([f.outcome.scored, f.timeToExitS, f.droneReturn], [false, null, null]);
  });

  // Each damaged field of a stored result, as a hand-edited or truncated results.json could carry it.
  for (const [label, damaged] of [
    ["the minimal shape { runId, occupants: [] }", { runId: RUN, occupants: [] }],
    ["violations missing", { ...result(), violations: undefined }],
    ["violations not a list", { ...result(), violations: "none" }],
    ["occupants missing", { ...result(), occupants: undefined }],
    ["an occupant without an outcome", { ...result(), occupants: [{ label: "simulation_evaluator", occupantKey: "o", arrivalTick: 10 }] }],
    ["a non-integer budget", { ...result(), budgetTick: "soon" }],
    ["an unknown drone return", { ...result(), droneReturn: "teleported" }],
    ["a string instead of an object", "completed"],
  ] as const) {
    test(`a malformed evaluator result (${label}) is reported, not scored and never throws`, () => {
      const text = JSON.stringify({ schema: "flyfirefighter.results/1", runId: RUN, result: damaged, outcome: { rescueLabel: "simulated_evacuation_completed" } });
      const bundle = buildBundle({ "results.json": text, "events.jsonl": jsonl(EVENTS), "replay.jsonl": "" }, fileOrigin);
      assert.ok(bundle.problems.some(p => p.includes("evaluator result is unusable") && p.includes("not scored")), bundle.problems.join(" | "));
      const outcome = outcomeOf(bundle);
      assert.deepEqual(outcome, { words: INCOMPLETE_WORDS, completed: false, scored: false });
      const f = runFigures(bundle);
      assert.notEqual(f.outcome.words, COMPLETED_WORDS);
      assert.deepEqual([f.collisions, f.violations.length, f.droneReturn], [0, 0, null]);
      assert.deepEqual(aggregate([f]).map(r => [r.runs, r.scored, r.completed]), [[1, 0, 0]]);
    });
  }

  test("every drone-return value the contract defines is scored, including no departure recorded and forced descent", () => {
    for (const droneReturn of ["returned", "no_departure_recorded", "landed_contingency", "forced_descent", "failed_no_supported_maneuver", "not_returned"] as const) {
      assert.equal(resultProblem(result({ droneReturn }), RUN), null, droneReturn);
      const bundle = buildBundle({ "results.json": resultsText(result({ droneReturn })) }, fileOrigin);
      assert.ok(!bundle.problems.some(p => p.includes("unusable")), `${droneReturn}: ${bundle.problems.join(" | ")}`);
      assert.deepEqual(outcomeOf(bundle), { words: COMPLETED_WORDS, completed: true, scored: true }, "drone return never changes the rescue outcome");
      assert.equal(runFigures(bundle).droneReturn, droneReturn);
    }
    assert.equal(DRONE_RETURNS.length, 6);
  });

  test("a bundle assembled without buildBundle still cannot score a foreign or malformed result", () => {
    const base = buildBundle({ "results.json": resultsText(result()) }, fileOrigin);
    assert.ok(base.results !== null);
    for (const bad of [result({ runId: "run-b" }), { runId: RUN } as unknown as MissionResult]) {
      const bundle: RunBundle = { ...base, results: { ...base.results, result: bad } };
      assert.equal(outcomeOf(bundle).scored, false);
      assert.equal(runFigures(bundle).outcome.words, INCOMPLETE_WORDS);
    }
  });
});

describe("action history and run figures", () => {
  test("groups proposal transitions with the approving commander and recorded effects", () => {
    const history = actionHistory(EVENTS);
    const glass = history.find(h => h.proposalId === "p-glass");
    assert.ok(glass !== undefined);
    assert.deepEqual(glass.steps.map(s => s.status), ["awaiting_approval", "approved", "executing", "completed"]);
    assert.equal(glass.approvedBy, "judge");
    assert.equal(glass.effects?.strikeDelivered, true);
    assert.equal(glass.consequential, true);
    const spray = history.find(h => h.proposalId === "p-spray");
    assert.equal(spray?.finalStatus, "aborted");
    assert.equal(spray?.effects?.waterDischargedL, 0.42, "water discharged before an abort stays recorded");
  });

  test("times count from authorization; the post-arrival recall is not an abort", () => {
    const f = runFigures(buildBundle({ "results.json": resultsText(result()), "events.jsonl": jsonl(EVENTS) }, fileOrigin));
    assert.equal(f.timeToEvidenceS, 10);
    assert.equal(f.timeToExitS, 79);
    assert.equal(f.recalls, 1);
    assert.equal(f.aborts, 1, "the aborted spray proposal counts; the recall does not");
    assert.equal(f.waterDischargedL, 0.42);
    assert.equal(f.strikes, 1);
    assert.equal(f.approvals, 2);
    assert.equal(f.rejections, 1);
  });

  test("aggregates keep denominators per condition and pair runs by scenario and seed", () => {
    const completed = runFigures(buildBundle({ "results.json": resultsText(result()), "events.jsonl": jsonl(EVENTS) }, fileOrigin));
    const failed = runFigures(buildBundle({ "results.json": resultsText(result({ violations: [{ tick: 9, kind: "collision", detail: "door" }], droneReturn: "not_returned" }), { controller: { label: "FlyVis + trained readout" } }) }, fileOrigin));
    const unscored = runFigures(buildBundle({ "results.json": resultsText(null, { seed: "s2" }) }, fileOrigin));
    const rows = aggregate([completed, failed, unscored]);
    const baseline = rows.find(r => r.condition.startsWith("Optical-flow"));
    const fly = rows.find(r => r.condition.startsWith("FlyVis"));
    assert.deepEqual([baseline?.runs, baseline?.scored, baseline?.completed, baseline?.incomplete], [2, 1, 1, 1]);
    assert.deepEqual([fly?.runs, fly?.completed, fly?.runsWithCollision, fly?.returned], [1, 0, 1, 0]);
    assert.equal(baseline?.exit.count, 1);
    const paired = pairs([completed, failed, unscored]);
    assert.equal(paired.rows.length, 1, "only seed s1 ran under both conditions");
    assert.equal(paired.rows[0].pairKey, "troy-training/main · seed s1");
  });
});
