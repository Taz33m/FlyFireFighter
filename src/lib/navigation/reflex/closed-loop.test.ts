/**
 * Closed-loop corridor toy for the flow baseline: a unit-scale check, NOT the benchmark. The held-out
 * comparison against the trained FlyVis readout runs later in the 3D twin with the real harness.
 *
 * Toy: a 2.4 m wide textured corridor rendered by synthetic.ts at the contract camera (320×180, 90° HFOV,
 * pitched 10° down), one visual period of camera latency, a first-order plant with 3 m/s² and 6 rad/s²
 * limits at 50 Hz, a 0.25 m aircraft radius and toy localisation (the goal is computed from the toy pose;
 * localisation is not under test). The controller sees only frames, the goal, its executed command and,
 * where stated, simulated ranges from 2D ray casts (forward ±15° to 4 m, lateral 45–135° sectors to 8 m).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MotionCommand } from "../../contracts/actions.ts";
import { vec3, wrapAngle } from "../../contracts/frames.ts";
import { FlowBaselineController } from "./flow-baseline.ts";
import type { Surface } from "./synthetic.ts";
import { ceilingAt, floorAt, plane, renderFrame, wallAtX, wallAtY } from "./synthetic.ts";
import type { CameraFrame, RangeAssist } from "./types.ts";
import { RGB_FRONT_CAMERA } from "./types.ts";

const HALF_WIDTH = 1.2;
const HEIGHT = 2.6;
const RADIUS = 0.25;
const DT = 0.02;

interface Box { readonly xMin: number; readonly xMax: number; readonly yMin: number; readonly yMax: number }
interface Course { readonly surfaces: readonly Surface[]; readonly endWallX: number; readonly boxes: readonly Box[] }
interface Sample { readonly t: number; readonly x: number; readonly y: number; readonly yaw: number; readonly speed: number; readonly label: string }
interface Run { readonly samples: readonly Sample[]; readonly minClearanceM: number }

function course(endWallX: number, boxes: readonly Box[]): Course {
  const surfaces: Surface[] = [floorAt(0, 21), ceilingAt(HEIGHT, 22), wallAtY(HALF_WIDTH, 23), wallAtY(-HALF_WIDTH, 24), wallAtX(endWallX, 25)];
  boxes.forEach((b, i) => {
    surfaces.push(plane(vec3(b.xMin, b.yMin, 0), vec3(0, 1, 0), vec3(0, 0, 1), 30 + i, 0.3, { uMin: 0, uMax: b.yMax - b.yMin, vMin: 0, vMax: HEIGHT }));
    surfaces.push(plane(vec3(b.xMin, b.yMin, 0), vec3(1, 0, 0), vec3(0, 0, 1), 40 + i, 0.3, { uMin: 0, uMax: b.xMax - b.xMin, vMin: 0, vMax: HEIGHT }));
  });
  return { surfaces, endWallX, boxes };
}

/** Distance from the aircraft centre to the nearest surface, minus its radius (negative = collision). */
function clearance(c: Course, x: number, y: number): number {
  let d = Math.min(HALF_WIDTH - Math.abs(y), c.endWallX - x);
  for (const b of c.boxes) d = Math.min(d, Math.hypot(Math.max(b.xMin - x, 0, x - b.xMax), Math.max(b.yMin - y, 0, y - b.yMax)));
  return d - RADIUS;
}

function rayHit(c: Course, x: number, y: number, angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;
  if (Math.abs(dy) > 1e-9) best = Math.min(best, ((dy > 0 ? HALF_WIDTH : -HALF_WIDTH) - y) / dy);
  if (dx > 1e-9) best = Math.min(best, (c.endWallX - x) / dx);
  for (const b of c.boxes) {
    const tx = [(b.xMin - x) / dx, (b.xMax - x) / dx];
    const ty = [(b.yMin - y) / dy, (b.yMax - y) / dy];
    const enter = Math.max(Math.min(...tx), Math.min(...ty));
    const exit = Math.min(Math.max(...tx), Math.max(...ty));
    if (enter <= exit && enter > 0) best = Math.min(best, enter);
  }
  return best;
}

