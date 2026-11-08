/**
 * Motion-guard behaviour. Scope: guardMotion only, against the fixture envelope (box x 0–20, y 0–10,
 * z 0–6), Tender T1 hard limits (4 m/s, 1.5 m/s vertical, 120°/s yaw, 3 m/s² → 0.03 m/s per tick) and the
 * default policy. Closed-loop cases feed each executed command back as the next tick's `previous`, as
 * the harness does.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionProposal, GuardedMotion, MotionCommand, MotionRequest } from "../contracts/actions.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { deepFreeze } from "../contracts/ids.ts";
import {
  command, CONTINGENCY_HOLD, CONTINGENCY_LAND, CONTINGENCY_MOVE, CONTINGENCY_RETURN, context, DEFAULT_POLICY, ENVELOPE, guardState,
  motionRequest, NOW, PLANNER_LAND, PLANNER_MOVE, PLANNER_SCAN, proposal, SLOW_MOVE, STILL, TENDER_T1, track,
} from "./motion-fixtures.ts";
import type { MotionGuardState } from "./motion-guard.ts";
import { guardMotion } from "./motion-guard.ts";
import type { HarnessContext } from "./policy.ts";

const HARD = TENDER_T1.hardLimits;
const ACCEL_STEP = HARD.maxAccelMps2 * TICK_S;

function guarded(request: MotionRequest, ctx: HarnessContext, state: MotionGuardState): GuardedMotion {
  const motion = guardMotion(request, ctx, state);
  assert.ok(motion !== null, "a non-null request must produce a guarded motion");
  return motion;
}

/** Run the guard for `ticks` ticks, feeding each executed command back as `previous`. */
function fly(request: MotionRequest, ctx: HarnessContext, state: MotionGuardState, ticks: number): GuardedMotion[] {
  const trace: GuardedMotion[] = [];
  let previous = state.previous;
  for (let i = 0; i < ticks; i++) {
    const motion = guarded({ ...request, tick: request.tick + i }, ctx, { ...state, previous });
    trace.push(motion);
    previous = motion.executed;
  }
  return trace;
}

