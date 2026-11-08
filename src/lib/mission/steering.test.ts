import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { BeliefSnapshot, FloorPlanPrior, HazardEvidence, OpeningEvidence } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3, wrapAngle } from "../contracts/frames.ts";
import { pointInPolygon, sphere } from "../contracts/geometry.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";
import { parseSceneMeta } from "../simulation/scene.ts";
import type { MotionCommand } from "../contracts/actions.ts";
import { DEFAULT_COMMAND_CONFIG, ReflexCommandMapper } from "../navigation/reflex/command.ts";
import type { ReflexCues } from "../navigation/reflex/types.ts";
import { climbInPlace, exteriorProfile, FOLLOWER, PathFollower } from "./steering.ts";
import { findFlightPath, fireDistance, polygonDistance, spaceOf, STEERING } from "./steering-graph.ts";

const META = parseSceneMeta(JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")));
const PRIOR: FloorPlanPrior = floorPlanPriorFromScene(META);
const BROKEN_EAST: OpeningEvidence = { openingId: "win-u-rear-bedroom-east", state: "broken", tick: 10, observationId: "obs-1" };
const STANDOFF = vec3(26.788, 0.6, 5.1);
const BEDROOM = vec3(24.2, -0.66, 5.05);
const ENTRY = vec3(11.8, 6.3, 1.4);
const CLEARANCE = 0.33;

function query(from: Vec3, goal: Vec3, openings: readonly OpeningEvidence[] = [BROKEN_EAST]) {
  return { prior: PRIOR, openings, hazards: [], tick: 100, from, goal, clearanceM: CLEARANCE };
}

/** Every sample of every leg that is in a room's height band lies inside some room or is outside every footprint. */
function legsStayInFreeSpace(points: readonly Vec3[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const steps = Math.ceil(distance(points[i - 1], points[i]) / 0.1);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const p = vec3(points[i - 1].x + (points[i].x - points[i - 1].x) * t, points[i - 1].y + (points[i].y - points[i - 1].y) * t, points[i - 1].z + (points[i].z - points[i - 1].z) * t);
      const space = spaceOf(PRIOR, p);
      if (space === "exterior") continue;
      const room = PRIOR.rooms.find(r => r.id === space)!;
      // Within 0.45 m of a polygon means inside a wall's thickness: only allowed where an opening is crossed.
      if (!pointInPolygon(p.x, p.y, room.polygon) && !nearOpening(p)) return false;
    }
  }
  return true;
}

function nearOpening(p: Vec3): boolean {
  return PRIOR.openings.some(o => Math.hypot(p.x - o.center.x, p.y - o.center.y) <= o.widthM / 2 + 0.1 && Math.abs(p.z - o.center.z) <= o.heightM / 2);
}

function belief(position: Vec3, yawRad: number, openings: readonly OpeningEvidence[]): BeliefSnapshot {
  return {
    runId: "r", tick: 100, evidenceRevision: 1, mapPrior: PRIOR, mapRevision: PRIOR.revision, mapChanges: [],
    pose: { tick: 100, position, yawRad, velocity: vec3(0, 0, 0), sigmaM: 0.05, yawSigmaRad: 0.01, supported: true },
    aircraft: { enduranceRemainingS: 800, waterRemainingL: 1, payloadsOnboard: [], ambientC: 20, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "test" },
    observations: [], reports: [], tracks: [], crewConfirmations: [], coverage: [], hazards: [], openings, routes: [], dispatchConfirmed: null,
  };
}

describe("flight paths through the floor-plan prior", () => {
  test("enters the rear bedroom through the window observed broken, and not through glass observed intact", () => {
    const path = findFlightPath(query(STANDOFF, BEDROOM));
    assert.ok(path);
    assert.deepEqual(path.via, ["win-u-rear-bedroom-east"]);
    assert.ok(legsStayInFreeSpace(path.points));
    // Intact glass everywhere and the front door drawn closed: the prior offers no way in.
    assert.equal(findFlightPath(query(STANDOFF, BEDROOM, [{ ...BROKEN_EAST, state: "closed" }])), null);
  });

  test("goes from the rear bedroom to the entry hall through the bedroom door, the upstairs hall and the stairs", () => {
    const path = findFlightPath(query(BEDROOM, ENTRY));
    assert.ok(path);
    assert.deepEqual(path.via, ["door-u-rear-bedroom", "stair-main"]);
    assert.ok(legsStayInFreeSpace(path.points), JSON.stringify(path.points));
  });

  test("a door observed closed is not passable even when the plan draws it open", () => {
    const closed: OpeningEvidence = { openingId: "door-u-rear-bedroom", state: "closed", tick: 20, observationId: "obs-2" };
    assert.equal(findFlightPath(query(BEDROOM, ENTRY, [BROKEN_EAST, closed])), null);
  });

  test("outside, legs go around the building instead of through it", () => {
    const north = vec3(20, 14, 4);
    const south = vec3(20, -8, 4);
    const path = findFlightPath(query(north, south, []));
    assert.ok(path && path.points.length > 2);
    assert.ok(legsStayInFreeSpace(path.points));
    assert.ok(path.points.every(p => PRIOR.rooms.every(room => !pointInPolygon(p.x, p.y, room.polygon))));
  });
});

