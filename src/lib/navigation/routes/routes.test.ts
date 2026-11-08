import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BeliefSnapshot, RouteAssessment } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { distance, vec3 } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import { box } from "../../contracts/geometry.ts";
import type { Observation } from "../../contracts/observation.ts";
import { defaultEvidenceConfig } from "../../evidence/config.ts";
import { EvidenceStore } from "../../evidence/store.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import { assessRoute } from "./index.ts";
import { allOpeningsSeen, DRONE_IN_BEDROOM, droneReturn, evacuation, fireSeen, input, NOW, PRIOR, RUN, roomsSeenAt, STAIR_TOP_FIRE, view } from "./test-fixtures.ts";

const SEEN = NOW - 100;
const FRONT_DOOR = PRIOR.openings[0].center;
const WINDOW = PRIOR.openings[4].center;

const passesThrough = (route: RouteAssessment, point: Vec3): boolean => route.waypoints.some(w => distance(w, point) < 1e-6);
const pathLength = (route: RouteAssessment): number => route.waypoints.slice(1).reduce((sum, w, i) => sum + distance(route.waypoints[i], w), 0);

function observedHouse(overrides: Parameters<typeof allOpeningsSeen>[1] = {}, seenTick = SEEN) {
  const rooms = roomsSeenAt(seenTick);
  return { observations: rooms.observations, coverage: rooms.coverage, openings: allOpeningsSeen(seenTick, overrides) };
}

describe("route assessor: openings and travelers", () => {
  test("a closed front door: the occupant route is supported once the door is observed; the drone leaves by the broken window", () => {
    const rooms = roomsSeenAt(SEEN);
    const unobservedDoor = assessRoute(input({ ...rooms, openings: allOpeningsSeen(SEEN).filter(o => o.evidence.openingId !== "front-door") }), evacuation());
    assert.equal(unobservedDoor.status, "unknown");
    assert.match(unobservedDoor.reason, /front-door \(plan says closed; not observed\)/);

    const house = observedHouse();
    const occupant = assessRoute(input(house), evacuation());
    assert.equal(occupant.status, "supported", occupant.reason);
    assert.ok(passesThrough(occupant, FRONT_DOOR), "people open an unlocked closed door");
    assert.ok(occupant.evidenceIds.includes("opening-front-door-closed-9900"));

    const drone = assessRoute(input(house), droneReturn());
    assert.equal(drone.status, "supported", drone.reason);
    assert.ok(passesThrough(drone, WINDOW));
    assert.ok(!passesThrough(drone, FRONT_DOOR), "the aircraft cannot open the closed front door");
  });

  test("a blocked exit door leaves the occupant no route, citing the observation", () => {
    const route = assessRoute(input(observedHouse({ "front-door": "blocked" })), evacuation());
    assert.equal(route.status, "unsupported");
    assert.match(route.reason, /front-door blocked \(observed at tick 9900\)/);
    assert.deepEqual(route.waypoints, []);
    assert.ok(route.evidenceIds.includes("opening-front-door-blocked-9900"));
  });

  test("the bedroom window is passable for the drone only when broken, and never for the occupant", () => {
    const closed = assessRoute(input(observedHouse({ "window-bedroom": "closed" })), droneReturn());
    assert.equal(closed.status, "unsupported");
    assert.match(closed.reason, /window-bedroom closed/);
    assert.match(closed.reason, /front-door closed/);

    const broken = assessRoute(input(observedHouse({ "window-bedroom": "broken" })), droneReturn());
    assert.ok(passesThrough(broken, WINDOW));

    const trapped = assessRoute(input(observedHouse({ "window-bedroom": "broken", "front-door": "blocked" })), evacuation());
    assert.equal(trapped.status, "unsupported", "a broken window is not a way out for a person");
    assert.doesNotMatch(trapped.reason, /window-bedroom/);
  });

  test("a door the plan draws closed stops the drone until it is observed open", () => {
    const wrongPlan = { ...PRIOR, openings: PRIOR.openings.map(o => (o.id === "door-u" ? { ...o, priorState: "closed" as const } : o)) };
    const fromHall = droneReturn({ from: vec3(3, 3, 4.3) });
    const house = observedHouse();
    const planOnly = assessRoute(input({ ...house, openings: house.openings.filter(o => o.evidence.openingId !== "door-u"), prior: wrongPlan }), fromHall);
    assert.equal(planOnly.status, "unsupported");
    assert.match(planOnly.reason, /door-u closed \(plan; not observed\)/);
    const seenOpen = assessRoute(input({ ...house, prior: wrongPlan }), fromHall);
    assert.equal(seenOpen.status, "supported", seenOpen.reason);
  });
});

