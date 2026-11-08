import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VISUAL_PERIOD_TICKS } from "../../contracts/clock.ts";
import type { ControllerInput, ControllerOutput, MotionController } from "../../navigation/reflex/types.ts";
import { buildCourse, courseCalibration } from "./course.ts";
import { runCourse } from "./runner.ts";
import { tuningScore } from "./batch.ts";

// Scope: closed-loop course runs without the FlyVis service (headless renderer, harness, stepWorld):
// the truth teacher completes a course collision-free through the harness; controllers receive only
// truth-free inputs (course-calibrated frames on visual ticks, goal from the estimate, ranges only when
// range assistance is on); a controller that never moves stalls, is scored incomplete with false braking
// and earns no tuning score (stopping forever cannot win). Each run renders real frames, so this file
// takes a few seconds.

const spec = buildCourse("train", "f525c15e");

class Spy implements MotionController {
  readonly id = "spy";
  readonly source = "operator" as const;
  readonly inputs: ControllerInput[] = [];
  private readonly forward: number;
  constructor(forward: number) {
    this.forward = forward;
  }
  reset(): void {
    this.inputs.length = 0;
  }
  step(input: ControllerInput): ControllerOutput {
    this.inputs.push(input);
    return { request: { source: "operator", tick: input.tick, velocityBody: { x: this.forward, y: 0, z: 0 }, yawRateRadps: 0 }, features: {}, label: "spy/fixed" };
  }
}

describe("course runner", () => {
  test("the truth teacher completes the course without collision through the harness", async () => {
    const { metrics, eventsJsonl } = await runCourse({ spec, runId: "test-teacher", controller: null, neural: null, rangeAssist: false, driver: { kind: "teacher" } });
    assert.equal(metrics.endReason, "completed");
    assert.equal(metrics.collisions, 0);
    assert.ok(metrics.timeToGoalS !== null && metrics.timeToGoalS < spec.budgetS);
    assert.ok(metrics.finalDistanceM <= 0.6);
    assert.match(eventsJsonl, /proposal\.proposed/);
  });

  test("a controller that never moves stalls, scores incomplete with false braking and earns no tuning score", async () => {
    const spy = new Spy(0);
    const { metrics } = await runCourse({ spec, runId: "test-still", controller: spy, neural: null, rangeAssist: false, driver: { kind: "controller" }, stallS: 3 });
    assert.equal(metrics.endReason, "stall");
    assert.equal(metrics.completed, false);
    assert.equal(metrics.timeToGoalS, null);
    assert.ok(metrics.falseBrakingS > 1, `false braking ${metrics.falseBrakingS}`);
    assert.ok(tuningScore([metrics]) <= 0);
  });

  test("controllers see course-calibrated frames on visual ticks, an estimated goal, and ranges only with range assistance", async () => {
    const off = new Spy(0.3);
    await runCourse({ spec, runId: "test-off", controller: off, neural: null, rangeAssist: false, driver: { kind: "controller" }, stallS: 2 });
    const on = new Spy(0.3);
    await runCourse({ spec, runId: "test-on", controller: on, neural: null, rangeAssist: true, driver: { kind: "controller" }, stallS: 2 });
    const calibration = courseCalibration(spec).id;
    for (const input of off.inputs) {
      assert.equal(input.tick % VISUAL_PERIOD_TICKS, 0);
      assert.equal(input.frame?.calibrationId, calibration);
      assert.equal(input.ranges, null);
      assert.ok(input.goal && Number.isFinite(input.goal.bearingRad) && input.goal.distanceM > 0);
      assert.deepEqual(Object.keys(input).sort(), ["frame", "goal", "previous", "quality", "ranges", "tick"]);
    }
    assert.ok(on.inputs.some(i => i.ranges !== null && i.ranges.forwardM !== null), "range readings reach the controller when assistance is on");
  });
});
