/**
 * Door crossings on the Troy upstairs, closed loop: the path follower (steering.ts + steering-graph.ts) and the
 * shared reflex mapper with the mission's close-quarters settings fly a kinematic Tender through the real scene
 * colliders. Scope: the geometry of leaving and entering a doorway, the cases measured in the live mission
 * (a replan from a pose in the rear-bedroom doorway drew a diagonal leg past a jamb; the aircraft struck it at
 * 0.06 m/s, and on another run passed the other jamb with 3 cm to spare). Not the whole mission.
 *
 * Plant: 50 Hz, the Tender's 3 m/s² acceleration and 6 rad/s² yaw-acceleration bounds, 0.275 m collision radius.
 * The controller has no usable vision (null cues, as in the smoky indoor runs: "slow_low_vision" at the
 * range-only ceiling), range readings one step late from 2D ray casts of the planar lidar against the scene's
 * boxes (forward ±30°, left and right 60°–120°, 3° beams to 8 m, as sensors/index.ts summarizes them), and an
 * estimated pose offset from the truth by a slowly varying error of up to 5 cm. Steering sees only that
 * estimate; the ray casts and the clearance check are the test's simulated world.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { MotionCommand } from "../contracts/actions.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { calibrationFromSensor } from "../contracts/camera.ts";
import type { CommandConfig } from "../navigation/reflex/command.ts";
import { ReflexCommandMapper } from "../navigation/reflex/command.ts";
import { FlowBaselineController } from "../navigation/reflex/flow-baseline.ts";
import type { RangeAssist, ReflexCues } from "../navigation/reflex/types.ts";
import { boxProximity } from "../simulation/collisions.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";
import { parseSceneMeta } from "../simulation/scene.ts";
import { withReadNoise } from "./camera-source.ts";
import { DOCKING_COMMAND_CONFIG, MISSION_COMMAND_CONFIG } from "./controller-slot.ts";
import { HeadlessColliderRenderer } from "./headless-camera.ts";
import { troyMeta } from "./mission-driver.ts";
import { createPresetWorld, loadPreset } from "./scenario.ts";
import { PathFollower } from "./steering.ts";

const META = parseSceneMeta(JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")));
const PRIOR = floorPlanPriorFromScene(META);
const ALL_BOXES = META.colliders.map(c => ({ id: c.id, openingId: c.openingId ?? null, min: vec3(c.min[0], c.min[1], c.min[2]), max: vec3(c.max[0], c.max[1], c.max[2]) }));
/** The active colliders of the flight in progress: every box except the leaves and panes of openings it has open. */
let BOXES = ALL_BOXES;
const RADIUS = 0.275;
const CLEARANCE = RADIUS + 0.05;
const DT = 0.02;
const DEG = Math.PI / 180;

function belief(position: Vec3, yawRad: number, tick: number): BeliefSnapshot {
  return {
    runId: "r", tick, evidenceRevision: 1, mapPrior: PRIOR, mapRevision: PRIOR.revision, mapChanges: [],
    pose: { tick, position, yawRad, velocity: vec3(0, 0, 0), sigmaM: 0.05, yawSigmaRad: 0.01, supported: true },
    aircraft: { enduranceRemainingS: 800, waterRemainingL: 1, payloadsOnboard: [], ambientC: 20, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "test" },
    observations: [], reports: [], tracks: [], crewConfirmations: [], coverage: [], hazards: [], openings: [], routes: [], dispatchConfirmed: null,
  };
}

/** Distance along a horizontal ray from (x, y) at height z to the nearest box that spans z (slab method). */
function rayHit(x: number, y: number, z: number, angle: number, maxM: number): number | null {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = Infinity;
  for (const b of BOXES) {
    if (z < b.min.z || z > b.max.z) continue;
    const tx = [(b.min.x - x) / dx, (b.max.x - x) / dx];
    const ty = [(b.min.y - y) / dy, (b.max.y - y) / dy];
    const enter = Math.max(Math.min(...tx), Math.min(...ty));
    const exit = Math.min(Math.max(...tx), Math.max(...ty));
    if (enter <= exit && exit > 0) best = Math.min(best, Math.max(0, enter));
  }
  return best <= maxM ? best : null;
}

/** Downward ultrasound: from 0.06 m below the centre to the highest box top under the aircraft, null beyond 4 m. */
function downRange(p: Vec3): number | null {
  const from = p.z - 0.06;
  let top = -Infinity;
  for (const b of BOXES) if (p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && b.max.z <= from) top = Math.max(top, b.max.z);
  return from - top <= 4 ? from - top : null;
}

