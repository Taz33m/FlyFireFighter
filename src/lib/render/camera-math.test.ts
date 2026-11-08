/**
 * Drone-camera math, checked against the contracts' independent pinhole projection (projectBodyPoint):
 * the render path (pose → Three.js camera basis → projection matrix → WebGL framebuffer → row flip) must
 * land every world point on the same calibrated pixel. No WebGL is involved.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CameraCalibration } from "../contracts/camera.ts";
import { projectBodyPoint } from "../contracts/camera.ts";
import type { Pose, Vec3 } from "../contracts/frames.ts";
import { dot, sub, vec3, worldPointToBody, worldToRender } from "../contracts/frames.ts";
import { encodeLuminance, lockedCalibration, luminanceFrameFromReadback, projectionFromIntrinsics, relativeLuminance, renderCameraPose } from "./camera-math.ts";

const calibration = lockedCalibration("tender-t1");
const EXPOSURE = { gain: 1, gamma: 2.2 };

/** Pixel (u right, v down from the top row) produced by the WebGL path, using only the module's outputs. */
function pixelThroughRenderPath(cal: CameraCalibration, pose: Pose, world: Vec3): { u: number; v: number; depth: number } {
  const camera = renderCameraPose(cal, pose);
  const rel = sub(worldToRender(world), camera.position);
  const local = [dot(rel, camera.right), dot(rel, camera.up), dot(rel, camera.back), 1];
  const m = projectionFromIntrinsics(cal);
  const clip = [0, 1, 2, 3].map(row => m[row] * local[0] + m[4 + row] * local[1] + m[8 + row] * local[2] + m[12 + row] * local[3]);
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  // WebGL viewport transform: framebuffer origin at the bottom-left corner, pixel centres at +0.5.
  const fbX = ((ndcX + 1) / 2) * cal.width;
  const fbY = ((ndcY + 1) / 2) * cal.height;
  const rowFromBottom = fbY - 0.5;
  return { u: fbX - 0.5, v: cal.height - 1 - rowFromBottom, depth: -local[2] };
}

describe("projection from intrinsics", () => {
  test("the locked rgb-front calibration gives a symmetric 90° × 58.7° frustum", () => {
    assert.equal(calibration.id, "rgb-front/v1");
    const actual = [calibration.width, calibration.height, calibration.fx, calibration.fy, calibration.cx, calibration.cy];
    [320, 180, 160, 160, 159.5, 89.5].forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < 1e-9, `field ${i}: ${actual[i]}`));
    const m = projectionFromIntrinsics(calibration);
    assert.ok(Math.abs(m[0] - 1) < 1e-12, "2 fx / W = 1 for a 90° horizontal field of view");
    assert.ok(Math.abs(m[5] - 320 / 180) < 1e-12, "2 fy / H with square pixels");
    assert.equal(m[8], 0);
    assert.equal(m[9], 0);
    assert.equal(m[11], -1, "w_clip = -z_camera");
  });

  test("an off-centre principal point keeps the lens axis on (cx, cy)", () => {
    const offset: CameraCalibration = { ...calibration, id: "test/off-centre", cx: 100.25, cy: 60.75 };
    const pose: Pose = { position: vec3(0, 0, 2), yawRad: 0 };
    const camera = renderCameraPose(offset, pose);
    const ahead = vec3(camera.position.x - 4 * camera.back.x, camera.position.y - 4 * camera.back.y, camera.position.z - 4 * camera.back.z);
    const world = vec3(ahead.x, -ahead.z, ahead.y); // render → world
    const pixel = pixelThroughRenderPath(offset, pose, world);
    assert.ok(Math.abs(pixel.u - 100.25) < 1e-9 && Math.abs(pixel.v - 60.75) < 1e-9, `got ${pixel.u}, ${pixel.v}`);
  });

  test("rejects an invalid depth range", () => {
    assert.throws(() => projectionFromIntrinsics(calibration, 0, 10), RangeError);
    assert.throws(() => projectionFromIntrinsics(calibration, 5, 1), RangeError);
  });

  test("both fictional aircraft lock the same rgb-front/v1 camera; unknown profiles are refused", () => {
    assert.deepEqual(lockedCalibration("scout-s1"), calibration);
    assert.throws(() => lockedCalibration("not-an-aircraft"), RangeError);
  });
});

