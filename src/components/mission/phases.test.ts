/**
 * Phase rail derivation: the failure modes a projector audience must never be misled by. Gate refusals hold
 * the rail; a detection never reaches "outside"; only this run's evaluator arrival does, and completion is
 * the evaluator's isCompletedRescue, not ours; aborts, contingencies and pauses halt the rail without erasing
 * progress.
 *
 * Scope: the rejected breach, the harness refusal at submission, the judge-challenge invalidation and the
 * abort-during-discharge records come from the real ActionHarness on the harness test house
 * (test-fixtures.ts), so gate states are the statuses and histories the harness actually produces. Completed
 * and guide records are hand-built (their lifecycles are covered by the harness tests). The localization
 * contingency is the harness's own selectContingency output. MissionView is assembled locally from those
 * records and makeBelief; nothing here runs the mission worker or reads simulator truth. The recorded-replay
 * cases narrow that MissionView to a PhaseView without an estimated pose, floor-plan prior or track positions,
 * as a replay rebuilt from events.jsonl has them (src/components/replay/replay-model.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionSpec, Contingency, ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import { TENDER_T1 } from "../../lib/contracts/aircraft.ts";
import type { MissionEnvelope } from "../../lib/contracts/envelope.ts";
import { EventLog } from "../../lib/contracts/events.ts";
import type { BeliefSnapshot, CallerReport, OccupantTrack, RouteAssessment } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import { vec3 } from "../../lib/contracts/frames.ts";
import { distanceToRegion } from "../../lib/contracts/geometry.ts";
import type { ConstraintViolation, MissionResult, OccupantOutcome } from "../../lib/contracts/outcomes.ts";
import { isCompletedRescue } from "../../lib/contracts/outcomes.ts";
import { occupancySummary } from "../../lib/evidence/summary.ts";
import { selectContingency } from "../../lib/harness/contingency.ts";
import { affectedRegion } from "../../lib/harness/effects.ts";
import type { SubmitResult } from "../../lib/harness/harness.ts";
import { ActionHarness } from "../../lib/harness/harness.ts";
import {
  approveCommand,
  BREACH_STANDOFF,
  breachBelief,
  breachInput,
  COMMANDER,
  ENVELOPE,
  evacuationRoute,
  executeCommand,
  FLOOR_PLAN,
  guideInput,
  makeBelief,
  makeContext,
  occupantTrack,
  PERSON_IN_SECTOR,
  personObservation,
  proposalInput,
  RUN_ID,
  SPRAY_STANDOFF,
  sprayAction,
  sprayBelief,
  sprayInput,
  T0,
} from "../../lib/harness/test-fixtures.ts";
import type { MissionView } from "../../lib/mission/protocol.ts";
import type { MissionPhaseId, PhaseRailState, PhaseView } from "./phases.ts";
import { derivePhaseRail, estimatedInside, PHASE_ORDER } from "./phases.ts";

/* Positions in the harness test house (upper floor z 3.0–5.6). */
/** At the rear window's standoff, outside the west wall. */
const OUTSIDE: Vec3 = BREACH_STANDOFF;
/** In the upstairs hallway, at the spray standoff. */
const HALLWAY: Vec3 = SPRAY_STANDOFF;
const BEDROOM: Vec3 = vec3(2, 2, 4.2);

const REPORT: CallerReport = {
  id: "report-1", runId: RUN_ID, receivedTick: 100, source: "judge", channel: "typed",
  originalText: "Someone may be in the upstairs rear bedroom.", roomHint: "bedroom-rear", countText: null, interpretation: "rules", supersedes: null,
};

/* Harness-produced records. */

function newHarness(): ActionHarness {
  return new ActionHarness(RUN_ID, new EventLog(RUN_ID));
}

function ids(result: SubmitResult): { id: string; digest: string } {
  if (result.proposalId === null || result.digest === null) throw new Error(`submission refused: ${JSON.stringify(result.findings)}`);
  return { id: result.proposalId, digest: result.digest };
}

