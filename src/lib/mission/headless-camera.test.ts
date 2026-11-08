import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { calibrationFromSensor } from "../contracts/camera.ts";
import type { Pose } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import { addSmoke } from "../simulation/fire.ts";
import { fixtureScenario } from "../simulation/fixture-scene.ts";
import { raycast } from "../simulation/raycast.ts";
import { sensorDirection, sensorOrigin } from "../simulation/sensors/pose.ts";
import { createWorld } from "../simulation/world.ts";
import { FIXTURE_SCENE } from "../simulation/world-fixtures.ts";
import { activeColliders } from "../simulation/world-state.ts";
import type { WorldState } from "../simulation/world-state.ts";
import { HEADLESS_RENDERER_LABEL, HeadlessColliderRenderer } from "./headless-camera.ts";
import { displayEncode, SMOKE_LUMINANCE } from "./headless-shading.ts";

const SPEC = TENDER_T1.sensors.find(s => s.id === "rgb-front")!;
const CALIBRATION = calibrationFromSensor(SPEC, 1);
/** Outside the fixture house, 15 m south of its front wall, looking north at it. */
const OUTSIDE: Pose = { position: vec3(5, -15, 1.5), yawRad: Math.PI / 2 };
/** Inside the living room, looking east at its east wall from about 3.7 m. */
const LIVING: Pose = { position: vec3(6, 4, 1.4), yawRad: 0 };

function world(overrides: Parameters<typeof fixtureScenario>[0] = {}): WorldState {
  return createWorld(FIXTURE_SCENE, fixtureScenario({ fire: null, occupants: [], ...overrides }));
}

function render(w: WorldState, pose: Pose, renderer = new HeadlessColliderRenderer(CALIBRATION)) {
  return { frame: renderer.render(w, { frameId: "f", tick: 0, pose }), renderer };
}

function patchStats(luminance: Float32Array, width: number, cols: readonly [number, number], rows: readonly [number, number]): { mean: number; std: number } {
  const values: number[] = [];
  for (let r = rows[0]; r < rows[1]; r++) for (let c = cols[0]; c < cols[1]; c++) values.push(luminance[r * width + c]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, std: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) };
}

describe("headless collider renderer v1", () => {
  test("renders the locked calibration and labels itself", () => {
    const { frame, renderer } = render(world(), OUTSIDE);
    assert.equal(renderer.label, HEADLESS_RENDERER_LABEL);
    assert.equal(frame.calibrationId, "rgb-front/v1");
    assert.equal(frame.width, 320);
    assert.equal(frame.height, 180);
    assert.equal(frame.luminance.length, 320 * 180);
    assert.ok(frame.luminance.every(v => v >= 0 && v <= 1));
  });

  test("pixel depths match the simulator's collider raycast along the mount's own ray directions; row 0 is the top", () => {
    const w = world();
    const { renderer } = render(w, OUTSIDE);
    const depth = renderer.lastDepth();
    const origin = sensorOrigin(OUTSIDE, SPEC);
    const colliders = activeColliders(w);
    // Independent geometry: pixel (u, v) of a pinhole camera looks at azimuth atan((cx − u)/fx) and elevation
    // atan((cy − v)/fy · cos(az)) about the optical axis; row 0 is elevation +vfov/2 (up).
    for (const [u, v] of [[160, 90], [160, 0], [160, 179], [0, 90], [319, 90], [40, 20], [280, 160], [120, 60]]) {
      const az = Math.atan((CALIBRATION.cx - u) / CALIBRATION.fx);
      const el = Math.atan(((CALIBRATION.cy - v) / CALIBRATION.fy) * Math.cos(az));
      const hit = raycast(colliders, origin, sensorDirection(OUTSIDE, SPEC, az, el), 80);
      const pixel = v * 320 + u;
      assert.ok(Math.abs(depth[pixel] - (hit?.distanceM ?? 80)) < 1e-6, `pixel (${u}, ${v}): ${depth[pixel]} vs ${hit?.distanceM ?? 80}`);
    }
    // The ground below the horizon is near at the bottom row; the top row looks over the house at the sky.
    assert.ok(depth[179 * 320 + 160] < 15);
    assert.equal(depth[160], 80);
  });

  test("is deterministic and textured: the same world and pose give identical frames, and a plain wall has contrast", () => {
    const w = world();
    const a = render(w, LIVING).frame;
    const b = render(w, LIVING).frame;
    assert.deepEqual(a.luminance, b.luminance);
    const wall = patchStats(a.luminance, 320, [130, 190], [60, 100]);
    assert.ok(wall.std > 0.01, `wall texture std ${wall.std}`);
  });

  test("smoke from the simulator's field lowers contrast toward the smoke luminance", () => {
    const clear = world();
    const smoky = world();
    addSmoke(smoky, "living", 1.5);
    const before = patchStats(render(clear, LIVING).frame.luminance, 320, [0, 320], [0, 180]);
    const after = patchStats(render(smoky, LIVING).frame.luminance, 320, [0, 320], [0, 180]);
    const smokeLevel = displayEncode(SMOKE_LUMINANCE, CALIBRATION.exposure.gain, CALIBRATION.exposure.gamma);
    assert.ok(after.std < before.std / 3, `std ${before.std} → ${after.std}`);
    assert.ok(Math.abs(after.mean - smokeLevel) < Math.abs(before.mean - smokeLevel));
  });

  test("an active fire in view is emissive and an extinguished one is not", () => {
    // Living-room fire 3 m ahead of a camera looking east.
    const burning = world({ fire: { roomId: "living", origin: vec3(9, 4, 0), radiusM: 0.4, initialHeatReleaseKW: 60, fuelMJ: 20 } });
    const lit = render(burning, LIVING).frame.luminance;
    assert.ok(lit.some(v => v >= 0.999), "flame saturates");
    burning.fires[0].extinguished = true;
    burning.fires[0].heatReleaseKW = 0;
    const out = render(burning, LIVING).frame.luminance;
    assert.ok(!out.some(v => v >= 0.999), "no flame once extinguished");
  });

  test("occupants appear as body proxies and broken glass stops occluding the room behind it", () => {
    const empty = world();
    const occupied = world({ occupants: [{ key: "o", start: vec3(9, 4, 0), mobility: "mobile" }] });
    const a = render(empty, LIVING).renderer.lastDepth();
    const b = render(occupied, LIVING).renderer.lastDepth();
    const centre = 89 * 320 + 160;
    assert.ok(b[centre] < a[centre] - 0.4, `person in front of the wall: ${b[centre]} vs ${a[centre]}`);

    const glass: Pose = { position: vec3(7.25, -3, 1.5), yawRad: Math.PI / 2 };
    const intact = world();
    const intactDepth = render(intact, glass).renderer.lastDepth()[89 * 320 + 160];
    intact.activeColliderIds.delete("glass-living-front");
    const brokenDepth = render(intact, glass).renderer.lastDepth()[89 * 320 + 160];
    assert.ok(intactDepth < 3.2 && brokenDepth > intactDepth + 3, `pane at ${intactDepth} m, then the room at ${brokenDepth} m`);
  });
});