function assertVec(actual: Vec3, expected: Vec3, message?: string): void {
  assert.ok(distance(actual, expected) <= 1e-9, `${message ?? "vector"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function horizontalSpeed(c: MotionCommand): number {
  return Math.hypot(c.velocityBody.x, c.velocityBody.y);
}

describe("the guard only limits", () => {
  const COMPONENTS = [-6, -1.2, -0.05, 0, 0.05, 1.2, 6];
  const YAW_RATES = [-5, -0.4, 0, 0.4, 5];
  const STATES: readonly [string, HarnessContext, MotionGuardState][] = [
    ["planner move at the centre", context(), guardState()],
    ["slow move with forward momentum", context(), guardState({ activeMotion: SLOW_MOVE, previous: command(1.5, 0, 0) })],
    ["scan while moving the other way", context(), guardState({ activeMotion: PLANNER_SCAN, previous: command(-1, 0.5, -0.3) })],
    ["planner land without localization", context({ pose: { supported: false } }), guardState({ activeMotion: PLANNER_LAND, previous: command(0.3, 0, -0.2) })],
    ["move with σ above the advance limit", context({ pose: { sigmaM: 1.2 } }), guardState({ previous: command(1, 0, 0) })],
    ["intervention station keeping", context(), guardState({ activeMotion: null, interventionActive: true, previous: command(0.1, -0.1, 0.05) })],
    ["aborted planner move", context(), guardState({ missionAborted: true, previous: command(1, 1, 0) })],
    ["aborted with a contingency return", context(), guardState({ missionAborted: true, activeMotion: CONTINGENCY_RETURN, previous: command(1, 0, 0) })],
    ["no validated goal", context(), guardState({ activeMotion: null, previous: command(0.5, 0, 0) })],
    ["near the east wall facing east", context({ pose: { position: vec3(19.6, 5, 3) } }), guardState({ previous: command(1.2, 0, 0) })],
    ["outside the envelope and yawed", context({ pose: { position: vec3(21, 11, 3), yawRad: 2.3 } }), guardState({ previous: command(0.5, 0.5, 0) })],
    ["contingency land near the ceiling", context({ pose: { position: vec3(10, 5, 5.8) } }), guardState({ activeMotion: CONTINGENCY_LAND })],
    ["planner move near the floor", context({ pose: { position: vec3(10, 5, 0.1) } }), guardState({ previous: command(0, 0, -0.4) })],
    ["planner move after the time box", context({ tick: ENVELOPE.endTick + 1 }), guardState({ previous: command(1, 0, 0) })],
    ["contingency hold after the time box", context({ tick: ENVELOPE.endTick + 1 }), guardState({ activeMotion: CONTINGENCY_HOLD, previous: command(0.2, 0, 0) })],
    ["inside a possible occupant's clearance, ahead-left", context({ tracks: [track("track-near", vec3(10.9, 5.6, 3))] }), guardState({ previous: command(0.8, 0.2, 0) })],
    ["yawed, nearing an occupant below", context({ pose: { yawRad: -2.5 }, tracks: [track("track-near", vec3(11.4, 4.2, 2.4), { uncertaintyM: 0.2 })] }), guardState({ previous: command(1, -0.5, -0.4) })],
  ];

  test("never raises a component's magnitude, flips its sign or exceeds a hard limit (deterministic grid)", () => {
    let checked = 0;
    for (const [label, ctx, state] of STATES) {
      // Frozen inputs also prove the guard never mutates what it is given.
      const frozenCtx = deepFreeze(ctx);
      const frozenState = deepFreeze(state);
      for (const x of COMPONENTS) for (const y of COMPONENTS) for (const z of COMPONENTS) for (const yaw of YAW_RATES) {
        const request = deepFreeze(motionRequest(x, y, z, yaw));
        const { requested, executed } = guarded(request, frozenCtx, frozenState);
        const where = `${label}: request (${x}, ${y}, ${z}, yaw ${yaw}) → ${JSON.stringify(executed)}`;
        assert.deepEqual(requested, request, where);
        const pairs: [number, number][] = [[executed.velocityBody.x, x], [executed.velocityBody.y, y], [executed.velocityBody.z, z], [executed.yawRateRadps, yaw]];
        for (const [out, asked] of pairs) {
          assert.ok(Number.isFinite(out), where);
          assert.ok(Math.abs(out) <= Math.abs(asked), `magnitude raised — ${where}`);
          assert.ok(out * asked >= 0, `sign flipped — ${where}`);
        }
        assert.ok(horizontalSpeed(executed) <= Math.min(HARD.maxSpeedMps, ENVELOPE.maxSpeedMps) + 1e-9, where);
        assert.ok(Math.abs(executed.velocityBody.z) <= HARD.maxVerticalSpeedMps, where);
        assert.ok(Math.abs(executed.yawRateRadps) <= HARD.maxYawRateRadps, where);
        checked++;
      }
    }
    assert.equal(checked, STATES.length * COMPONENTS.length ** 3 * YAW_RATES.length);
  });

  test("an in-limit request that needs no acceleration passes unchanged with no limits reported", () => {
    const steady = command(1.2, -0.4, 0.3, 0.5);
    const motion = guarded(motionRequest(1.2, -0.4, 0.3, 0.5), context(), guardState({ previous: steady }));
    assert.deepEqual(motion.executed, steady);
    assert.deepEqual(motion.limits, []);
  });

  test("a null request yields null (the simulator holds a zero setpoint) unless a terminal failure is active", () => {
    for (const [, ctx, state] of STATES) assert.equal(guardMotion(null, ctx, state), null);
  });

  test("is a pure function of its inputs", () => {
    const ctx = context({ pose: { position: vec3(19.7, 9.7, 5.7), yawRad: 0.7 } });
    const state = guardState({ previous: command(0.6, 0.1, 0.2) });
    const request = motionRequest(2, 1, 1, 1);
    assert.deepEqual(guardMotion(request, ctx, state), guardMotion(request, ctx, state));
  });
});

describe("gates", () => {
  test("without an active goal or intervention the aircraft is commanded still, whatever the reflex asks", () => {
    for (const request of [motionRequest(1.5, 0.3, 0.2, 0.4), motionRequest(-0.1, 0, 0, 0, "operator"), motionRequest(0, 0, 0)]) {
      const motion = guarded(request, context(), guardState({ activeMotion: null, previous: command(1, 0, 0) }));
      assert.deepEqual(motion.executed, STILL);
      assert.deepEqual(motion.limits, ["no_active_goal"]);
      assert.deepEqual(motion.requested, request);
    }
  });

  test("an executing non-motion action (speech) is not a goal to fly toward", () => {
    const speaking = proposal({ kind: "speak", templateId: "stay-low" });
    const motion = guarded(motionRequest(1, 0, 0), context(), guardState({ activeMotion: speaking, previous: command(1, 0, 0) }));
    assert.deepEqual(motion.executed, STILL);
    assert.deepEqual(motion.limits, ["no_active_goal"]);
  });

  test("a mission abort zeroes non-contingency motion at once", () => {
    const request = motionRequest(1, 0, 0);
    for (const activeMotion of [PLANNER_MOVE, CONTINGENCY_MOVE, null]) {
      const motion = guarded(request, context(), guardState({ missionAborted: true, activeMotion, previous: command(1, 0, 0) }));
      assert.deepEqual(motion.executed, STILL, `active: ${activeMotion?.action.kind ?? "none"} by ${activeMotion?.proposer ?? "-"}`);
      assert.deepEqual(motion.limits, ["mission_aborted"]);
    }
  });

  test("after an abort a contingency return or land keeps flying under the ordinary limits, and a contingency hold keeps station", () => {
    for (const activeMotion of [CONTINGENCY_RETURN, CONTINGENCY_LAND]) {
      const motion = guarded(motionRequest(1, 0, -0.2), context(), guardState({ missionAborted: true, activeMotion, previous: command(1, 0, -0.2) }));
      assertVec(motion.executed.velocityBody, vec3(1, 0, -0.2), activeMotion.action.kind);
      assert.deepEqual(motion.limits, []);
    }
    const hold = guarded(motionRequest(1, 0, -0.2), context(), guardState({ missionAborted: true, activeMotion: CONTINGENCY_HOLD, previous: command(1, 0, -0.2) }));
    assertVec(hold.executed.velocityBody, vec3(DEFAULT_POLICY.stationKeepingSpeedMps, 0, -0.2), "hold");
    assert.deepEqual(hold.limits, ["speed"]);
  });

  test("terminal failure brakes and descends even without a request, labelled as a contingency", () => {
    const motion = guardMotion(null, context(), guardState({ terminalFailure: true, missionAborted: true, previous: command(1.5, 0, 0) }));
    assert.ok(motion !== null);
    assert.equal(motion.requested.source, "contingency");
    assert.deepEqual(motion.executed, command(0, 0, -DEFAULT_POLICY.terminalDescentMps, 0));
    assert.deepEqual(motion.limits, ["mission_aborted"]);
  });

  test("terminal failure overrides any request and records what was asked", () => {
    const request = motionRequest(2, 1, 1, 1, "operator");
    for (const activeMotion of [CONTINGENCY_RETURN, PLANNER_MOVE, null]) {
      const motion = guarded(request, context(), guardState({ terminalFailure: true, activeMotion }));
      assert.deepEqual(motion.executed, command(0, 0, -DEFAULT_POLICY.terminalDescentMps, 0));
      assert.deepEqual(motion.requested, request);
      assert.deepEqual(motion.limits, ["mission_aborted"]);
    }
  });

  test("the terminal descent never exceeds the vertical hard limit", () => {
    const motion = guardMotion(null, context({ policy: { terminalDescentMps: 5 } }), guardState({ terminalFailure: true }));
    assert.equal(motion?.executed.velocityBody.z, -HARD.maxVerticalSpeedMps);
  });

  test("the envelope time box stops mission motion after endTick but not contingencies", () => {
    const request = motionRequest(1, 0, 0);
    const moving = { previous: command(1, 0, 0) };
    const atEnd = guarded(request, context({ tick: ENVELOPE.endTick }), guardState(moving));
    assertVec(atEnd.executed.velocityBody, vec3(1, 0, 0), "at endTick");
    const after = guarded(request, context({ tick: ENVELOPE.endTick + 1 }), guardState(moving));
    assert.deepEqual(after.executed, STILL);
    assert.deepEqual(after.limits, ["envelope_boundary"]);
    for (const activeMotion of [CONTINGENCY_RETURN, CONTINGENCY_LAND]) {
      const contingency = guarded(request, context({ tick: ENVELOPE.endTick + 1 }), guardState({ ...moving, activeMotion }));
      assertVec(contingency.executed.velocityBody, vec3(1, 0, 0), activeMotion.action.kind);
    }
    const hold = guarded(request, context({ tick: ENVELOPE.endTick + 1 }), guardState({ ...moving, activeMotion: CONTINGENCY_HOLD }));
    assertVec(hold.executed.velocityBody, vec3(DEFAULT_POLICY.stationKeepingSpeedMps, 0, 0), "a contingency hold after the time box keeps station");
  });

  test("review F4: a hold or a scan keeps station instead of travelling at envelope speed", () => {
    const keep = DEFAULT_POLICY.stationKeepingSpeedMps;
    for (const activeMotion of [CONTINGENCY_HOLD, proposal({ kind: "hold", durationTicks: 600 }), PLANNER_SCAN]) {
      const trace = fly(motionRequest(2, 0, 0.4, 0.3), context(), guardState({ activeMotion }), 200);
      for (const motion of trace) {
        assert.ok(horizontalSpeed(motion.executed) <= keep + 1e-12, `${activeMotion.proposer} ${activeMotion.action.kind}: ${horizontalSpeed(motion.executed)} m/s`);
        assert.ok(Math.abs(motion.executed.velocityBody.z) <= keep + 1e-12);
      }
      const last = trace[trace.length - 1];
      assertVec(last.executed.velocityBody, vec3(keep, 0, keep), activeMotion.action.kind);
      assert.equal(last.executed.yawRateRadps, 0.3, "yaw in place is not travel");
      assert.ok(last.limits.includes("speed"));
    }
  });
});

describe("speed, vertical-speed and yaw-rate clamps", () => {
  /** Clamp cases with `previous` already at the clamped value, so acceleration does not interfere. */
  function clamped(request: MotionRequest, expected: MotionCommand, activeMotion: ActionProposal, ctx: HarnessContext = context()): GuardedMotion {
    const motion = guarded(request, ctx, guardState({ activeMotion, previous: expected }));
    assertVec(motion.executed.velocityBody, expected.velocityBody);
    assert.ok(Math.abs(motion.executed.yawRateRadps - expected.yawRateRadps) <= 1e-12);
    return motion;
  }

  test("horizontal speed is capped by the move's own limit, preserving direction", () => {
    const motion = clamped(motionRequest(3, 4, 0), command(0.9, 1.2, 0), SLOW_MOVE);
    assert.deepEqual(motion.limits, ["speed"]);
    assert.ok(Math.abs(motion.executed.velocityBody.x / motion.executed.velocityBody.y - 0.75) < 1e-12);
  });

  test("the envelope speed caps a faster move and any non-move action", () => {
    assert.deepEqual(clamped(motionRequest(3, 4, 0), command(1.2, 1.6, 0), PLANNER_MOVE).limits, ["speed"]);
    assert.deepEqual(clamped(motionRequest(-3, 4, 0), command(-1.2, 1.6, 0), CONTINGENCY_RETURN).limits, ["speed"]);
  });

  test("the aircraft hard limit holds even under a misconfigured faster envelope", () => {
    const fastEnvelope = context({ envelope: { maxSpeedMps: 6 } });
    assert.deepEqual(clamped(motionRequest(6, -8, 0), command(2.4, -3.2, 0), CONTINGENCY_RETURN, fastEnvelope).limits, ["speed"]);
  });

  test("vertical speed and yaw rate are clamped symmetrically and keep their sign", () => {
    assert.deepEqual(clamped(motionRequest(0, 0, 4), command(0, 0, 1.5), PLANNER_MOVE).limits, ["vertical_speed"]);
    assert.deepEqual(clamped(motionRequest(0, 0, -4), command(0, 0, -1.5), PLANNER_MOVE).limits, ["vertical_speed"]);
    assert.deepEqual(clamped(motionRequest(0, 0, 0, 5), command(0, 0, 0, HARD.maxYawRateRadps), PLANNER_MOVE).limits, ["yaw_rate"]);
    assert.deepEqual(clamped(motionRequest(0, 0, 0, -5), command(0, 0, 0, -HARD.maxYawRateRadps), PLANNER_MOVE).limits, ["yaw_rate"]);
  });

  test("all three clamps can apply at once", () => {
    const motion = clamped(motionRequest(-3, 4, -4, -5), command(-1.2, 1.6, -1.5, -HARD.maxYawRateRadps), PLANNER_MOVE);
    assert.deepEqual([...motion.limits].sort(), ["speed", "vertical_speed", "yaw_rate"]);
  });

  test("non-finite components never reach an actuator", () => {
    const nanVelocity = guarded(motionRequest(NaN, 1, 0), context(), guardState({ previous: command(0, 1, 0) }));
    assert.deepEqual(nanVelocity.executed.velocityBody, vec3(0, 0, 0));
    assert.ok(nanVelocity.limits.includes("speed"));
    assert.ok(Number.isNaN(nanVelocity.requested.velocityBody.x), "the request is recorded as received");
    const infiniteYaw = guarded(motionRequest(0.5, 0, 0, Infinity), context(), guardState({ previous: command(0.5, 0, 0) }));
    assert.equal(infiniteYaw.executed.yawRateRadps, 0);
    assertVec(infiniteYaw.executed.velocityBody, vec3(0.5, 0, 0));
    assert.deepEqual(infiniteYaw.limits, ["yaw_rate"]);
  });
});

describe("acceleration", () => {
  test("from rest each tick changes velocity by at most maxAccel·dt until the request is reached", () => {
    const trace = fly(motionRequest(1.2, 0, 0), context(), guardState(), 60);
    let previous = vec3(0, 0, 0);
    for (const motion of trace) {
      assert.ok(distance(motion.executed.velocityBody, previous) <= ACCEL_STEP + 1e-12);
      previous = motion.executed.velocityBody;
    }
    const reached = trace.findIndex(motion => motion.executed.velocityBody.x === 1.2);
    // 1.2 m/s at 0.03 m/s per tick needs 40 ticks (index 39); allow one tick of floating-point rounding.
    assert.ok(reached === 39 || reached === 40, `reached at index ${reached}`);
    assert.ok(trace.slice(0, reached).every(motion => motion.limits.includes("acceleration")));
    assert.ok(trace.slice(reached).every(motion => motion.limits.length === 0));
  });

  test("the bound applies to the whole velocity vector, including climbs", () => {
    const [first] = fly(motionRequest(1, 1, 1), context(), guardState(), 1);
    assert.ok(Math.abs(distance(first.executed.velocityBody, vec3(0, 0, 0)) - ACCEL_STEP) < 1e-12);
    assert.deepEqual(first.limits, ["acceleration"]);
  });

  test("a sideways request keeps forward motion that is still requested and ramps only the new component", () => {
    const motion = guarded(motionRequest(1, 1, 0), context(), guardState({ previous: command(1, 0, 0) }));
    assertVec(motion.executed.velocityBody, vec3(1, ACCEL_STEP, 0));
    assert.deepEqual(motion.limits, ["acceleration"]);
  });

  test("a brake or slow-down is executed at once: the guard never holds the aircraft above the request", () => {
    const brake = guarded(motionRequest(0, 0, 0), context(), guardState({ previous: command(1.5, 0, 0) }));
    assert.deepEqual(brake.executed.velocityBody, vec3(0, 0, 0));
    assert.deepEqual(brake.limits, []);
    const slower = guarded(motionRequest(0.5, 0, 0), context(), guardState({ previous: command(1.5, 0, 0) }));
    assert.deepEqual(slower.executed.velocityBody, vec3(0.5, 0, 0));
    assert.deepEqual(slower.limits, []);
  });

  test("a reversal drops the old direction at once and ramps the new one", () => {
    const motion = guarded(motionRequest(-1, 0, 0), context(), guardState({ previous: command(1, 0, 0) }));
    assertVec(motion.executed.velocityBody, vec3(-ACCEL_STEP, 0, 0));
    assert.deepEqual(motion.limits, ["acceleration"]);
  });

  test("a broken (NaN) acceleration limit stops growth instead of disabling the limit", () => {
    const broken = context({ profile: { ...TENDER_T1, hardLimits: { ...HARD, maxAccelMps2: NaN } } });
    const motion = guarded(motionRequest(1, 0, 0), broken, guardState());
    assert.deepEqual(motion.executed.velocityBody, vec3(0, 0, 0));
    assert.deepEqual(motion.limits, ["acceleration"]);
  });
});

describe("localization", () => {
  const unsupported: readonly [string, HarnessContext][] = [
    ["estimator unsupported", context({ pose: { supported: false } })],
    ["σ above the advance limit", context({ pose: { sigmaM: DEFAULT_POLICY.maxSigmaForAdvanceM + 0.01 } })],
    ["σ unknown (NaN)", context({ pose: { sigmaM: NaN } })],
  ];

  test("without supported localization there is no horizontal or vertical advancement, even over many ticks", () => {
    for (const [label, ctx] of unsupported) {
      const trace = fly(motionRequest(1.5, -0.5, 0.4, 0.3), ctx, guardState({ previous: command(1.5, -0.5, 0.4) }), 200);
      for (const motion of trace) {
        assert.deepEqual(motion.executed.velocityBody, vec3(0, 0, 0), label);
        assert.deepEqual(motion.limits, ["localization"], label);
      }
      // Turning in place does not advance the aircraft and stays available to re-acquire features.
      assert.equal(trace[0].executed.yawRateRadps, 0.3);
    }
  });

  test("an active landing may still descend, but not climb or drift", () => {
    for (const [label, ctx] of unsupported) {
      for (const activeMotion of [PLANNER_LAND, CONTINGENCY_LAND]) {
        const descend = guarded(motionRequest(0.5, 0.2, -0.4), ctx, guardState({ activeMotion, previous: command(0, 0, -0.4) }));
        assertVec(descend.executed.velocityBody, vec3(0, 0, -0.4), label);
        assert.deepEqual(descend.limits, ["localization"]);
        const climb = guarded(motionRequest(0, 0, 0.4), ctx, guardState({ activeMotion, previous: STILL }));
        assert.deepEqual(climb.executed.velocityBody, vec3(0, 0, 0), label);
        assert.deepEqual(climb.limits, ["localization"]);
      }
    }
  });

  test("σ exactly at the advance limit still supports movement", () => {
    const ctx = context({ pose: { sigmaM: DEFAULT_POLICY.maxSigmaForAdvanceM } });
    const motion = guarded(motionRequest(1, 0, 0), ctx, guardState({ previous: command(1, 0, 0) }));
    assertVec(motion.executed.velocityBody, vec3(1, 0, 0));
    assert.deepEqual(motion.limits, []);
  });
});

describe("envelope boundary", () => {
  /** Steady-state guard call at a pose: `previous` equals the request, so only position limits act. */
  function at(position: Vec3, request: MotionRequest, yawRad = 0, activeMotion: ActionProposal = PLANNER_MOVE): GuardedMotion {
    return guarded(request, context({ pose: { position, yawRad } }), guardState({ activeMotion, previous: { velocityBody: request.velocityBody, yawRateRadps: 0 } }));
  }

  test("outward motion near a wall stops; motion back inside continues", () => {
    const nearEast = vec3(19.5, 5, 3);
    const outward = at(nearEast, motionRequest(1, 0, 0));
    assert.deepEqual(outward.executed.velocityBody, vec3(0, 0, 0));
    assert.deepEqual(outward.limits, ["envelope_boundary"]);
    const inward = at(nearEast, motionRequest(-1, 0, 0));
    assertVec(inward.executed.velocityBody, vec3(-1, 0, 0));
    assert.deepEqual(inward.limits, []);
  });

  test("within the uncertainty margin, motion along the wall is allowed but not toward it", () => {
    const inMargin = vec3(19.9, 5, 3);
    assertVec(at(inMargin, motionRequest(0, 1, 0)).executed.velocityBody, vec3(0, 1, 0));
    assert.deepEqual(at(inMargin, motionRequest(0.2, 1, 0)).executed.velocityBody, vec3(0, 0, 0));
  });

  test("already outside, moving farther away stops while returning toward the envelope is allowed", () => {
    const outside = vec3(21, 5, 3);
    assert.deepEqual(at(outside, motionRequest(1, 0, 0)).executed.velocityBody, vec3(0, 0, 0));
    const back = at(outside, motionRequest(-1, 0, 0));
    assertVec(back.executed.velocityBody, vec3(-1, 0, 0));
    assert.deepEqual(back.limits, []);
  });

  test("the prediction uses the estimated yaw to rotate body velocity into the world frame", () => {
    const facingNorth = Math.PI / 2;
    const nearEast = vec3(19.5, 5, 3);
    // Facing north, body right (−Y) is world east (toward the wall) and body left is world west.
    assert.deepEqual(at(nearEast, motionRequest(0, -1, 0), facingNorth).executed.velocityBody, vec3(0, 0, 0));
    assertVec(at(nearEast, motionRequest(0, 1, 0), facingNorth).executed.velocityBody, vec3(0, 1, 0));
    assertVec(at(nearEast, motionRequest(1, 0, 0), facingNorth).executed.velocityBody, vec3(1, 0, 0));
  });

  test("a climb toward the ceiling is stopped while level motion continues", () => {
    const motion = at(vec3(10, 5, 5.7), motionRequest(1, 0, 0.5));
    assertVec(motion.executed.velocityBody, vec3(1, 0, 0));
    assert.deepEqual(motion.limits, ["envelope_boundary"]);
  });

  test("near the floor only a landing may keep descending", () => {
    const low = vec3(10, 5, 0.25);
    assert.deepEqual(at(low, motionRequest(0, 0, -0.5)).executed.velocityBody, vec3(0, 0, 0));
    for (const land of [PLANNER_LAND, CONTINGENCY_LAND]) {
      const landing = at(low, motionRequest(0, 0, -0.5), 0, land);
      assertVec(landing.executed.velocityBody, vec3(0, 0, -0.5));
      assert.deepEqual(landing.limits, []);
    }
  });

  test("an envelope with no permitted region or an unknown position allows no translation", () => {
    const noRegion = guarded(motionRequest(-1, 0, 0), context({ envelope: { regions: [] } }), guardState({ previous: command(-1, 0, 0) }));
    assert.deepEqual(noRegion.executed.velocityBody, vec3(0, 0, 0));
    assert.deepEqual(noRegion.limits, ["envelope_boundary"]);
    const lost = guarded(motionRequest(-1, 0, 0), context({ pose: { position: vec3(NaN, 5, 3) } }), guardState({ previous: command(-1, 0, 0) }));
    assert.deepEqual(lost.executed.velocityBody, vec3(0, 0, 0));
  });
});

describe("station keeping during an intervention", () => {
  test("translation is capped at the station-keeping speed in each axis, preserving direction", () => {
    const s = DEFAULT_POLICY.stationKeepingSpeedMps;
    const expected = vec3(s / Math.SQRT2, s / Math.SQRT2, s);
    const motion = guarded(motionRequest(1, 1, 0.5), context(), guardState({ activeMotion: null, interventionActive: true, previous: { velocityBody: expected, yawRateRadps: 0 } }));
    assertVec(motion.executed.velocityBody, expected);
    assert.deepEqual(motion.limits, ["speed"]);
  });

  test("small corrections pass unchanged and an intervention alone is enough to permit them", () => {
    const motion = guarded(motionRequest(0.1, 0, -0.1), context(), guardState({ activeMotion: null, interventionActive: true, previous: command(0.1, 0, -0.1) }));
    assertVec(motion.executed.velocityBody, vec3(0.1, 0, -0.1));
    assert.deepEqual(motion.limits, []);
  });

  test("station keeping also applies when a motion action is active", () => {
    const trace = fly(motionRequest(2, 0, 0), context(), guardState({ interventionActive: true }), 30);
    assert.ok(trace.every(motion => horizontalSpeed(motion.executed) <= DEFAULT_POLICY.stationKeepingSpeedMps + 1e-12));
    assert.equal(trace[29].executed.velocityBody.x, DEFAULT_POLICY.stationKeepingSpeedMps);
  });
});

describe("requests from every source share one guard", () => {
  test("operator, flow baseline and fly readout requests are limited identically", () => {
    const sources = ["fly_readout", "engineered_readout", "flow_baseline", "classical_fallback", "operator", "contingency"] as const;
    const results = sources.map(source => guarded(motionRequest(3, 4, 2, 4, source, NOW), context(), guardState()));
    for (const result of results) assert.deepEqual({ executed: result.executed, limits: result.limits }, { executed: results[0].executed, limits: results[0].limits });
  });
});