describe("wall clearance in the flight paths", () => {
  // Jamb corners of the rear-bedroom door (hall face x = 22.0, bedroom face x = 22.15; the door spans y 0.15–0.95).
  const JAMBS = [[22.0, 0.15], [22.0, 0.95], [22.15, 0.15], [22.15, 0.95]] as const;
  function closestToJambs(points: readonly Vec3[]): number {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
      for (let k = 0; k <= 200; k++) {
        const t = k / 200;
        const x = points[i - 1].x + (points[i].x - points[i - 1].x) * t;
        const y = points[i - 1].y + (points[i].y - points[i - 1].y) * t;
        for (const [jx, jy] of JAMBS) best = Math.min(best, Math.hypot(x - jx, y - jy));
      }
    }
    return best;
  }

  test("replanned from a pose off-centre in the doorway, the path re-centres in the door instead of cutting past a jamb", () => {
    // The measured contact: from here the direct leg to the hall ran diagonally past the north jamb.
    const start = vec3(22.33, 0.43, 4.67);
    const startGap = Math.min(...JAMBS.map(([jx, jy]) => Math.hypot(start.x - jx, start.y - jy)));
    const out = findFlightPath(query(start, ENTRY, []));
    assert.ok(out);
    // Legs are checked at 0.25 m samples, so the continuous minimum may fall a few millimetres below the bound.
    assert.ok(closestToJambs(out.points) >= Math.min(CLEARANCE, startGap) - 0.005, `closest ${closestToJambs(out.points).toFixed(3)} m to a jamb`);
    assert.deepEqual([out.points[1].x, out.points[1].y], [22.075, 0.55], "first to the door's centre");
    // Into the bedroom from the same doorway: through the bedroom-side portal, not diagonally past the south jamb.
    const inward = findFlightPath(query(vec3(22.27, 0.47, 4.73), vec3(24.53, -2.42, 5.05), []));
    assert.ok(inward && closestToJambs(inward.points) >= CLEARANCE, `inward: closest ${inward ? closestToJambs(inward.points).toFixed(3) : "no path"} m`);
  });

  test("the wall margin never makes a connected goal unreachable: a corridor narrower than twice the clearance still gets its straight leg", () => {
    const corridor: FloorPlanPrior = {
      revision: 1, source: "test", floors: [{ index: 0, elevationM: 0, ceilingM: 3 }],
      rooms: [{ id: "room-corridor", name: "Corridor", floor: 0, polygon: [[0, 0], [6, 0], [6, 0.6], [0, 0.6]], zMin: 0, zMax: 3 }],
      openings: [], exits: [], assemblyPoint: { kind: "sphere", center: vec3(20, 20, 0), radiusM: 1 },
    };
    const from = vec3(1, 0.3, 1.4);
    const goal = vec3(5, 0.3, 1.4);
    const out = findFlightPath({ prior: corridor, openings: [], hazards: [], tick: 0, from, goal, clearanceM: CLEARANCE });
    assert.ok(out, "a path, flown with the permissive rule");
    assert.deepEqual(out.points, [from, goal]);
  });

  test("outside the doorways, ordinary room legs keep at least the clearance from the walls of the Troy upstairs", () => {
    const hall = findFlightPath(query(vec3(20.8, 0.4, 4.9), vec3(17.5, 2.0, 5.0), []));
    assert.ok(hall);
    assert.deepEqual(hall.via, ["door-u-study"]);
    // The study door spans y 0.75–1.65 in the wall x 19.552–19.702.
    const studyJambs = [[19.552, 0.75], [19.552, 1.65], [19.702, 0.75], [19.702, 1.65]];
    let best = Infinity;
    for (let i = 1; i < hall.points.length; i++) {
      for (let k = 0; k <= 200; k++) {
        const t = k / 200;
        const x = hall.points[i - 1].x + (hall.points[i].x - hall.points[i - 1].x) * t;
        const y = hall.points[i - 1].y + (hall.points[i].y - hall.points[i - 1].y) * t;
        for (const [jx, jy] of studyJambs) best = Math.min(best, Math.hypot(x - jx, y - jy));
      }
    }
    assert.ok(best >= CLEARANCE, `closest ${best.toFixed(3)} m to a study jamb`);
  });
});