/** The commander rejects the window-access proposal the harness put in front of them. */
function commanderRejectedBreach(): ProposalRecord[] {
  const harness = newHarness();
  const submitted = harness.submit(breachInput(), makeContext(breachBelief(T0)));
  assert.equal(submitted.status, "awaiting_approval");
  const { id } = ids(submitted);
  const rejected = harness.reject({ type: "reject", runId: RUN_ID, proposalId: id, commanderId: COMMANDER, tick: T0 + 5, reason: "Not through that window." }, makeContext(breachBelief(T0 + 5)));
  assert.equal(rejected.status, "rejected");
  return [...harness.records()];
}

/** The harness refuses a breach at submission (wrong aircraft): the commander never sees it. */
function harnessRefusedBreach(): ProposalRecord[] {
  const harness = newHarness();
  assert.equal(harness.submit(breachInput({ aircraftId: "tender-t2" }), makeContext(breachBelief(T0))).status, "rejected");
  return [...harness.records()];
}

/** Judge challenge: approved spray, then a possible person observed in the sector before execution. */
function challengedSpray(): ProposalRecord[] {
  const harness = newHarness();
  const { id, digest } = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
  assert.equal(harness.approve(approveCommand(id, digest, T0 + 5), makeContext(sprayBelief(T0 + 5))).status, "approved");
  const person = personObservation("obs-person-1", T0 + 8);
  const result = harness.requestExecution(executeCommand(id, digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10, { extraObservations: [person] })));
  assert.equal(result.status, "invalidated");
  return [...harness.records()];
}

/** Mission abort while the spray is discharging; returns the records and the contingency the harness started. */
function abortedDuringDischarge(): { records: ProposalRecord[]; contingency: Contingency | null } {
  const harness = newHarness();
  const { id, digest } = ids(harness.submit(sprayInput(), makeContext(sprayBelief(T0))));
  harness.approve(approveCommand(id, digest, T0 + 5), makeContext(sprayBelief(T0 + 5)));
  assert.equal(harness.requestExecution(executeCommand(id, digest, "req-1", T0 + 10), makeContext(sprayBelief(T0 + 10))).status, "executing");
  const abort = harness.abort({ type: "abort", runId: RUN_ID, scope: "mission", by: COMMANDER, tick: T0 + 20, reason: "Commander abort." }, makeContext(sprayBelief(T0 + 20)));
  return { records: [...harness.records()], contingency: abort.contingency };
}

/* Hand-built records for completed and routine lifecycles. */

const ACTIONS: Readonly<Record<"breach_opening" | "spray" | "guide", ActionSpec>> = {
  breach_opening: breachInput().action,
  spray: sprayAction(),
  guide: guideInput().action,
};

function record(kind: keyof typeof ACTIONS, status: ProposalStatus, id = `fx-${kind}-${status}`): ProposalRecord {
  const consequential = kind !== "guide";
  const asked = consequential ? [{ tick: T0 + 1, status: "awaiting_approval" as const, reason: "fixture", ruleIds: [] }] : [];
  return {
    proposal: { ...proposalInput(ACTIONS[kind]), id, digest: "f".repeat(64) },
    risk: consequential ? "consequential" : "routine",
    status,
    approval: null,
    execution: null,
    findings: [],
    history: [{ tick: T0, status: "proposed", reason: "fixture", ruleIds: [] }, ...asked, { tick: T0 + 2, status, reason: "fixture", ruleIds: [] }],
  };
}

/* MissionView and outcome assembly. */

interface ViewOptions {
  readonly status?: MissionView["status"];
  readonly position?: Vec3;
  readonly poseSupported?: boolean;
  readonly sigmaM?: number;
  readonly proposals?: readonly ProposalRecord[];
  readonly tracks?: readonly OccupantTrack[];
  readonly routes?: readonly RouteAssessment[];
  readonly reports?: readonly CallerReport[];
  readonly envelope?: MissionEnvelope | null;
  readonly contingency?: Contingency | null;
}

function belief(o: ViewOptions): BeliefSnapshot {
  const base = makeBelief(T0 + 50, { position: o.position ?? OUTSIDE, poseSupported: o.poseSupported, sigmaM: o.sigmaM, tracks: o.tracks, routes: o.routes });
  return { ...base, reports: o.reports ?? [REPORT] };
}

