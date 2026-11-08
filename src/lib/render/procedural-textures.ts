/**
 * Deterministic procedural detail textures for the drone camera and the twin view.
 *
 * The exported scene uses flat procedural colours, so optical flow and FlyVis T4/T5 motion cells would
 * see almost no signal between edges. Each material class gets a seamless, single-channel 256 × 256
 * pattern (brick, plaster, wood grain, fabric, stone, paving, roof seams, foliage, carpet) generated here
 * in plain arithmetic, with no canvas, so it is byte-identical in every browser, run and controller. The
 * shader maps it in world units with triplanar projection (the GLB has no UVs) and modulates albedo by
 * 1 + strength · (2d − 1). Change TEXTURE_SET_VERSION (and the checksum in the test) whenever any
 * pattern, size or class assignment changes.
 */

export const TEXTURE_SET_VERSION = "procedural-detail/v1";
export const DETAIL_SIZE = 256;

export type DetailClass = "brick" | "plaster" | "wood" | "fabric" | "stone" | "paving" | "roof" | "foliage" | "carpet";

/** World size of one texture tile (metres) and albedo modulation depth. */
export const DETAIL_SPECS: Readonly<Record<DetailClass, { readonly tileM: number; readonly strength: number }>> = {
  brick: { tileM: 0.9, strength: 0.32 },
  plaster: { tileM: 1.6, strength: 0.14 },
  wood: { tileM: 0.9, strength: 0.28 },
  fabric: { tileM: 0.3, strength: 0.2 },
  stone: { tileM: 1.2, strength: 0.22 },
  paving: { tileM: 1.2, strength: 0.28 },
  roof: { tileM: 2.0, strength: 0.2 },
  foliage: { tileM: 1.0, strength: 0.34 },
  carpet: { tileM: 0.5, strength: 0.18 },
};

const RULES: readonly (readonly [RegExp, DetailClass])[] = [
  [/brick/, "brick"],
  [/carpet/, "carpet"],
  [/fabric|linen/, "fabric"],
  [/wood|bench|stair/, "wood"],
  [/paver|tile|floor_stone/, "paving"],
  [/asphalt|concrete|curb|slate|stone/, "stone"],
  [/roof|copper/, "roof"],
  [/grass|foliage|plant|bark|shrub/, "foliage"],
  [/paint|ceiling|plaster|white_furn|cardboard/, "plaster"],
];

/** Material class from an exported material name; null (no detail) for glass, metal, lights and the aircraft. */
export function classifyMaterial(name: string): DetailClass | null {
  const lower = name.toLowerCase();
  if (/glass|lens|light|drone|^metal/.test(lower)) return null;
  return RULES.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
}

/** FNV-1a 32-bit hash of a string. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** Integer lattice hash → [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Periodic value noise with `cells` lattice cells across the tile; u, v in [0, 1). */
function valueNoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const c = (i: number, j: number) => hash2(mod(x0 + i, cells), mod(y0 + j, cells), seed);
  const top = c(0, 0) + (c(1, 0) - c(0, 0)) * fx;
  const bottom = c(0, 1) + (c(1, 1) - c(0, 1)) * fx;
  return top + (bottom - top) * fy;
}

function fractal(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const amplitude = 0.5 ** o;
    sum += amplitude * valueNoise(u, v, base * 2 ** o, seed + o * 1013);
    norm += amplitude;
  }
  return sum / norm;
}

type Pattern = (u: number, v: number, seed: number) => number;

const PATTERNS: Readonly<Record<DetailClass, Pattern>> = {
  brick: (u, v, seed) => {
    const rows = 12;
    const row = Math.floor(v * rows);
    const shifted = mod(u * 4 + (row % 2) * 0.5, 4);
    const col = Math.floor(shifted);
    const mortar = v * rows - row < 0.12 || shifted - col < 0.04;
    const tint = hash2(mod(col, 4), row, seed);
    return mortar ? 0.12 + 0.1 * fractal(u, v, 32, 2, seed) : 0.45 + 0.35 * tint + 0.2 * fractal(u, v, 16, 3, seed + 7) - 0.1;
  },
  plaster: (u, v, seed) => fractal(u, v, 4, 5, seed),
  wood: (u, v, seed) => {
    const planks = 6;
    const plank = Math.floor(u * planks);
    const within = u * planks - plank;
    if (within < 0.03) return 0.08;
    const grain = 0.5 + 0.5 * Math.sin(2 * Math.PI * (within * 3 + 2.5 * fractal(u, v, 8, 3, seed + plank)));
    return 0.25 + 0.35 * hash2(plank, 0, seed) + 0.4 * grain * 0.8;
  },
  fabric: (u, v, seed) => 0.5 + 0.3 * Math.sin(2 * Math.PI * u * 32) * Math.sin(2 * Math.PI * v * 32) + 0.25 * (fractal(u, v, 16, 2, seed) - 0.5),
  stone: (u, v, seed) => 0.35 * fractal(u, v, 8, 4, seed) + 0.65 * (hash2(Math.floor(u * 128), Math.floor(v * 128), seed + 3) * 0.5 + fractal(u, v, 32, 2, seed + 5) * 0.5),
  paving: (u, v, seed) => {
    const n = 4;
    const tx = Math.floor(u * n);
    const ty = Math.floor(v * n);
    const grout = u * n - tx < 0.05 || v * n - ty < 0.05;
    return grout ? 0.1 : 0.35 + 0.35 * hash2(tx, ty, seed) + 0.3 * fractal(u, v, 16, 3, seed + 11);
  },
  roof: (u, v, seed) => {
    const seams = 4;
    const within = u * seams - Math.floor(u * seams);
    return within < 0.04 ? 0.92 : within < 0.08 ? 0.1 : 0.4 + 0.3 * fractal(u, v, 8, 3, seed);
  },
  foliage: (u, v, seed) => Math.min(1, Math.max(0, 1.6 * (fractal(u, v, 16, 4, seed) - 0.5) + 0.5)),
  carpet: (u, v, seed) => 0.45 * fractal(u, v, 64, 2, seed) + 0.55 * hash2(Math.floor(u * 256), Math.floor(v * 256), seed + 9),
};

/** One class's texture as 8-bit values, row-major, seamless across both edges. */
export function generateDetail(cls: DetailClass, size = DETAIL_SIZE): Uint8Array {
  const seed = fnv1a(`${TEXTURE_SET_VERSION}:${cls}`);
  const pattern = PATTERNS[cls];
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = pattern((x + 0.5) / size, (y + 0.5) / size, seed);
      out[y * size + x] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
  }
  return out;
}

export const DETAIL_CLASSES = Object.keys(DETAIL_SPECS) as DetailClass[];