describe("burning fires in the flight paths", () => {
  // The hall fire as the cameras report it: a sphere on the hall floor (floor z 3.6).
  const HALL_FIRE: HazardEvidence = { observationId: "obs-fire", tick: 90, hazard: "fire", region: sphere(vec3(20.85, 2.1, 3.6), 0.4), intensity: 0.1 };
  const OUT: HazardEvidence = { ...HALL_FIRE, observationId: "obs-fire-out", tick: 95, intensity: 0 };
  const withFire = (from: Vec3, goal: Vec3, hazards: readonly HazardEvidence[] = [HALL_FIRE]) => findFlightPath({ ...query(from, goal, []), hazards });
  /** Closest sampled approach of the path to the fire or the hot column above it. */
  const closestToFire = (points: readonly Vec3[]) => {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
      for (let k = 0; k <= 100; k++) {
        const t = k / 100;
        best = Math.min(best, fireDistance([HALL_FIRE], vec3(points[i - 1].x + (points[i].x - points[i - 1].x) * t, points[i - 1].y + (points[i].y - points[i - 1].y) * t, points[i - 1].z + (points[i].z - points[i - 1].z) * t)));
      }
    }
    return best;
  };

  test("the hot column counts: 0.6 m above the fire is inside its clearance, 1 m beside the column is not", () => {
    assert.equal(fireDistance([HALL_FIRE], vec3(20.98, 2.37, 4.2)), 0, "over the fire at the measured 4.2 m");
    assert.ok(fireDistance([HALL_FIRE], vec3(20.85, 2.1, 3.6 + 0.4 + STEERING.fireColumnM + 0.5)) <= 0.5 + 1e-9, "the column reaches fireColumnM above the region");
    assert.ok(fireDistance([HALL_FIRE], vec3(20.85 + 0.4 + 1.05, 2.1, 4.6)) >= STEERING.fireClearanceM);
  });

  test("the measured overflight is refused: with the hall fire across the hall's width there is no path south past it, not a leg over it", () => {
    // Staged spray run: the aircraft flew south along x ≈ 21.0 over the fire at z ≈ 4.2 (ambient 99 °C).
    assert.equal(withFire(vec3(21.01, 3.12, 4.2), vec3(21.075, 0.55, 4.65)), null);
    assert.equal(withFire(vec3(20.3, 3.76, 4.8), vec3(21.075, 0.55, 4.65)), null);
    // The same leg without the fire, or once the fire is seen out, is planned as before.
    assert.ok(withFire(vec3(20.3, 3.76, 4.8), vec3(21.075, 0.55, 4.65), []));
    assert.ok(withFire(vec3(20.3, 3.76, 4.8), vec3(21.075, 0.55, 4.65), [HALL_FIRE, OUT]), "a later intensity-0 sighting at the same place reports it out");
  });

  test("a spray standoff on the clearance boundary beside the study door is reached through the door's centre, never nearer the fire", () => {
    const standoff = vec3(19.95, 0.9, 4.6);
    assert.ok(fireDistance([HALL_FIRE], standoff) >= STEERING.fireClearanceM);
    const path = withFire(vec3(18.0, 1.2, 5.0), standoff);
    assert.ok(path);
    assert.ok(closestToFire(path.points) >= STEERING.fireClearanceM - 0.01, `closest ${closestToFire(path.points).toFixed(3)} m`);
  });

  test("from a pose over the fire the aircraft may leave, away from it, but a goal inside the clearance has no path", () => {
    const over = vec3(20.9, 2.3, 4.2);
    const out = withFire(over, vec3(16.0, 3.76, 4.8));
    assert.ok(out, "a way out to the landing");
    const second = out.points[1];
    assert.ok(fireDistance([HALL_FIRE], second) >= STEERING.fireClearanceM, "the first leg ends clear of the fire");
    assert.equal(withFire(vec3(16.0, 3.76, 4.8), vec3(20.98, 2.37, 4.2)), null, "no path to a goal over the fire");
  });

  test("the follower holds instead of flying a straight line past a fire when the prior offers no path", () => {
    const follower = new PathFollower();
    const at = vec3(21.01, 3.12, 4.2);
    const out = follower.steer({ belief: { ...belief(at, -Math.PI / 2, []), hazards: [HALL_FIRE] }, goal: vec3(21.075, 0.55, 4.65), focus: null, clearanceM: CLEARANCE });
    assert.ok(distance(out.target, at) < 1e-9, `target ${JSON.stringify(out.target)}`);
    assert.ok(out.goal.distanceM <= FOLLOWER.arrivalBiasM + 1e-9, "reports itself at its goal: hold");
  });
});

