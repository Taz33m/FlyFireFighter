/**
 * The planner's no-progress watch on a route action: the harness advances a return's goal from waypoint to
 * waypoint, so the remaining distance jumps up at each advance. The watch restarts its baseline at a new waypoint
 * (horizontally; floating waypoint heights follow the aircraft) and still stops an action that is stuck. Scope:
 * MissionPlanner.watch against a minimal harness stand-in exposing activeMotion and abort; the route cursor's
 * advance itself is the harness's (covered by the harness route tests).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Tick } from "../contracts/clock.ts";
import { EventLog } from "../contracts/events.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import type { ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { DecisionBroker } from "../navigation/planner/broker.ts";
import type { PlannerTick } from "./planner-step.ts";
import { MissionPlanner, NO_PROGRESS_TICKS } from "./planner-step.ts";

const RUN_ID = "run-watch";

/** A return action whose goal the test moves, like the harness's route cursor; records aborts. */
function returning() {
  const state = { goal: vec3(27.25, -3.78, 3.96) as Vec3, aborted: null as string | null };
  const harness = {
    runId: RUN_ID,
    activeMotion: () => state.aborted !== null ? null : { proposal: { id: "p-return", action: { kind: "return", routeId: "route-return" }, proposer: "local_planner" }, goal: state.goal },
    abort: (command: { readonly reason: string }) => { state.aborted = command.reason; return { accepted: true }; },
  };
  const planner = new MissionPlanner(new DecisionBroker({ runId: RUN_ID, cloudEnabled: false }));
  const log = new EventLog(RUN_ID);
  const watch = (tick: Tick, remainingM: number) => {
    const t = { ctx: { tick } as unknown as HarnessContext, harness: harness as unknown as ActionHarness, log, lastInterventionTick: null, nowMs: 0 } satisfies PlannerTick;
    planner.watch(t, remainingM);
  };
  return { state, watch };
}

describe("the no-progress watch on a route", () => {
  test("a waypoint advance restarts the baseline: steady progress toward the next waypoint is not aborted", () => {
    const { state, watch } = returning();
    let tick = 1000;
    // Closing on the first waypoint: 10 m down to 1.02 m.
    for (let d = 10; d > 1.02; d -= 0.01) watch(tick++, d);
    // The harness advances the goal 4.4 m along the facade; the steering's remaining distance jumps to 16.45 m
    // (including a detour), then falls steadily.
    state.goal = vec3(27.25, 0.6, 6.23);
    for (let i = 0; i <= NO_PROGRESS_TICKS + 500; i++) watch(tick++, 16.45 - 0.004 * i);
    assert.equal(state.aborted, null, "progress toward the new waypoint is progress");
  });

  test("a goal whose height alone changes does not restart it: a stuck return is still stopped", () => {
    const { state, watch } = returning();
    let tick = 1000;
    for (let i = 0; i <= NO_PROGRESS_TICKS + 10; i++) {
      state.goal = vec3(27.25, -3.78, 3.96 + i * 0.001);
      watch(tick++, 5);
    }
    assert.match(state.aborted ?? "", /no progress toward the goal for 1500 ticks \(5\.00 m remaining\)/);
  });

  test("stuck after an advance: stopped once the new baseline has not improved for the full window", () => {
    const { state, watch } = returning();
    let tick = 1000;
    for (let d = 6; d > 2; d -= 0.01) watch(tick++, d);
    state.goal = vec3(27.25, 2.45, 4.77);
    for (let i = 0; i < NO_PROGRESS_TICKS; i++) watch(tick++, 8);
    assert.equal(state.aborted, null, "not before the window has passed");
    for (let i = 0; i < 5; i++) watch(tick++, 8);
    assert.match(state.aborted ?? "", /8\.00 m remaining/);
  });
});