function missionView(o: ViewOptions = {}): MissionView {
  const b = belief(o);
  const proposals = o.proposals ?? [];
  return {
    runId: RUN_ID,
    config: { scenarioId: "fixture-house", seed: "seed-1", aircraftId: TENDER_T1.id, controller: "trained_readout", decider: "local", commanderId: COMMANDER, speed: 1 },
    status: o.status ?? "running",
    tick: b.tick,
    simToWallRatio: 1,
    envelope: o.envelope === undefined ? ENVELOPE : o.envelope,
    belief: b,
    occupancy: occupancySummary(b),
    proposals,
    pendingApproval: proposals.find(r => r.status === "awaiting_approval") ?? null,
    affectedRegions: proposals.flatMap(r => {
      const region = affectedRegion(r.proposal.action, TENDER_T1, FLOOR_PLAN);
      return region === null ? [] : [{ proposalId: r.proposal.id, region }];
    }),
    motion: null,
    controller: { mode: "trained_readout", label: "test", source: "fly_readout", features: {}, neural: null, inputFrameId: null },
    decider: { label: "Local planner", status: "test", lastChoice: null },
    contingency: o.contingency ?? null,
    water: { remainingL: 1, dischargedL: 0 },
  };
}

function outcome(outcomes: readonly OccupantOutcome[], o: { runId?: string; violations?: readonly ConstraintViolation[] } = {}): MissionResult {
  return {
    label: "simulation_evaluator", runId: o.runId ?? RUN_ID, seed: "seed-1", endedTick: 30_000, budgetTick: 60_000,
    occupants: outcomes.map((kind, i) => ({ label: "simulation_evaluator", occupantKey: `occupant-${i}`, outcome: kind, arrivalTick: kind === "reached_assembly_point" ? 20_000 : null })),
    violations: o.violations ?? [],
    droneReturn: "returned",
  };
}

/* Assertions. */

/** Every caption: one short plain sentence, no rule ids, digests, proposal ids or harness trigger codes. */
function assertPlainCaption(caption: string): void {
  assert.ok(caption.length > 0 && caption.length <= 140, `caption length ${caption.length}: ${caption}`);
  assert.doesNotMatch(caption, /\bH\d{1,2}\b/, "no rule ids");
  assert.doesNotMatch(caption, /[0-9a-f]{16,}/, "no digests");
  assert.doesNotMatch(caption, /run-1\/p\d|fx-/, "no proposal ids");
  assert.doesNotMatch(caption, /trigger:|σ/, "no harness diagnostics");
  assert.doesNotMatch(caption, /[.!?]\s+\S/, "a single sentence");
}

function rail(view: PhaseView | null, result: MissionResult | null = null): PhaseRailState {
  const state = derivePhaseRail({ view, outcome: result });
  assert.deepEqual(state.steps.map(s => s.id), PHASE_ORDER, "every phase, in order");
  assert.equal(state.steps.filter(s => s.state === "current").length <= 1, true, "at most one current step");
  assertPlainCaption(state.caption);
  return state;
}

function step(state: PhaseRailState, id: MissionPhaseId) {
  const found = state.steps.find(s => s.id === id);
  assert.ok(found);
  return found;
}

function statesAfter(state: PhaseRailState, id: MissionPhaseId): string[] {
  return state.steps.slice(PHASE_ORDER.indexOf(id) + 1).map(s => s.state);
}

/* Tests. */

describe("before and at the start of a run", () => {
  test("no view: report is current, nothing else has happened and nothing is halted", () => {
    const state = rail(null);
    assert.equal(state.current, "report");
    assert.equal(state.halt, null);
    assert.deepEqual(statesAfter(state, "report"), Array(7).fill("upcoming"));
    assert.ok(state.steps.every(s => s.gate === "none"));
  });

  test("awaiting the report stays on report; a received report asks the commander to authorize the approach", () => {
    const waiting = rail(missionView({ status: "awaiting_report", reports: [], envelope: null }));
    assert.equal(waiting.current, "report");

    const received = rail(missionView({ status: "awaiting_authorization", envelope: null }));
    assert.equal(received.current, "approach");
    assert.equal(step(received, "report").state, "done");
    assert.match(received.caption, /authorize/i);

    const flying = rail(missionView());
    assert.equal(flying.current, "approach");
    assert.match(flying.caption, /reported rear bedroom/, "the report directs the approach without becoming a person");
  });
});

