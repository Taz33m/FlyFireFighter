import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { distance, vec3 } from "../contracts/frames.ts";
import { EvidenceRejection } from "./errors.ts";
import type { EvidenceErrorCode } from "./errors.ts";
import { FIXTURE_RUN, fixtureStore, observation, person, snapshotInput } from "./fixtures.ts";
import type { EvidenceStore } from "./store.ts";

const t = (n: number) => `${FIXTURE_RUN}/t${n}`;
const tracksAt = (store: EvidenceStore, tick: number) => store.snapshot(snapshotInput(tick)).tracks;
const rejectedWith = (code: EvidenceErrorCode) => (error: unknown) => error instanceof EvidenceRejection && error.code === code;

// Default gate: max(noise, min(3 m, noise + 1.2 m/s x seconds between sightings)), noise = 3.5 x hypot(track, detection uncertainty).
// Fixture detections have 0.3 m uncertainty unless stated. z = 3.9 m is floor 1; z = 1.0 m is floor 0.

describe("possible-occupant association", () => {
  test("one person seen twice while moving within the gate is one track holding both sightings", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(2, 6, 3.9, { uncertaintyM: 0.4 })] }));
    // 1 s later and 1.1 m away; the gate is 3.5 x 0.57 + 1.2 = 3 m (capped).
    const second = store.ingestObservation(observation({ id: "o2", captureTick: 1100, detections: [person(3, 6.5, 3.9, { uncertaintyM: 0.4, confidence: 0.5 })] }));
    assert.ok(second.accepted);
    assert.deepEqual(second.tracks.map(change => change.change), ["associated"]);

    const tracks = tracksAt(store, 1105);
    assert.equal(tracks.length, 1);
    const [track] = tracks;
    assert.deepEqual(track.observationIds, ["o1", "o2"]);
    // The position fuses both sightings; after 1 s the occupant may have moved 1.2 m, so it follows the newer one closely.
    assert.ok(distance(track.position, vec3(3, 6.5, 3.9)) < 0.15, JSON.stringify(track.position));
    assert.ok(distance(track.position, vec3(3, 6.5, 3.9)) < distance(track.position, vec3(2, 6, 3.9)));
    assert.equal(track.roomId, "f1-rear-bedroom");
    assert.deepEqual([track.firstSeenTick, track.lastSeenTick], [1000, 1100]);
    assert.equal(track.confidence, 0.6, "a weaker later sighting does not lower the indication");
    assert.equal(track.uncertaintyM, 0.4);
  });

  test("a sighting beyond the speed-bounded gate starts a separate track", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(1, 6, 3.9)] }));
    // 0.5 s later and 2.5 m away; the gate is only 3.5 x 0.42 + 0.6 = 2.1 m.
    store.ingestObservation(observation({ id: "o2", captureTick: 1050, detections: [person(3.5, 6, 3.9)] }));
    const tracks = tracksAt(store, 1055);
    assert.deepEqual(tracks.map(track => track.observationIds), [["o1"], ["o2"]]);
    assert.ok(tracks.every(track => track.ambiguousWith.length === 0));
  });

  test("two simultaneous far-apart detections are two tracks", () => {
    const store = fixtureStore();
    const result = store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(1, 5, 3.9), person(8, 2, 3.9)] }));
    assert.ok(result.accepted);
    assert.deepEqual(result.tracks.map(change => [change.trackId, change.change]), [[t(1), "created"], [t(2), "created"]]);
    const tracks = tracksAt(store, 1005);
    assert.deepEqual(tracks.map(track => track.roomId), ["f1-rear-bedroom", "f1-landing"]);
    assert.ok(tracks.every(track => track.status === "possible" && track.ambiguousWith.length === 0));
  });

  test("two detections in one frame near one track are not folded into it", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(2, 6, 3.9)] }));
    // Both are 0.4 m from t1 a second later; one frame cannot show the same person twice.
    store.ingestObservation(observation({ id: "o2", captureTick: 1100, detections: [person(2.4, 6, 3.9), person(1.6, 6, 3.9)] }));
    const [earlier, a, b] = tracksAt(store, 1105);
    assert.deepEqual(earlier.observationIds, ["o1"], "neither detection may claim the earlier track alone");
    assert.deepEqual(earlier.ambiguousWith, [t(2), t(3)]);
    assert.deepEqual([a.ambiguousWith, b.ambiguousWith], [[t(1)], [t(1)]]);
  });

  test("a detection between two tracks starts a new track linked both ways; repeat sightings extend it", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(1, 6, 3.9), person(4, 6, 3.9)] }));
    // 1 s later, 1.5 m from each track: both 2.7 m gates contain it, so the identity is unresolved.
    const between = store.ingestObservation(observation({ id: "o2", captureTick: 1100, detections: [person(2.5, 6, 3.9)] }));
    assert.ok(between.accepted);
    assert.deepEqual(between.tracks, [{ detectionIndex: 0, trackId: t(3), change: "created", ambiguousWith: [t(1), t(2)] }]);
    const [left, right, middle] = tracksAt(store, 1105);
    assert.deepEqual([left.ambiguousWith, right.ambiguousWith, middle.ambiguousWith], [[t(3)], [t(3)], [t(1), t(2)]]);
    assert.deepEqual([left.observationIds, right.observationIds], [["o1"], ["o1"]], "neither earlier track was updated or merged");

    // The same spot 0.2 s later lies in all three gates. It extends the recorded ambiguity rather than
    // adding a fourth track for the same unresolved identity on every frame.
    store.ingestObservation(observation({ id: "o3", captureTick: 1120, detections: [person(2.5, 6.1, 3.9)] }));
    const after = tracksAt(store, 1125);
    assert.equal(after.length, 3);
    assert.deepEqual(after[2].observationIds, ["o2", "o3"]);
    assert.deepEqual(after[2].ambiguousWith, [t(1), t(2)]);
    assert.ok(after.every(track => track.status === "possible" && track.mergedInto === null));
  });

  test("a sighting on another floor is linked as possibly the same person, never silently joined", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(2, 6, 1.0)] }));
    // 10 s later, directly above and 2.9 m away: inside the 3 m gate, but on the other floor.
    store.ingestObservation(observation({ id: "o2", captureTick: 2000, detections: [person(2, 6, 3.9)] }));
    const [below, above] = tracksAt(store, 2005);
    assert.deepEqual([below.roomId, above.roomId], ["f0-kitchen", "f1-rear-bedroom"]);
    assert.deepEqual(below.observationIds, ["o1"]);
    assert.deepEqual([below.ambiguousWith, above.ambiguousWith], [[t(2)], [t(1)]]);
  });

  test("a late, older sighting joins the track without moving it back in time", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(2, 6, 3.9)] }));
    store.ingestObservation(observation({ id: "o2", captureTick: 1200, detections: [person(3, 6, 3.9)] }));
    const [current] = tracksAt(store, 1205);
    // Captured before both, delivered after both.
    store.ingestObservation(observation({ id: "o0", captureTick: 900, arrivalTick: 1300, detections: [person(1.5, 6, 3.9)] }));
    const [track] = tracksAt(store, 1300);
    assert.deepEqual(track.observationIds, ["o1", "o2", "o0"]);
    assert.deepEqual(track.position, current.position, "the older sighting does not move the track");
    assert.ok(distance(track.position, vec3(3, 6, 3.9)) < 0.05);
    assert.deepEqual([track.firstSeenTick, track.lastSeenTick], [900, 1200]);
  });

  test("detections below the confidence threshold neither create nor update tracks", () => {
    const store = fixtureStore();
    const result = store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(2, 6, 3.9, { confidence: 0.1 })] }));
    assert.ok(result.accepted);
    assert.deepEqual([result.tracks, result.ignoredDetections], [[], [0]]);
    assert.deepEqual(tracksAt(store, 1005), []);
  });
});