/** Simulated range sensor: nearest return over a sector of nine rays, null beyond its maximum range. */
function sectorRange(c: Course, x: number, y: number, yaw: number, from: number, to: number, maxM: number): number | null {
  let nearest = Infinity;
  for (let i = 0; i <= 8; i++) nearest = Math.min(nearest, rayHit(c, x, y, yaw + from + ((to - from) * i) / 8));
  return nearest <= maxM ? nearest : null;
}

function ranges(c: Course, x: number, y: number, yaw: number): RangeAssist {
  const deg = Math.PI / 180;
  return { forwardM: sectorRange(c, x, y, yaw, -15 * deg, 15 * deg, 4), leftM: sectorRange(c, x, y, yaw, 45 * deg, 135 * deg, 8), rightM: sectorRange(c, x, y, yaw, -135 * deg, -45 * deg, 8), downM: 1.2 };
}

const approach = (current: number, target: number, step: number): number => current + Math.max(-step, Math.min(step, target - current));

interface SimOptions {
  readonly start: { x: number; y: number };
  readonly goal: { x: number; y: number };
  readonly maxSteps: number;
  readonly useRanges: boolean;
  readonly stop: (s: Sample, still: number) => boolean;
  /** Point to face once the goal is reached (GoalEstimate.faceBearingRad from the toy pose). */
  readonly focus?: { x: number; y: number };
  /** Added to the reported goal distance, like the mission follower's arrival bias. */
  readonly distanceBiasM?: number;
}

function simulate(c: Course, o: SimOptions): Run {
  const controller = new FlowBaselineController();
  let { x, y } = o.start;
  let yaw = 0;
  let executed: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };
  let delivered: CameraFrame | null = null;
  let minClearanceM = Infinity;
  let stillSteps = 0;
  const samples: Sample[] = [];
  for (let k = 0; k < o.maxSteps; k++) {
    const tick = 2 * k;
    const captured = renderFrame(c.surfaces, { position: vec3(x, y, 1.2), yawRad: yaw }, { width: 320, height: 180, camera: RGB_FRONT_CAMERA, noiseSigma: 0.01, noiseSeed: 500 + k }, { frameId: `toy-${tick}`, captureTick: tick });
    const faceBearingRad = o.focus ? wrapAngle(Math.atan2(o.focus.y - y, o.focus.x - x) - yaw) : undefined;
    const goal = { bearingRad: wrapAngle(Math.atan2(o.goal.y - y, o.goal.x - x) - yaw), distanceM: Math.hypot(o.goal.x - x, o.goal.y - y) + (o.distanceBiasM ?? 0), heightErrorM: 0, faceBearingRad };
    const out = controller.step({ tick, frame: delivered, goal, previous: executed, quality: { frame: 1, poseSigmaM: 0.05 }, ranges: o.useRanges ? ranges(c, x, y, yaw) : null });
    delivered = captured;
    const r = out.request;
    executed = { velocityBody: vec3(approach(executed.velocityBody.x, r.velocityBody.x, 3 * DT), approach(executed.velocityBody.y, r.velocityBody.y, 3 * DT), 0), yawRateRadps: approach(executed.yawRateRadps, r.yawRateRadps, 6 * DT) };
    x += (Math.cos(yaw) * executed.velocityBody.x - Math.sin(yaw) * executed.velocityBody.y) * DT;
    y += (Math.sin(yaw) * executed.velocityBody.x + Math.cos(yaw) * executed.velocityBody.y) * DT;
    yaw += executed.yawRateRadps * DT;
    minClearanceM = Math.min(minClearanceM, clearance(c, x, y));
    const sample = { t: (k + 1) * DT, x, y, yaw, speed: Math.hypot(executed.velocityBody.x, executed.velocityBody.y), label: out.label };
    samples.push(sample);
    stillSteps = sample.speed < 0.02 ? stillSteps + 1 : 0;
    if (o.stop(sample, stillSteps)) break;
  }
  return { samples, minClearanceM };
}

