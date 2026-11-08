/**
 * Synthetic thermal view: the pure parts only (calibration, temperature encoding, smoke attenuation, the
 * false-colour palette, display span and readback orientation). The GPU pass itself is checked in a headed
 * browser; nothing here creates a WebGL context.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectBodyPoint, verticalFovDeg } from "../contracts/camera.ts";
import { vec3 } from "../contracts/frames.ts";
import {
  ENCODE_MAX_C, ENCODE_MIN_C, EXTERIOR_AMBIENT_C, FIXED_SPAN, MIN_AUTO_SPAN_C, OCCUPANT_SURFACE_C, SKY_C,
  apparentTemperatureC, colorizeReadback, decodeTemperature, displaySpan, encodeTemperature, flameTemperatureC,
  fuelBedTemperatureC, paletteColor, roomTemperatureAt, temperatureColor, thermalCalibration, thermalTransmittance,
} from "./thermal-camera.ts";

const luma = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("thermal calibration", () => {
  const cal = thermalCalibration("scout-s1");

  test("matches the aircraft profile's thermal-front sensor: 160 × 120, 57° HFOV, 10° pitch", () => {
    assert.ok(cal !== null);
    assert.equal(cal.id, "thermal-front/v1");
    assert.equal(cal.width, 160);
    assert.equal(cal.height, 120);
    assert.ok(Math.abs(cal.mount.pitchRad - (10 * Math.PI) / 180) < 1e-12);
    // Square pixels: the profile's stated 44° vertical field follows from the horizontal one.
    assert.ok(Math.abs(verticalFovDeg(cal) - 44) < 0.5, `vertical FOV ${verticalFovDeg(cal)}`);
  });

  test("a point 28.5° to the side of the optical axis lands on the image edge", () => {
    assert.ok(cal !== null);
    // Body frame: x forward, y left. Undo the 10° mount pitch by raising the point along the optical axis.
    const pitch = cal.mount.pitchRad;
    const forward = vec3(Math.cos(pitch), 0, -Math.sin(pitch));
    const side = Math.tan((28.5 * Math.PI) / 180);
    const point = vec3(cal.mount.positionBody.x + forward.x * 10, cal.mount.positionBody.y + side * 10, cal.mount.positionBody.z + forward.z * 10);
    const pixel = projectBodyPoint(cal, point);
    assert.ok(pixel !== null);
    assert.ok(Math.abs(pixel.u - -0.5) < 1e-6, `u = ${pixel.u}`); // y left → left edge of the image
    assert.ok(Math.abs(pixel.v - cal.cy) < 1e-6);
  });

  test("an unknown aircraft has no thermal calibration", () => {
    assert.equal(thermalCalibration("no-such-aircraft"), null);
  });
});

describe("temperature encoding", () => {
  test("round-trips inside the encoded range and clamps outside it", () => {
    for (const c of [ENCODE_MIN_C, -5, 20, 33.5, 412, ENCODE_MAX_C]) assert.ok(Math.abs(decodeTemperature(encodeTemperature(c)) - c) < 1e-9);
    assert.equal(encodeTemperature(ENCODE_MIN_C - 50), 0);
    assert.equal(encodeTemperature(ENCODE_MAX_C + 50), 1);
  });
});

describe("temperature model", () => {
  test("fire is hotter than an occupant, who is warmer than a room at 20 °C; temperatures rise with heat release", () => {
    let previous = -Infinity;
    for (const q of [5, 50, 150, 400, 2000]) {
      const flame = flameTemperatureC(q);
      assert.ok(flame > previous && flame >= 500 && flame <= 800, `flame ${flame} at ${q} kW`);
      assert.ok(fuelBedTemperatureC(q) < flame && fuelBedTemperatureC(q) > OCCUPANT_SURFACE_C);
      previous = flame;
    }
    assert.ok(OCCUPANT_SURFACE_C > 20);
  });

  test("no heat release means no fire temperature", () => {
    assert.equal(flameTemperatureC(0), EXTERIOR_AMBIENT_C);
    assert.equal(fuelBedTemperatureC(Number.NaN), EXTERIOR_AMBIENT_C);
  });

  test("smoke that nearly blinds the RGB camera only partly attenuates thermal", () => {
    const tau = 3; // visible transmittance e^-3 ≈ 0.05
    const t = thermalTransmittance(tau);
    assert.ok(t > 0.7 && t < 1, `thermal transmittance ${t}`);
    assert.equal(thermalTransmittance(0), 1);
    assert.ok(thermalTransmittance(40) < 0.05, "dense smoke still hides detail: thermal is not immune");
  });

  test("apparent temperature moves toward the gas temperature, never past it", () => {
    const seen = apparentTemperatureC(OCCUPANT_SURFACE_C, 60, 5);
    assert.ok(seen > OCCUPANT_SURFACE_C && seen < 60);
    assert.equal(apparentTemperatureC(OCCUPANT_SURFACE_C, 60, 0), OCCUPANT_SURFACE_C);
  });

  test("room lookup uses the simulated room temperature inside, the exterior ambient outside", () => {
    const boxes = [{ roomId: "bedroom", min: [0, 0, 3] as const, max: [4, 4, 6] as const }, { roomId: "attic", min: [0, 0, 6] as const, max: [4, 4, 8] as const }];
    const temps = new Map([["bedroom", 48]]);
    assert.equal(roomTemperatureAt(vec3(2, 2, 4), boxes, temps), 48);
    assert.equal(roomTemperatureAt(vec3(9, 2, 4), boxes, temps), EXTERIOR_AMBIENT_C);
    assert.equal(roomTemperatureAt(vec3(2, 2, 7), boxes, temps), EXTERIOR_AMBIENT_C, "a room missing from the snapshot is not invented");
  });
});

describe("false-colour palette", () => {
  test("runs from black to near-white with monotonically rising luminance", () => {
    assert.deepEqual(paletteColor(0), [0, 0, 0]);
    assert.ok(luma(paletteColor(1)) > 245);
    let previous = -1;
    for (let i = 0; i <= 200; i++) {
      const l = luma(paletteColor(i / 200));
      assert.ok(l >= previous - 1e-9, `luminance drops at ${i / 200}`);
      previous = l;
    }
  });

  test("clamps out-of-range and non-finite inputs", () => {
    assert.deepEqual(paletteColor(-3), paletteColor(0));
    assert.deepEqual(paletteColor(7), paletteColor(1));
    assert.deepEqual(paletteColor(Number.NaN), paletteColor(0));
  });

  test("in the fixed span a fire saturates while an occupant is visibly warmer than the room", () => {
    assert.deepEqual(temperatureColor(flameTemperatureC(200), FIXED_SPAN), paletteColor(1));
    assert.ok(luma(temperatureColor(OCCUPANT_SURFACE_C, FIXED_SPAN)) > luma(temperatureColor(20, FIXED_SPAN)));
  });
});

describe("display span", () => {
  test("fixed mode ignores the frame", () => {
    assert.deepEqual(displaySpan([20, 600], "fixed"), FIXED_SPAN);
  });

  test("auto mode excludes a single hot pixel and keeps room and occupant apart", () => {
    const frame = new Float32Array(19200).fill(20);
    frame.fill(OCCUPANT_SURFACE_C, 0, 1500);
    frame[100] = 700;
    const span = displaySpan(frame, "auto");
    assert.ok(span.maxC < 700);
    assert.ok(span.minC <= 20 && span.maxC >= OCCUPANT_SURFACE_C);
  });

  test("sky pixels do not stretch the auto span, so ambient ground is not shown at the top of the palette", () => {
    const frame = new Float32Array(1000).fill(EXTERIOR_AMBIENT_C);
    frame.fill(SKY_C, 0, 400);
    const span = displaySpan(frame, "auto");
    assert.ok(span.minC > SKY_C && span.maxC > EXTERIOR_AMBIENT_C, `span ${span.minC}..${span.maxC}`);
    assert.ok(Math.abs(displaySpan(new Float32Array(10).fill(SKY_C), "auto").minC - (SKY_C - MIN_AUTO_SPAN_C / 2)) < 1e-9, "an all-sky frame still gets a span");
  });

  test("a uniform frame is widened to the minimum span around its value", () => {
    const span = displaySpan(new Float32Array(100).fill(21), "auto");
    assert.ok(Math.abs(span.maxC - span.minC - MIN_AUTO_SPAN_C) < 1e-9);
    assert.ok(Math.abs((span.maxC + span.minC) / 2 - 21) < 1e-9);
  });
});

describe("readback colourisation", () => {
  test("flips WebGL rows so the top image row is the last readback row, for float and byte targets", () => {
    const width = 3;
    const height = 2;
    const hot = encodeTemperature(400);
    const cold = encodeTemperature(10);
    const float = new Float32Array(width * height * 4);
    for (let i = 0; i < width; i++) float[i * 4] = hot; // readback row 0 = bottom of the image
    for (let i = width; i < width * height; i++) float[i * 4] = cold;
    const image = colorizeReadback(float, width, height, "fixed");
    assert.ok(Math.abs(image.temperatures[width * (height - 1)] - 400) < 1e-3, "bottom image row is hot");
    assert.ok(Math.abs(image.temperatures[0] - 10) < 1e-3, "top image row is cold");
    assert.equal(image.rgba.length, width * height * 4);
    assert.equal(image.rgba[3], 255);
    const bytes = new Uint8Array(float.length);
    float.forEach((v, i) => { bytes[i] = Math.round(v * 255); });
    const fromBytes = colorizeReadback(bytes, width, height, "fixed");
    assert.ok(Math.abs(fromBytes.maxC - 400) < (ENCODE_MAX_C - ENCODE_MIN_C) / 255, "8-bit targets decode within one quantisation step");
    assert.equal(image.centreC, image.temperatures[1 * width + 1]);
  });
});