describe("stairs in the flight paths", () => {
  // stair-main: bottom (14.232, 3.757, 0), top (19.552, 3.757, 3.6), flown 1.2 m above the treads.
  const TOP = vec3(19.552, 3.757, 4.8);
  const BOTTOM = vec3(14.232, 3.757, 1.2);

  test("replanned from partway down the stair, the path continues down it instead of climbing back to the top node", () => {
    // The measured stall: the follower replans every second, and each plan from a pose on the stair began at its top node.
    const onStair = vec3(18.93, 3.79, 3.79);
    const down = findFlightPath(query(onStair, ENTRY, []));
    assert.ok(down);
    assert.deepEqual(down.points[1], BOTTOM, `first leg to ${JSON.stringify(down.points[1])}`);
    assert.ok(!down.points.some(p => distance(p, TOP) < 1e-9), "never back up to the top node");
    const up = findFlightPath(query(onStair, vec3(20.3, 3.0, 5.0), []));
    assert.ok(up);
    assert.ok(up.points[1].z > onStair.z && !up.points.some(p => distance(p, BOTTOM) < 1e-9), "going up, it climbs on and never goes down first");
  });

  test("a pose far above the stair's line is not on it: it uses the stair's end nodes as before", () => {
    // Over the landing 1.7 m above the hover line (high in the upstairs hall, near the stair top): reaches the bottom via the top node.
    const above = findFlightPath(query(vec3(19.0, 3.757, 6.13), ENTRY, []));
    assert.ok(above && above.points.some(p => distance(p, TOP) < 1e-9));
  });

  test("climbing, a pose 0.9 m above the hover line is still on the stair: the path goes on up, not back to the bottom node", () => {
    // Measured in the rendered closed loop: tracking its pursuit target ahead and above, the aircraft rose 0.87 m above the line.
    const high = findFlightPath(query(vec3(15.24, 3.76, 2.75), vec3(20.38, 3.55, 5.0), []));
    assert.ok(high && !high.points.some(p => distance(p, BOTTOM) < 1e-9), JSON.stringify(high?.points));
  });

  test("at the stair foot, 0.23 m short of the bottom node and 0.27 m above it, the follower flies on up the stair instead of dropping onto the node", () => {
    // The measured stall: every other replan read that short leg as a descent in place (goal 0.22 m away, hold), the next climbed again.
    const out = new PathFollower().steer({ belief: belief(vec3(14.0, 3.84, 1.47), -0.3, []), goal: vec3(20.38, 3.55, 5.0), focus: vec3(20.6, 1.5, 5.0), clearanceM: CLEARANCE });
    assert.ok(out.goal.distanceM > 5, `goal distance ${out.goal.distanceM.toFixed(2)} m`);
    assert.ok(out.target.x > 14.232, `steering toward ${JSON.stringify(out.target)}`);
  });
});