describe("window access gate", () => {
  test("a commander-rejected breach holds the rail at access while the drone is outside", () => {
    const state = rail(missionView({ proposals: commanderRejectedBreach() }));
    assert.equal(state.current, "access");
    assert.equal(step(state, "access").gate, "rejected");
    assert.deepEqual(statesAfter(state, "access"), Array(5).fill("upcoming"));
    assert.match(state.caption, /You rejected/);
  });

  test("a breach the harness refused at submission is not presented as the commander's rejection", () => {
    const state = rail(missionView({ proposals: harnessRefusedBreach() }));
    assert.equal(state.current, "access");
    assert.equal(step(state, "access").gate, "rejected");
    assert.doesNotMatch(state.caption, /You rejected/);
    assert.match(state.caption, /Safety checks refused/);
  });

  test("broken glass is not entry: a completed breach with the drone still estimated outside stays on access", () => {
    const state = rail(missionView({ proposals: [record("breach_opening", "completed")] }));
    assert.equal(state.current, "access");
    assert.equal(step(state, "access").gate, "completed");
    assert.equal(step(state, "search").state, "upcoming");
  });

  test("entry after a completed breach marks access done", () => {
    const state = rail(missionView({ position: BEDROOM, proposals: [record("breach_opening", "completed")] }));
    assert.equal(state.current, "search");
    assert.equal(step(state, "access").state, "done");
  });

  test("entry without any breach marks access skipped, not done", () => {
    const state = rail(missionView({ position: BEDROOM }));
    assert.equal(state.current, "search");
    assert.equal(step(state, "access").state, "skipped");
    assert.equal(step(state, "access").gate, "none");
  });

  test("entry through another opening after a rejected breach keeps the rejection visible and marks access skipped", () => {
    const state = rail(missionView({ position: HALLWAY, proposals: commanderRejectedBreach() }));
    assert.equal(state.current, "search");
    assert.equal(step(state, "access").state, "skipped");
    assert.equal(step(state, "access").gate, "rejected");
  });
});

describe("estimated inside (floor-plan prior, estimated pose)", () => {
  test("a window standoff outside the wall is outside; a room on the right floor is inside", () => {
    assert.equal(estimatedInside(FLOOR_PLAN, OUTSIDE), null);
    assert.deepEqual(estimatedInside(FLOOR_PLAN, BEDROOM), { roomId: "bedroom-rear" });
  });

  test("an interior doorway gap between two rooms still counts as inside, so crossing it does not flicker the rail back", () => {
    // The bedroom/hallway wall gap at x 3.94–4.06, at the bedroom door.
    assert.deepEqual(estimatedInside(FLOOR_PLAN, vec3(4.0, 1, 4)), { roomId: null });
  });

  test("hovering above the roof over a room is outside; the slab between floors counts as the floor below", () => {
    assert.equal(estimatedInside(FLOOR_PLAN, vec3(2, 2, 6.2)), null);
    assert.deepEqual(estimatedInside(FLOOR_PLAN, vec3(8, 2, 2.9)), { roomId: "kitchen" });
    assert.equal(estimatedInside(FLOOR_PLAN, vec3(2, 2, -1)), null);
  });
});

describe("search: a detection is not an evacuation", () => {
  test("a possible-occupant track stays inside search and never advances towards outside", () => {
    const track = occupantTrack(T0 + 40);
    const state = rail(missionView({ position: HALLWAY, proposals: [record("breach_opening", "completed")], tracks: [track] }));
    assert.equal(state.current, "search");
    assert.equal(step(state, "outside").state, "upcoming");
    assert.match(state.caption, /possible occupant/i);
    assert.match(state.caption, /not an evacuation/);
  });

  test("an evaluator outcome with no arrival (inside, or outside but short of the assembly point) never reaches outside", () => {
    const result = outcome(["inside", "outside_not_at_assembly_point"]);
    const state = rail(missionView({ status: "ended", position: HALLWAY, tracks: [occupantTrack(T0 + 40)] }), result);
    assert.equal(state.current, "search");
    assert.equal(step(state, "outside").state, "upcoming");
    assert.equal(state.halt?.kind, "ended_incomplete");
    assert.match(state.caption, /No simulated occupant reached the assembly point/);
  });
});