describe("route assessor: fire and the last intervention", () => {
  test("fire seen after the last intervention on the corridor makes the route unsupported and keeps the blocked path", () => {
    const fire = fireSeen("fire-after", NOW - 50);
    const route = assessRoute(input({ ...observedHouse(), fires: [fire] }, NOW - 500), evacuation());
    assert.equal(route.status, "unsupported");
    assert.match(route.reason, /fire-after/);
    assert.match(route.reason, /in hall-u/);
    assert.ok(route.evidenceIds.includes("fire-after"));
    assert.ok(route.waypoints.length > 0, "planners relate the fire to the blocked route");
  });

  test("fire away from the corridor does not block the route", () => {
    const kitchenFire = fireSeen("fire-kitchen", NOW - 50, vec3(8, 3.4, 0.3));
    const route = assessRoute(input({ ...observedHouse(), fires: [kitchenFire] }), evacuation());
    assert.equal(route.status, "supported", route.reason);
  });

  test("fire seen only before the intervention: unknown until fresh post-intervention coverage of the rooms and the fire location", () => {
    const intervention = NOW - 1000;
    const fire = fireSeen("fire-before", intervention - 200);
    const staleRooms = observedHouse({}, intervention - 100);
    const stale = assessRoute(input({ ...staleRooms, fires: [fire] }, intervention), evacuation());
    assert.equal(stale.status, "unknown", "suppression alone never makes a route usable");
    assert.match(stale.reason, /hall-u \(last observed at tick 8900, before the intervention at tick 9000\)/);
    assert.match(stale.reason, /fire seen beside the route \(tick 8800, fire-before\) needs a fresh look after the intervention at tick 9000/);

    const rooms = observedHouse({}, SEEN);
    const elsewhere = { ...rooms, observations: rooms.observations.filter(o => !o.id.startsWith("view-hall-u")) };
    const noLook = assessRoute(input({ ...elsewhere, fires: [fire] }, intervention), evacuation());
    assert.equal(noLook.status, "unknown", "room coverage elsewhere does not show the fire location");
    assert.match(noLook.reason, /needs a fresh look/);

    const look = view("look-stair-top", SEEN, box(vec3(3.5, 0, 3), vec3(6, 3, 5.8)));
    const cleared = assessRoute(input({ ...elsewhere, observations: [...elsewhere.observations, look], fires: [fire] }, intervention), evacuation());
    assert.equal(cleared.status, "supported", cleared.reason);
    assert.ok(cleared.evidenceIds.includes("look-stair-top"));
    assert.match(cleared.reason, /re-observed with no fire/);

    const tooEarly = view("look-before", intervention - 10, box(vec3(3.5, 0, 3), vec3(6, 3, 5.8)));
    // Below minCoverageQuality (0.3): a frame unusable as a whole.
    const blurry = view("look-blurry", SEEN, box(vec3(3.5, 0, 3), vec3(6, 3, 5.8)), { quality: 0.2 });
    const unhelpful = assessRoute(input({ ...elsewhere, observations: [...elsewhere.observations, tooEarly, blurry], fires: [fire] }, intervention), evacuation());
    assert.equal(unhelpful.status, "unknown", "a look before the intervention or below adequate quality cannot clear it");
  });

  test("fire evidence on the floor is cleared by a look at the air just above it, since footprints stop at the floor", () => {
    const intervention = NOW - 1000;
    const onFloor = fireSeen("fire-on-floor", intervention - 200, vec3(7.3, 2, 3), 0.35);
    const rooms = observedHouse();
    const others = rooms.observations.filter(o => !o.id.startsWith("view-bedroom"));
    const route = (lookFromZ: number) => assessRoute(input({ ...rooms, observations: [...others, view("look", SEEN, box(vec3(6.5, 1, lookFromZ), vec3(8.5, 3, 5.8)))], fires: [onFloor] }, intervention), evacuation());
    assert.equal(route(3.25).status, "supported", route(3.25).reason);
    assert.equal(route(3.5).status, "unknown", "the view must reach 0.3 m above the floor where the fire was");
  });

  test("thousands of per-frame fire sightings: the latest sighting of each place decides, quickly", () => {
    const intervention = NOW - 1000;
    const frames = Array.from({ length: 3000 }, (_, i) => fireSeen(`fire-frame-${i}`, intervention - 3000 + i, vec3(7.3 + ((i % 7) - 3) * 0.01, 2 + ((i % 5) - 2) * 0.01, 3.2), 0.3 + (i % 4) * 0.02));
    const rooms = observedHouse();
    const look = view("look", SEEN, box(vec3(6.5, 1, 3.25), vec3(8.5, 3, 5.8)));
    const scene = { ...rooms, observations: [...rooms.observations.filter(o => !o.id.startsWith("view-bedroom")), look] };
    const started = performance.now();
    const cleared = assessRoute(input({ ...scene, fires: frames }, intervention), evacuation());
    const elapsedMs = performance.now() - started;
    assert.equal(cleared.status, "supported", cleared.reason);
    assert.ok(elapsedMs < 1500, `assessment took ${elapsedMs.toFixed(0)} ms`);
    const blocked = assessRoute(input({ ...scene, fires: [...frames, fireSeen("fire-again", SEEN, vec3(7.3, 2, 3.2))] }, intervention), evacuation());
    assert.equal(blocked.status, "unsupported");
    assert.match(blocked.reason, /fire-again/);
  });

  test("a fresh look that still shows fire is new blocking evidence, not clearance", () => {
    const intervention = NOW - 1000;
    const before = fireSeen("fire-before", intervention - 200);
    const stillBurning = fireSeen("fire-still", SEEN, STAIR_TOP_FIRE, 0.2);
    const route = assessRoute(input({ ...observedHouse(), fires: [before, stillBurning] }, intervention), evacuation());
    assert.equal(route.status, "unsupported");
    assert.match(route.reason, /fire-still/);
  });
});

