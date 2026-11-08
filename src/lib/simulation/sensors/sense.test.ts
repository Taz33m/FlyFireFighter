import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bodyPointToWorld, distance, vec3, wrapAngle } from "../../contracts/frames.ts";
import { depthImageProblems, MAX_DEPTH_IMAGE_CELLS, MAX_UNION_PARTS } from "../../contracts/geometry.ts";
import type { Region } from "../../contracts/geometry.ts";
import type { Observation } from "../../contracts/observation.ts";
import type { Schema } from "../../contracts/schema.ts";
import { arr, int, lit, num, obj, str, validate, vec3Schema } from "../../contracts/schema.ts";
import { fixtureWorld } from "../environment-fixtures.ts";
import { addSmoke } from "../fire.ts";
import { estimatedPose } from "../localization.ts";
import { senseTick } from "./index.ts";

/* A strict copy of the evidence store's observation schema (src/lib/evidence/schemas.ts is off-limits here). */
const nullable = (inner: Schema): Schema => ({ type: "nullable", inner });
const simple = {
  box: obj({ kind: lit("box"), min: vec3Schema, max: vec3Schema }),
  sphere: obj({ kind: lit("sphere"), center: vec3Schema, radiusM: num(0) }),
  sector: obj({ kind: lit("sector"), apex: vec3Schema, axis: vec3Schema, halfAngleRad: num(0, Math.PI), rangeM: num(0) }),
  prism: obj({ kind: lit("prism"), polygon: arr(arr(num(), 2, 2), 1024, 3), zMin: num(), zMax: num() }),
  depth_image: obj({
    kind: lit("depth_image"), apex: vec3Schema, forward: vec3Schema, up: vec3Schema, hfovRad: num(0, Math.PI), vfovRad: num(0, Math.PI),
    cols: int(1, MAX_DEPTH_IMAGE_CELLS), rows: int(1, MAX_DEPTH_IMAGE_CELLS), depthsM: arr(num(0), MAX_DEPTH_IMAGE_CELLS, 1), floorZM: arr(nullable(num()), MAX_DEPTH_IMAGE_CELLS, 1),
  }),
};
const region: Schema = { type: "tagged", tag: "kind", variants: { ...simple, union: obj({ kind: lit("union"), parts: arr({ type: "tagged", tag: "kind", variants: simple }, MAX_UNION_PARTS, 1) }) } };
const method = lit("oracle_fixture", "thermal_blob", "image_detector");
const detection: Schema = {
  type: "tagged",
  tag: "kind",
  variants: {
    possible_person: obj({ kind: lit("possible_person"), position: vec3Schema, uncertaintyM: num(0), confidence: num(0, 1), method }),
    hazard: obj({ kind: lit("hazard"), hazard: lit("fire", "smoke", "heat", "obstruction"), region, intensity: num() }),
    opening_state: obj({ kind: lit("opening_state"), openingId: str(256), state: lit("closed", "open", "broken", "blocked") }),
  },
};
const observationSchema = obj({
  id: str(256), runId: str(256), sensorId: str(128), modality: lit("rgb", "thermal", "lidar", "ultrasound", "imu"),
  captureTick: int(), arrivalTick: int(), frameId: nullable(str(256)), calibrationId: nullable(str(256)),
  provenance: lit("simulated_sensor", "fixture", "recording"), sensorPose: obj({ position: vec3Schema, yawRad: num(), sigmaM: num(0) }),
  quality: num(0, 1), footprint: nullable(region), personSearch: nullable(method), detections: arr(detection, 64), supersedes: nullable(str(256)),
});

function sectorsOf(r: Region): Extract<Region, { kind: "sector" }>[] {
  if (r.kind === "union") return r.parts.flatMap(sectorsOf);
  return r.kind === "sector" ? [r] : [];
}