describe("water spray gate and the judge challenge", () => {
  test("a spray invalidated by a possible person observed after approval holds the rail at suppress", () => {
    const person = occupantTrack(T0 + 8, { id: "track-2", position: PERSON_IN_SECTOR, roomId: "hallway" });
    const records = [record("breach_opening", "completed"), ...challengedSpray()];
    const view = missionView({ position: HALLWAY, proposals: records, tracks: [person] });
    const region = view.affectedRegions.find(r => r.proposalId === records[1].proposal.id)?.region;
    assert.ok(region && distanceToRegion(region, PERSON_IN_SECTOR) <= person.uncertaintyM, "precondition: the track touches the harness's spray region");

    const state = rail(view);
    assert.equal(state.current, "suppress");
    assert.equal(step(state, "suppress").gate, "invalidated");
    assert.equal(step(state, "reassess").state, "upcoming");
    assert.match(state.caption, /possible person/);
    assert.match(state.caption, /new approval/);
  });

  test("an invalidated spray is not blamed on a person when no possible occupant is near the spray region", () => {
    const records = [record("breach_opening", "completed"), ...challengedSpray()];
    const state = rail(missionView({ position: HALLWAY, proposals: records, tracks: [occupantTrack(T0 + 40)] }));
    assert.equal(step(state, "suppress").gate, "invalidated");
    assert.doesNotMatch(state.caption, /possible person/);
    assert.match(state.caption, /New evidence cancelled/);
  });

  test("the rail follows the newest spray proposal: a fresh request after the invalidation awaits its own approval", () => {
    const records = [record("breach_opening", "completed"), ...challengedSpray(), record("spray", "awaiting_approval", "fx-spray-2")];
    const state = rail(missionView({ position: HALLWAY, proposals: records }));
    assert.equal(state.current, "suppress");
    assert.equal(step(state, "suppress").gate, "awaiting_approval");
    assert.match(state.caption, /Waiting for your approval/);
  });

  test("guidance on an independently supported route after a rejected spray marks suppress skipped, never done", () => {
    const records = [record("breach_opening", "completed"), record("spray", "rejected"), record("guide", "executing")];
    const state = rail(missionView({ position: HALLWAY, proposals: records, routes: [evacuationRoute(T0 + 30)] }));
    assert.equal(state.current, "guide");
    assert.equal(step(state, "suppress").state, "skipped");
    assert.equal(step(state, "suppress").gate, "rejected");
  });

  test("a completed spray moves to reassess, which holds until guidance is actually executing", () => {
    const done = [record("breach_opening", "completed"), record("spray", "completed")];
    assert.equal(rail(missionView({ position: HALLWAY, proposals: done })).current, "reassess");
    assert.equal(rail(missionView({ position: HALLWAY, proposals: [...done, record("guide", "validated")] })).current, "reassess");
    const stopped = rail(missionView({ position: HALLWAY, proposals: [...done, record("guide", "invalidated")] }));
    assert.equal(stopped.current, "reassess");
    assert.match(stopped.caption, /Guidance stopped/);
    assert.equal(rail(missionView({ position: HALLWAY, proposals: [...done, record("guide", "executing")] })).current, "guide");
  });
});