describe("route assessor: a fire seen out (intensity-0 sightings)", () => {
  // Regression (main E2E): the spray put the fire out, but the last flame sighting, captured after the
  // intervention, kept the evacuation route unsupported, because nothing ever reported the fire out.
  const intervention = NOW - 1000;
  const rooms = observedHouse();
  const withoutHallView = { ...rooms, observations: rooms.observations.filter(o => !o.id.startsWith("view-hall-u")) };
  const flame = fireSeen("flame-after", intervention + 5);
  const out = (id: string, tick: number, center: Vec3 = STAIR_TOP_FIRE, quality = 0.9) => fireSeen(id, tick, center, 0.3, 0, { quality });

  test("a later sighting of the same place with no flame lifts the blocker, and serves as the fresh look there", () => {
    const blocked = assessRoute(input({ ...withoutHallView, fires: [flame] }, intervention), evacuation());
    assert.equal(blocked.status, "unsupported", "the flame seen after the intervention blocks while nothing shows it out");
    const route = assessRoute(input({ ...withoutHallView, fires: [flame, out("seen-out", intervention + 20)] }, intervention), evacuation());
    assert.equal(route.status, "supported", route.reason);
    assert.ok(route.evidenceIds.includes("seen-out"));
    assert.match(route.reason, /re-observed with no fire/);
  });

  test("a no-flame sighting never blocks a route by itself", () => {
    const route = assessRoute(input({ ...rooms, fires: [out("seen-out", SEEN)] }, intervention), evacuation());
    assert.equal(route.status, "supported", route.reason);
  });

  test("a no-flame sighting elsewhere, or older than the flame, does not lift it", () => {
    const elsewhere = assessRoute(input({ ...withoutHallView, fires: [flame, out("out-elsewhere", intervention + 20, vec3(2, 3, 3.2))] }, intervention), evacuation());
    assert.equal(elsewhere.status, "unsupported", elsewhere.reason);
    const relit = fireSeen("flame-later", intervention + 30);
    const older = assessRoute(input({ ...withoutHallView, fires: [out("seen-out", intervention + 20), relit] }, intervention), evacuation());
    assert.equal(older.status, "unsupported", "a flame seen after the no-flame sighting is new blocking evidence");
    assert.match(older.reason, /flame-later/);
  });

  test("a no-flame sighting from an inadequate frame lifts the blocker but is not the look a supported route needs", () => {
    const route = assessRoute(input({ ...withoutHallView, fires: [flame, out("seen-out-blurry", intervention + 20, STAIR_TOP_FIRE, 0.2)] }, intervention), evacuation());
    assert.equal(route.status, "unknown", route.reason);
    assert.match(route.reason, /fire seen beside the route \(tick 9005, flame-after\) needs a fresh look/);
  });

  test("a look whose frame reports no flame at the spot is not mistaken for a fire sighting", () => {
    const earlier = fireSeen("flame-before", intervention - 200);
    const look = view("look-no-flame", SEEN, box(vec3(3.5, 0, 3), vec3(6, 3, 5.8)), { detections: [{ kind: "hazard", hazard: "fire", region: earlier.hazard.region, intensity: 0 }] });
    const route = assessRoute(input({ ...withoutHallView, observations: [...withoutHallView.observations, look], fires: [earlier] }, intervention), evacuation());
    assert.equal(route.status, "supported", route.reason);
    assert.ok(route.evidenceIds.includes("look-no-flame"));
  });
});