function contractProblems(o: Observation): string[] {
  const problems = validate(observationSchema, o);
  if (o.footprint?.kind === "depth_image") problems.push(...depthImageProblems(o.footprint).map(p => `${o.id}: ${p}`));
  for (const s of o.footprint ? sectorsOf(o.footprint) : []) if (Math.abs(Math.hypot(s.axis.x, s.axis.y, s.axis.z) - 1) > 1e-6) problems.push(`${o.id}: non-unit sector axis`);
  for (const d of o.detections) if (d.kind === "possible_person" && d.method !== o.personSearch) problems.push(`${o.id}: detection method differs from personSearch`);
  return problems;
}

const busyWorld = () =>
  fixtureWorld({
    drone: { position: vec3(2, 2, 1.2), yawRad: 0 },
    openings: { "door-ab": "open" },
    occupants: [{ key: "occupant-1", position: vec3(6, 2, 0) }],
    fire: { roomId: "room-b", origin: vec3(6.5, 3.2, 0.3), radiusM: 0.25, initialHeatReleaseKW: 40, fuelMJ: 60 },
  });

describe("senseTick envelope", () => {
  test("each sensor reports exactly on its cadence (period = SIM_HZ / rateHz ticks)", () => {
    const world = busyWorld();
    const ids = (tick: number) => {
      world.tick = tick;
      return senseTick(world).observations.map(o => o.sensorId).sort();
    };
    assert.deepEqual(ids(0), ["imu", "lidar-planar", "rgb-down", "rgb-front", "thermal-front", "ultrasound-down", "ultrasound-front"]);
    assert.deepEqual(ids(1), ["imu"]);
    assert.deepEqual(ids(2), ["imu", "rgb-front"]);
    assert.deepEqual(ids(5), ["imu", "lidar-planar", "ultrasound-down", "ultrasound-front"]);
    assert.deepEqual(ids(10), ["imu", "lidar-planar", "rgb-down", "rgb-front", "thermal-front", "ultrasound-down", "ultrasound-front"]);
    world.tick = 1;
    const quiet = senseTick(world);
    assert.equal(quiet.ranges, null, "no range sensor fired");
    assert.ok(quiet.imu !== null);
  });

  test("ids, capture/arrival ticks and sensor poses come from the capture tick and the estimate, not truth", () => {
    const world = busyWorld();
    world.tick = 40;
    world.estimator.driftM = vec3(0.6, -0.4, 0);
    world.estimator.yawDriftRad = 0.2;
    world.estimator.sigmaM = 0.3;
    const estimate = estimatedPose(world);
    for (const o of senseTick(world).observations) {
      const spec = world.profile.sensors.find(s => s.id === o.sensorId);
      assert.ok(spec);
      assert.equal(o.id, `run-fixture/${o.sensorId}/40`);
      assert.equal(o.captureTick, 40);
      assert.equal(o.arrivalTick, 40 + spec.latencyTicks);
      assert.equal(o.provenance, "simulated_sensor");
      const fromEstimate = bodyPointToWorld({ position: estimate.position, yawRad: estimate.yawRad }, spec.mount.positionBody);
      const fromTruth = bodyPointToWorld({ position: world.drone.position, yawRad: world.drone.yawRad }, spec.mount.positionBody);
      assert.ok(distance(o.sensorPose.position, fromEstimate) < 1e-12, `${o.sensorId} pose is the estimate`);
      assert.ok(distance(o.sensorPose.position, fromTruth) > 0.5, `${o.sensorId} pose is not truth`);
      assert.ok(Math.abs(wrapAngle(o.sensorPose.yawRad - (estimate.yawRad + spec.mount.yawRad))) < 1e-12);
      assert.equal(o.sensorPose.sigmaM, 0.3);
      for (const s of o.footprint ? sectorsOf(o.footprint) : []) assert.ok(distance(s.apex, fromEstimate) < 1e-12, `${o.sensorId} footprint apex`);
    }
  });

  test("only camera frames (thermal and RGB) declare a person search, and only they carry possible-person detections", () => {
    for (const world of [busyWorld(), fixtureWorld()]) {
      for (const tick of [0, 10, 20]) {
        world.tick = tick;
        for (const o of senseTick(world).observations) {
          const camera = o.modality === "thermal" || o.modality === "rgb";
          assert.equal(o.personSearch, camera ? "oracle_fixture" : null, `${o.id}`);
          if (!camera) assert.ok(o.detections.every(d => d.kind !== "possible_person"));
        }
      }
    }
  });

  test("every observation satisfies the observation contract; camera person searches carry depth images, lidar a bounded union of unit-axis sectors", () => {
    const world = busyWorld();
    addSmoke(world, "room-a", 0.8);
    for (let tick = 0; tick <= 40; tick += 2) {
      world.tick = tick;
      for (const o of senseTick(world).observations) {
        assert.deepEqual(contractProblems(o), [], o.id);
        if (o.modality === "imu") assert.equal(o.footprint, null);
        if (o.modality === "rgb" || o.modality === "thermal") assert.equal(o.footprint?.kind ?? null, o.personSearch === null ? null : "depth_image", o.id);
        if (o.modality === "lidar") {
          assert.equal(o.footprint?.kind, "union", o.id);
          if (o.footprint?.kind === "union") assert.ok(o.footprint.parts.length <= MAX_UNION_PARTS);
        }
      }
    }
  });

  test("cameras search for people at 10 Hz: the 50 Hz forward camera's other frames report quality and hazards but no search or footprint", () => {
    const world = busyWorld();
    const searched: number[] = [];
    for (let tick = 0; tick < 40; tick++) {
      world.tick = tick;
      for (const o of senseTick(world).observations) {
        if (o.modality !== "rgb" && o.modality !== "thermal") continue;
        if (o.personSearch !== null) {
          searched.push(tick);
          continue;
        }
        assert.equal(o.sensorId, "rgb-front", `${o.id}: only the 50 Hz camera skips searches`);
        assert.equal(o.footprint, null);
        assert.ok(o.detections.every(d => d.kind !== "possible_person"));
        assert.ok(o.quality > 0.5, `${o.id} still estimates frame quality for the controller`);
      }
    }
    assert.deepEqual([...new Set(searched)], [0, 10, 20, 30]);
  });

  test("senseTick is deterministic for the same world and tick and does not mutate the world", () => {
    const a = busyWorld();
    const b = busyWorld();
    for (const world of [a, b]) {
      world.tick = 30;
      addSmoke(world, "room-a", 1.5);
    }
    const before = JSON.stringify({ ...a, activeColliderIds: [...a.activeColliderIds] });
    const first = senseTick(a);
    assert.deepEqual(senseTick(a), first);
    assert.deepEqual(senseTick(b), first, "an identical world gives an identical frame");
    assert.equal(JSON.stringify({ ...a, activeColliderIds: [...a.activeColliderIds] }), before);
  });

  test("range readings are body-sector minima of this tick's returns, null where nothing returned", () => {
    const indoors = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), yawRad: 0 } });
    const ranges = senseTick(indoors).ranges;
    assert.ok(ranges !== null);
    assert.equal(ranges.arrivalTick, 3, "the slowest contributing latency (ultrasound, 3 ticks)");
    const near = (value: number | null, expected: number) => value !== null && Math.abs(value - expected) < 0.2;
    assert.ok(near(ranges.forwardM, 1.86), `forward ${ranges.forwardM}`);
    assert.ok(near(ranges.leftM, 2), `left ${ranges.leftM}`);
    assert.ok(near(ranges.rightM, 2), `right ${ranges.rightM}`);
    assert.ok(near(ranges.downM, 1.14), `down ${ranges.downM}`);
    const open = senseTick(fixtureWorld({ drone: { position: vec3(-11, 2, 6), yawRad: Math.PI } })).ranges;
    assert.deepEqual([open?.forwardM, open?.leftM, open?.rightM, open?.downM], [null, null, null, null]);
  });
});
