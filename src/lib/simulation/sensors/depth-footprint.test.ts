/*
 * Depth-image person-search footprints (imaging.ts): a contained point must be in view of the camera (line of
 * sight from its apex, only lattice-sampling misses within one lattice step of a silhouette edge allowed), the
 * air just above a floor in clear view must be contained, and nothing below a floor, behind a wall or a closed
 * door, or (for thermal) behind glass may be. Scope: rgb-front, rgb-down and thermal-front on the Troy
 * training scene and the two-room fixture, with no localization error (the image's apex is the true camera).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { DepthImageRegion } from "../../contracts/geometry.ts";
import { regionContains } from "../../contracts/geometry.ts";
import type { Observation } from "../../contracts/observation.ts";
import type { FixtureOptions } from "../environment-fixtures.ts";
import { fixtureWorld } from "../environment-fixtures.ts";
import { keyedUniform } from "../random.ts";
import { parseSceneMeta, sceneModelFromMeta } from "../scene.ts";
import { createWorld } from "../world.ts";
import type { RuntimeCollider, WorldState } from "../world-state.ts";
import { senseTick } from "./index.ts";
import { LATTICE } from "./imaging.ts";
import { cameraFrame, inPinholeView, truePose } from "./pose.ts";
import { visibleThrough } from "./rgb.ts";
import { traceClear, traceSet } from "./trace.ts";

const TROY = new URL("../../../../public/scenes/troy-training/scene.meta.json", import.meta.url);
const CAMERAS = ["rgb-front", "rgb-down", "thermal-front"] as const;

function troyWorld(): WorldState {
  const meta = parseSceneMeta(JSON.parse(readFileSync(TROY, "utf8")));
  return createWorld(sceneModelFromMeta(meta), { scenarioId: "depth", seed: "depth-1", runId: "run-depth", profile: TENDER_T1, fire: null, occupants: [], openingOverrides: {} });
}

/**
 * The frame's depth images re-expressed at the TRUE camera pose. Observations report geometry from the
 * estimated pose, which carries localization jitter even without drift; these tests judge the measurement.
 */
function footprints(world: WorldState): Map<string, DepthImageRegion> {
  const out = new Map<string, DepthImageRegion>();
  for (const o of senseTick(world).observations as Observation[]) if (o.footprint?.kind === "depth_image") out.set(o.sensorId, inTruthFrame(world, o.sensorId, o.footprint));
  return out;
}

function inTruthFrame(world: WorldState, sensorId: string, r: DepthImageRegion): DepthImageRegion {
  const spec = TENDER_T1.sensors.find(sensor => sensor.id === sensorId)!;
  const truth = cameraFrame(truePose(world), spec);
  const dz = r.apex.z - truth.origin.z;
  return { ...r, apex: truth.origin, forward: truth.forward, up: truth.up, floorZM: r.floorZM.map(z => (z === null ? null : z - dz)) };
}

function left(r: DepthImageRegion): Vec3 {
  return vec3(r.up.y * r.forward.z - r.up.z * r.forward.y, r.up.z * r.forward.x - r.up.x * r.forward.z, r.up.x * r.forward.y - r.up.y * r.forward.x);
}

/** Point at image-plane tangents (x towards left, y up) and z-depth f. */
function imagePoint(r: DepthImageRegion, x: number, y: number, f: number): Vec3 {
  const l = left(r);
  return vec3(r.apex.x + (r.forward.x + l.x * x + r.up.x * y) * f, r.apex.y + (r.forward.y + l.y * x + r.up.y * y) * f, r.apex.z + (r.forward.z + l.z * x + r.up.z * y) * f);
}

interface Soundness {
  readonly contained: number;
  /** Contained but not in view, yet in view one lattice step away: lattice sampling at a silhouette edge. */
  readonly edge: number;
  readonly violations: string[];
}

