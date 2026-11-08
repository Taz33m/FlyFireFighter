/**
 * Recorded replay model: the rail, outcome and timeline at a playhead are rebuilt only from events up to that
 * tick and the truth-free frame summary, and the outcome appears only when the recording reaches it.
 *
 * Scope: small hand-built bundles in the exported format (events.jsonl lines shaped like the harness's
 * proposal.* events, results.json, replay.jsonl with a truth-free summary), always passed through buildBundle
 * so validation applies as on the page. Frames carry a deliberately misleading `render` (a true drone position
 * inside the house) to show that nothing here reads it. The 3D playback itself is checked in the browser.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MissionEvent } from "../../lib/contracts/events.ts";
import type { MissionResult } from "../../lib/contracts/outcomes.ts";
import { buildBundle } from "../results/bundle.ts";
import type { ReplayModel } from "./replay-model.ts";
import { contingencyReason, createReplayModel, eventCountAt, frameIndexAt, gateFrameFrom, momentAt, outcomeAt, summaryOf } from "./replay-model.ts";

const RUN = "run-r";
const BREACH = { kind: "breach_opening", openingId: "win-rear", standoff: { x: 0, y: 0, z: 4 }, strikePoint: { x: 0, y: 0.5, z: 4 } };
const SPRAY = { kind: "spray", standoff: { x: 1, y: 1, z: 4 }, aimPoint: { x: 2, y: 1, z: 4 }, flowLps: 0.1, durationTicks: 300 };
const GUIDE = { kind: "guide", trackId: "t1", routeId: "route-evac", templateIds: [], maxDurationTicks: 1000 };
const REGION = { kind: "sphere", center: { x: 0, y: 0.5, z: 4 }, radiusM: 1 };

let seq = 0;
function event(tick: number, kind: string, data: MissionEvent["data"] = {}, extra: Partial<MissionEvent> = {}): MissionEvent {
  seq += 1;
  return { seq, runId: RUN, tick, source: "harness", kind, subject: null, ruleIds: [], reason: kind, data, ...extra };
}

/** proposal.<status> as the harness logs it; proposal.proposed also carries the full proposal. */
function proposal(tick: number, id: string, action: { kind: string }, status: string, extra: Partial<MissionEvent> = {}): MissionEvent {
  const risk = action.kind === "breach_opening" || action.kind === "spray" ? "consequential" : "routine";
  const data: MissionEvent["data"] = { proposalId: id, actionKind: action.kind, proposer: "local_planner", risk, status, digest: "d".repeat(64), findings: [], affectedRegion: risk === "consequential" ? REGION : null };
  return event(tick, `proposal.${status}`, status === "proposed" ? { ...data, proposal: { id, action } } : data, { subject: id, ...extra });
}

const START: MissionEvent[] = [
  event(0, "report.received", { roomHint: "bedroom-rear", originalText: "Someone may be upstairs." }, { source: "intake" }),
  event(0, "mission.authorized", { commanderId: "judge" }, { source: "commander" }),
];

function result(overrides: Partial<MissionResult> = {}): MissionResult {
  return {
    label: "simulation_evaluator", runId: RUN, seed: "s", endedTick: 900, budgetTick: 1200,
    occupants: [{ label: "simulation_evaluator", occupantKey: "occupant-1", outcome: "reached_assembly_point", arrivalTick: 850 }],
    violations: [], droneReturn: "returned", ...overrides,
  };
}

interface FrameOptions {
  readonly pending?: (tick: number) => string | null;
  readonly contingency?: (tick: number) => string | null;
  readonly status?: (tick: number) => string;
}

/** One frame every 10 ticks up to `last`, each with a TRUE drone position inside the house in `render`. */
function frames(last: number, o: FrameOptions = {}): object[] {
  const out: object[] = [];
  for (let tick = 10; tick <= last; tick += 10) {
    out.push({
      tick,
      render: { label: "simulation_truth_for_rendering", tick, drone: { position: { x: 2, y: 2, z: 4.2 }, yawRad: 0, velocity: { x: 0, y: 0, z: 0 } } },
      summary: { status: o.status?.(tick) ?? "running", controllerLabel: "Optical-flow baseline", deciderLabel: "Local planner", waterRemainingL: 1, pendingApprovalId: o.pending?.(tick) ?? null, contingency: o.contingency?.(tick) ?? null },
    });
  }
  return out;
}

const jsonl = (items: readonly object[]) => items.map(i => `${JSON.stringify(i)}\n`).join("");

function model(events: readonly MissionEvent[], r: MissionResult | null, frameList: readonly object[], resultsExtra: object = {}): ReplayModel {
  const results = JSON.stringify({ schema: "flyfirefighter.results/1", runId: RUN, result: r, ...resultsExtra });
  return createReplayModel(buildBundle({ "results.json": results, "events.jsonl": jsonl(events), "replay.jsonl": jsonl(frameList) }, { kind: "file", names: [] }));
}

