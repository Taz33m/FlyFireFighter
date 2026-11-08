import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import { calibrationFromSensor } from "../../contracts/camera.ts";
import { horizontalFovDeg, parseNeuralError, parseNeuralReady, resetRequestFor } from "./messages.ts";

// Scope: pure helpers for flyfirefighter.neural/1 messages that the shared contract does not parse.

const rgb = TENDER_T1.sensors.find(s => s.id === "rgb-front");
if (rgb === undefined) throw new Error("fixture: rgb-front sensor missing");
const calibration = calibrationFromSensor(rgb, 1);

describe("neural reset request", () => {
  test("derives the horizontal field of view from the intrinsics, not from the sensor spec", () => {
    assert.ok(Math.abs(horizontalFovDeg(calibration) - 90) < 1e-9);
    assert.ok(Math.abs(horizontalFovDeg({ ...calibration, fx: calibration.fx * 2 }) - (2 * Math.atan(0.5) * 180) / Math.PI) < 1e-9);
  });

  test("refuses calibrations the service could not lock", () => {
    assert.throws(() => resetRequestFor("run-1", { ...calibration, width: 1 }), RangeError);
    assert.throws(() => resetRequestFor("run-1", { ...calibration, height: 180.5 }), RangeError);
    assert.throws(() => resetRequestFor("run-1", { ...calibration, fx: 0 }), RangeError);
    assert.throws(() => resetRequestFor("run-1", { ...calibration, id: "" }), RangeError);
  });
});

describe("neural replies", () => {
  test("accepts a ready from the pinned service", () => {
    const ready = {
      type: "ready", protocol: "flyfirefighter.neural/1", runId: "run-1",
      model: {
        name: "flow/0000/000", checkpoint: "results/flow/0000/000/chkpts/chkpt_00000",
        checkpointSha256: "d0e42857e738d0315897c2d50fde9eb3fb1a3fb1f071d55dfc13d53d72bccc3f",
        upstreamCommit: "0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa", weightsLicenseStatus: "UNCLEAR",
      },
      eye: { extent: 15, hexals: 721 }, warmupSteps: 50,
    };
    assert.ok(parseNeuralReady(ready).ok);
    assert.equal(parseNeuralReady({ ...ready, eye: { extent: 15, hexals: 721, lockedWidth: 320 } }).ok, false);
  });

  test("error replies must use a contract code and may omit run and seq", () => {
    assert.ok(parseNeuralError({ type: "error", runId: null, seq: null, code: "bad_request", message: "service busy" }).ok);
    assert.ok(parseNeuralError({ type: "error", runId: "run-1", seq: 3, code: "out_of_order", message: "expected seq 2" }).ok);
    assert.equal(parseNeuralError({ type: "error", runId: null, seq: null, code: "retry_later", message: "" }).ok, false);
    assert.equal(parseNeuralError({ type: "error", runId: null, seq: -1, code: "internal", message: "" }).ok, false);
  });
});
