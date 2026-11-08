import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { CameraFrame } from "../../contracts/camera.ts";
import { calibrationFromSensor } from "../../contracts/camera.ts";
import { NeuralClient } from "./client.ts";
import { NeuralClientError } from "./errors.ts";
import { connectWebSocketTransport } from "./transport.ts";

// Scope: opt-in, cross-process check of the real WebSocket transport and NeuralClient against the
// running FlyVis service (services/flyvis: `.venv/bin/python -m flyvis_service.server`). Skipped unless
// FLYFIREFIGHTER_NEURAL_LIVE=1. Frames are synthetic drifting gratings, not simulator renders.

const live = process.env.FLYFIREFIGHTER_NEURAL_LIVE === "1";
const skip = live ? false : "set FLYFIREFIGHTER_NEURAL_LIVE=1 with the FlyVis service running on 127.0.0.1:3201";

const rgb = TENDER_T1.sensors.find(s => s.id === "rgb-front");
if (rgb === undefined) throw new Error("fixture: rgb-front sensor missing");
const calibration = calibrationFromSensor(rgb, 1);

/** Sinusoidal grating drifting horizontally; period 0.25 of the central square crop, 2 Hz. */
function grating(index: number, direction: 1 | -1): CameraFrame {
  const { width, height } = calibration;
  const side = Math.min(width, height);
  const t = (index + 1) * 0.02;
  const luminance = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xc = (x + 0.5 - width / 2) / side;
      luminance[y * width + x] = 0.5 + 0.4 * Math.sin((2 * Math.PI * (xc - direction * 0.5 * t)) / 0.25);
    }
  }
  return { frameId: `g${direction}-${index}`, captureTick: 2 * index, calibrationId: calibration.id, width, height, luminance };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

describe("FlyVis service, live", { skip }, () => {
  test("ready validates, drift direction survives the wire, and round trips are measured", async () => {
    const client = new NeuralClient(await connectWebSocketTransport(), { stepDeadlineMs: 200 });
    try {
      const results: Record<string, number> = {};
      const roundTrips: number[] = [];
      for (const direction of [1, -1] as const) {
        const ready = await client.reset(`live-${direction}`, calibration);
        assert.equal(ready.eye.hexals, 721);
        const center: number[] = [];
        for (let i = 0; i < 150; i++) {
          const frame = grating(i, direction);
          const started = performance.now();
          const features = await client.step(frame, frame.captureTick);
          if (i > 0) roundTrips.push(performance.now() - started);
          if (i >= 100) center.push(features.horizontalMotion[1]);
        }
        results[direction === 1 ? "rightward" : "leftward"] = center.reduce((a, b) => a + b, 0) / center.length;
      }
      const median = percentile(roundTrips, 50);
      const p99 = percentile(roundTrips, 99);
      console.log(`[live] 320x180 round trip over ${roundTrips.length} steps: median ${median.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms; ` +
        `center horizontalMotion rightward ${results.rightward.toFixed(4)}, leftward ${results.leftward.toFixed(4)}`);
      assert.ok(results.rightward > 0 && results.leftward < 0, "row-major top-left frames keep image-right as rightward motion");
    } finally {
      client.close();
      await client.closed;
    }
  });

  test("a second client is refused while one is connected, and can connect once it closes", async () => {
    const first = new NeuralClient(await connectWebSocketTransport());
    await first.reset("live-first", calibration);
    const second = new NeuralClient(await connectWebSocketTransport());
    await assert.rejects(second.reset("live-second", calibration), (error: unknown) => error instanceof NeuralClientError && (error.code === "service" || error.code === "closed"));
    assert.equal((await second.closed).code, 1013);
    first.close();
    await first.closed;
    const third = new NeuralClient(await connectWebSocketTransport());
    try {
      assert.equal((await third.reset("live-third", calibration)).runId, "live-third");
    } finally {
      third.close();
      await third.closed;
    }
  });
});