const at = (m: ReplayModel, tick: number) => momentAt(m, frameIndexAt(m, tick), null);
const stepOf = (m: ReplayModel, tick: number, id: string) => at(m, tick).rail.steps.find(s => s.id === id);

describe("approval gates move and hold the rail", () => {
  const gated = [
    ...START,
    proposal(100, "p1", BREACH, "proposed"),
    proposal(100, "p1", BREACH, "awaiting_approval"),
    proposal(200, "p1", BREACH, "approved", { source: "harness" }),
    proposal(210, "p1", BREACH, "executing"),
    proposal(260, "p1", BREACH, "completed"),
    proposal(400, "p2", SPRAY, "proposed"),
    proposal(400, "p2", SPRAY, "awaiting_approval"),
    proposal(450, "p2", SPRAY, "approved"),
    proposal(460, "p2", SPRAY, "executing"),
    proposal(520, "p2", SPRAY, "completed"),
  ];
  const pending = (tick: number) => (tick >= 100 && tick < 200 ? "p1" : tick >= 400 && tick < 450 ? "p2" : null);
  const m = model(gated, null, frames(600, { pending }));

  test("a gate awaiting approval, then completed, moves the rail from approach to access to reassess", () => {
    assert.equal(at(m, 50).rail.current, "approach");
    const waiting = at(m, 150);
    assert.equal(waiting.rail.current, "access");
    assert.equal(waiting.rail.steps.find(s => s.id === "access")?.gate, "awaiting_approval");
    assert.equal(waiting.view.pendingApproval?.proposal.id, "p1", "the pending record is the one the summary names");
    assert.match(waiting.rail.caption, /Waiting for your approval to break the window/);
    assert.equal(stepOf(m, 300, "access")?.gate, "completed");
    assert.equal(at(m, 300).rail.current, "access", "no recorded estimated pose: broken glass alone is not entry");
    assert.equal(at(m, 420).rail.current, "suppress");
    assert.equal(at(m, 600).rail.current, "reassess");
    assert.equal(stepOf(m, 600, "access")?.state, "done");
  });

  test("the rebuilt proposal keeps its recorded history and affected region", () => {
    const end = at(m, 600);
    const breach = end.proposals.find(p => p.proposal.id === "p1");
    assert.deepEqual(breach?.history.map(h => [h.tick, h.status]), [[100, "proposed"], [100, "awaiting_approval"], [200, "approved"], [210, "executing"], [260, "completed"]]);
    assert.equal(breach?.proposal.action.openingId, "win-rear");
    assert.equal(breach?.risk, "consequential");
    assert.deepEqual(end.view.affectedRegions.map(r => r.proposalId), ["p1", "p2"]);
  });

  test("jumping between approval gates lands on gate frames and never on routine actions", () => {
    const withRoutine = model([...gated, proposal(530, "p3", GUIDE, "proposed"), proposal(530, "p3", GUIDE, "validated"), proposal(540, "p3", GUIDE, "executing")], null, frames(600));
    const gateTicks = withRoutine.gateFrames.map(i => withRoutine.frameTicks[i]);
    assert.deepEqual(gateTicks, [100, 200, 210, 260, 400, 450, 460, 520]);
    const first = gateFrameFrom(withRoutine, 0, 1);
    assert.equal(first === null ? null : withRoutine.frameTicks[first], 100);
    const last = withRoutine.frameTicks.length - 1;
    const back = gateFrameFrom(withRoutine, last, -1);
    assert.equal(back === null ? null : withRoutine.frameTicks[back], 520);
    assert.equal(gateFrameFrom(withRoutine, withRoutine.gateFrames[withRoutine.gateFrames.length - 1], 1), null);
  });
});

describe("refusals hold the rail", () => {
  test("a commander-rejected spray holds the rail at suppress for the rest of the recording", () => {
    const events = [
      ...START,
      proposal(100, "p1", BREACH, "proposed"), proposal(100, "p1", BREACH, "awaiting_approval"), proposal(150, "p1", BREACH, "approved"), proposal(160, "p1", BREACH, "executing"), proposal(200, "p1", BREACH, "completed"),
      proposal(300, "p2", SPRAY, "proposed"), proposal(300, "p2", SPRAY, "awaiting_approval"), proposal(350, "p2", SPRAY, "rejected", { source: "harness" }),
    ];
    const m = model(events, null, frames(800));
    for (const tick of [360, 500, 800]) {
      const moment = at(m, tick);
      assert.equal(moment.rail.current, "suppress");
      assert.equal(moment.rail.steps.find(s => s.id === "suppress")?.gate, "rejected");
      assert.match(moment.rail.caption, /You rejected the water spray/);
      assert.deepEqual(moment.rail.steps.slice(5).map(s => s.state), ["upcoming", "upcoming", "upcoming"]);
    }
  });
});