describe("frame-rate association (regression: one person seen at 50 Hz through glass became dozens of tracks)", () => {
  /** Deterministic standard normal samples (mulberry32 + Box-Muller). */
  function normal(seed: number): () => number {
    let a = seed >>> 0;
    const uniform = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  }

  /**
   * A hovering drone outside the rear-bedroom window sights people every 2 ticks (50 Hz) for 40 s, with the
   * simulator's error model: measurement sigma 0.1 + 0.05 x range per horizontal axis (half vertically), a
   * slowly drifting pose error, and reported uncertainty hypot(pose sigma, measurement sigma).
   */
  function hover(people: readonly { x: number; y: number; z: number }[], sigmaPoseM: number, rangeM: number, seed: number): EvidenceStore {
    const g = normal(seed);
    const store = fixtureStore();
    const sigmaM = 0.1 + 0.05 * rangeM;
    const bias = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 2000; i++) {
      const tick = 1000 + 2 * i;
      bias.x += 0.003 * g();
      bias.y += 0.003 * g();
      bias.z += 0.003 * g();
      const detections = people.map(p => ({
        kind: "possible_person" as const,
        position: vec3(p.x + bias.x + sigmaM * g(), p.y + bias.y + sigmaM * g(), p.z + bias.z + 0.5 * sigmaM * g()),
        uncertaintyM: Math.hypot(sigmaPoseM, sigmaM),
        confidence: 0.6,
        method: "oracle_fixture" as const,
      }));
      const result = store.ingestObservation(observation({ id: `rgb-${i}`, captureTick: tick, arrivalTick: tick, modality: "rgb", detections }));
      assert.ok(result.accepted);
    }
    return store;
  }

  test("a stationary person sighted at 50 Hz for 40 s is one track holding every sighting", () => {
    for (const [sigmaPoseM, rangeM, seed] of [[0.1, 3, 1], [0.2, 5, 2], [0.3, 8, 3], [0.3, 12, 4]]) {
      const tracks = tracksAt(hover([{ x: 3, y: 6, z: 3.4 }], sigmaPoseM, rangeM, seed), 5000);
      assert.equal(tracks.length, 1, `pose sigma ${sigmaPoseM} m at ${rangeM} m: ${tracks.length} tracks`);
      assert.equal(tracks[0].observationIds.length, 2000);
      assert.ok(distance(tracks[0].position, vec3(3, 6, 3.4)) < 0.5, `fused position ${JSON.stringify(tracks[0].position)}`);
      assert.equal(tracks[0].uncertaintyM, Math.hypot(sigmaPoseM, 0.1 + 0.05 * rangeM), "the reported uncertainty never drops below a sighting's own");
    }
  });

  test("two people 3 m apart sighted in every frame stay two unambiguous tracks", () => {
    const tracks = tracksAt(hover([{ x: 1.5, y: 6, z: 3.4 }, { x: 4.5, y: 6, z: 3.4 }], 0.2, 4, 5), 5000);
    assert.equal(tracks.length, 2);
    assert.deepEqual(tracks.map(track => track.observationIds.length), [2000, 2000]);
    assert.ok(tracks.every(track => track.ambiguousWith.length === 0));
  });

  test("a sighting whose noisy height resolves to no room (the floor slab) joins the nearby track", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(3, 6, 3.3)] }));
    // z = 2.9 m lies between floor 0 (up to 2.6 m) and floor 1 (from 3 m): no room contains it.
    const slab = store.ingestObservation(observation({ id: "o2", captureTick: 1002, detections: [person(3.1, 6, 2.9)] }));
    assert.ok(slab.accepted);
    assert.deepEqual(slab.tracks.map(change => [change.trackId, change.change]), [[t(1), "associated"]]);
    // A sighting well inside floor 0's rooms is still another floor: linked, not joined.
    const below = store.ingestObservation(observation({ id: "o3", captureTick: 1100, detections: [person(3, 6, 1.6)] }));
    assert.ok(below.accepted);
    assert.deepEqual(below.tracks.map(change => [change.trackId, change.change, change.ambiguousWith]), [[t(2), "created", [t(1)]]]);
  });
});

