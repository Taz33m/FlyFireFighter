/**
 * Counter-based keyed randomness.
 *
 * Every draw is a pure function of (scenario seed, stream name, tick, index), so one consumer's number of
 * draws can never reshuffle another consumer's noise, and paired runs with different controllers see the
 * same sensor noise wherever they make the same measurement.
 */

/** 32-bit FNV-1a over a string, then a murmur3 finalizer. */
function hashString(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return finalize(h);
}

function finalize(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1) keyed by (seed, stream, tick, index). */
export function keyedUniform(seed: string, stream: string, tick: number, index = 0): number {
  const key = hashString(stream, hashString(seed, 0x9e3779b9));
  const mixed = finalize(key ^ finalize(Math.imul(tick | 0, 0x27d4eb2d) ^ finalize(Math.imul((index | 0) + 1, 0x165667b1))));
  // Combine two finalized words for 53 bits of resolution.
  const high = mixed >>> 5;
  const low = finalize(mixed ^ 0x6a09e667) >>> 6;
  return (high * 67108864 + low) / 9007199254740992;
}

/** Standard normal via Box–Muller over two keyed uniforms. */
export function keyedGaussian(seed: string, stream: string, tick: number, index = 0): number {
  const u1 = Math.max(keyedUniform(seed, stream, tick, 2 * index), Number.MIN_VALUE);
  const u2 = keyedUniform(seed, stream, tick, 2 * index + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