describe("the outcome follows the playhead", () => {
  const rescued = [
    ...START,
    proposal(100, "p1", BREACH, "proposed"), proposal(100, "p1", BREACH, "awaiting_approval"), proposal(120, "p1", BREACH, "completed"),
    proposal(200, "p2", SPRAY, "proposed"), proposal(200, "p2", SPRAY, "awaiting_approval"), proposal(220, "p2", SPRAY, "completed"),
    proposal(300, "p3", GUIDE, "proposed"), proposal(300, "p3", GUIDE, "validated"), proposal(310, "p3", GUIDE, "executing"), proposal(700, "p3", GUIDE, "completed"),
    event(850, "evaluator.occupant_arrived", {}, { source: "evaluator" }),
    event(895, "outcome.recorded", { rescueLabel: "simulated_evacuation_completed" }, { source: "evaluator" }),
  ];

  test("the outcome is hidden before outcome.recorded and visible from it", () => {
    const m = model(rescued, result(), frames(900));
    assert.equal(m.outcomeTick, 895);
    assert.equal(outcomeAt(m, 890), null);
    const before = at(m, 890);
    assert.equal(before.outcome, null);
    assert.equal(before.outcomeReached, false);
    assert.equal(before.rail.current, "guide", "an arrival event alone does not reveal the outcome");
    assert.equal(before.view.status, "running");
    const after = at(m, 900);
    assert.deepEqual(after.outcome, result());
    assert.equal(after.view.status, "ended", "as in the runtime, a recorded outcome ends the run");
  });

  test("a completed rescue reaches \"Outside\" done only once isCompletedRescue holds and the outcome is reached", () => {
    const m = model(rescued, result(), frames(900));
    assert.equal(stepOf(m, 890, "outside")?.state, "upcoming");
    const end = at(m, 900);
    assert.equal(end.rail.current, "outside");
    assert.equal(stepOf(m, 900, "outside")?.state, "done");
    assert.match(end.rail.caption, /^Simulated evacuation completed/);
    assert.equal(m.finalOutcome.words, "Simulated evacuation completed");
  });

  test("an incomplete result (arrival after budget) never reads \"Simulated evacuation completed\", at any playhead", () => {
    const late = result({ occupants: [{ label: "simulation_evaluator", occupantKey: "occupant-1", outcome: "reached_assembly_point", arrivalTick: 1300 }] });
    const m = model(rescued, late, frames(900));
    for (let i = 0; i < m.frames.length; i++) {
      const moment = momentAt(m, i, null);
      assert.doesNotMatch(moment.rail.caption, /evacuation completed/i, `frame ${i}`);
      assert.notEqual(moment.rail.steps.find(s => s.id === "outside")?.state, "done");
    }
    assert.equal(at(m, 900).rail.halt?.kind, "ended_incomplete");
    assert.equal(m.finalOutcome.words, "Incomplete: human assistance needed");
  });

  test("without an outcome.recorded event a scored result appears only at the last recorded frame", () => {
    const m = model(rescued.filter(e => e.kind !== "outcome.recorded"), result(), frames(900));
    assert.equal(m.outcomeRecorded, false);
    assert.equal(at(m, 890).outcome, null);
    assert.notEqual(at(m, 900).outcome, null);
  });
});

