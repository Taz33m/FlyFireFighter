/**
 * .FWI encoding against the official converter. Scope: a 4 × 3 image covering the console palette, pure black,
 * pure white and near-black values, encoded by `fwi-convert` from the freewili 0.0.51 SDK (2026-11-08), must match
 * byte for byte; header fields; and size validation.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FWI_HEADER_BYTES, encodeFwi, rgb565 } from "./fwi.ts";

/** The fixture's pixels, row by row (as written to fixture.png). */
const PIXELS: readonly (readonly [number, number, number])[] = [
  [17, 23, 20], [252, 101, 43], [210, 244, 132], [238, 243, 233],
  [255, 128, 112], [159, 211, 245], [0, 0, 0], [255, 255, 255],
  [1, 2, 3], [128, 64, 32], [8, 4, 8], [37, 41, 36],
];
/** `fwi-convert -i fixture.png -o fixture.fwi`, hex. */
const OFFICIAL = "46573031494d4700010000000c000000040003000000000010a2f305cf90e79cfbed9e9d0000ffff000079e300002144";

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

describe("FWI encoding", () => {
  test("matches the official converter byte for byte", () => {
    const rgba = new Uint8Array(PIXELS.flatMap(([r, g, b]) => [r, g, b, 255]));
    assert.equal(hex(encodeFwi(rgba, 4, 3)), OFFICIAL);
  });

  test("header: magic, transparency flag, pixel count, size; a full screen is 153,624 bytes", () => {
    const out = encodeFwi(new Uint8Array(320 * 240 * 4).fill(40), 320, 240);
    const view = new DataView(out.buffer);
    assert.equal(String.fromCharCode(...out.slice(0, 7)), "FW01IMG");
    assert.equal(view.getUint32(8, true), 1);
    assert.equal(view.getUint32(12, true), 76800);
    assert.equal(view.getUint16(16, true), 320);
    assert.equal(view.getUint16(18, true), 240);
    assert.equal(out.length, FWI_HEADER_BYTES + 153600);
  });

  test("channels are truncated, not rounded, as in the converter", () => {
    assert.equal(rgb565(8, 4, 8), 0); // would round up to non-zero
    assert.equal(rgb565(255, 255, 255), 0xffff);
  });

  test("rejects a buffer that does not match the size, or an impossible size", () => {
    assert.throws(() => encodeFwi(new Uint8Array(4 * 4), 2, 3));
    assert.throws(() => encodeFwi(new Uint8Array(0), 0, 0));
  });
});