describe("exterior climbs and descents keep clear of the facade", () => {
  const OPEN_FRONT: OpeningEvidence = { openingId: "door-front", state: "open", tick: 10, observationId: "obs-front" };
  const HOME = vec3(30.5, 28.0, 1.0);
  const facade = (p: Vec3) => Math.min(...PRIOR.rooms.map(room => polygonDistance(room.polygon, p.x, p.y)));
  /** The plumb (climb or descent) legs of a profile. */
  const plumbLegs = (points: readonly Vec3[]) => points.slice(1).map((q, k) => [points[k], q] as const).filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 && Math.abs(b.z - a.z) > 0.25);

  test("leaving through the front door for home, the climb to transit height happens at least facadeClearanceM from the building, after a level move out", () => {
    // Measured: the climb in place right outside the door struck the wall above it (and would meet the entrance canopy).
    const path = findFlightPath(query(vec3(12.6, 6.2, 1.1), HOME, [OPEN_FRONT]));
    assert.ok(path);
    const profile = exteriorProfile(path.points, PRIOR, 7);
    const climbs = plumbLegs(profile);
    assert.ok(climbs.length >= 1);
    for (const [a] of climbs) assert.ok(facade(a) >= FOLLOWER.facadeClearanceM - 1e-9, `climb at ${JSON.stringify(a)}, ${facade(a).toFixed(2)} m from the building`);
    const climbAt = profile.indexOf(climbs[0][0]);
    assert.ok(Math.abs(profile[climbAt].z - profile[climbAt - 1].z) < 1e-9, "the move out to the climb point is level");
  });

  test("a climb in place over an exterior start beside the facade moves out first; one already clear stays where it is", () => {
    const beside = climbInPlace([vec3(14.02, 6.27, 1.1), vec3(20, 14, 4)], PRIOR);
    assert.ok(facade(beside[1]) >= FOLLOWER.facadeClearanceM - 1e-9 && beside[1].z === 1.1, `moved out level to ${JSON.stringify(beside[1])}`);
    assert.deepEqual([beside[2].x, beside[2].y, beside[2].z], [beside[1].x, beside[1].y, 4]);
    const open = climbInPlace([vec3(30, 20, 0.5), vec3(20, 14, 4)], PRIOR);
    assert.deepEqual(open, [vec3(30, 20, 0.5), vec3(30, 20, 4), vec3(20, 14, 4)]);
  });

  test("coming home to a window standoff, the descent from transit height happens out from the facade and the last metres are level", () => {
    const standoff = vec3(18.2, -3.32, 5.1);
    const path = findFlightPath(query(vec3(30.5, 28.0, 3), standoff, []));
    assert.ok(path);
    const profile = exteriorProfile(path.points, PRIOR, 7);
    for (const [a, b] of plumbLegs(profile)) assert.ok(facade(a) >= FOLLOWER.facadeClearanceM - 1e-9, `vertical leg ${JSON.stringify(a)} → ${b.z} ${facade(a).toFixed(2)} m from the building`);
    assert.equal(profile.at(-1)?.z, 5.1);
    assert.equal(profile.at(-2)?.z, 5.1, "flies in level at the standoff's height");
  });
});

describe("path follower", () => {
  test("steers toward the window approach line and reports the remaining path length plus the arrival bias", () => {
    const follower = new PathFollower();
    // Outside the east window, offset sideways; the goal is inside the bedroom.
    const out = follower.steer({ belief: belief(vec3(28, 1.4, 5.1), Math.PI, [BROKEN_EAST]), goal: BEDROOM, focus: null, clearanceM: CLEARANCE });
    assert.deepEqual(out.via, ["win-u-rear-bedroom-east"]);
    assert.ok(out.remainingM > distance(vec3(28, 1.4, 5.1), BEDROOM) - 1e-9);
    assert.ok(Math.abs(out.goal.distanceM - (out.remainingM + FOLLOWER.arrivalBiasM)) < 1e-9);
    // Facing west (yaw π) with the path's next point to the south-west of the aircraft: steer left of the nose is
    // positive bearing; the window line y = 0.6 is to the aircraft's left (south) when facing west.
    assert.ok(out.goal.bearingRad > 0, `bearing ${out.goal.bearingRad}`);
  });

  test("with a focus, the aircraft approaches its goal from the side away from the focus", () => {
    const follower = new PathFollower();
    const goal = vec3(28.43, 0.6, 5.1);
    const focus = vec3(24.2, -0.66, 5.05);
    const out = follower.steer({ belief: belief(vec3(30.5, 20, 3), -Math.PI / 2, []), goal, focus, clearanceM: CLEARANCE });
    // The approach point lies 1 m beyond the goal, away from the focus, so the final leg points at the room.
    assert.ok(out.remainingM > distance(vec3(30.5, 20, 3), goal));
  });
});