/** Random points inside the image's cells and depths; every contained one must be in view (see the header). */
function checkSoundness(world: WorldState, r: DepthImageRegion, transparent: ((c: RuntimeCollider) => boolean) | undefined, label: string, samples: number): Soundness {
  const set = traceSet(world, r.apex, 40);
  const tanH = Math.tan(r.hfovRad / 2);
  const tanV = Math.tan(r.vfovRad / 2);
  const step = (2 * tanH) / (r.cols * LATTICE);
  const inView = (p: Vec3) => traceClear(set, r.apex, p, transparent);
  let contained = 0;
  let edge = 0;
  const violations: string[] = [];
  for (let i = 0; i < samples; i++) {
    const u = (stream: string) => keyedUniform(label, stream, i);
    const cell = Math.min(r.cols * r.rows - 1, Math.floor(u("cell") * r.cols * r.rows));
    const x = tanH - (2 * tanH * ((cell % r.cols) + u("x"))) / r.cols;
    const y = tanV - (2 * tanV * (Math.floor(cell / r.cols) + u("y"))) / r.rows;
    const f = Math.min(r.depthsM[cell], 15) * u("f");
    const p = imagePoint(r, x, y, f);
    if (!regionContains(r, p)) continue;
    contained += 1;
    if (inView(p)) continue;
    const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dy]) => imagePoint(r, x + dx * step, y + dy * step, f));
    if (neighbours.some(inView)) edge += 1;
    else violations.push(`${label}: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) at depth ${f.toFixed(2)} m`);
  }
  return { contained, edge, violations };
}

describe("depth-image footprints are sound on the Troy scene", { skip: existsSync(TROY) ? false : "public/scenes/troy-training/scene.meta.json is not present" }, () => {
  test("every contained point is in view, except within one lattice step of a silhouette edge", () => {
    const world = troyWorld();
    // Ground-floor rooms, the upstairs hall, and outside facing the house, each at four headings.
    const poses: readonly Vec3[] = [vec3(12, 6.5, 1.2), vec3(15, 1, 1.2), vec3(23, 2, 1.2), vec3(20.5, 2.5, 4.8), vec3(24, 3, 4.8), vec3(17.5, 11, 3)];
    let contained = 0;
    let edge = 0;
    const violations: string[] = [];
    for (const position of poses) {
      for (const yawRad of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        world.drone.position = position;
        world.drone.yawRad = yawRad;
        world.tick = 0;
        for (const [id, r] of footprints(world)) {
          const result = checkSoundness(world, r, id.startsWith("rgb") ? visibleThrough : undefined, `${id}@${position.x},${position.y},${position.z}/${yawRad.toFixed(2)}`, 400);
          contained += result.contained;
          edge += result.edge;
          violations.push(...result.violations);
        }
      }
    }
    console.log(`depth-image soundness: ${contained} contained samples, ${edge} out of view within one lattice step of a silhouette edge, ${violations.length} other`);
    assert.ok(contained > 10000, `${contained} contained samples`);
    assert.deepEqual(violations, [], "contained points out of view and not near a silhouette edge");
    assert.ok(edge < 0.01 * contained, `${edge} of ${contained} contained points are out of view at silhouette edges`);
  });
});

