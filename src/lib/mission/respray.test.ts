/**
 * Look before spraying again, through the mission planner: after a spray completes, the planner (fed the
 * harness's own spray records) chooses no second spray from the flame sighting that predates it; it holds at
 * the standoff facing the fire, and chooses the spray again only once a sighting captured after the spray still
 * shows flame. Regression for the live run where a spray completed at 136.01 s, another was proposed at 136.02 s and
 * 0.3 L more was discharged at a fire already out.
 *
 * Scope: MissionPlanner + ActionHarness with the local decider on the harness fixture scene (test-fixtures.ts:
 * the hallway fire, the aircraft at the spray standoff); beliefs are fixtures, stepped tick by tick.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { EventLog } from "../contracts/events.ts";
import type { ProposalId } from "../contracts/ids.ts";
import { ActionHarness } from "../harness/harness.ts";
import { approveCommand, fireHazard, makeContext, RUN_ID, SPRAY_AIM, sprayBelief, sprayInput, T0 } from "../harness/test-fixtures.ts";
import type { DecisionRecord } from "../navigation/planner/broker.ts";
import { DecisionBroker } from "../navigation/planner/broker.ts";
import type { PlannerTick } from "./planner-step.ts";
import { MissionPlanner } from "./planner-step.ts";

function sprayDecision(): DecisionRecord {
  return {
    runId: RUN_ID, requestId: "req-1", evidenceRevision: 12, tick: T0, decider: "local_planner", candidateId: "request_suppression:hallway", tool: "request_suppression",
    description: "fixture spray", proposal: sprayInput({}, { durationTicks: 50 }), risk: "consequential", requiresCommanderApproval: true, gatewayStatus: null,
    fallbackReason: "fixture", localChoiceId: "request_suppression:hallway", latencyMs: null,
  };
}

/** The mission loop's planner and harness on the fixture scene, stepped by hand. */
function setup() {
  const log = new EventLog(RUN_ID);
  const harness = new ActionHarness(RUN_ID, log);
  const planner = new MissionPlanner(new DecisionBroker({ runId: RUN_ID, cloudEnabled: false }));
  const tickAt = (tick: number, belief: BeliefSnapshot = sprayBelief(tick)): PlannerTick => ({ ctx: makeContext(belief), harness, log, lastInterventionTick: harness.lastInterventionAt(tick), nowMs: 0 });
  const advance = (tick: number, belief?: BeliefSnapshot) => {
    const t = tickAt(tick, belief);
    planner.tick(t);
    harness.step(t.ctx, null);
  };
  return { harness, planner, tickAt, advance };
}

function status(harness: ActionHarness, id: ProposalId): string | null {
  return harness.record(id)?.status ?? null;
}

/** The spray the planner proposed from the fixture decision, approved and run to completion; returns its id and the first tick after it. */
function completedSpray({ harness, planner, tickAt, advance }: ReturnType<typeof setup>): { id: ProposalId; ended: number; next: number } {
  planner.receive({ send: null, abort: [], decisions: [sprayDecision()], discarded: [] });
  planner.tick(tickAt(T0));
  const id = planner.focus;
  assert.ok(id !== null && status(harness, id) === "awaiting_approval");
  const digest = harness.record(id)?.proposal.digest ?? "";
  assert.ok(harness.approve(approveCommand(id, digest, T0 + 2), tickAt(T0 + 2).ctx).accepted);
  let tick = T0 + 3;
  while (status(harness, id) !== "completed" && tick < T0 + 200) advance(tick++);
  const ended = harness.record(id)?.execution?.endedTick;
  assert.ok(ended !== undefined && ended !== null, "the spray completed");
  return { id, ended, next: tick };
}

describe("the planner looks before spraying again", () => {
  test("no second spray from the sighting before the first; it faces the fire, and sprays again only on a later flame", () => {
    const loop = setup();
    const { harness, planner, tickAt, advance } = loop;
    const { ended, next } = completedSpray(loop);
    const sprays = () => harness.records().filter(r => r.proposal.action.kind === "spray").length;

    // The flame sighting (tick 700) predates the spray: hold and look, never a second spray.
    for (const later of [next, next + 60, next + 400, next + 1200]) {
      advance(later);
      assert.equal(sprays(), 1, `no second spray at tick ${later}`);
      assert.deepEqual(harness.activeMotion()?.proposal.action, { kind: "scan", lookAt: SPRAY_AIM, durationTicks: 200 }, `holding facing the fire at tick ${later}`);
    }
    assert.match(planner.lastDecision?.candidateId ?? "", /:fire-recheck$/, "the look at the sprayed fire was the choice");

    // A sighting captured after the spray still shows flame: the planner chooses the spray again (and, its
    // standoff being another than where the fixture aircraft hovers, moves there to propose it).
    const now = next + 1300;
    assert.ok(now - 10 > ended);
    planner.tick(tickAt(now, sprayBelief(now, { hazards: [fireHazard(), fireHazard(now - 10)] })));
    assert.equal(planner.lastDecision?.candidateId, "request_suppression:hallway");
    assert.equal(planner.lastDecision?.proposal?.action.kind, "spray");
  });
});
