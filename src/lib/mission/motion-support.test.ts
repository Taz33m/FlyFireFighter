/**
 * Mission-side motion support around the reflex controller: the exterior height profile, the range-blocked
 * detour, the stale looming-memory re-sense and the measured motion handed to the controller. Scope: these
 * helpers in isolation on the Troy prior; the closed loop is exercised by the end-to-end mission test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { vec3 } from "../contracts/frames.ts";
import type { ControllerInput } from "../navigation/reflex/types.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";
import { parseSceneMeta } from "../simulation/scene.ts";
import { DOCKING_COMMAND_CONFIG, MISSION_COMMAND_CONFIG, measuredMotion } from "./controller-slot.ts";
import { DETOUR, RangeDetour } from "./detour.ts";
import { STALL, StallMonitor } from "./stall.ts";
import { exteriorProfile, FOLLOWER } from "./steering.ts";
import { polygonDistance } from "./steering-graph.ts";

const META = parseSceneMeta(JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")));
const PRIOR = floorPlanPriorFromScene(META);
const LAUNCH = vec3(30.5, 28, 0.1);
const APPROACH = vec3(27.8, 0.6, 5.1);
const STANDOFF = vec3(26.8, 0.6, 5.1);

describe("exterior height profile", () => {
  test("a long exterior transit climbs in place to the transit height, flies level and descends clear of the facade before its end", () => {
    const points = exteriorProfile([LAUNCH, APPROACH, STANDOFF], PRIOR, 7);
    assert.deepEqual(points[1], vec3(LAUNCH.x, LAUNCH.y, 7));
    // APPROACH is 1.4 m from the bedroom's outline: the descent happens facadeClearanceM out, then level in to it.
    const facade = (x: number, y: number) => Math.min(...PRIOR.rooms.map(room => polygonDistance(room.polygon, x, y)));
    assert.equal(points[2].z, 7);
    assert.ok(facade(points[2].x, points[2].y) >= FOLLOWER.facadeClearanceM - 1e-9, `descent ${facade(points[2].x, points[2].y).toFixed(2)} m from the building`);
    assert.deepEqual(points[3], vec3(points[2].x, points[2].y, APPROACH.z));
    assert.deepEqual(points[4], APPROACH);
    // Every leg is either vertical or level: no slanted leg that could rise into an overhang.
    for (let i = 1; i < points.length; i++) {
      const horizontal = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      assert.ok(horizontal < 1e-9 || Math.abs(points[i].z - points[i - 1].z) < 1e-9 || i === points.length - 1, `leg ${i} is slanted`);
    }
  });

  test("without a transit height the climb still happens over the start, and short exterior hops stay level", () => {
    assert.deepEqual(exteriorProfile([LAUNCH, APPROACH], PRIOR, null), [LAUNCH, vec3(LAUNCH.x, LAUNCH.y, APPROACH.z), APPROACH]);
    const hop = [vec3(27.8, 0.6, 5.1), vec3(27.8, 3.0, 5.1)];
    assert.deepEqual(exteriorProfile(hop, PRIOR, 7), hop);
  });
});

describe("range-blocked detour", () => {
  const blocked = { tick: 100, pose: vec3(29.7, 10.8, 5), yawRad: -Math.PI / 2, bearingRad: 0.05, remainingM: 12, vertical: false, inOpenSpace: true };

  test("an obstacle reading on the path ahead sidesteps toward the open side, then passes it on the original heading", () => {
    const detour = new RangeDetour();
    // Facing south (−y): left is east (+x). The left sector has no return, the right one sees a wall at 3 m.
    const step = detour.update({ ...blocked, ranges: { forwardM: 1.0, leftM: null, rightM: 3 } });
    assert.ok(step !== null);
    assert.ok(Math.abs(step.x - (blocked.pose.x + DETOUR.offsetM)) < 1e-9 && Math.abs(step.y - blocked.pose.y) < 1e-9, JSON.stringify(step));
    // Reaching the sidestep hands over to the pass point, south of the obstacle.
    const pass = detour.update({ ...blocked, tick: 200, pose: step, ranges: { forwardM: null, leftM: null, rightM: null } });
    assert.ok(pass !== null && pass.y < blocked.pose.y - 1.0 - DETOUR.passM + 1e-9);
  });

  test("no detour when the reading is far, the goal is just in front of it, the leg is vertical, neither side has room or it is near the building", () => {
    const far = new RangeDetour().update({ ...blocked, ranges: { forwardM: DETOUR.triggerM + 0.5, leftM: null, rightM: null } });
    const arriving = new RangeDetour().update({ ...blocked, remainingM: 1.2, ranges: { forwardM: 1.0, leftM: null, rightM: null } });
    const climbing = new RangeDetour().update({ ...blocked, vertical: true, ranges: { forwardM: 1.0, leftM: null, rightM: null } });
    const boxedIn = new RangeDetour().update({ ...blocked, ranges: { forwardM: 1.0, leftM: 1.2, rightM: 1.5 } });
    const nearBuilding = new RangeDetour().update({ ...blocked, inOpenSpace: false, ranges: { forwardM: 1.0, leftM: null, rightM: null } });
    assert.deepEqual([far, arriving, climbing, boxedIn, nearBuilding], [null, null, null, null, null]);
  });
});

describe("stale looming memory", () => {
  function input(tick: number, forwardM: number | null, speed = 0): ControllerInput {
    return { tick, frame: null, goal: { bearingRad: 0.1, distanceM: 3, heightErrorM: 0 }, previous: { velocityBody: vec3(speed, 0, 0), yawRateRadps: 0 }, quality: { frame: 1, poseSigmaM: 0.05 }, ranges: { forwardM, leftM: null, rightM: null, downM: 2 } };
  }
  const held = { freeDistanceM: 0.8, freeDistanceKnown: 1 };
  const { stopDistanceM, arrivalRadiusM } = MISSION_COMMAND_CONFIG;

  test("a hover held by a looming distance the forward range contradicts re-senses after the hold time, rate limited", () => {
    const monitor = new StallMonitor();
    const reasons: (string | null)[] = [];
    for (let tick = 0; tick < STALL.ticks + STALL.minRepeatTicks; tick += 2) reasons.push(monitor.update(input(tick, 2.5), held, stopDistanceM, arrivalRadiusM));
    const fired = reasons.filter(r => r !== null);
    assert.equal(fired.length, 1, "one reset per hold period and repeat interval");
    assert.match(String(fired[0]), /forward range 2\.50 m/);
  });

  test("no re-sense when the forward range confirms the obstacle, while moving, or when the distance is not held", () => {
    const run = (make: (tick: number) => ControllerInput, features = held) => {
      const monitor = new StallMonitor();
      let any = false;
      for (let tick = 0; tick <= 3 * STALL.ticks; tick += 2) any = monitor.update(make(tick), features, stopDistanceM, arrivalRadiusM) !== null || any;
      return any;
    };
    assert.equal(run(t => input(t, 0.9)), false, "range agrees: a real obstacle");
    assert.equal(run(t => input(t, 2.5, 0.3)), false, "moving: looming is being measured");
    assert.equal(run(t => input(t, 2.5), { freeDistanceM: 3, freeDistanceKnown: 1 }), false);
  });

  test("docking braking stops inside the glass breaker's reach (less the margin) but outside the collision radius", () => {
    const radius = 0.55 / 2;
    for (const brake of [DOCKING_COMMAND_CONFIG.stopDistanceM, DOCKING_COMMAND_CONFIG.rangeClearanceM]) assert.ok(brake > radius && brake < 0.45 - 0.08, `${brake}`);
    assert.ok(MISSION_COMMAND_CONFIG.stopDistanceM > 0.45, "cruise braking would stop out of reach");
  });
});

describe("measured motion for the controller", () => {
  test("the gyro yaw rate and the estimated velocity in the body frame replace the command; the command fills gaps", () => {
    const command = { velocityBody: vec3(1, 0, 0), yawRateRadps: 0.45 };
    const measured = measuredMotion(command, 0.01, vec3(0, -0.5, 0), -Math.PI / 2);
    assert.ok(Math.abs(measured.yawRateRadps - 0.01) < 1e-12);
    assert.ok(Math.abs(measured.velocityBody.x - 0.5) < 1e-9 && Math.abs(measured.velocityBody.y) < 1e-9);
    assert.deepEqual(measuredMotion(command, null, null, 0), command);
  });
});