describe("depth-image footprints keep the air just above floors and nothing beyond what was seen", () => {
  const ids = (o: Observation) => o.sensorId;
  const frame = (options: FixtureOptions) => {
    const world = fixtureWorld(options);
    const observations = senseTick(world).observations.flatMap(o => (o.footprint?.kind === "depth_image" ? [{ ...o, footprint: inTruthFrame(world, o.sensorId, o.footprint) }] : []));
    return { world, observations };
  };

  test("points 0.1–0.3 m above open ground and a room floor, 2–6 m away in clear view, are contained", () => {
    // Outdoors facing away from the house over open ground; and in room-a facing the shared wall (table aside).
    const cases = [
      { drone: { position: vec3(-5, 2, 1.2), yawRad: Math.PI }, x: [-11, -7.5], y: [0.5, 3.5] },
      { drone: { position: vec3(0.5, 2, 1.2), yawRad: 0 }, x: [2.6, 3.85], y: [1.7, 3.8] },
    ];
    for (const { drone, x, y } of cases) {
      const { observations } = frame({ drone });
      for (const o of observations.filter(obs => obs.sensorId !== "rgb-down")) {
        const spec = TENDER_T1.sensors.find(sensor => sensor.id === o.sensorId)!;
        const missed: string[] = [];
        let checked = 0;
        for (let i = 0; i <= 10; i++) {
          for (let j = 0; j <= 6; j++) {
            for (const h of [0.1, 0.2, 0.3]) {
              const p = vec3(x[0] + ((x[1] - x[0]) * i) / 10, y[0] + ((y[1] - y[0]) * j) / 6, h);
              if (!inPinholeView({ position: drone.position, yawRad: drone.yawRad }, spec, p, 6.5)) continue;
              checked += 1;
              if (!regionContains(o.footprint!, p)) missed.push(`(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${h})`);
            }
          }
        }
        assert.ok(checked > 60, `${ids(o)}: ${checked} points in view`);
        assert.deepEqual(missed, [], `${ids(o)} from (${drone.position.x}, ${drone.position.y})`);
      }
    }
  });

  test("nothing below a floor, behind a wall or a closed door is contained", () => {
    const { observations } = frame({ drone: { position: vec3(2, 2, 1.2), yawRad: 0 } });
    assert.equal(observations.length, 3);
    for (const o of observations) {
      for (let i = 0; i < 3000; i++) {
        const u = (stream: string) => keyedUniform(`below-${o.sensorId}`, stream, i);
        const underFloor = vec3(-1 + 10 * u("x"), -1 + 6 * u("y"), -0.01 - 0.5 * u("z"));
        assert.ok(!regionContains(o.footprint!, underFloor), `${ids(o)} contains ${JSON.stringify(underFloor)} below the floor`);
        const roomB = vec3(4.15 + 3.9 * u("bx"), 0.05 + 3.9 * u("by"), 0.05 + 2.5 * u("bz"));
        assert.ok(!regionContains(o.footprint!, roomB), `${ids(o)} contains ${JSON.stringify(roomB)} behind the closed door`);
        const outside = vec3(4.15 + 3 * u("ox"), -3 + 2.85 * u("oy"), 0.05 + 2.5 * u("oz"));
        assert.ok(!regionContains(o.footprint!, outside), `${ids(o)} contains ${JSON.stringify(outside)} behind the south wall`);
      }
    }
  });

  test("RGB coverage continues through intact glass into the room; thermal coverage never does", () => {
    const { observations } = frame({ drone: { position: vec3(-2.5, 2, 1.5), yawRad: 0 } });
    const inside = (o: Observation) => {
      let n = 0;
      for (let i = 0; i < 3000; i++) {
        const u = (stream: string) => keyedUniform(`glass-${o.sensorId}`, stream, i);
        if (regionContains(o.footprint!, vec3(0.05 + 3.9 * u("x"), 0.05 + 3.9 * u("y"), 0.05 + 2.5 * u("z")))) n += 1;
      }
      return n;
    };
    const thermal = observations.find(o => o.sensorId === "thermal-front")!;
    const rgb = observations.find(o => o.sensorId === "rgb-front")!;
    assert.equal(inside(thermal), 0, "LWIR does not pass glass");
    assert.ok(inside(rgb) > 100, `RGB sees into the room through the pane (${inside(rgb)} of 3000 samples)`);
  });
});

describe("cameras covered", () => {
  test("rgb-front, rgb-down and thermal-front all report depth-image footprints on search frames", () => {
    const world = fixtureWorld({ drone: { position: vec3(2, 2, 1.2), yawRad: 0 } });
    assert.deepEqual([...footprints(world).keys()].sort(), [...CAMERAS].sort());
  });
});
