import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "../contracts/frames.ts";
import { box, depthImage, sector } from "../contracts/geometry.ts";
import type { RoomCoverage } from "../contracts/evidence.ts";
import { FRESHNESS_RESOLUTION, searchedFractionSince } from "./coverage.ts";
import { FIXTURE_PRIOR, fixtureStore, observation, snapshotInput } from "./fixtures.ts";
import { occupancySummary } from "./summary.ts";

// Rooms are sampled on a 0.5 m grid; the upstairs rear bedroom (x 0..6, y 4..8, z 3..5.6) has 12 x 8 x 6 points.

describe("room coverage", () => {
  test("rooms move from unobserved to degraded to observed, with fractions, time and modality", () => {
    const store = fixtureStore();
    // West half of the upstairs rear bedroom (x 0..3) at adequate quality, east half only degraded (below the
    // 0.3 adequate-quality bar, which rejects frames unusable as a whole).
    store.ingestObservation(observation({ id: "rgb-1", captureTick: 100, modality: "rgb", quality: 0.9, footprint: box(vec3(-1, 3.9, 2.9), vec3(3, 8.1, 5.7)) }));
    store.ingestObservation(observation({ id: "thermal-1", captureTick: 140, modality: "thermal", quality: 0.2, footprint: box(vec3(3, 3.9, 2.9), vec3(6, 8.1, 5.7)) }));
    // The whole upstairs front bedroom, degraded.
    store.ingestObservation(observation({ id: "lidar-1", captureTick: 120, modality: "lidar", quality: 0.15, footprint: box(vec3(-1, -1, 2.9), vec3(6, 3.9, 5.7)) }));

    const coverage = new Map(store.snapshot(snapshotInput(150)).coverage.map(room => [room.roomId, room]));
    assert.deepEqual(coverage.get("f1-rear-bedroom"), { roomId: "f1-rear-bedroom", state: "observed", fractionAdequate: 0.5, fractionAny: 1, lastObservedTick: 140, bestModality: "rgb", fractionSearched: 0, searchedSince: [] });
    assert.deepEqual(coverage.get("f1-front-bedroom"), { roomId: "f1-front-bedroom", state: "degraded", fractionAdequate: 0, fractionAny: 1, lastObservedTick: 120, bestModality: "lidar", fractionSearched: 0, searchedSince: [] });
    assert.deepEqual(coverage.get("f0-kitchen"), { roomId: "f0-kitchen", state: "unobserved", fractionAdequate: 0, fractionAny: 0, lastObservedTick: null, bestModality: null, fractionSearched: 0, searchedSince: [] });
  });

  test("a footprint that reaches into a room only partly covers it, and non-spatial sensors cover nothing", () => {
    const store = fixtureStore();
    // A camera on the landing looking west through the open rear-bedroom door, 3 m range.
    store.ingestObservation(observation({ id: "rgb-door", captureTick: 100, modality: "rgb", quality: 0.8, footprint: sector(vec3(7, 6, 4.2), vec3(-1, 0, 0), 0.5, 3) }));
    store.ingestObservation(observation({ id: "imu-1", captureTick: 100, modality: "imu", footprint: null }));
    const rear = store.snapshot(snapshotInput(105)).coverage.find(room => room.roomId === "f1-rear-bedroom");
    assert.ok(rear !== undefined && rear.state === "observed");
    assert.ok(rear.fractionAdequate > 0 && rear.fractionAdequate < 0.2, `fractionAdequate ${rear.fractionAdequate}`);
    assert.equal(rear.fractionAny, rear.fractionAdequate);
  });

  test("adequate coverage of every room leaves occupancy unresolved and creates no clear state", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "sweep", captureTick: 100, quality: 0.95, footprint: box(vec3(-1, -1, -1), vec3(11, 9, 7)) }));
    const belief = store.snapshot(snapshotInput(105));
    assert.ok(belief.coverage.every(room => room.state === "observed" && room.fractionAdequate === 1));

    const summary = occupancySummary(belief);
    assert.equal(summary.occupancy, "unresolved");
    assert.deepEqual(summary.roomsByCoverage, { unobserved: [], degraded: [], observed: FIXTURE_PRIOR.rooms.map(room => room.id) });
    assert.doesNotMatch(JSON.stringify(belief) + JSON.stringify(summary), /clear/i);
  });
});