describe("route assessor: floors, coverage and duration", () => {
  test("stairs link the floors; without them the upstairs occupant has no route", () => {
    const route = assessRoute(input(observedHouse()), evacuation());
    assert.ok(passesThrough(route, vec3(5, 1, 4)) && passesThrough(route, vec3(1, 1, 1)), "stair ends, lifted 1 m, are waypoints");
    const flat = assessRoute(input({ ...observedHouse(), prior: { ...PRIOR, stairs: [] } }), evacuation());
    assert.equal(flat.status, "unsupported");
    assert.match(flat.reason, /the plan does not connect them/);
  });

  test("rooms without fresh coverage make the route unknown and are named for inspection", () => {
    const partial = roomsSeenAt(SEEN, ["bedroom", "hall-u"]);
    const old = { roomId: "hall-g", state: "observed" as const, fractionAdequate: 1, fractionAny: 1, lastObservedTick: NOW - 7000, bestModality: "rgb" as const };
    const route = assessRoute(input({ ...partial, coverage: [...partial.coverage, old], openings: allOpeningsSeen(SEEN) }), evacuation());
    assert.equal(route.status, "unknown");
    assert.match(route.reason, /hall-g \(last observed at tick 3000, more than 30 s ago\)/);
    const degraded = { ...old, state: "degraded" as const, lastObservedTick: SEEN };
    const dim = assessRoute(input({ ...partial, coverage: [...partial.coverage, degraded], openings: allOpeningsSeen(SEEN) }), evacuation());
    assert.match(dim.reason, /hall-g \(only degraded coverage/);
    assert.doesNotMatch(dim.reason, /bedroom|hall-u \(/);
  });

  test("estimated duration is the path length over the traveler's speed", () => {
    const sameRoom = assessRoute(input(observedHouse()), droneReturn({ from: vec3(1, 3, 1.2), destination: { kind: "point", point: vec3(5, 3, 1.2) }, speedMps: 2 }));
    assert.deepEqual(sameRoom.waypoints, [vec3(1, 3, 1.2), vec3(5, 3, 1.2)]);
    assert.equal(sameRoom.estimatedDurationS, 2);
    const evac = assessRoute(input(observedHouse()), evacuation());
    assert.ok(Math.abs(evac.estimatedDurationS * 0.8 - pathLength(evac)) < 1e-9);
    assert.equal(evac.assessedTick, NOW);
  });

  test("assessment is deterministic and rejects malformed requests", () => {
    const scene = observedHouse();
    assert.deepEqual(assessRoute(input(scene), evacuation()), assessRoute(input(scene), evacuation()));
    assert.throws(() => assessRoute(input(scene), evacuation({ speedMps: 0 })), RangeError);
    assert.throws(() => assessRoute(input(scene), evacuation({ from: vec3(Number.NaN, 0, 0) })), RangeError);
    const missing = assessRoute(input(scene), evacuation({ destination: { kind: "exit", exitId: "exit-roof", then: null } }));
    assert.equal(missing.status, "unsupported");
  });
});

describe("route assessor: fresh person-search coverage from the evidence store (regression: one useless frame supported a route)", () => {
  const INTERVENTION = 5000;
  const ROOMS: Record<string, Region> = {
    "hall-g": box(vec3(0, 0, 0), vec3(6, 4, 2.8)),
    kitchen: box(vec3(6.1, 0, 0), vec3(10, 4, 2.8)),
    "hall-u": box(vec3(0, 0, 3), vec3(6, 4, 5.8)),
    bedroom: box(vec3(6.1, 0, 3), vec3(10, 4, 5.8)),
  };
  const CORNERS: Record<string, Region> = {
    "hall-g": box(vec3(0, 0, 0), vec3(0.8, 0.8, 0.8)),
    kitchen: box(vec3(9.2, 3.2, 0), vec3(10, 4, 0.8)),
    "hall-u": box(vec3(0, 3.2, 3), vec3(0.8, 4, 3.8)),
    bedroom: box(vec3(9.2, 3.2, 5.0), vec3(10, 4, 5.8)),
  };
  const STATES = { "front-door": "closed", "back-door": "closed", "door-g": "open", "door-u": "open", "window-bedroom": "broken" } as const;

  function storeWith(frames: readonly Observation[]): BeliefSnapshot {
    const store = new EvidenceStore(defaultEvidenceConfig(RUN, PRIOR));
    for (const frame of frames) {
      const result = store.ingestObservation(frame, NOW);
      assert.ok(result.accepted, JSON.stringify(result));
    }
    return store.snapshot({
      tick: NOW,
      pose: { tick: NOW, position: DRONE_IN_BEDROOM, yawRad: 0, velocity: vec3(0, 0, 0), sigmaM: 0.1, yawSigmaRad: 0.02, supported: true },
      aircraft: { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 25, thrustAvailableN: 60 },
      landing: { supported: false, site: null, evidenceIds: [], reason: "fixture" },
    });
  }
  const sweep = (tick: number, regions: Record<string, Region> = ROOMS, overrides: Partial<Observation> = {}) =>
    Object.entries(regions).map(([room, region]) => view(`sweep-${room}-${tick}`, tick, region, overrides));
  const openings = (tick: number) =>
    Object.entries(STATES).map(([openingId, state]) => view(`opening-${openingId}-${tick}`, tick, null, { detections: [{ kind: "opening_state", openingId, state }] }));
  // Written against a 30 s route evidence age; the mechanism, not the default value, is under test.
  const assess = (belief: BeliefSnapshot, lastInterventionTick = INTERVENTION) => assessRoute({ belief, tick: NOW, lastInterventionTick, policy: { ...DEFAULT_POLICY, routeEvidenceMaxAgeTicks: 3000 } }, evacuation());

  test("the drone's own return needs passable openings, not rooms searched for people; an occupant's route still does", () => {
    // Openings fresh, rooms never person-searched since the intervention.
    const belief = storeWith([...openings(NOW - 50)]);
    const policy = { ...DEFAULT_POLICY, routeEvidenceMaxAgeTicks: 3000 };
    const drone = assessRoute({ belief, tick: NOW, lastInterventionTick: INTERVENTION, policy }, droneReturn());
    assert.equal(drone.status, "supported", drone.reason);
    assert.match(drone.reason, /need no person search for the drone's own passage/);
    const occupant = assessRoute({ belief, tick: NOW, lastInterventionTick: INTERVENTION, policy }, evacuation());
    assert.equal(occupant.status, "unknown");
    assert.match(occupant.reason, /rooms without fresh coverage/);
  });

  test("a pane seen broken long ago stays passable for the drone; an occupant's door seen long ago does not", () => {
    const policy = { ...DEFAULT_POLICY, routeEvidenceMaxAgeTicks: 3000 };
    // Every opening observed long ago, before the intervention, plus one fresh view of the bedroom: the drone's
    // way out through the broken bedroom pane is supported; the occupant's way through doors is not.
    const belief = storeWith([...openings(100), ...sweep(NOW - 50, { bedroom: ROOMS.bedroom })]);
    const drone = assessRoute({ belief, tick: NOW, lastInterventionTick: INTERVENTION, policy }, droneReturn());
    assert.equal(drone.status, "supported", drone.reason);
    assert.doesNotMatch(drone.reason, /window-bedroom \(last observed broken/);
    const occupant = assessRoute({ belief, tick: NOW, lastInterventionTick: INTERVENTION, policy }, evacuation());
    assert.equal(occupant.status, "unknown");
    assert.match(occupant.reason, /door-u \(last observed open at tick 100, before the intervention/);
  });

  test("token lidar frames after the intervention do not support the route", () => {
    const tokens = sweep(NOW - 50, CORNERS, { modality: "lidar", sensorId: "lidar", personSearch: null, quality: 0.05 });
    const route = assess(storeWith([...sweep(100), ...openings(100), ...tokens]));
    assert.equal(route.status, "unknown");
    assert.match(route.reason, /bedroom \(only 0% person-searched at adequate quality since the intervention at tick 5000; needs 30%\)/);
    assert.ok(!route.evidenceIds.some(id => id.startsWith("sweep-")), `cites ${route.evidenceIds.join(",")}`);
  });

  test("person-search frames glimpsing only a corner of each room are not enough either", () => {
    const route = assess(storeWith([...sweep(100), ...openings(NOW - 50), ...sweep(NOW - 50, CORNERS)]));
    assert.equal(route.status, "unknown");
    assert.match(route.reason, /hall-g \(only \d% person-searched/);
  });

  test("openings observed only before the intervention do not support the route", () => {
    const route = assess(storeWith([...sweep(100), ...openings(100), ...sweep(NOW - 50)]));
    assert.equal(route.status, "unknown");
    assert.match(route.reason, /front-door \(last observed closed at tick 100, before the intervention at tick 5000\)/);
    assert.doesNotMatch(route.reason, /rooms without fresh coverage/);
  });

  test("openings observed after the intervention but older than the evidence age limit do not support the route", () => {
    const route = assess(storeWith([...sweep(100), ...openings(2010), ...sweep(NOW - 50)]), 2000);
    assert.equal(route.status, "unknown");
    assert.match(route.reason, /front-door \(last observed closed at tick 2010, more than 30 s ago\)/);
  });

  test("fresh adequate person-search sweeps of the rooms and fresh opening states support it, citing those frames", () => {
    const route = assess(storeWith([...sweep(100), ...openings(NOW - 50), ...sweep(NOW - 50)]));
    assert.equal(route.status, "supported", route.reason);
    for (const room of ["bedroom", "hall-u", "hall-g"]) assert.ok(route.evidenceIds.includes(`sweep-${room}-${NOW - 50}`), route.evidenceIds.join(","));
    assert.ok(route.evidenceIds.includes(`opening-front-door-${NOW - 50}`));
  });
});

describe("route assessor: supersession (regression: an unrelated frame could supersede a fire sighting)", () => {
  const rooms = roomsSeenAt(SEEN);
  const base = (fire: ReturnType<typeof fireSeen>) => ({ observations: rooms.observations, coverage: rooms.coverage, openings: allOpeningsSeen(SEEN), fires: [fire] });
  const fireFrame = (): ReturnType<typeof fireSeen> => {
    const fire = fireSeen("fire-1", NOW - 20);
    return { ...fire, observation: { ...fire.observation, frameId: "thermal-frame-9" } };
  };

  test("a frame from another sensor naming the fire frame hides nothing", () => {
    const fire = fireFrame();
    const lidar = view("lidar-x", NOW - 10, null, { modality: "lidar", sensorId: "lidar-planar", frameId: "thermal-frame-9", personSearch: null, quality: 0.1, supersedes: "fire-1" });
    const route = assessRoute(input({ ...base(fire), observations: [...rooms.observations, lidar] }), evacuation());
    assert.equal(route.status, "unsupported");
    assert.ok(route.evidenceIds.includes("fire-1"));
  });

  test("a frame of the same sensor but another frame, or captured earlier, hides nothing", () => {
    const fire = fireFrame();
    for (const replacement of [
      view("other-frame", NOW - 20, null, { modality: "thermal", sensorId: "thermal-front", frameId: "thermal-frame-10", supersedes: "fire-1" }),
      view("earlier", NOW - 30, null, { modality: "thermal", sensorId: "thermal-front", frameId: "thermal-frame-9", supersedes: "fire-1" }),
      view("unframed", NOW - 20, null, { modality: "thermal", sensorId: "thermal-front", frameId: null, supersedes: "fire-1" }),
    ]) {
      const route = assessRoute(input({ ...base(fire), observations: [...rooms.observations, replacement] }), evacuation());
      assert.equal(route.status, "unsupported", replacement.id);
    }
  });

  test("a valid reprocessing of the same frame replaces its fire evidence with the replacement's", () => {
    const fire = fireFrame();
    const reprocessed = { ...fire.observation, id: "fire-1-reprocessed", arrivalTick: NOW - 5, detections: [], supersedes: "fire-1" };
    const cleared = assessRoute(input({ ...base(fire), observations: [...rooms.observations, reprocessed] }), evacuation());
    assert.equal(cleared.status, "supported", cleared.reason);
    // The replacement still seeing the fire keeps the route blocked, now citing the replacement.
    const stillFire = fireSeen("fire-1-reprocessed", NOW - 20);
    const blocked = assessRoute(input({ ...base(fire), observations: [...rooms.observations, { ...reprocessed, detections: stillFire.observation.detections }], fires: [fire, stillFire] }), evacuation());
    assert.equal(blocked.status, "unsupported");
    assert.ok(blocked.evidenceIds.includes("fire-1-reprocessed") && !blocked.evidenceIds.includes("fire-1"));
  });
});