/** Planar-lidar sector minima in the body frame, as sensors/index.ts summarizes them, and the downward range. */
function ranges(p: Vec3, yaw: number): RangeAssist {
  const sector = (from: number, to: number): number | null => {
    let nearest: number | null = null;
    for (let a = from; a <= to + 1e-9; a += 3) {
      const r = rayHit(p.x, p.y, p.z + 0.08, yaw + a * DEG, 8);
      if (r !== null && (nearest === null || r < nearest)) nearest = r;
    }
    return nearest;
  };
  return { forwardM: sector(-30, 30), leftM: sector(60, 120), rightM: sector(-120, -60), downM: downRange(p) };
}

/** Gap between the aircraft's collision sphere and the nearest box (negative: contact). */
function gap(p: Vec3): { gapM: number; id: string } {
  let best = { gapM: Infinity, id: "" };
  for (const b of BOXES) {
    const d = boxProximity(b.min, b.max, p).distanceM - RADIUS;
    if (d < best.gapM) best = { gapM: d, id: b.id };
  }
  return best;
}

const approach = (current: number, target: number, step: number) => current + Math.max(-step, Math.min(step, target - current));

interface Flight {
  readonly minGapM: number;
  readonly nearestId: string;
  readonly reached: boolean;
  readonly seconds: number;
  readonly modes: ReadonlySet<string>;
  /** Climbs of more than 1 m from the lowest height since the previous one (the first climb included). */
  readonly climbs: number;
  readonly abortedAtWaypoint: number | null;
}

/** Openings the flight finds open (their door leaf or pane is gone and the belief has observed them open) and the exterior transit height. */
interface FlightOptions {
  readonly open?: readonly string[];
  readonly transitZ?: number | null;
  /** Usable vision with nothing looming (outdoors in clear air) instead of none (indoor smoke). */
  readonly clearVision?: boolean;
  /** Command settings (default: close quarters). */
  readonly config?: CommandConfig;
  /**
   * Waypoints flown one after another as the harness does for a route (the goal is the current one; the next once
   * the aircraft is within its 0.3 m arrival tolerance); `goal` is then the last. A waypoint with no 0.25 m
   * improvement in its distance for 15 s ends the flight as a no-progress abort.
   */
  readonly waypoints?: readonly Vec3[];
}

const CLEAR_VISION: ReflexCues = { visualConfidence: 1, centering: 0, centeringWeight: 0, loomingRateHz: null, avoidTurn: 0 };

/** The harness's route cursor (next waypoint within 0.3 m) with a per-waypoint no-progress watch (0.25 m in 15 s). */
class RouteCursor {
  index = 0;
  private best = Infinity;
  private since = 0;

  private readonly waypoints: readonly Vec3[];

  constructor(waypoints: readonly Vec3[]) {
    this.waypoints = waypoints;
  }

  get last(): boolean {
    return this.index === this.waypoints.length - 1;
  }

  update(p: Vec3, step: number): Vec3 {
    while (!this.last && distance(p, this.waypoints[this.index]) <= 0.3) {
      this.index += 1;
      this.best = Infinity;
      this.since = step;
    }
    const remaining = distance(p, this.waypoints[this.index]);
    if (remaining < this.best - 0.25) {
      this.best = remaining;
      this.since = step;
    }
    return this.waypoints[this.index];
  }

  stalled(step: number): boolean {
    return (step - this.since) * DT >= 15;
  }
}

/** Climbs: the aircraft rises 1 m above its lowest height since the previous climb ended (it then descended 0.3 m). */
class ClimbCounter {
  count = 0;
  private low: number;
  private peak: number;
  private climbing = false;

  constructor(z: number) {
    this.low = z;
    this.peak = z;
  }

  add(z: number): void {
    if (this.climbing) {
      if (z < this.peak - 0.3) {
        this.climbing = false;
        this.low = z;
      }
      this.peak = Math.max(this.peak, z);
      return;
    }
    this.low = Math.min(this.low, z);
    if (z > this.low + 1) {
      this.count += 1;
      this.climbing = true;
      this.peak = z;
    }
  }
}