describe("guide and outside: only this run's evaluator arrival", () => {
  const rescued = [record("breach_opening", "completed"), record("spray", "completed"), record("guide", "completed")];

  test("completed guidance without an evaluator arrival stays on guide", () => {
    const state = rail(missionView({ position: HALLWAY, proposals: rescued }));
    assert.equal(state.current, "guide");
    assert.equal(step(state, "outside").state, "upcoming");
    assert.equal(state.halt, null);
  });

  test("a run that ends after guidance with no arrival halts as incomplete on guide", () => {
    const state = rail(missionView({ status: "ended", position: HALLWAY, proposals: rescued }), outcome(["inside"]));
    assert.equal(state.current, "guide");
    assert.equal(step(state, "outside").state, "upcoming");
    assert.equal(state.halt?.kind, "ended_incomplete");
    assert.match(state.caption, /human assistance/);
  });

  test("an ended run with no outcome yet claims neither completion nor failure", () => {
    const state = rail(missionView({ status: "ended", position: HALLWAY, proposals: rescued }));
    assert.equal(state.current, "guide");
    assert.equal(state.halt, null);
    assert.match(state.caption, /waiting for the simulation evaluator/);
  });

  test("an evaluator arrival within budget and without violations reaches outside, worded by rescueLabel", () => {
    const result = outcome(["reached_assembly_point"]);
    assert.ok(isCompletedRescue(result), "precondition: the evaluator scores this a completed rescue");
    const state = rail(missionView({ status: "ended", position: OUTSIDE, proposals: rescued }), result);
    assert.equal(state.current, "outside");
    assert.equal(step(state, "outside").state, "done");
    assert.equal(step(state, "guide").state, "done");
    assert.equal(state.halt, null);
    assert.match(state.caption, /^Simulated evacuation completed/);
    assert.match(state.caption, /other rooms remain unresolved/, "one evacuation is never a house all-clear");
  });

  test("an outcome from a different run is ignored", () => {
    const state = rail(missionView({ position: HALLWAY, proposals: rescued }), outcome(["reached_assembly_point"], { runId: "run-0" }));
    assert.equal(state.current, "guide");
    assert.equal(step(state, "outside").state, "upcoming");
  });

  test("arrival with a scored violation is outside but not done, and is never worded as a completed evacuation", () => {
    const result = outcome(["reached_assembly_point"], { violations: [{ tick: 9000, kind: "collision", detail: "fixture" }] });
    const state = rail(missionView({ status: "ended", position: OUTSIDE, proposals: rescued }), result);
    assert.equal(state.current, "outside");
    assert.equal(step(state, "outside").state, "current");
    assert.equal(state.halt?.kind, "ended_incomplete");
    assert.match(state.halt?.kind === "ended_incomplete" ? state.halt.reason : "", /1 scored constraint violation/);
    assert.doesNotMatch(state.caption, /evacuation completed/i);
  });

  test("partial arrival counts occupants; outside is done only when the evaluator's isCompletedRescue says so", () => {
    const result = outcome(["reached_assembly_point", "inside"]);
    const state = rail(missionView({ status: "ended", position: OUTSIDE, proposals: rescued }), result);
    assert.equal(state.current, "outside");
    assert.match(state.caption, /1 of 2 simulated occupants at the assembly point/);
    const completed = isCompletedRescue(result);
    assert.equal(step(state, "outside").state, completed ? "done" : "current");
    assert.equal(state.halt?.kind ?? null, completed ? null : "ended_incomplete");
  });
});

describe("halts keep the progress made", () => {
  test("a mission abort during discharge halts the rail at suppress with the harness's aborted gate and contingency", () => {
    const { records, contingency } = abortedDuringDischarge();
    assert.ok(contingency, "a mission abort always selects a contingency");
    const state = rail(missionView({ status: "aborted", position: HALLWAY, proposals: [record("breach_opening", "completed"), ...records], contingency }));
    assert.equal(state.current, "suppress");
    assert.equal(step(state, "suppress").gate, "aborted");
    assert.deepEqual(["report", "approach", "access", "search"].map(id => step(state, id as MissionPhaseId).state), ["done", "done", "done", "done"]);
    assert.equal(state.halt?.kind, "aborted");
    assert.equal(state.halt?.kind === "aborted" ? state.halt.reason : null, contingency.reason);
    assert.match(state.caption, /^Mission aborted/);
  });

  test("a localization contingency while searching halts the rail on search and names the cause plainly", () => {
    const lost = { position: HALLWAY, poseSupported: false, sigmaM: 3 };
    const contingency = selectContingency(makeContext(belief(lost)), "localization_lost");
    const state = rail(missionView({ ...lost, proposals: [record("breach_opening", "completed")], contingency }));
    assert.equal(state.current, "search");
    assert.equal(step(state, "access").state, "done");
    assert.deepEqual(state.halt, { kind: "contingency", contingency: contingency.kind, reason: contingency.reason });
    assert.match(state.caption, /^Localization stopped supporting movement;/);
  });

  test("pausing at the access gate keeps the pending approval visible", () => {
    const records = [record("breach_opening", "awaiting_approval")];
    const state = rail(missionView({ status: "paused", proposals: records }));
    assert.equal(state.current, "access");
    assert.equal(step(state, "access").gate, "awaiting_approval");
    assert.deepEqual(state.halt, { kind: "paused" });
    assert.match(state.caption, /Paused during window access/);
  });
});