describe("render camera pose", () => {
  test("a level aircraft facing east looks east and 10° below the horizon", () => {
    const camera = renderCameraPose(calibration, { position: vec3(0, 0, 0), yawRad: 0 });
    const pitch = (10 * Math.PI) / 180;
    // Lens axis = -back; world east = render +X, world up = render +Y.
    assert.ok(Math.abs(-camera.back.x - Math.cos(pitch)) < 1e-12 && Math.abs(-camera.back.y + Math.sin(pitch)) < 1e-12 && Math.abs(camera.back.z) < 1e-12);
    // Image right is world south (body right) = render +Z.
    assert.ok(Math.abs(camera.right.z - 1) < 1e-12);
    // The mount offset (0.12 m forward, 0.02 m up) is applied in the body frame.
    assert.ok(Math.abs(camera.position.x - 0.12) < 1e-12 && Math.abs(camera.position.y - 0.02) < 1e-12);
  });

  test("render path and the calibrated pinhole model agree on every visible point", () => {
    const poses: Pose[] = [
      { position: vec3(20.4, 3.1, 4.2), yawRad: 0.7 },
      { position: vec3(30.5, 28, 0.1), yawRad: -Math.PI / 2 },
      { position: vec3(-3, 12, 6.5), yawRad: 2.9 },
    ];
    let checked = 0;
    for (const pose of poses) {
      for (let i = 0; i < 60; i++) {
        // Deterministic spread of points around the aircraft.
        const offset = vec3(Math.sin(i * 1.3) * 7, Math.cos(i * 0.7) * 7, Math.sin(i * 2.1) * 2.5);
        const world = vec3(pose.position.x + offset.x, pose.position.y + offset.y, pose.position.z + offset.z);
        const expected = projectBodyPoint(calibration, worldPointToBody(pose, world));
        if (expected === null || expected.depth < 0.1) continue;
        const actual = pixelThroughRenderPath(calibration, pose, world);
        assert.ok(Math.abs(actual.u - expected.u) < 1e-6 && Math.abs(actual.v - expected.v) < 1e-6, `pose yaw ${pose.yawRad}, point ${i}: render (${actual.u}, ${actual.v}) vs calibration (${expected.u}, ${expected.v})`);
        assert.ok(Math.abs(actual.depth - expected.depth) < 1e-9);
        checked++;
      }
    }
    assert.ok(checked > 40, `only ${checked} points were in front of the lens`);
  });
});

describe("luminance readback", () => {
  test("Rec. 709 weights on linear light, then the calibration gamma", () => {
    assert.ok(Math.abs(relativeLuminance(1, 1, 1) - 1) < 1e-12);
    assert.ok(Math.abs(encodeLuminance(relativeLuminance(1, 0, 0), EXPOSURE) - Math.pow(0.2126, 1 / 2.2)) < 1e-12);
    assert.ok(Math.abs(encodeLuminance(0.18, EXPOSURE) - 0.4587) < 1e-4, "18 % grey encodes near 0.46");
    assert.ok(Math.abs(encodeLuminance(0.1, { gain: 2, gamma: 2.2 }) - encodeLuminance(0.2, EXPOSURE)) < 1e-12, "gain scales linear light before encoding");
  });

  test("clamps overexposure and maps negative or NaN light to black", () => {
    assert.equal(encodeLuminance(3.5, EXPOSURE), 1);
    assert.equal(encodeLuminance(-0.2, EXPOSURE), 0);
    assert.equal(encodeLuminance(Number.NaN, EXPOSURE), 0);
  });

  test("flips WebGL rows so row 0 is the top of the image", () => {
    const width = 3;
    const height = 2;
    // Bottom framebuffer row is black; top framebuffer row is white with a dark middle pixel.
    const rgba = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0.18, 0.18, 0.18, 1, 1, 1, 1, 1]);
    const frame = luminanceFrameFromReadback(rgba, width, height, EXPOSURE);
    assert.deepEqual(Array.from(frame.slice(0, 3)).map(v => Math.round(v * 1e4) / 1e4), [1, 0.4587, 1]);
    assert.deepEqual(Array.from(frame.slice(3)), [0, 0, 0]);
  });

  test("8-bit linear readback is scaled by 1/255 and buffer sizes are enforced", () => {
    const frame = luminanceFrameFromReadback(new Uint8Array([255, 255, 255, 255]), 1, 1, EXPOSURE);
    assert.equal(frame[0], 1);
    assert.throws(() => luminanceFrameFromReadback(new Float32Array(4), 2, 1, EXPOSURE), RangeError);
    assert.throws(() => luminanceFrameFromReadback(new Float32Array(8), 2, 1, EXPOSURE, new Float32Array(3)), RangeError);
  });

  test("a rendered point and its readback pixel coincide after the flip", () => {
    const pose: Pose = { position: vec3(5, 5, 2), yawRad: 1.1 };
    const target = vec3(9, 8.5, 1.2);
    const expected = projectBodyPoint(calibration, worldPointToBody(pose, target));
    assert.ok(expected !== null);
    const u = Math.round(expected.u);
    const v = Math.round(expected.v);
    // Simulate the GPU writing that pixel at its framebuffer row (counted from the bottom).
    const rgba = new Float32Array(calibration.width * calibration.height * 4);
    const fbRow = calibration.height - 1 - v;
    rgba.fill(1, (fbRow * calibration.width + u) * 4, (fbRow * calibration.width + u) * 4 + 3);
    const frame = luminanceFrameFromReadback(rgba, calibration.width, calibration.height, EXPOSURE);
    assert.equal(frame[v * calibration.width + u], 1);
    assert.equal(frame.reduce((sum, value) => sum + value, 0), 1);
  });
});
