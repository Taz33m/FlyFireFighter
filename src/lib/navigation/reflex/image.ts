/**
 * Small-image utilities for the optical-flow baseline: area resampling to the flow grid, a binomial
 * pyramid, central-difference gradients, truncated box sums and bilinear sampling. Row-major Float32Array
 * images; pixel (x, y) has its centre at integer coordinates.
 */
import type { CameraFrame } from "./types.ts";

export interface ImageLevel {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** Finest level first. */
export type Pyramid = readonly ImageLevel[];

/** Area-average a frame onto a width×height grid. Non-finite samples count as 0; values are clamped to [0, 1]. */
export function resampleToGrid(frame: CameraFrame, width: number, height: number): Float32Array {
  const { width: sw, height: sh, luminance } = frame;
  if (sw < width || sh < height || luminance.length !== sw * sh) throw new RangeError(`Cannot resample a ${sw}×${sh} frame to ${width}×${height}`);
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const r0 = Math.floor((j * sh) / height);
    const r1 = Math.max(r0 + 1, Math.floor(((j + 1) * sh) / height));
    for (let i = 0; i < width; i++) {
      const c0 = Math.floor((i * sw) / width);
      const c1 = Math.max(c0 + 1, Math.floor(((i + 1) * sw) / width));
      let sum = 0;
      for (let r = r0; r < r1; r++) {
        for (let c = r * sw + c0, end = r * sw + c1; c < end; c++) {
          const value = luminance[c];
          sum += value > 0 ? (value < 1 ? value : 1) : 0;
        }
      }
      out[j * width + i] = sum / ((r1 - r0) * (c1 - c0));
    }
  }
  return out;
}

/** Separable [1 2 1]/4 blur with replicated borders. */
function blur121(src: Float32Array, w: number, h: number, tmp: Float32Array, out: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = 0.25 * src[row + (x > 0 ? x - 1 : 0)] + 0.5 * src[row + x] + 0.25 * src[row + (x < w - 1 ? x + 1 : w - 1)];
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const mid = y * w;
    const down = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) out[mid + x] = 0.25 * tmp[up + x] + 0.5 * tmp[mid + x] + 0.25 * tmp[down + x];
  }
}

function halve(src: ImageLevel): ImageLevel {
  const width = Math.floor(src.width / 2);
  const height = Math.floor(src.height / 2);
  const data = new Float32Array(width * height);
  const s = src.data;
  const w = src.width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = 2 * y * w + 2 * x;
      data[y * width + x] = 0.25 * (s[p] + s[p + 1] + s[p + w] + s[p + w + 1]);
    }
  }
  return { width, height, data };
}

/** Gaussian-like pyramid: blurred grid, then repeated 2×2 averaging and blurring while the level stays ≥ 16×10. */
export function buildPyramid(grid: Float32Array, width: number, height: number, levels: number): Pyramid {
  const tmp = new Float32Array(width * height);
  const base = new Float32Array(width * height);
  blur121(grid, width, height, tmp, base);
  const out: ImageLevel[] = [{ width, height, data: base }];
  while (out.length < levels && out[out.length - 1].width >= 32 && out[out.length - 1].height >= 20) {
    const half = halve(out[out.length - 1]);
    const smoothed = new Float32Array(half.data.length);
    blur121(half.data, half.width, half.height, tmp, smoothed);
    out.push({ width: half.width, height: half.height, data: smoothed });
  }
  return out;
}

/** Central-difference gradients (one-sided at the borders). */
export function gradients(level: ImageLevel, ix: Float32Array, iy: Float32Array): void {
  const { width: w, height: h, data } = level;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = (y > 0 ? y - 1 : y) * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    const sy = down - up === 2 * w ? 0.5 : 1;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : x;
      const xr = x < w - 1 ? x + 1 : x;
      ix[row + x] = (data[row + xr] - data[row + xl]) / (xr - xl);
      iy[row + x] = (data[down + x] - data[up + x]) * sy;
    }
  }
}

const B5 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

/** One row or column of the 5-tap binomial mean; weights are renormalised where the window leaves the image. */
function smoothLine(src: Float32Array, dst: Float32Array, offset: number, step: number, len: number): void {
  for (let i = 0; i < len; i++) {
    const p = offset + i * step;
    if (i >= 2 && i < len - 2) {
      dst[p] = 0.375 * src[p] + 0.25 * (src[p - step] + src[p + step]) + 0.0625 * (src[p - 2 * step] + src[p + 2 * step]);
      continue;
    }
    let acc = 0;
    let norm = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= len) continue;
      acc += B5[k + 2] * src[offset + j * step];
      norm += B5[k + 2];
    }
    dst[p] = acc / norm;
  }
}

/**
 * Separable 5×5 binomial weighted mean ([1 4 6 4 1]/16 per axis, σ ≈ 1 px). Used as the Lucas–Kanade window:
 * unlike a box, its frequency response is non-negative, so the dense iteration never amplifies
 * high-frequency flow errors (a box window's negative side lobes make them grow with every iteration).
 */
export function binomialMean5(src: Float32Array, w: number, h: number, tmp: Float32Array, out: Float32Array): void {
  for (let y = 0; y < h; y++) smoothLine(src, tmp, y * w, 1, w);
  for (let x = 0; x < w; x++) smoothLine(tmp, out, x, w, h);
}

/** Catmull–Rom weights for samples at offsets −1, 0, 1, 2 from the integer part of the coordinate. */
function cubicWeights(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

const WX = new Float64Array(4);
const WY = new Float64Array(4);

/**
 * Catmull–Rom bicubic sample with clamped borders. Used for the Lucas–Kanade warp: bilinear interpolation
 * smooths the warped image by an amount that depends on the sub-pixel offset and the local texture, which
 * left ~0.1 px structured flow errors (enough to fake divergence in a small window); bicubic removes most.
 */
export function bicubic(level: ImageLevel, x: number, y: number): number {
  const { width: w, height: h, data } = level;
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  cubicWeights(cx - x0, WX);
  cubicWeights(cy - y0, WY);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const yy = y0 + j - 1;
    const row = (yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy) * w;
    let acc = 0;
    for (let i = 0; i < 4; i++) {
      const xx = x0 + i - 1;
      acc += WX[i] * data[row + (xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx)];
    }
    sum += WY[j] * acc;
  }
  return sum;
}

export function bilinear(level: ImageLevel, x: number, y: number): number {
  const { width: w, height: h, data } = level;
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const fx = cx - x0;
  const fy = cy - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