function fly(start: Vec3, yaw0: number, goal: Vec3, seconds: number, options: FlightOptions = {}): Flight {
  const open = new Set(options.open ?? []);
  BOXES = ALL_BOXES.filter(b => b.openingId === null || !open.has(b.openingId));
  const openings = [...open].map(openingId => ({ openingId, state: "open" as const, tick: 1, observationId: `obs-${openingId}` }));
  const follower = new PathFollower();
  const mapper = new ReflexCommandMapper("flow_baseline", options.config ?? DOCKING_COMMAND_CONFIG);
  const route = new RouteCursor(options.waypoints ?? [goal]);
  const climbs = new ClimbCounter(start.z);
  let p = start;
  let yaw = yaw0;
  let executed: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };
  let sensed = ranges(p, yaw);
  let minGap = { gapM: Infinity, id: "" };
  const modes = new Set<string>();
  for (let k = 0; k < seconds / DT; k++) {
    const tick = 2 * k;
    // A slowly varying pose-estimate error of up to 5 cm.
    const estimate = vec3(p.x + 0.04 * Math.sin(k / 37), p.y + 0.03 * Math.cos(k / 23), p.z);
    const target = route.update(p, k);
    const end = { minGapM: minGap.gapM, nearestId: minGap.id, seconds: k * DT, modes, climbs: climbs.count };
    if (route.stalled(k)) return { ...end, reached: false, abortedAtWaypoint: route.index };
    const steer = follower.steer({ belief: { ...belief(estimate, yaw, tick), openings }, goal: target, focus: null, clearanceM: CLEARANCE, ranges: sensed, transitZ: options.transitZ ?? null });
    if (route.last && Math.hypot(goal.x - p.x, goal.y - p.y) <= 0.3 && Math.abs(goal.z - p.z) <= 0.3) return { ...end, reached: true, abortedAtWaypoint: null };
    const vision = options.clearVision === true;
    const out = mapper.map({ tick, frame: null, goal: steer.goal, previous: executed, quality: { frame: vision ? 1 : 0, poseSigmaM: 0.05 }, ranges: sensed }, vision ? CLEAR_VISION : null);
    modes.add(out.mode);
    const r = out.request;
    executed = { velocityBody: vec3(approach(executed.velocityBody.x, r.velocityBody.x, 3 * DT), approach(executed.velocityBody.y, r.velocityBody.y, 3 * DT), approach(executed.velocityBody.z, r.velocityBody.z, 3 * DT)), yawRateRadps: approach(executed.yawRateRadps, r.yawRateRadps, 6 * DT) };
    const v = executed.velocityBody;
    p = vec3(p.x + (Math.cos(yaw) * v.x - Math.sin(yaw) * v.y) * DT, p.y + (Math.sin(yaw) * v.x + Math.cos(yaw) * v.y) * DT, p.z + v.z * DT);
    yaw += executed.yawRateRadps * DT;
    sensed = ranges(p, yaw);
    const g = gap(p);
    if (g.gapM < minGap.gapM) minGap = g;
    climbs.add(p.z);
  }
  return { minGapM: minGap.gapM, nearestId: minGap.id, reached: false, seconds, modes, climbs: climbs.count, abortedAtWaypoint: null };
}

describe("door crossings on the Troy upstairs (follower + close-quarters mapper, closed loop)", () => {
  test("leaving the rear bedroom from a pose 0.12 m off-centre in its doorway, heading north-west: clears both jambs and reaches the hall", () => {
    // The measured contact: replanned here, the old leg ran diagonally past the north jamb (col-wall-u-hall-bedrooms-03).
    const run = fly(vec3(22.33, 0.43, 4.67), 2.7, vec3(20.3, 2.6, 4.8), 40);
    assert.ok(run.minGapM >= 0.04, `closest ${run.minGapM.toFixed(3)} m to ${run.nearestId}`);
    assert.ok(run.reached, "reached the hall goal");
  });

  test("entering the rear bedroom from its doorway toward the south window, heading south-east: clears the south jamb and reaches the goal", () => {
    // The measured near-miss: the old direct leg passed the south jamb (col-wall-u-hall-bedrooms-01) with 3 cm to spare.
    const run = fly(vec3(22.27, 0.47, 4.73), -0.86, vec3(24.53, -2.42, 5.05), 40);
    assert.ok(run.minGapM >= 0.04, `closest ${run.minGapM.toFixed(3)} m to ${run.nearestId}`);
    assert.ok(run.reached, "reached the window approach");
  });

  test("from the upstairs hall into the study through its 0.9 m door and back out toward the fire's corner: no contact", () => {
    const into = fly(vec3(20.8, 0.4, 4.9), Math.PI, vec3(17.5, 2.0, 5.0), 40);
    assert.ok(into.minGapM >= 0.04 && into.reached, `into the study: closest ${into.minGapM.toFixed(3)} m to ${into.nearestId}, reached ${into.reached}`);
    const out = fly(vec3(18.0, 1.6, 5.0), 0, vec3(20.5, 1.8, 4.9), 40);
    assert.ok(out.minGapM >= 0.04 && out.reached, `out to the hall: closest ${out.minGapM.toFixed(3)} m to ${out.nearestId}, reached ${out.reached}`);
  });

  test("down the stairwell from the upstairs landing to the entry hall, and back up: no contact, both goals reached", () => {
    // The staged post-suppression sweep: replanned every second from a pose partway down the stair, the path
    // went back up to the stair's top node each time and the aircraft climbed and turned round for 15 s.
    const down = fly(vec3(20.3, 3.6, 5.0), Math.PI, vec3(11.71, 6.21, 1.4), 90);
    assert.ok(down.minGapM >= 0.04, `down: closest ${down.minGapM.toFixed(3)} m to ${down.nearestId}`);
    assert.ok(down.reached, `down: reached the entry (${down.seconds.toFixed(1)} s)`);
    const up = fly(vec3(11.71, 6.21, 1.4), 0, vec3(20.3, 3.0, 5.0), 90);
    assert.ok(up.minGapM >= 0.04, `up: closest ${up.minGapM.toFixed(3)} m to ${up.nearestId}`);
    assert.ok(up.reached, `up: reached the hall (${up.seconds.toFixed(1)} s)`);
  });
});