describe("only events up to the playhead, and only this run's validated result", () => {
  test("events after the playhead are excluded from the timeline count, reports, tracks and routes", () => {
    const events = [
      ...START,
      event(100, "route.status_changed", { routeId: "route-evac", purpose: "evacuation", status: "unknown" }, { source: "evidence" }),
      event(200, "track.created", { trackId: "t1", roomId: "bedroom-rear", uncertaintyM: 0.4, confidence: 0.5 }, { source: "evidence" }),
      event(300, "route.status_changed", { routeId: "route-evac", purpose: "evacuation", status: "supported" }, { source: "evidence" }),
      event(305, "report.received", { roomHint: null, originalText: "Second call." }, { source: "intake" }),
    ];
    const m = model(events, null, frames(400));
    assert.equal(eventCountAt(m, 150), 3);
    const early = at(m, 150);
    assert.equal(early.eventCount, 3);
    assert.deepEqual(early.view.belief.tracks, []);
    assert.deepEqual(early.view.belief.routes, [{ purpose: "evacuation", status: "unknown" }]);
    assert.equal(early.view.belief.reports.length, 1);
    const late = at(m, 400);
    assert.equal(late.eventCount, 6);
    assert.deepEqual(late.view.belief.tracks, [{ status: "possible", roomId: "bedroom-rear", uncertaintyM: 0.4, position: null }]);
    assert.deepEqual(late.view.belief.routes, [{ purpose: "evacuation", status: "supported" }], "the latest status per route");
    assert.equal(late.view.belief.reports.length, 2);
  });

  test("the estimated pose is never taken from frame.render: without summary.estimatedPosition it is null", () => {
    const m = model(START, null, frames(100));
    assert.equal(at(m, 100).view.belief.pose, null);
    assert.equal(at(m, 100).summary.estimatedPosition, null);
  });

  test("a recorded summary.estimatedPosition is read as the estimated pose; malformed values are ignored", () => {
    const base = frames(20) as { summary: object }[];
    const withPose = base.map((f, i) => ({ ...f, summary: { ...f.summary, estimatedPosition: i === 0 ? { x: 1, y: 2, z: 3 } : { x: "no" } } }));
    const m = model(START, null, withPose);
    assert.deepEqual(momentAt(m, 0, null).view.belief.pose, { position: { x: 1, y: 2, z: 3 } });
    assert.equal(momentAt(m, 1, null).view.belief.pose, null);
  });

  test("a foreign-run or malformed evaluator result stays unscored and never reaches the rail", () => {
    const events = [...START, event(895, "outcome.recorded", {}, { source: "evaluator" })];
    for (const bad of [result({ runId: "run-other" }), { ...result(), droneReturn: "teleported" }, { runId: RUN, occupants: [] }]) {
      const m = model(events, bad as MissionResult, frames(900), { outcome: { rescueLabel: "simulated_evacuation_completed" } });
      assert.equal(m.result, null);
      assert.equal(m.finalOutcome.scored, false);
      assert.equal(m.finalOutcome.words, "Incomplete: human assistance needed");
      const end = at(m, 900);
      assert.equal(end.outcome, null);
      assert.equal(end.outcomeReached, true, "the recording still reached its outcome event");
      assert.notEqual(end.rail.current, "outside");
      assert.doesNotMatch(end.rail.caption, /evacuation completed/i);
    }
  });

  test("events from another run in the same file are left out of the replay", () => {
    const m = model([...START, event(100, "mission.authorized", {}, { runId: "run-other" }), event(120, "report.received", { roomHint: "x" }, { runId: "run-other" })], null, frames(200));
    assert.equal(m.excludedEvents, 2);
    assert.equal(at(m, 200).view.belief.reports.length, 1);
  });
});

describe("contingencies and summaries", () => {
  test("a contingency in the summary halts the rail with the contingency's own reason from the latest contingency.selected", () => {
    const events = [...START, event(100, "contingency.selected", { kind: "return", trigger: "localization_lost" }, { reason: "Contingency return started (trigger: localization_lost): Localization stopped supporting movement. Returning." })];
    const m = model(events, null, frames(200, { contingency: tick => (tick >= 100 ? "return" : null) }));
    assert.equal(at(m, 90).rail.halt, null);
    const halted = at(m, 150).rail;
    assert.equal(halted.halt?.kind, "contingency");
    assert.match(halted.caption, /^Localization stopped supporting movement; the drone is returning\.$/);
  });

  test("the contingency reason is the text after the trigger; summaries with missing fields read safely", () => {
    assert.equal(contingencyReason("Contingency failure (trigger: no_route): No supported manoeuvre."), "No supported manoeuvre.");
    assert.equal(contingencyReason("Plain reason."), "Plain reason.");
    const s = summaryOf({ tick: 5 } as never);
    assert.deepEqual([s.status, s.controllerLabel, s.pendingApprovalId, s.contingency, s.estimatedPosition], ["running", null, null, null, null]);
  });

  test("reconstruction from checkpoints matches reconstruction from the start, in any seek order", () => {
    const many: MissionEvent[] = [...START];
    for (let i = 0; i < 150; i++) many.push(event(10 + i * 5, "track.created", { trackId: `t${i}`, roomId: null, uncertaintyM: 0.5 }, { source: "evidence" }));
    many.push(proposal(900, "p1", BREACH, "proposed"), proposal(900, "p1", BREACH, "awaiting_approval"));
    const forward = model(many, null, frames(1000));
    const backward = model(many, null, frames(1000));
    const indices = forward.frames.map((_, i) => i);
    const a = indices.map(i => momentAt(forward, i, null));
    const b = [...indices].reverse().map(i => momentAt(backward, i, null)).reverse();
    for (const i of indices) {
      assert.equal(a[i].view.belief.tracks.length, b[i].view.belief.tracks.length);
      assert.equal(a[i].rail.caption, b[i].rail.caption);
    }
    assert.equal(a[a.length - 1].view.belief.tracks.length, 150);
    assert.equal(a[a.length - 1].rail.current, "access");
  });
});
