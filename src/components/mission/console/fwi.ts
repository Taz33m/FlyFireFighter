/**
 * FreeWili image (.FWI) encoder, byte-for-byte the official converter (`fwi-convert` in the freewili Python
 * SDK 0.0.51, freewili/image.py). Pure and browser-safe.
 *
 * Layout: a 24-byte little-endian header — "FW01IMG\0", flags u32 = 1, pixel count u32, width u16, height u16,
 * transparent colour u16 = 0, image id u16 = 0 — then one RGB565 value per pixel, rows top to bottom, each value
 * stored high byte first. Channels are scaled as trunc(c / 255 × 31|63|31), as the converter does. Flag 1 marks
 * colour 0 (pure black) as transparent, so screens should not rely on pure black.
 *
 * Not used by the console on OG firmware v024, which refuses file-backed images ("NotSupported file-backed images
 * are not supported on FreeWili OG"); kept for firmware that can show them (docs/commander-console.md).
 */

export const FWI_HEADER_BYTES = 24;

/** RGB565 for one 8-bit-per-channel colour, as the official converter computes it. */
export function rgb565(r: number, g: number, b: number): number {
  return (Math.trunc((r / 255) * 31) << 11) | (Math.trunc((g / 255) * 63) << 5) | Math.trunc((b / 255) * 31);
}

/** Encode RGBA pixels (alpha ignored, as for an RGB source image) into an .FWI file. */
export function encodeFwi(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 0x7fff || height > 0x7fff) {
    throw new RangeError(`Invalid FWI size ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) throw new RangeError("Pixel buffer does not match the image size");
  const out = new Uint8Array(FWI_HEADER_BYTES + width * height * 2);
  const view = new DataView(out.buffer);
  [0x46, 0x57, 0x30, 0x31, 0x49, 0x4d, 0x47, 0x00].forEach((byte, i) => { out[i] = byte; }); // "FW01IMG\0"
  view.setUint32(8, 1, true);
  view.setUint32(12, width * height, true);
  view.setUint16(16, width, true);
  view.setUint16(18, height, true);
  view.setUint16(20, 0, true);
  view.setUint16(22, 0, true);
  for (let p = 0; p < width * height; p++) {
    view.setUint16(FWI_HEADER_BYTES + p * 2, rgb565(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]), false);
  }
  return out;
}