describe("holding a station facing the focus (follower + shared mapper, closed loop)", () => {
  const DEG = Math.PI / 180;
  // Clear, steady vision with nothing looming: what the mapper sees while hovering in open air.
  const CLEAR: ReflexCues = { visualConfidence: 1, centering: 0, centeringWeight: 0, loomingRateHz: null, avoidTurn: 0 };
  const approach = (current: number, target: number, step: number) => current + Math.max(-step, Math.min(step, target - current));

  /** 50 Hz kinematic plant (3 m/s², 6 rad/s² limits) driven by the follower's goal estimate from the estimated pose. */
  function hold(o: { start: Vec3; goal: Vec3; focus: Vec3 | null; arrivalRadiusM: number; seconds: number }) {
    const follower = new PathFollower();
    const mapper = new ReflexCommandMapper("flow_baseline", { ...DEFAULT_COMMAND_CONFIG, arrivalRadiusM: o.arrivalRadiusM });
    let p = o.start;
    let yaw = 0;
    let executed: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };
    const samples: { t: number; p: Vec3; yaw: number; mode: string; face: number | null }[] = [];
    for (let k = 0; k < o.seconds * 50; k++) {
      const steer = follower.steer({ belief: { ...belief(p, yaw, []), tick: 100 + 2 * k }, goal: o.goal, focus: o.focus, clearanceM: CLEARANCE });
      const out = mapper.map({ tick: 100 + 2 * k, frame: null, goal: steer.goal, previous: executed, quality: { frame: 1, poseSigmaM: 0.05 }, ranges: null }, CLEAR);
      const r = out.request;
      executed = { velocityBody: vec3(approach(executed.velocityBody.x, r.velocityBody.x, 0.06), approach(executed.velocityBody.y, r.velocityBody.y, 0.06), 0), yawRateRadps: approach(executed.yawRateRadps, r.yawRateRadps, 0.12) };
      const v = executed.velocityBody;
      p = vec3(p.x + (Math.cos(yaw) * v.x - Math.sin(yaw) * v.y) * 0.02, p.y + (Math.sin(yaw) * v.x + Math.cos(yaw) * v.y) * 0.02, p.z);
      yaw += executed.yawRateRadps * 0.02;
      const face = o.focus === null ? null : Math.abs(wrapAngle(Math.atan2(o.focus.y - p.y, o.focus.x - p.x) - yaw));
      samples.push({ t: (k + 1) * 0.02, p, yaw, mode: out.mode, face });
    }
    return samples;
  }

  // Open air east of the house on the Troy prior, arrived heading east (+x); the focus is 60° to the left, 2 m away.
  const station = vec3(30, 4, 3);
  const focus = vec3(station.x + 2 * Math.cos(60 * DEG), station.y + 2 * Math.sin(60 * DEG), 3);

  test("the follower reports the focus as the face bearing, and none without a focus", () => {
    const follower = new PathFollower();
    const out = follower.steer({ belief: belief(station, 0, []), goal: station, focus, clearanceM: CLEARANCE });
    assert.ok(Math.abs((out.goal.faceBearingRad ?? NaN) - 60 * DEG) < 1e-9);
    const none = new PathFollower().steer({ belief: belief(station, 0, []), goal: station, focus: null, clearanceM: CLEARANCE });
    assert.equal(none.goal.faceBearingRad, null);
  });

  test("arrived with a focus 60° to the left: within 5° of it within 3 s, inside the 0.3 m arrival radius throughout", () => {
    const samples = hold({ start: station, goal: station, focus, arrivalRadiusM: 0.3, seconds: 4 });
    const faced = samples.find(s => (s.face ?? Infinity) <= 5 * DEG);
    assert.ok(faced !== undefined && faced.t <= 3, `faced after ${faced?.t ?? "never"} s`);
    assert.ok(samples.filter(s => s.t >= faced.t).every(s => (s.face ?? Infinity) <= 5 * DEG));
    assert.ok(samples.every(s => distance(s.p, station) <= 0.3));
  });

  test("with close-quarters settings (0.15 m arrival radius) and 0.2 m of drift, it returns to the goal while facing the focus", () => {
    const start = vec3(station.x - 0.2, station.y, station.z);
    const samples = hold({ start, goal: station, focus, arrivalRadiusM: 0.15, seconds: 4 });
    const faced = samples.find(s => (s.face ?? Infinity) <= 5 * DEG);
    assert.ok(faced !== undefined && faced.t <= 3, `faced after ${faced?.t ?? "never"} s`);
    assert.ok(samples.every(s => distance(s.p, station) <= 0.3), "never farther than the harness's arrival tolerance");
    const last = samples.at(-1)!;
    assert.ok(distance(last.p, station) < 0.1, `settled ${distance(last.p, station).toFixed(3)} m from the goal`);
  });

  test("without a focus the arrived aircraft keeps its heading", () => {
    const samples = hold({ start: station, goal: station, focus: null, arrivalRadiusM: 0.3, seconds: 2 });
    assert.ok(samples.every(s => s.yaw === 0 && distance(s.p, station) < 1e-12 && s.mode === "hold_arrived"));
  });
});
