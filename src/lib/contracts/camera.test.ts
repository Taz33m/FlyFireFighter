import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "./aircraft.ts";
import { calibrationFromSensor, projectBodyPoint, verticalFovDeg } from "./camera.ts";
import { vec3 } from "./frames.ts";
import { encodeLuminanceU8, parseNeuralFeatures } from "./neural.ts";

const rgb = TENDER_T1.sensors.find(s => s.id === "rgb-front");
if (rgb === undefined) throw new Error("fixture: rgb-front sensor missing");
const calibration = calibrationFromSensor(rgb, 1);

describe("camera calibration", () => {
  test("square-pixel intrinsics reproduce the declared fields of view", () => {
    assert.ok(Math.abs(calibration.fx - 160) < 1e-9, "90° HFOV over 320 px gives fx = 160");
    assert.ok(Math.abs(verticalFovDeg(calibration) - (rgb.verticalFovDeg ?? 0)) < 0.05);
  });

  test("a point on the pitched lens axis projects to the principal point", () => {
    const pitch = calibration.mount.pitchRad;
    const ahead = vec3(calibration.mount.positionBody.x + 3 * Math.cos(pitch), calibration.mount.positionBody.y, calibration.mount.positionBody.z - 3 * Math.sin(pitch));
    const pixel = projectBodyPoint(calibration, ahead);
    assert.ok(pixel !== null);
    assert.ok(Math.abs(pixel.u - calibration.cx) < 1e-9 && Math.abs(pixel.v - calibration.cy) < 1e-9);
    assert.ok(Math.abs(pixel.depth - 3) < 1e-9);
  });

  test("body-left appears on the image left, and points behind the lens do not project", () => {
    const left = projectBodyPoint(calibration, vec3(4, 1, -0.7));
    const right = projectBodyPoint(calibration, vec3(4, -1, -0.7));
    assert.ok(left !== null && right !== null && left.u < calibration.cx && right.u > calibration.cx);
    assert.equal(projectBodyPoint(calibration, vec3(-2, 0, 0)), null);
  });

  test("the horizontal field-of-view edge lands on the image border", () => {
    const pitch = calibration.mount.pitchRad;
    // 45° to the left of the lens axis, in the camera's own horizontal plane.
    const axis = vec3(Math.cos(pitch), 0, -Math.sin(pitch));
    const point = vec3(axis.x * 5, 5, axis.z * 5);
    const pixel = projectBodyPoint(calibration, vec3(point.x + calibration.mount.positionBody.x, point.y + calibration.mount.positionBody.y, point.z + calibration.mount.positionBody.z));
    assert.ok(pixel !== null && Math.abs(pixel.u - (calibration.cx - calibration.fx)) < 1e-9);
  });
});

describe("neural protocol", () => {
  const reply = {
    type: "features", runId: "run-1", seq: 4, tick: 8, frameId: "f-8",
    horizontalMotion: [-0.2, 0, 0.3], expansion: 0.25, responses: { T4a: [0.1, 0.2, 0.3], T5b: [0, 0, 0.4] }, latencyMs: 6.5,
  };

  test("accepts a well-formed features reply", () => {
    assert.ok(parseNeuralFeatures(reply).ok);
  });

  test("rejects malformed sectors, non-finite values and unknown fields", () => {
    assert.equal(parseNeuralFeatures({ ...reply, horizontalMotion: [0, 1] }).ok, false);
    assert.equal(parseNeuralFeatures({ ...reply, responses: { T4a: [0, NaN, 0] } }).ok, false);
    assert.equal(parseNeuralFeatures({ ...reply, responses: { "T4a; rm -rf": [0, 0, 0] } }).ok, false);
    assert.equal(parseNeuralFeatures({ ...reply, motionRequest: { forward: 9 } }).ok, false);
  });

  test("u8 encoding clamps and rounds", () => {
    assert.deepEqual(Array.from(encodeLuminanceU8(Float32Array.from([-1, 0, 0.5, 1, 2, NaN]))), [0, 0, 128, 255, 255, 0]);
  });
});