describe("recorded replay: no estimated pose, prior or track positions", () => {
  /** The MissionView narrowed as a replay rebuilds it: what events.jsonl and the truth-free summary carry. */
  function replayView(o: ViewOptions & { prior?: boolean } = {}): PhaseView {
    const view = missionView(o);
    return {
      ...view,
      belief: {
        ...view.belief,
        mapPrior: o.prior === false ? null : view.belief.mapPrior,
        pose: null,
        tracks: view.belief.tracks.map(t => ({ status: t.status, roomId: t.roomId, uncertaintyM: t.uncertaintyM, position: null })),
      },
    };
  }

  test("without an estimated pose, a completed breach stays on access: broken glass is never presented as entry", () => {
    const state = rail(replayView({ position: BEDROOM, proposals: [record("breach_opening", "completed")] }));
    assert.equal(state.current, "access");
    assert.equal(step(state, "access").gate, "completed");
    assert.equal(step(state, "search").state, "upcoming");
  });

  test("without an estimated pose, gate evidence still moves the rail: a completed spray reaches reassess and the breach reads done", () => {
    const state = rail(replayView({ proposals: [record("breach_opening", "completed"), record("spray", "completed")] }));
    assert.equal(state.current, "reassess");
    assert.equal(step(state, "access").state, "done");
    assert.equal(step(state, "suppress").state, "done");
    assert.equal(step(state, "search").state, "done", "a step behind the rail without its own gate is passed");
  });

  test("a refused spray still holds the rail at suppress without a pose", () => {
    const state = rail(replayView({ proposals: [record("breach_opening", "completed"), record("spray", "rejected")] }));
    assert.equal(state.current, "suppress");
    assert.equal(step(state, "suppress").gate, "rejected");
    assert.deepEqual(statesAfter(state, "suppress"), Array(3).fill("upcoming"));
  });

  test("without the floor-plan prior, captions name no room or opening and nothing is estimated inside", () => {
    assert.equal(estimatedInside(null, BEDROOM), null);
    const approach = rail(replayView({ prior: false }));
    assert.equal(approach.current, "approach");
    assert.equal(approach.caption, "Approaching the house from outside.");
    const access = rail(replayView({ prior: false, proposals: commanderRejectedBreach() }));
    assert.equal(access.current, "access");
    assert.match(access.caption, /You rejected breaking the window/);
  });

  test("a track without a recorded position is never blamed for an invalidated spray", () => {
    const person = occupantTrack(T0 + 8, { id: "track-2", position: PERSON_IN_SECTOR, roomId: "hallway" });
    const records = [record("breach_opening", "completed"), ...challengedSpray()];
    const live = rail(missionView({ position: HALLWAY, proposals: records, tracks: [person] }));
    assert.match(live.caption, /possible person/, "precondition: live, with the position, the person is named");
    const replay = rail(replayView({ position: HALLWAY, proposals: records, tracks: [person] }));
    assert.equal(replay.current, "suppress");
    assert.equal(step(replay, "suppress").gate, "invalidated");
    assert.doesNotMatch(replay.caption, /possible person/);
    assert.match(replay.caption, /New evidence cancelled/);
  });

  test("this run's evaluator arrival still reaches outside without a pose; completion still follows isCompletedRescue", () => {
    const rescued = [record("breach_opening", "completed"), record("spray", "completed"), record("guide", "completed")];
    const done = rail(replayView({ status: "ended", proposals: rescued }), outcome(["reached_assembly_point"]));
    assert.equal(done.current, "outside");
    assert.equal(step(done, "outside").state, "done");
    const late = outcome(["reached_assembly_point"], { violations: [{ tick: 9000, kind: "collision", detail: "fixture" }] });
    const incomplete = rail(replayView({ status: "ended", proposals: rescued }), late);
    assert.equal(step(incomplete, "outside").state, "current");
    assert.doesNotMatch(incomplete.caption, /evacuation completed/i);
  });
});
