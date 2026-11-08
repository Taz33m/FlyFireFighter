import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Vec3 } from "./frames.ts";
import { bodyPointToWorld, bodyToOptical, opticalToBody, renderToWorld, rotateBodyToWorld, rotateWorldToBody, vec3, worldPointToBody, worldToRender, wrapAngle } from "./frames.ts";

function assertNear(actual: Vec3, expected: Vec3, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual.x - expected.x) < tolerance && Math.abs(actual.y - expected.y) < tolerance && Math.abs(actual.z - expected.z) < tolerance,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

describe("world to render (Three.js, Y up)", () => {
  test("east stays +X, up becomes +Y, north becomes -Z (the default camera's forward)", () => {
    assertNear(worldToRender(vec3(1, 0, 0)), vec3(1, 0, 0));
    assertNear(worldToRender(vec3(0, 0, 1)), vec3(0, 1, 0));
    assertNear(worldToRender(vec3(0, 1, 0)), vec3(0, 0, -1));
  });

  test("preserves handedness: east × north = up in both frames", () => {
    const east = worldToRender(vec3(1, 0, 0));
    const north = worldToRender(vec3(0, 1, 0));
    const crossed = vec3(east.y * north.z - east.z * north.y, east.z * north.x - east.x * north.z, east.x * north.y - east.y * north.x);
    assertNear(crossed, worldToRender(vec3(0, 0, 1)));
  });

  test("round-trips", () => {
    const p = vec3(3.25, -7.5, 2.125);
    assertNear(renderToWorld(worldToRender(p)), p);
  });
});

describe("body frame (X forward, Y left, Z up)", () => {
  test("an aircraft yawed +90° faces north: forward is north and left is west", () => {
    const yaw = Math.PI / 2;
    assertNear(rotateBodyToWorld(yaw, vec3(1, 0, 0)), vec3(0, 1, 0));
    assertNear(rotateBodyToWorld(yaw, vec3(0, 1, 0)), vec3(-1, 0, 0));
    assertNear(rotateBodyToWorld(yaw, vec3(0, 0, 1)), vec3(0, 0, 1));
  });

  test("points convert both ways through a pose", () => {
    const pose = { position: vec3(10, -4, 3), yawRad: 2.3 };
    const point = vec3(-1.5, 6, 0.4);
    assertNear(bodyPointToWorld(pose, worldPointToBody(pose, point)), point);
    assertNear(rotateWorldToBody(-0.7, rotateBodyToWorld(-0.7, point)), point);
  });

  test("wrapAngle maps to (-π, π]", () => {
    assert.equal(wrapAngle(-Math.PI), Math.PI);
    assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-12);
    assert.ok(Math.abs(wrapAngle(2 * Math.PI)) < 1e-12);
    assert.ok(Math.abs(wrapAngle(-3 * Math.PI / 2) - Math.PI / 2) < 1e-12);
  });
});

describe("camera optical frame (X right, Y down, Z forward)", () => {
  test("forward is the lens axis, body-left is image-left, body-up is image-up", () => {
    assertNear(bodyToOptical(vec3(1, 0, 0)), vec3(0, 0, 1));
    assertNear(bodyToOptical(vec3(0, 1, 0)), vec3(-1, 0, 0));
    assertNear(bodyToOptical(vec3(0, 0, 1)), vec3(0, -1, 0));
  });

  test("a camera pitched down by θ sees a point θ below the horizon on its axis", () => {
    const pitch = 0.35;
    const optical = bodyToOptical(vec3(Math.cos(pitch), 0, -Math.sin(pitch)), pitch);
    assertNear(optical, vec3(0, 0, 1));
    const p = vec3(2, -0.4, 0.9);
    assertNear(opticalToBody(bodyToOptical(p, pitch), pitch), p);
  });
});