describe("closed-loop corridor toy (unit-scale check, not the benchmark)", () => {
  test("vision only: centres in the corridor, brakes on looming and stops short of a dead end without collision", () => {
    const deadEnd = course(8, []);
    const run = simulate(deadEnd, { start: { x: 0, y: 0.5 }, goal: { x: 12, y: 0 }, maxSteps: 700, useRanges: false, stop: (_, still) => still >= 75 });
    const last = run.samples.at(-1) as Sample;
    assert.ok(run.minClearanceM > 0.2, `minimum clearance ${run.minClearanceM.toFixed(3)} m`);
    assert.ok(last.speed < 0.02, "came to rest");
    assert.ok(8 - last.x > 0.5 && 8 - last.x < 1.6, `stopped ${(8 - last.x).toFixed(2)} m before the wall`);
    const middle = run.samples.filter(s => s.x > 3 && s.x < 5.5);
    assert.ok(middle.length > 0 && middle.every(s => Math.abs(s.y) < 0.2), "centred from a 0.5 m offset");
    assert.ok(run.samples.some(s => s.label === "flow_baseline/brake_looming" && 8 - s.x > 1.5), "looming braking began more than 1.5 m out");
  });

  test("with range assistance: slows for a half-width obstacle, passes through the gap and continues without collision", () => {
    const obstacle: Box = { xMin: 4.5, xMax: 4.9, yMin: 0.1, yMax: HALF_WIDTH };
    const run = simulate(course(30, [obstacle]), { start: { x: 0, y: 0.5 }, goal: { x: 14, y: 0 }, maxSteps: 800, useRanges: true, stop: s => s.x > 7.5 });
    assert.ok(run.minClearanceM > 0.03, `minimum clearance ${run.minClearanceM.toFixed(3)} m`);
    assert.ok((run.samples.at(-1) as Sample).x > 7.5, "passed the obstacle within the step budget");
    const nearObstacle = run.samples.filter(s => s.x > 2.5 && s.x < 4.5);
    assert.ok(Math.min(...nearObstacle.map(s => s.speed)) < 0.8, "slowed on the approach");
    assert.ok(run.samples.filter(s => s.x > 4.5 && s.x < 4.9).every(s => s.y < obstacle.yMin - RADIUS), "passed beside, not through, the obstacle");
  });
});

describe("holding a reached goal facing a focus (closed loop)", () => {
  const DEG = Math.PI / 180;
  const room = course(30, []);
  const start = { x: 3, y: 0 };
  // 60° to the left of the arrival heading (+x), 3 m away; the follower's 0.12 m arrival bias is kept.
  const focus = { x: start.x + 3 * Math.cos(60 * DEG), y: start.y + 3 * Math.sin(60 * DEG) };
  const offFocus = (s: Sample) => Math.abs(wrapAngle(Math.atan2(focus.y - s.y, focus.x - s.x) - s.yaw));

  test("turns in place to face a focus 60° to the left within 3 s and stays within the 0.3 m arrival radius", () => {
    const run = simulate(room, { start, goal: start, focus, distanceBiasM: 0.12, maxSteps: 250, useRanges: false, stop: () => false });
    const faced = run.samples.find(s => offFocus(s) <= 5 * DEG);
    assert.ok(faced !== undefined && faced.t <= 3, `within 5° of the focus after ${faced?.t.toFixed(2) ?? "never"} s`);
    assert.ok(run.samples.filter(s => s.t >= faced.t).every(s => offFocus(s) <= 5 * DEG), "keeps facing it once turned");
    const drift = Math.max(...run.samples.map(s => Math.hypot(s.x - start.x, s.y - start.y)));
    assert.ok(drift <= 0.3, `stayed ${drift.toFixed(3)} m from the goal`);
    assert.ok(run.samples.some(s => s.label === "flow_baseline/hold_face"), "labelled as holding facing the focus");
  });

  test("without a focus the arrived aircraft keeps its heading (unchanged behaviour)", () => {
    const run = simulate(room, { start, goal: start, distanceBiasM: 0.12, maxSteps: 150, useRanges: false, stop: () => false });
    assert.ok(run.samples.every(s => Math.abs(s.yaw) < 1e-9 && Math.hypot(s.x - start.x, s.y - start.y) < 1e-9), "no motion at all");
    assert.ok(run.samples.slice(5).every(s => s.label === "flow_baseline/hold_arrived"));
  });
});
