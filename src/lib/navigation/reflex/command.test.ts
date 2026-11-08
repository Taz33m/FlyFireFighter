/**
 * The shared cue → command mapper while holding facing a focus (GoalEstimate.faceBearingRad) and while turning
 * in place near a forward surface. Scope: one mapper step per case with fixed cues; the closed-loop turn is in
 * closed-loop.test.ts and steering.test.ts.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "../../contracts/frames.ts";
import { DEFAULT_COMMAND_CONFIG, ReflexCommandMapper } from "./command.ts";
import type { ControllerInput, GoalEstimate, RangeAssist, ReflexCues } from "./types.ts";

const CLEAR: ReflexCues = { visualConfidence: 1, centering: 0.6, centeringWeight: 1, loomingRateHz: null, avoidTurn: 0 };

function step(goal: GoalEstimate, ranges: RangeAssist | null = null) {
  const input: ControllerInput = { tick: 10, frame: null, goal, previous: { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 }, quality: { frame: 1, poseSigmaM: 0.05 }, ranges };
  return new ReflexCommandMapper("flow_baseline").map(input, CLEAR);
}

describe("holding facing a focus", () => {
  const c = DEFAULT_COMMAND_CONFIG;

  test("inside the arrival radius: turns toward the face bearing at goalGain without translating, ignoring flow centering", () => {
    const out = step({ bearingRad: 2, distanceM: 0.2, heightErrorM: 0, faceBearingRad: -0.4 });
    assert.equal(out.mode, "hold_face");
    assert.ok(Math.abs(out.request.yawRateRadps - c.goalGain * -0.4) < 1e-12);
    assert.deepEqual([out.request.velocityBody.x, out.request.velocityBody.y], [0, 0]);
    // A face bearing beyond ±π is wrapped, and the yaw rate stays within the limits.
    const behind = step({ bearingRad: 0, distanceM: 0.2, heightErrorM: 0, faceBearingRad: 2 * Math.PI - 3 });
    assert.equal(behind.request.yawRateRadps, -c.limits.maxYawRateRadps);
  });

  test("between the arrival and hold radii: drifts back toward the goal in any body direction while turning to face", () => {
    // Goal directly to the right, focus ahead-left: slide right, turn left, no forward travel toward the goal.
    const out = step({ bearingRad: -Math.PI / 2, distanceM: 0.45, heightErrorM: 0, faceBearingRad: 0.3 });
    assert.equal(out.mode, "hold_face");
    assert.ok(Math.abs(out.request.velocityBody.y + c.approachGain * (0.45 - c.arrivalRadiusM)) < 1e-9, `lateral ${out.request.velocityBody.y}`);
    assert.ok(Math.abs(out.request.velocityBody.x) < 1e-9);
    assert.ok(out.request.yawRateRadps > 0);
  });

  test("beyond the hold radius the face bearing changes nothing", () => {
    const goal = { bearingRad: 0.7, distanceM: 2, heightErrorM: 0.1 };
    assert.deepEqual(step({ ...goal, faceBearingRad: -1 }), step(goal));
  });

  test("range assistance keeps precedence: no turn toward a side inside the lateral clearance, brake-and-turn up close", () => {
    const vetoed = step({ bearingRad: 0, distanceM: 0.2, heightErrorM: 0, faceBearingRad: 1 }, { forwardM: null, leftM: 0.3, rightM: null, downM: null });
    assert.ok(vetoed.request.yawRateRadps <= 0);
    const braked = step({ bearingRad: 0, distanceM: 0.2, heightErrorM: 0, faceBearingRad: 1 }, { forwardM: 0.2, leftM: null, rightM: null, downM: null });
    assert.equal(braked.mode, "range_brake");
    assert.equal(braked.request.velocityBody.x, -c.blindSpeedMps, "backs off, but no faster than the unsensed rear allows");
  });

  test("a non-finite face bearing is ignored", () => {
    const goal = { bearingRad: 0, distanceM: 0.2, heightErrorM: 0 };
    assert.deepEqual(step({ ...goal, faceBearingRad: Number.NaN }), step(goal));
  });
});

describe("turning in place near a forward surface", () => {
  const c = DEFAULT_COMMAND_CONFIG;
  // Goal behind-left, a surface just beyond the range-brake clearance ahead, the open side to the right:
  // the measured exterior dead-lock alternated the goal turn (left) and the range brake's turn (right).
  const goal = { bearingRad: 2.5, distanceM: 19.7, heightErrorM: 0 };
  const ranges = (forwardM: number): RangeAssist => ({ forwardM, leftM: 0.65, rightM: 4.6, downM: null });

  test("keeps turning toward the open side on both sides of the clearance threshold", () => {
    const inside = step(goal, ranges(c.rangeClearanceM - 0.05));
    const beyond = step(goal, ranges(c.rangeClearanceM + 0.05));
    assert.equal(inside.mode, "range_brake");
    assert.equal(beyond.mode, "range_turn");
    assert.equal(Math.sign(inside.request.yawRateRadps), -1);
    assert.equal(Math.sign(beyond.request.yawRateRadps), -1, "same direction: no alternation at the threshold");
  });

  test("with the goal ahead, or the surface beyond the hysteresis band, the goal turn is unchanged", () => {
    const ahead = { bearingRad: 0.4, distanceM: 5, heightErrorM: 0 };
    assert.notEqual(step(ahead, ranges(c.rangeClearanceM + 0.05)).mode, "range_turn");
    const far = step(goal, ranges(c.rangeClearanceM + c.rangeTurnHysteresisM + 0.05));
    assert.ok(far.request.yawRateRadps > 0, "turns toward the goal (left) once the surface is clear");
  });
});

describe("sensor-covered translation", () => {
  const c = DEFAULT_COMMAND_CONFIG;
  // No usable vision: the range-only ceiling, as indoors in smoke. The mapper is the only state, so each step is fresh.
  const blind = (goal: GoalEstimate, ranges: RangeAssist | null, config = c) => {
    const input: ControllerInput = { tick: 10, frame: null, goal, previous: { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 }, quality: { frame: 0, poseSigmaM: 0.05 }, ranges };
    return new ReflexCommandMapper("flow_baseline", config).map(input, null);
  };
  const ahead = { bearingRad: 0, distanceM: 5, heightErrorM: 0 };
  const side = (leftM: number | null, rightM: number | null): RangeAssist => ({ forwardM: 3, leftM, rightM, downM: null });

  test("a lateral return close to the contact clearance limits forward speed (it may sit 60° off the nose); open flanks do not", () => {
    const open = blind(ahead, side(null, null));
    assert.ok(open.request.velocityBody.x > 0.3, `open: ${open.request.velocityBody.x}`);
    const jamb = blind(ahead, side(null, c.contactClearanceM + 0.03));
    assert.equal(jamb.mode, "slow_flank");
    assert.ok(Math.abs(jamb.request.velocityBody.x - (2 * 0.03) / c.rangeBrakeTimeS) < 1e-9, `beside a jamb: ${jamb.request.velocityBody.x}`);
    const touching = blind(ahead, side(c.contactClearanceM - 0.01, null));
    assert.equal(touching.request.velocityBody.x, 0, "no forward travel with a side inside the contact clearance");
  });

  test("inside the contact band the push away acts even when the comfort lateral clearance is smaller (close-quarters settings)", () => {
    const docking = { ...c, lateralClearanceM: 0.3 };
    const out = blind(ahead, side(null, c.contactClearanceM), docking);
    assert.ok(out.request.velocityBody.y > 0, `pushed left, away from the right return: ${out.request.velocityBody.y}`);
  });

  test("a hold drifting sideways toward a near side is bounded by that side's reading; away from it, it is not", () => {
    // Goal 0.45 m to the right while holding a face bearing ahead: the drift is to the right.
    const toRight = { bearingRad: -Math.PI / 2, distanceM: 0.45, heightErrorM: 0, faceBearingRad: 0 };
    const free = blind(toRight, side(null, null));
    assert.ok(free.request.velocityBody.y < -0.05, `free drift: ${free.request.velocityBody.y}`);
    const nearWall = blind(toRight, side(null, c.contactClearanceM + 0.2));
    // The push band starts at contact + band; at contact + 0.2 the only bound is the reading.
    assert.ok(nearWall.request.velocityBody.y >= -0.2 / c.rangeBrakeTimeS - 1e-9, `toward the wall: ${nearWall.request.velocityBody.y}`);
    const atWall = blind(toRight, side(null, c.contactClearanceM));
    assert.ok(atWall.request.velocityBody.y >= 0, `at the contact clearance it no longer moves toward the wall: ${atWall.request.velocityBody.y}`);
    // Close-quarters comfort clearance (0.3 m), a left return beyond the push band: it bounds only leftward motion.
    const docking = { ...c, lateralClearanceM: 0.3 };
    const awayFromLeft = blind(toRight, side(c.contactClearanceM + c.contactPushBandM + 0.05, null), docking);
    assert.equal(awayFromLeft.request.velocityBody.y, blind(toRight, side(null, null), docking).request.velocityBody.y, "a near left side does not limit a drift to the right");
  });

  test("backward travel (nothing measures the rear) is capped: a hold drifting back to a goal behind it", () => {
    const behind = { bearingRad: Math.PI, distanceM: 0.5, heightErrorM: 0, faceBearingRad: 0 };
    const out = blind(behind, side(null, null));
    assert.equal(out.mode, "hold_face");
    assert.ok(out.request.velocityBody.x < 0 && out.request.velocityBody.x >= -c.blindSpeedMps - 1e-12, `backward ${out.request.velocityBody.x}`);
  });
});

describe("a latched range turn while turning in place", () => {
  const c = DEFAULT_COMMAND_CONFIG;
  test("with the forward reading chattering across the band edge, the turn keeps one direction until the goal is within 60° of the nose", () => {
    const mapper = new ReflexCommandMapper("flow_baseline");
    // Goal behind-left; open side to the right; the wall ahead reads alternately inside and beyond the band.
    const step = (tick: number, bearingRad: number, forwardM: number) => mapper.map({ tick, frame: null, goal: { bearingRad, distanceM: 2.7, heightErrorM: 0 }, previous: { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 }, quality: { frame: 1, poseSigmaM: 0.05 }, ranges: { forwardM, leftM: 0.5, rightM: 2.7, downM: null } }, CLEAR);
    const band = c.rangeClearanceM + c.rangeTurnHysteresisM;
    const yaws = [0.55, 0.65, 0.95, 0.62, 1.4, 0.58].map((f, k) => step(10 + 2 * k, 2.1, band + (f - 0.6)).request.yawRateRadps);
    assert.ok(yaws.every(y => y === -c.rangeTurnRateRadps), `turned right throughout: ${yaws.map(y => y.toFixed(2)).join(", ")}`);
    // The nose has come round: the goal is 40° to the right now; the latch releases and goal steering resumes.
    const released = step(40, -0.7, 3);
    assert.notEqual(released.mode, "range_turn");
    assert.ok(released.request.yawRateRadps < 0 && released.request.yawRateRadps !== -c.rangeTurnRateRadps, `goal steering: ${released.request.yawRateRadps}`);
    // A new in-place turn with the open side now to the left starts afresh (no stale latch).
    const fresh = mapper.map({ tick: 42, frame: null, goal: { bearingRad: -2.1, distanceM: 2.7, heightErrorM: 0 }, previous: { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 }, quality: { frame: 1, poseSigmaM: 0.05 }, ranges: { forwardM: band - 0.05, leftM: 2.7, rightM: 0.5, downM: null } }, CLEAR);
    assert.equal(fresh.request.yawRateRadps, c.rangeTurnRateRadps);
  });
});

describe("range-only speed with nothing ahead", () => {
  const c = DEFAULT_COMMAND_CONFIG;
  const ahead = { bearingRad: 0, distanceM: 5, heightErrorM: 0 };
  const blind = (ranges: RangeAssist | null) => new ReflexCommandMapper("flow_baseline").map({ tick: 10, frame: null, goal: ahead, previous: { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 }, quality: { frame: 0, poseSigmaM: 0.05 }, ranges }, null);

  test("no forward return while the sensor returns to the sides is clear space ahead: the range-only ceiling applies, as with a far forward return", () => {
    const clear = blind({ forwardM: null, leftM: 2.5, rightM: 7.5, downM: 1.8 });
    assert.ok(Math.abs(clear.request.velocityBody.x - c.rangeOnlySpeedMps * (0.4 + 0.6 * 1)) < 1e-9, `${clear.request.velocityBody.x}`);
    assert.equal(clear.request.velocityBody.x, blind({ forwardM: 7.9, leftM: 2.5, rightM: 7.5, downM: 1.8 }).request.velocityBody.x);
  });

  test("with no return in any sector (the sensor's view proves nothing), or no range assistance at all, it does not advance without vision", () => {
    assert.equal(blind({ forwardM: null, leftM: null, rightM: null, downM: null }).request.velocityBody.x, 0);
    assert.equal(blind(null).request.velocityBody.x, 0);
  });
});

describe("smooth-flight options (rangeKnownM, turnSpeedExponent, minPoseSpeedScale)", () => {
  const c = DEFAULT_COMMAND_CONFIG;
  const run = (config: typeof c, goal: GoalEstimate, ranges: RangeAssist | null, poseSigmaM = 0.05) =>
    new ReflexCommandMapper("flow_baseline", config).map({ tick: 10, frame: null, goal, previous: { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 }, quality: { frame: 1, poseSigmaM }, ranges }, { visualConfidence: 1, centering: 0, centeringWeight: 0, loomingRateHz: null, avoidTurn: 0 });
  const far = { bearingRad: 0, distanceM: 20, heightErrorM: 0 };
  const open: RangeAssist = { forwardM: null, leftM: 3, rightM: 3, downM: 2 };

  test("by default an unmeasured space ahead is flown at exploration speed; with rangeKnownM a lidar-clear space ahead is cruised", () => {
    assert.equal(run(c, far, open).request.velocityBody.x, c.exploreSpeedMps);
    assert.equal(run({ ...c, rangeKnownM: 3 }, far, open).request.velocityBody.x, c.cruiseSpeedMps);
    // A forward return nearer than rangeKnownM does not count as known; the range brake still limits speed.
    const near = run({ ...c, rangeKnownM: 3 }, far, { ...open, forwardM: 1.5 });
    assert.ok(near.request.velocityBody.x <= (1.5 - c.rangeClearanceM) / c.rangeBrakeTimeS + 1e-9);
  });

  test("turnSpeedExponent 0.5 keeps more speed toward a goal 60° off the nose; a goal abeam is still turned toward in place", () => {
    const off = { bearingRad: Math.PI / 3, distanceM: 20, heightErrorM: 0 };
    const stiff = run({ ...c, rangeKnownM: 3 }, off, open).request.velocityBody.x;
    const smooth = run({ ...c, rangeKnownM: 3, turnSpeedExponent: 0.5 }, off, open).request.velocityBody.x;
    assert.ok(Math.abs(stiff - 0.5 * c.cruiseSpeedMps) < 1e-9 && Math.abs(smooth - Math.SQRT1_2 * c.cruiseSpeedMps) < 1e-9, `${stiff} ${smooth}`);
    assert.equal(run({ ...c, turnSpeedExponent: 0.5 }, { bearingRad: Math.PI / 2 + 0.1, distanceM: 20, heightErrorM: 0 }, open).request.velocityBody.x, 0);
  });

  test("minPoseSpeedScale sets the speed scale at an unreliable pose estimate", () => {
    const lost = (min: number) => run({ ...c, rangeKnownM: 3, minPoseSpeedScale: min }, far, open, 5).request.velocityBody.x;
    assert.ok(Math.abs(lost(0.4) - 0.4 * c.cruiseSpeedMps) < 1e-9 && Math.abs(lost(0.75) - 0.75 * c.cruiseSpeedMps) < 1e-9);
  });
});
