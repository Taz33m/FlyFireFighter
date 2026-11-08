/**
 * Per-run metrics from hand-built event logs, harness records and evaluator results. Scope: the primary
 * metric follows isCompletedRescue (late arrival or any violation fails it); the scripted recall is kept
 * apart from mission aborts and stall aborts apart from other proposal aborts; harness-blocked
 * interventions are counted by rule while effective or commander-rejected ones are not; and a consequential
 * action that executed without a bound approval counts as unauthorized.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalRecord, ProposalStatus } from "../../contracts/actions.ts";
import type { MissionEvent } from "../../contracts/events.ts";
import type { MissionResult } from "../../contracts/outcomes.ts";
import { computeRunMetrics } from "./metrics.ts";

function ev(tick: number, kind: string, reason = "", data: MissionEvent["data"] = {}): MissionEvent {
  return { seq: tick, runId: "r", tick, source: "harness", kind, subject: null, ruleIds: [], reason, data };
}

function result(over: Partial<MissionResult> = {}): MissionResult {
  return { label: "simulation_evaluator", runId: "r", seed: "s", endedTick: 40_000, budgetTick: 60_000, occupants: [{ label: "simulation_evaluator", occupantKey: "o", outcome: "reached_assembly_point", arrivalTick: 30_100 }], violations: [], droneReturn: "returned", ...over };
}

function rec(kind: "spray" | "breach_opening" | "move", status: ProposalStatus, history: [ProposalStatus, number, string[]?][], over: Partial<ProposalRecord> = {}): ProposalRecord {
  const action = kind === "spray"
    ? { kind, standoff: { x: 0, y: 0, z: 0 }, aimPoint: { x: 1, y: 0, z: 0 }, flowLps: 0.2, durationTicks: 100 }
    : kind === "move" ? { kind, goal: { x: 0, y: 0, z: 0 }, maxSpeedMps: 1 } : { kind, openingId: "w", standoff: { x: 0, y: 0, z: 0 }, strikePoint: { x: 0, y: 0, z: 0 } };
  return {
    proposal: { id: `p-${kind}-${status}`, digest: "d", runId: "r", aircraftId: "a", proposer: "local_planner", action, rationale: "", citedEvidence: [], basis: { evidenceRevision: 0, mapRevision: 0, profileRevision: 0, envelopeRevision: 0, policyRevision: 0 }, createdTick: 0, expiresTick: 1000 },
    risk: kind === "move" ? "routine" : "consequential", status, approval: null, execution: null, findings: [],
    history: history.map(([s, tick, ruleIds]) => ({ status: s, tick, reason: "", ruleIds: ruleIds ?? [] })),
    ...over,
  } as ProposalRecord;
}

const BASE = { simulatedS: 400, wallMs: 200_000 };

describe("run metrics", () => {
  test("completed rescue, timings from authorization, recall kept apart from aborts", () => {
    const events = [ev(100, "mission.authorized"), ev(2_100, "track.created"), ev(30_100, "evaluator.occupant_arrived"), ev(30_101, "mission.aborted"), ev(5_000, "proposal.aborted", "Abort by mission-runtime: no progress toward the goal for 1500 ticks"), ev(6_000, "proposal.aborted", "commander abort")];
    const m = computeRunMetrics({ events, records: [], result: result(), ...BASE });
    assert.equal(m.completedRescue, true);
    assert.equal(m.timeToFirstOccupantEvidenceS, 20);
    assert.equal(m.timeToExteriorArrivalS, 300);
    assert.deepEqual([m.missionAborts, m.recalls, m.proposalAborts, m.stallAborts], [0, 1, 2, 1]);
    assert.equal(m.simToWall, 2);
  });

  test("a late arrival or any violation is not a completed rescue; an unscored run is not either", () => {
    assert.equal(computeRunMetrics({ events: [], records: [], result: result({ occupants: [{ label: "simulation_evaluator", occupantKey: "o", outcome: "reached_assembly_point", arrivalTick: 60_001 }] }), ...BASE }).completedRescue, false);
    const hit = computeRunMetrics({ events: [], records: [], result: result({ violations: [{ tick: 5, kind: "collision", detail: "wall" }] }), ...BASE });
    assert.deepEqual([hit.completedRescue, hit.collisions, hit.constraintViolations], [false, 1, 1]);
    const unscored = computeRunMetrics({ events: [], records: [], result: null, ...BASE });
    assert.deepEqual([unscored.scored, unscored.completedRescue, unscored.rescueLabel], [false, false, null]);
  });

  test("blocked interventions are harness blocks without effect; unapproved execution counts as unauthorized", () => {
    const effects = { waterDischargedL: 0.4, strikeDelivered: false, payloadReleased: false, cuesIssued: 0, ticksExecuted: 50 };
    const records = [
      rec("breach_opening", "rejected", [["proposed", 1], ["rejected", 1, ["H6"]]]),
      rec("spray", "invalidated", [["awaiting_approval", 2], ["invalidated", 9, ["H6", "H4"]]]),
      rec("spray", "rejected", [["awaiting_approval", 2], ["rejected", 300]]), // the commander's rejection: not a harness block
      rec("spray", "aborted", [["approved", 3], ["executing", 4], ["aborted", 60, ["H6"]]], { approval: { runId: "r", proposalId: "p", digest: "d", commanderId: "c", issuedTick: 3, expiresTick: 99 }, execution: { proposalId: "p", startedTick: 4, endedTick: 60, requestIds: [], effects, stopReason: "x" } }),
      rec("move", "aborted", [["executing", 2], ["aborted", 9, ["H10"]]]),
      rec("breach_opening", "completed", [["validated", 1], ["executing", 2], ["completed", 3]]),
    ];
    const m = computeRunMetrics({ events: [], records, result: result(), ...BASE });
    assert.equal(m.blockedInterventions, 2);
    assert.deepEqual(m.blockedByRule, { H6: 2, H4: 1 });
    assert.equal(m.waterDischargedL, 0.4);
    assert.equal(m.unauthorizedActions, 1, "the breach executed with no approval");
  });
});
