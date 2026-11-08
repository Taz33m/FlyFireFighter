/**
 * Holding a station facing the focus: the planner's dwell after a preposition move and an intervention
 * awaiting approval each hand the controller {station, focus} through a routine scan in place, so the
 * harness lets the aircraft turn (it gates every request, a pure yaw included, without an executing motion
 * action). Scope: MissionPlanner + ActionHarness + GoalSelector on the harness fixture scene; the
 * controller's turn itself is covered by the closed-loop tests (closed-loop.test.ts, steering.test.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MotionRequest } from "../contracts/actions.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { EventLog } from "../contracts/events.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { ActionHarness } from "../harness/harness.ts";
import { approveCommand, makeContext, moveInput, RUN_ID, SPRAY_AIM, SPRAY_STANDOFF, sprayBelief, sprayInput, T0 } from "../harness/test-fixtures.ts";
import { DecisionBroker } from "../navigation/planner/broker.ts";
import type { DecisionRecord } from "../navigation/planner/broker.ts";
import { GoalSelector } from "./goal.ts";
import type { PlannerTick } from "./planner-step.ts";
import { DWELL_TICKS, FACE_TOLERANCE_RAD, FACE_WAIT_TICKS, facingErrorRad, MissionPlanner, NO_PROGRESS_TICKS } from "./planner-step.ts";

const YAW_ONLY = (tick: number): MotionRequest => ({ source: "flow_baseline", tick, velocityBody: vec3(0, 0, 0), yawRateRadps: 0.5 });

function setup() {
  const log = new EventLog(RUN_ID);
  const harness = new ActionHarness(RUN_ID, log);
  const planner = new MissionPlanner(new DecisionBroker({ runId: RUN_ID, cloudEnabled: false }));
  const goals = new GoalSelector();
  const at = (tick: number): { belief: BeliefSnapshot; t: PlannerTick } => {
    const belief = sprayBelief(tick);
    return { belief, t: { ctx: makeContext(belief), harness, log, lastInterventionTick: null, nowMs: 0 } };
  };
  return { harness, planner, goals, at };
}

function sprayDecision(): DecisionRecord {
  return {
    runId: RUN_ID, requestId: "req-1", evidenceRevision: 12, tick: T0, decider: "local_planner", candidateId: "suppress-1", tool: "request_suppression",
    description: "fixture spray", proposal: sprayInput(), risk: "consequential", requiresCommanderApproval: true, gatewayStatus: null,
    fallbackReason: "fixture", localChoiceId: "suppress-1", latencyMs: null,
  };
}

describe("goal selection while holding a station", () => {
  test("during the dwell after a preposition move: {station, focus}, and the harness executes a pure turn", () => {
    const { harness, planner, goals, at } = setup();
    let { belief, t } = at(T0);
    const move = harness.submit(moveInput(SPRAY_STANDOFF), t.ctx);
    assert.ok(move.accepted && move.proposalId !== null && move.digest !== null, JSON.stringify(move.findings));
    planner.meta.set(move.proposalId, { candidateId: "suppress-1", focus: SPRAY_AIM, station: SPRAY_STANDOFF, role: "preposition" });
    assert.ok(harness.requestExecution({ type: "execute", runId: RUN_ID, proposalId: move.proposalId, digest: move.digest, requestId: "m#run", tick: T0 }, t.ctx).accepted);
    harness.step(t.ctx, null);
    assert.equal(harness.record(move.proposalId)?.status, "completed", "already on the station");
    // Without the dwell scan nothing owns the motion: the guard replaces even a pure turn with stillness.
    ({ belief, t } = at(T0 + 1));
    assert.equal(harness.step(t.ctx, YAW_ONLY(T0 + 1)).motion?.executed.yawRateRadps ?? 0, 0);
    ({ belief, t } = at(T0 + 2));
    planner.noteArrival(t);
    const active = harness.activeMotion();
    assert.equal(active?.proposal.action.kind, "scan");
    const target = goals.select(harness, planner, belief);
    assert.ok(target !== null);
    assert.ok(distance(target.goal, SPRAY_STANDOFF) < 1e-9, "holds where it stands on the station");
    assert.deepEqual(target.focus, SPRAY_AIM);
    const turned = harness.step(t.ctx, YAW_ONLY(T0 + 2)).motion;
    assert.ok(turned !== null && turned.executed.yawRateRadps > 0, "the guard lets the aircraft turn in place during the dwell");
    assert.equal(Math.hypot(turned.executed.velocityBody.x, turned.executed.velocityBody.y), 0);
    // The dwell lasts DWELL_TICKS, after which planning resumes as before.
    assert.equal(active?.proposal.action.kind === "scan" ? active.proposal.action.durationTicks : null, DWELL_TICKS);
  });

  test("an intervention awaiting approval, then approved and executing, keeps {station, focus}", () => {
    const { harness, planner, goals, at } = setup();
    let { belief, t } = at(T0);
    planner.receive({ send: null, abort: [], decisions: [sprayDecision()], discarded: [] });
    planner.tick(t);
    const spray = planner.focus;
    assert.ok(spray !== null, "the spray was proposed from its station");
    assert.equal(harness.record(spray)?.status, "awaiting_approval");
    let target = goals.select(harness, planner, belief);
    assert.equal(harness.activeMotion()?.proposal.action.kind, "scan");
    assert.ok(target !== null && distance(target.goal, SPRAY_STANDOFF) < 1e-9);
    assert.deepEqual(target.focus, SPRAY_AIM, "awaiting approval: faces the aim");

    const record = harness.record(spray)!;
    ({ belief, t } = at(T0 + 2));
    assert.ok(harness.approve(approveCommand(spray, record.proposal.digest, T0 + 2), t.ctx).accepted);
    harness.step(t.ctx, null);
    target = goals.select(harness, planner, belief);
    assert.ok(target !== null && distance(target.goal, SPRAY_STANDOFF) < 1e-9);
    assert.deepEqual(target.focus, SPRAY_AIM, "approved: still faces the aim");

    ({ belief, t } = at(T0 + 3));
    planner.tick(t);
    harness.step(t.ctx, null);
    assert.equal(harness.record(spray)?.status, "executing");
    ({ belief, t } = at(T0 + 4));
    planner.tick(t);
    assert.equal(harness.activeMotion(), null, "the facing scan ends once the spray executes");
    target = goals.select(harness, planner, belief);
    assert.ok(target !== null && target.proposalId === spray && distance(target.goal, SPRAY_STANDOFF) < 1e-9);
    assert.deepEqual(target.focus, SPRAY_AIM, "executing: faces the aim");
  });

  test("a hold without a focus is unchanged: anchored where it began and no focus", () => {
    const { harness, planner, goals, at } = setup();
    const { belief, t } = at(T0);
    const hold = harness.submit({ ...moveInput(SPRAY_STANDOFF), action: { kind: "hold", durationTicks: 300 } }, t.ctx);
    assert.ok(hold.proposalId !== null && hold.digest !== null);
    assert.ok(harness.requestExecution({ type: "execute", runId: RUN_ID, proposalId: hold.proposalId, digest: hold.digest, requestId: "h#run", tick: T0 }, t.ctx).accepted);
    const target = goals.select(harness, planner, belief);
    assert.ok(target !== null && distance(target.goal, SPRAY_STANDOFF) < 1e-9);
    assert.equal(target.focus, null);
  });
});

describe("an intervention is proposed only once the aircraft faces its target", () => {
  test("60 degrees off the aim it turns first (a scan facing the aim), and proposes once facing", () => {
    const { harness, planner } = setup();
    const facingAt = (tick: number, yawOffRad: number) => {
      const base = sprayBelief(tick);
      const toAim = Math.atan2(SPRAY_AIM.y - base.pose.position.y, SPRAY_AIM.x - base.pose.position.x);
      const belief = { ...base, pose: { ...base.pose, yawRad: toAim + yawOffRad } };
      return { belief, t: { ctx: makeContext(belief), harness, log: new EventLog(RUN_ID), lastInterventionTick: null, nowMs: 0 } as PlannerTick };
    };
    let { belief, t } = facingAt(T0, Math.PI / 3);
    assert.ok((facingErrorRad(belief.pose, SPRAY_AIM) ?? 0) > FACE_TOLERANCE_RAD);
    planner.receive({ send: null, abort: [], decisions: [sprayDecision()], discarded: [] });
    planner.tick(t);
    assert.equal(planner.focus, null, "not proposed while facing away");
    assert.equal(harness.activeMotion()?.proposal.action.kind, "scan", "turning to face the aim");
    ({ belief, t } = facingAt(T0 + FACE_WAIT_TICKS + 1, 0.05));
    planner.receive({ send: null, abort: [], decisions: [sprayDecision()], discarded: [] });
    planner.tick(t);
    assert.ok(planner.focus !== null && harness.record(planner.focus)?.status === "awaiting_approval", "proposed once facing");
  });

  test("the facing error is the horizontal angle to the focus, and undefined without one or overhead", () => {
    const pose = { position: vec3(0, 0, 1), yawRad: 0 };
    assert.ok(Math.abs((facingErrorRad(pose, vec3(1, 1, 0)) ?? 0) - Math.PI / 4) < 1e-12);
    assert.ok(Math.abs((facingErrorRad({ ...pose, yawRad: 3 * Math.PI / 2 }, vec3(0, 1, 0)) ?? 0) - Math.PI) < 1e-12);
    assert.equal(facingErrorRad(pose, null), null);
    assert.equal(facingErrorRad(pose, vec3(0.1, 0, 0)), null);
  });
});

describe("the no-progress watch", () => {
  test("a move whose first reading is the previous goal's leftover distance is not aborted while it progresses", () => {
    const { harness, planner, at } = setup();
    const { t } = at(T0);
    const move = harness.submit(moveInput(vec3(SPRAY_STANDOFF.x + 3, SPRAY_STANDOFF.y, SPRAY_STANDOFF.z)), t.ctx);
    assert.ok(move.proposalId !== null && move.digest !== null);
    assert.ok(harness.requestExecution({ type: "execute", runId: RUN_ID, proposalId: move.proposalId, digest: move.digest, requestId: "m#run", tick: T0 }, t.ctx).accepted);
    harness.step(t.ctx, null);
    // The steering's remaining distance still holds the previous move's last value on the first tick (0.3 m),
    // then the real distance (16 m) falls at 0.25 m/s: steady progress, never 0.25 m below the stale 0.3 m.
    planner.watch(at(T0 + 1).t, 0.3);
    for (let i = 2; i <= NO_PROGRESS_TICKS + 200; i++) planner.watch(at(T0 + i).t, 16 - 0.0025 * i);
    assert.notEqual(harness.record(move.proposalId)?.status, "aborted", "steady progress is progress");
    assert.equal(harness.activeMotion()?.proposal.id, move.proposalId);
  });
});