describe("climbing the stair in lingering smoke (rendered frames, optical-flow baseline, closed loop)", () => {
  /**
   * The main run after the fire was out: the sweep sent the aircraft up from the stair foot, and it sat there for
   * 20 s. Here the real optical-flow baseline sees frames from the headless collider renderer (the runtime's own
   * renderer, with its read noise) of the Troy main world with the fire out and 0.2 /m of smoke left in every
   * room (visual confidence about 0.15), with the close-quarters settings, the path follower and the planar-lidar
   * and downward ranges of the closed loop above. It starts hovering still at the measured stall point.
   */
  test("from a standstill at the stair foot it climbs to the upstairs landing without stalling or contact", () => {
    const meta = troyMeta().meta;
    const preset = loadPreset(meta, "main", "troy-seed-1", "run-stair-test");
    const world = createPresetWorld(preset);
    for (const fire of world.fires) {
      fire.extinguished = true;
      fire.heatReleaseKW = 0;
    }
    for (const room of world.compartments) if (room.id !== "exterior") room.smokeExtinctionPerM = 0.2;
    const rgb = preset.scenario.profile.sensors.find(sensor => sensor.id === "rgb-front");
    assert.ok(rgb);
    const calibration = calibrationFromSensor(rgb, 1);
    const renderer = new HeadlessColliderRenderer(calibration);
    const controller = new FlowBaselineController({ command: DOCKING_COMMAND_CONFIG });
    const follower = new PathFollower();
    const goal = vec3(20.38, 3.55, 5.0);
    const focus = vec3(20.6, 1.5, 5.0);
    let p = vec3(14.0, 3.84, 1.4);
    let yaw = -0.3;
    let executed: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };
    let minGap = { gapM: Infinity, id: "" };
    let braked = 0;
    let steps = 0;
    let reachedS: number | null = null;
    for (let k = 0; k < 40 / DT && reachedS === null; k++) {
      const tick = 2 * k;
      const frame = withReadNoise(renderer.render(world, { frameId: `stair/${tick}`, tick, pose: { position: p, yawRad: yaw } }), calibration, "troy-seed-1", tick);
      const sensed = ranges(p, yaw);
      const v = executed.velocityBody;
      const velocity = vec3(Math.cos(yaw) * v.x - Math.sin(yaw) * v.y, Math.sin(yaw) * v.x + Math.cos(yaw) * v.y, v.z);
      const steer = follower.steer({ belief: { ...belief(p, yaw, tick), pose: { ...belief(p, yaw, tick).pose, velocity } }, goal, focus, clearanceM: CLEARANCE, ranges: sensed });
      const out = controller.step({ tick, frame, goal: steer.goal, previous: executed, quality: { frame: 0.4, poseSigmaM: 0.05 }, ranges: sensed });
      steps += 1;
      if (out.label.endsWith("brake_looming")) braked += 1;
      const r = out.request;
      executed = { velocityBody: vec3(approach(v.x, r.velocityBody.x, 3 * DT), approach(v.y, r.velocityBody.y, 3 * DT), approach(v.z, r.velocityBody.z, 3 * DT)), yawRateRadps: approach(executed.yawRateRadps, r.yawRateRadps, 6 * DT) };
      const e = executed.velocityBody;
      p = vec3(p.x + (Math.cos(yaw) * e.x - Math.sin(yaw) * e.y) * DT, p.y + (Math.sin(yaw) * e.x + Math.cos(yaw) * e.y) * DT, p.z + e.z * DT);
      yaw += executed.yawRateRadps * DT;
      const g = gap(p);
      if (g.gapM < minGap.gapM) minGap = g;
      if (Math.hypot(goal.x - p.x, goal.y - p.y) <= 0.3 && Math.abs(goal.z - p.z) <= 0.3) reachedS = (k + 1) * DT;
    }
    // About 9.4 m of path at the 0.25 m/s range-only ceiling; the measured stall took twice as long (49.6 s here).
    assert.ok(reachedS !== null && reachedS <= 32, `reached the landing after ${reachedS?.toFixed(1) ?? "never (40 s)"}`);
    assert.ok(braked / steps < 0.02, `looming braking on ${braked} of ${steps} steps`);
    assert.ok(minGap.gapM >= 0.04, `closest ${minGap.gapM.toFixed(3)} m to ${minGap.id}`);
  });
});