describe("person-search freshness (regression: one useless frame made a room count as freshly observed)", () => {
  const REAR = box(vec3(-1, 3.9, 2.9), vec3(7, 8.1, 5.7));
  const rear = (coverage: readonly RoomCoverage[]) => coverage.find(room => room.roomId === "f1-rear-bedroom") as RoomCoverage;

  test("only adequate-quality person-search frames refresh sample points; lidar, unsearched or dim frames do not", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "search-early", captureTick: 100, modality: "thermal", quality: 0.9, footprint: REAR }));
    // After tick 500: a whole-room lidar frame (no person search), a dim thermal frame and an unsearched RGB frame.
    store.ingestObservation(observation({ id: "lidar", captureTick: 600, modality: "lidar", quality: 0.95, footprint: REAR }));
    store.ingestObservation(observation({ id: "dim", captureTick: 610, modality: "thermal", quality: 0.2, footprint: REAR }));
    store.ingestObservation(observation({ id: "rgb-unsearched", captureTick: 620, modality: "rgb", personSearch: null, quality: 0.9, footprint: REAR }));
    const room = rear(store.snapshot(snapshotInput(700)).coverage);
    assert.equal(room.state, "observed");
    assert.equal(room.lastObservedTick, 620, "any frame still counts as a look for lastObservedTick");
    assert.equal(room.fractionSearched, 1);
    assert.equal(searchedFractionSince(room, 100), 1);
    assert.equal(searchedFractionSince(room, 101), 0, "nothing searched the room after tick 100");
    assert.equal(searchedFractionSince(room, 500), 0);
  });

  test("a frame glimpsing one corner refreshes only that corner's share of the room", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "search-early", captureTick: 100, quality: 0.9, footprint: REAR }));
    store.ingestObservation(observation({ id: "corner", captureTick: 900, quality: 0.9, footprint: box(vec3(-0.1, 3.9, 2.9), vec3(0.6, 4.6, 3.6)) }));
    const room = rear(store.snapshot(snapshotInput(950)).coverage);
    const fresh = searchedFractionSince(room, 500);
    assert.ok(fresh > 0 && fresh < 0.05, `corner share ${fresh}`);
    assert.equal(searchedFractionSince(room, 0), 1);
  });

  test("a coverage entry without a freshness profile (older beliefs) has no fresh search", () => {
    const legacy: RoomCoverage = { roomId: "r", state: "observed", fractionAdequate: 1, fractionAny: 1, lastObservedTick: 10, bestModality: "rgb" };
    assert.equal(searchedFractionSince(legacy, 0), 0);
  });

  test("the thinned profile never over-counts and under-counts by less than its resolution", () => {
    const store = fixtureStore();
    // 300 narrow person-search slices of the room at distinct ticks, in shuffled arrival order.
    const order = Array.from({ length: 300 }, (_, i) => (i * 113) % 300);
    for (const i of order) {
      const x = -0.05 + (i % 60) * 0.1;
      const z = 2.9 + Math.floor(i / 60) * 0.6;
      store.ingestObservation(observation({ id: `slice-${i}`, captureTick: 1000 + i, arrivalTick: 1400, quality: 0.9, footprint: box(vec3(x, 3.9, z), vec3(x + 0.1, 8.1, z + 0.6)) }));
    }
    const room = rear(store.snapshot(snapshotInput(1400)).coverage);
    const steps = room.searchedSince ?? [];
    assert.ok(steps.length <= 1 / FRESHNESS_RESOLUTION + 2, `${steps.length} steps`);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i].sinceTick < steps[i - 1].sinceTick && steps[i].fraction > steps[i - 1].fraction);
    // Exact answer by brute force: replay the same slices into a store and read each tick's share.
    const exact = (since: number) => {
      const probe = fixtureStore();
      for (const i of order) {
        if (1000 + i < since) continue;
        const x = -0.05 + (i % 60) * 0.1;
        const z = 2.9 + Math.floor(i / 60) * 0.6;
        probe.ingestObservation(observation({ id: `slice-${i}`, captureTick: 1000 + i, arrivalTick: 1400, quality: 0.9, footprint: box(vec3(x, 3.9, z), vec3(x + 0.1, 8.1, z + 0.6)) }));
      }
      return rear(probe.snapshot(snapshotInput(1400)).coverage).fractionSearched ?? 0;
    };
    for (const since of [1000, 1050, 1123, 1200, 1299, 1300]) {
      const reported = searchedFractionSince(room, since);
      const truth = exact(since);
      assert.ok(reported <= truth + 1e-12, `since ${since}: reported ${reported} > exact ${truth}`);
      assert.ok(truth - reported < FRESHNESS_RESOLUTION, `since ${since}: reported ${reported}, exact ${truth}`);
    }
  });
});

describe("depth-image footprints", () => {
  // A thermal camera in the landing doorway (x 6.5) looking west into the upstairs rear bedroom, 3.5 m up:
  // one cell column per metre of image, floors at the bedroom's floor (z 3).
  const view = (depth: number) =>
    depthImage({ apex: vec3(6.5, 6, 4.5), forward: vec3(-1, 0, 0), up: vec3(0, 0, 1), hfovRad: 1.6, vfovRad: 1.4, cols: 8, rows: 6, depthsM: Array(48).fill(depth), floorZM: Array(48).fill(3) });

  test("cover room points within their depth and above the floor, and searched space grows with depth", () => {
    const near = fixtureStore();
    near.ingestObservation(observation({ id: "near", captureTick: 100, quality: 0.9, footprint: view(2) }));
    const far = fixtureStore();
    far.ingestObservation(observation({ id: "far", captureTick: 100, quality: 0.9, footprint: view(6.5) }));
    const fraction = (store: ReturnType<typeof fixtureStore>) => store.snapshot(snapshotInput(105)).coverage.find(room => room.roomId === "f1-rear-bedroom")?.fractionSearched ?? 0;
    assert.ok(fraction(near) > 0 && fraction(near) < fraction(far), `near ${fraction(near)}, far ${fraction(far)}`);
    const downstairs = far.snapshot(snapshotInput(105)).coverage.find(room => room.roomId === "f0-rear-bedroom");
    assert.equal(downstairs?.fractionAny, 0, "nothing below the floor the camera looked down onto");
  });

  test("a malformed depth image is rejected at the evidence boundary", () => {
    const image = view(3);
    const store = fixtureStore();
    assert.equal(store.ingestObservation(observation({ id: "short", captureTick: 100, footprint: { ...image, depthsM: image.depthsM.slice(1) } })).accepted, false);
    assert.equal(store.ingestObservation(observation({ id: "skew", captureTick: 100, footprint: { ...image, up: vec3(0.6, 0, 0.8) } })).accepted, false, "up not orthogonal to forward");
    assert.equal(store.ingestObservation(observation({ id: "valid", captureTick: 100, footprint: image })).accepted, true);
  });
});
