/**
 * Dense pyramidal Lucas–Kanade estimator and the rotational motion model on synthetic frames: known
 * sub-pixel and multi-pixel translations, rotation against exact reprojection, and rejection of a dark,
 * low-contrast frame (no information must not look like no motion).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bodyToOptical, opticalToBody, rotateWorldToBody, vec3 } from "../../contracts/frames.ts";
import { DenseFlow } from "./flow.ts";
import { predictedRotationFlow } from "./flow-cues.ts";
import { buildPyramid, resampleToGrid } from "./image.ts";
import { darkSequence, yawSequence } from "./scenarios.ts";
import { renderFrame, wallAtX } from "./synthetic.ts";
import type { CameraFrame } from "./types.ts";
import { RGB_FRONT_CAMERA, focalLengthPx } from "./types.ts";

const FRONTAL = { horizontalFovDeg: 90, pitchRad: 0 };
const pyramid = (frame: CameraFrame) => buildPyramid(resampleToGrid(frame, 80, 45), 80, 45, 3);
const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe("dense pyramidal Lucas–Kanade", () => {
  // A wall 2 m ahead seen by a pitch-0 camera; a sideways camera step of Δ shifts the image by f·Δ/2 grid pixels.
  for (const shiftPx of [0.4, 1.5, 3.2]) {
    test(`recovers a uniform ${shiftPx} px translation (median error < 0.06 px, mean within 2%)`, () => {
      const deltaM = (shiftPx * 2) / focalLengthPx(FRONTAL, 80);
      const render = (y: number, tick: number) => renderFrame([wallAtX(2, 3)], { position: vec3(0, y, 1), yawRad: 0 }, { width: 320, height: 180, camera: FRONTAL }, { frameId: `t${tick}`, captureTick: tick });
      const field = new DenseFlow().compute(pyramid(render(0, 0)), pyramid(render(deltaM, 2)));
      const errors: number[] = [];
      let sum = 0;
      for (let y = 5; y < 40; y++) {
        for (let x = 5; x < 75; x++) {
          const p = y * 80 + x;
          if (field.weight[p] <= 0) continue;
          errors.push(Math.hypot(field.u[p] - shiftPx, field.v[p]));
          sum += field.u[p];
        }
      }
      assert.ok(errors.length > 0.8 * 35 * 70, `valid vectors ${errors.length}`);
      assert.ok(median(errors) < 0.06, `median error ${median(errors)}`);
      assert.ok(Math.abs(sum / errors.length / shiftPx - 1) < 0.02);
    });
  }

  test("a dark, low-contrast frame yields no usable vectors", () => {
    const [a, b] = darkSequence({ frames: 2 });
    const field = new DenseFlow().compute(pyramid(a.frame), pyramid(b.frame));
    assert.equal(field.validFraction, 0);
  });

  test("measured rotation matches the predicted rotational field, with or without that field as a prior", () => {
    const [a, b] = yawSequence({ frames: 2, yawRateRadps: 0.8, noiseSigma: 0 });
    const prior = predictedRotationFlow(80, 45, RGB_FRONT_CAMERA, 0.02, 0.8);
    for (const field of [new DenseFlow().compute(pyramid(a.frame), pyramid(b.frame)), new DenseFlow().compute(pyramid(a.frame), pyramid(b.frame), prior)]) {
      const residuals: number[] = [];
      for (let p = 0; p < field.u.length; p++) if (field.weight[p] > 0) residuals.push(Math.hypot(field.u[p] - prior.u[p], field.v[p] - prior.v[p]));
      assert.ok(median(residuals) < 0.06, `median residual ${median(residuals)}`);
    }
  });
});

describe("rotational motion model", () => {
  test("matches exact reprojection through the pitched camera (first-order model: within 3% + 0.005 px at 1.2 rad/s)", () => {
    const yawRate = 1.2;
    const dt = 0.02;
    const f = focalLengthPx(RGB_FRONT_CAMERA, 80);
    const predicted = predictedRotationFlow(80, 45, RGB_FRONT_CAMERA, dt, yawRate);
    for (const [col, row] of [[40, 15], [3, 3], [76, 41], [10, 30], [60, 8]]) {
      const x = (col + 0.5 - 40) / f;
      const y = (row + 0.5 - 22.5) / f;
      const ray = opticalToBody(vec3(x, y, 1), RGB_FRONT_CAMERA.pitchRad);
      const after = bodyToOptical(rotateWorldToBody(yawRate * dt, ray), RGB_FRONT_CAMERA.pitchRad);
      const p = row * 80 + col;
      const exactU = (after.x / after.z - x) * f;
      const exactV = (after.y / after.z - y) * f;
      const error = Math.hypot(exactU - predicted.u[p], exactV - predicted.v[p]);
      assert.ok(error < 0.03 * Math.hypot(exactU, exactV) + 0.005, `pixel ${col},${row}: error ${error}`);
    }
  });
});