describe("explicit track corrections", () => {
  test("a retraction keeps the track, records the reason and stops it attracting new sightings", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(2, 6, 3.9)] }));
    const revision = store.evidenceRevision;
    const correction = store.retractTrack(t(1), "Crew identified the heat source as a radiator.", 1010);
    assert.equal(store.evidenceRevision, revision + 1);

    store.ingestObservation(observation({ id: "o2", captureTick: 1020, detections: [person(2.1, 6, 3.9)] }));
    const [retracted, fresh] = tracksAt(store, 1025);
    assert.equal(retracted.status, "retracted");
    assert.deepEqual(retracted.observationIds, ["o1"]);
    assert.deepEqual([fresh.observationIds, fresh.ambiguousWith], [["o2"], []]);
    assert.deepEqual(store.trackCorrections(), [{ kind: "retracted", trackId: t(1), mergedInto: null, reason: "Crew identified the heat source as a radiator.", tick: 1010 }]);
    assert.deepEqual(correction, store.trackCorrections()[0]);

    assert.throws(() => store.retractTrack(t(1), "Again.", 1030), rejectedWith("invalid_state"));
    assert.throws(() => store.retractTrack(t(2), "   ", 1030), rejectedWith("invalid"));
    assert.throws(() => store.retractTrack("unknown", "Reason.", 1030), rejectedWith("unknown_reference"));
    assert.equal(store.evidenceRevision, revision + 2, "only the retraction and o2 changed the evidence");
  });

  test("a merge folds one track into another while keeping both records and their links", () => {
    const store = fixtureStore();
    store.ingestObservation(observation({ id: "o1", captureTick: 1000, detections: [person(1, 6, 3.9), person(4, 6, 3.9)] }));
    store.ingestObservation(observation({ id: "o2", captureTick: 1100, detections: [person(2.5, 6, 3.9)] }));
    store.mergeTracks(t(1), t(3), "Crew followed one person from the window to the doorway.", 1200);

    const [kept, other, merged] = tracksAt(store, 1200);
    assert.deepEqual(kept.observationIds, ["o1", "o2"]);
    assert.deepEqual(kept.position, { x: 2.5, y: 6, z: 3.9 }, "the kept track takes the more recent sighting");
    assert.equal(kept.lastSeenTick, 1100);
    assert.deepEqual([merged.status, merged.mergedInto, merged.observationIds], ["merged", t(1), ["o2"]]);
    assert.deepEqual([kept.ambiguousWith, other.ambiguousWith], [[t(2)], [t(1)]]);
    assert.throws(() => store.mergeTracks(t(1), t(3), "Twice.", 1210), rejectedWith("invalid_state"));
    assert.throws(() => store.mergeTracks(t(2), t(2), "Self.", 1210), rejectedWith("invalid_state"));
  });
});