describe("leaving the house through the front door for home (follower + close-quarters mapper, closed loop)", () => {
  // door-front: 1.0 m wide, 2.2 m high, in the entry's east wall (x 13.532–13.882); above it the wall continues
  // (col-wall-ra-east-02 from z 2.2) and outside an entrance canopy (not in the prior) overhangs it to x 15.482 at
  // z 2.92. The return climbs to the 7 m transit height (1 m below the envelope ceiling) and flies to the launch point,
  // here all the way with the close-quarters settings and clear vision (0.4 m/s exploring), so about 42 m takes some 110 s.
  const HOME = vec3(30.5, 28.0, 1.0);
  const options = { open: ["door-front"], transitZ: 7, clearVision: true };

  test("from inside the entry hall, out through the front door and home: no contact", () => {
    const run = fly(vec3(12.6, 6.2, 1.1), 0, HOME, 260, options);
    assert.ok(run.minGapM >= 0.04, `closest ${run.minGapM.toFixed(3)} m to ${run.nearestId}`);
    assert.ok(run.reached, `reached home (${run.seconds.toFixed(1)} s)`);
  });

  test("from the doorway's outer face (the measured pose before the climb): it first moves out from the facade, then climbs, without contact", () => {
    // The live collision: from here the aircraft climbed in place 0.14 m outside the door and struck the wall above it at 0.71 m/s.
    const run = fly(vec3(13.9, 6.27, 1.1), 0.03, HOME, 260, options);
    assert.ok(run.minGapM >= 0.04, `closest ${run.minGapM.toFixed(3)} m to ${run.nearestId}`);
    assert.ok(run.reached, `reached home (${run.seconds.toFixed(1)} s)`);
  });
});

describe("the homeward return along a route's waypoints (follower + cruise mapper, closed loop)", () => {
  // The main run's return (p85): route-return's waypoints run along the east facade about 1 m out, then to the
  // launch point; the harness makes each the goal in turn. Heights are interpolated from the start toward the pad,
  // as the route's floating nodes are. Measured: each 2–8 m hop went out, up to the 7 m transit height and down
  // again, and the return was aborted for lack of progress 37 s in.
  const start = vec3(17.7, -5.6, 5.3);
  const chain = [vec3(27.25, -3.78, 0), vec3(27.25, 0.6, 0), vec3(27.25, 2.45, 0), vec3(27.25, 8.12, 0), vec3(30.5, 28.0, 0)];
  const lengths = chain.map((q, k) => Math.hypot(q.x - (k === 0 ? start.x : chain[k - 1].x), q.y - (k === 0 ? start.y : chain[k - 1].y)));
  const total = lengths.reduce((a, b) => a + b, 0);
  let along = 0;
  const waypoints = chain.map((q, k) => {
    along += lengths[k];
    return vec3(q.x, q.y, start.z + (1.0 - start.z) * (along / total));
  });

  test("from beside the house at 5.3 m to the launch point: each waypoint hop is flown without climbing back up, no hop stalls, no contact", () => {
    const run = fly(start, 0.2, waypoints[waypoints.length - 1], 240, { waypoints, transitZ: 7, clearVision: true, config: MISSION_COMMAND_CONFIG });
    assert.equal(run.abortedAtWaypoint, null, `no progress toward waypoint ${run.abortedAtWaypoint} for 15 s`);
    assert.ok(run.reached, `reached the launch point (${run.seconds.toFixed(1)} s)`);
    // At most the one climb to transit height for the final 20 m leg to the pad; none between the facade waypoints.
    assert.ok(run.climbs <= 1, `${run.climbs} climbs`);
    assert.ok(run.minGapM >= 0.04, `closest ${run.minGapM.toFixed(3)} m to ${run.nearestId}`);
  });
});
