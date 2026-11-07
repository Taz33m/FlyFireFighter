/**
 * Dense pyramidal Lucas–Kanade optical flow on a small luminance grid (default 80×45).
 *
 * Why Lucas–Kanade rather than Horn–Schunck: LK is local, so every vector carries its own reliability
 * (the smaller eigenvalue of the 2×2 structure tensor, plus the post-warp residual). The controller needs
 * that to tell "no motion" from "no information": a dark or textureless frame yields rejected vectors and
 * low confidence instead of Horn–Schunck's smoothness fill-in, which invents plausible flow from
 * neighbours. A three-level pyramid handles the 2–4 px/frame motions expected at 50 Hz on this grid, and
 * the cost is a fixed number of O(N) passes (no data-dependent iteration counts).
 *
 * Formulation (iterative dense LK): per level, warp the next image by the current flow (bicubic), form the temporal
 * residual It, take window means of Ix·It and Iy·It (5×5 binomial window, see image.ts) and solve
 * (G + αI)·d = −b per pixel, where G is the window-mean structure tensor of the previous image. The small Tikhonov term α keeps textureless pixels from
 * exploding. Noise robustness: area averaging to the grid, a binomial blur at every level, the
 * eigenvalue/residual gates and, downstream, robust region pooling.
 *
 * An optional prior flow (e.g. the rotation predicted from the efference copy) initialises the coarsest
 * level, so the solver only estimates the residual. Without it the regularised update under-estimates
 * rotation where texture is weak, and that spatially varying shortfall reads as spurious divergence.
 */
import type { ImageLevel, Pyramid } from "./image.ts";
import { bicubic, bilinear, binomialMean5, gradients } from "./image.ts";

export interface FlowConfig {
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly levels: number;
  readonly iterations: number;
  /** Smallest eigenvalue of the window-mean structure tensor (luminance² per pixel²) for a usable vector. */
  readonly minEigen: number;
  /** Largest window-mean |It| after convergence for a usable vector (rejects occlusions and aliasing). */
  readonly maxResidual: number;
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = Object.freeze({ gridWidth: 80, gridHeight: 45, levels: 3, iterations: 4, minEigen: 4e-5, maxResidual: 0.04 });

/** Diagonal regularisation of G (luminance² units). */
const TIKHONOV = 4e-6;
/** Largest flow increment per iteration, in pixels of the current level. */
const MAX_STEP_PX = 1;

/** Prior displacement field at grid resolution (grid pixels, previous → current). */
export interface FlowPrior {
  readonly u: Float32Array;
  readonly v: Float32Array;
}

export interface FlowField {
  readonly width: number;
  readonly height: number;
  /** Displacement from the previous to the current image in grid pixels: u to the right, v downward. */
  readonly u: Float32Array;
  readonly v: Float32Array;
  /** Reliability in [0, 1]; 0 marks a rejected vector. */
  readonly weight: Float32Array;
  readonly validFraction: number;
  /** RMS luminance gradient of the previous grid image, per grid pixel. */
  readonly contrast: number;
}

interface LevelBuffers {
  readonly ix: Float32Array;
  readonly iy: Float32Array;
  readonly sxx: Float32Array;
  readonly sxy: Float32Array;
  readonly syy: Float32Array;
  readonly u: Float32Array;
  readonly v: Float32Array;
  readonly ex: Float32Array;
  readonly ey: Float32Array;
  readonly bx: Float32Array;
  readonly by: Float32Array;
  readonly res: Float32Array;
  readonly tmp: Float32Array;
  readonly inside: Uint8Array;
}

function allocate(n: number): LevelBuffers {
  const f = () => new Float32Array(n);
  return { ix: f(), iy: f(), sxx: f(), sxy: f(), syy: f(), u: f(), v: f(), ex: f(), ey: f(), bx: f(), by: f(), res: f(), tmp: f(), inside: new Uint8Array(n) };
}

function structureTensor(level: ImageLevel, b: LevelBuffers): void {
  const { width: w, height: h } = level;
  gradients(level, b.ix, b.iy);
  for (let p = 0; p < w * h; p++) {
    b.ex[p] = b.ix[p] * b.ix[p];
    b.ey[p] = b.iy[p] * b.iy[p];
    b.bx[p] = b.ix[p] * b.iy[p];
  }
  binomialMean5(b.ex, w, h, b.tmp, b.sxx);
  binomialMean5(b.ey, w, h, b.tmp, b.syy);
  binomialMean5(b.bx, w, h, b.tmp, b.sxy);
}

/** Initialise a level's flow from the next coarser level (coordinates and displacements doubled). */
function upsample(coarse: LevelBuffers, cw: number, ch: number, fine: LevelBuffers, fw: number, fh: number): void {
  const cu: ImageLevel = { width: cw, height: ch, data: coarse.u };
  const cv: ImageLevel = { width: cw, height: ch, data: coarse.v };
  for (let y = 0; y < fh; y++) {
    const yc = (y + 0.5) / 2 - 0.5;
    for (let x = 0; x < fw; x++) {
      const xc = (x + 0.5) / 2 - 0.5;
      fine.u[y * fw + x] = 2 * bilinear(cu, xc, yc);
      fine.v[y * fw + x] = 2 * bilinear(cv, xc, yc);
    }
  }
}

/** Coarsest-level initial flow: zero, or the prior sampled at this level's pixel centres and scaled by 2^-k. */
function initialise(b: LevelBuffers, w: number, h: number, k: number, fine: ImageLevel, prior: FlowPrior | undefined): void {
  if (!prior) {
    b.u.fill(0);
    b.v.fill(0);
    return;
  }
  const scale = 2 ** k;
  const pu: ImageLevel = { width: fine.width, height: fine.height, data: prior.u };
  const pv: ImageLevel = { width: fine.width, height: fine.height, data: prior.v };
  for (let y = 0; y < h; y++) {
    const yf = (y + 0.5) * scale - 0.5;
    for (let x = 0; x < w; x++) {
      const xf = (x + 0.5) * scale - 0.5;
      b.u[y * w + x] = bilinear(pu, xf, yf) / scale;
      b.v[y * w + x] = bilinear(pv, xf, yf) / scale;
    }
  }
}

/** It = next(x + flow) − prev(x); stores Ix·It, Iy·It, |It| and whether the warped sample is inside. */
function warpResidual(prev: ImageLevel, next: ImageLevel, b: LevelBuffers): void {
  const { width: w, height: h } = prev;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const xw = x + b.u[p];
      const yw = y + b.v[p];
      const inside = xw >= -0.5 && xw <= w - 0.5 && yw >= -0.5 && yw <= h - 0.5;
      const it = inside ? bicubic(next, xw, yw) - prev.data[p] : 0;
      b.inside[p] = inside ? 1 : 0;
      b.ex[p] = b.ix[p] * it;
      b.ey[p] = b.iy[p] * it;
      b.res[p] = Math.abs(it);
    }
  }
}

const clampStep = (d: number): number => (d > MAX_STEP_PX ? MAX_STEP_PX : d < -MAX_STEP_PX ? -MAX_STEP_PX : d);

function solveUpdate(b: LevelBuffers, n: number): void {
  for (let p = 0; p < n; p++) {
    const sxx = b.sxx[p] + TIKHONOV;
    const syy = b.syy[p] + TIKHONOV;
    const sxy = b.sxy[p];
    const det = sxx * syy - sxy * sxy;
    b.u[p] += clampStep(-(syy * b.bx[p] - sxy * b.by[p]) / det);
    b.v[p] += clampStep(-(sxx * b.by[p] - sxy * b.bx[p]) / det);
  }
}

export function minEigenvalue(sxx: number, sxy: number, syy: number): number {
  const half = (sxx - syy) / 2;
  return (sxx + syy) / 2 - Math.sqrt(half * half + sxy * sxy);
}

/** Per-vector reliability: an eigenvalue ramp from minEigen to 4·minEigen, zeroed by the residual/inside gates. */
function finalWeights(b: LevelBuffers, w: number, h: number, config: FlowConfig, weight: Float32Array): number {
  binomialMean5(b.res, w, h, b.tmp, b.ex);
  let valid = 0;
  for (let p = 0; p < w * h; p++) {
    const ramp = (minEigenvalue(b.sxx[p], b.sxy[p], b.syy[p]) - config.minEigen) / (3 * config.minEigen);
    const usable = b.inside[p] === 1 && b.ex[p] <= config.maxResidual && ramp > 0;
    weight[p] = usable ? Math.min(1, ramp) : 0;
    if (usable) valid++;
  }
  return valid;
}

function rmsGradient(b: LevelBuffers, n: number): number {
  let sum = 0;
  for (let p = 0; p < n; p++) sum += b.ix[p] * b.ix[p] + b.iy[p] * b.iy[p];
  return Math.sqrt(sum / n);
}

/** Reusable dense flow solver. Buffers are owned by the instance; returned fields are fresh copies. */
export class DenseFlow {
  readonly config: FlowConfig;
  private readonly buffers: LevelBuffers[] = [];

  constructor(config: FlowConfig = DEFAULT_FLOW_CONFIG) {
    if (!(config.iterations >= 1 && config.levels >= 1 && config.minEigen > 0 && config.gridWidth >= 16 && config.gridHeight >= 10)) throw new RangeError("Invalid flow configuration");
    this.config = config;
  }

  compute(prev: Pyramid, next: Pyramid, prior?: FlowPrior): FlowField {
    const depth = Math.min(prev.length, next.length);
    if (depth === 0 || prev[0].width !== next[0].width || prev[0].height !== next[0].height) throw new RangeError("Flow pyramids differ in shape");
    const n0 = prev[0].width * prev[0].height;
    if (prior && (prior.u.length !== n0 || prior.v.length !== n0)) throw new RangeError("Flow prior does not match the grid");
    for (let k = depth - 1; k >= 0; k--) this.solveLevel(k, depth, prev, next, prior);
    const { width, height } = prev[0];
    const n = width * height;
    const b0 = this.buffers[0];
    warpResidual(prev[0], next[0], b0);
    const weight = new Float32Array(n);
    const valid = finalWeights(b0, width, height, this.config, weight);
    return { width, height, u: b0.u.slice(0, n), v: b0.v.slice(0, n), weight, validFraction: valid / n, contrast: rmsGradient(b0, n) };
  }

  private solveLevel(k: number, depth: number, prev: Pyramid, next: Pyramid, prior: FlowPrior | undefined): void {
    const { width: w, height: h } = prev[k];
    const n = w * h;
    if (!this.buffers[k] || this.buffers[k].u.length !== n) this.buffers[k] = allocate(n);
    const b = this.buffers[k];
    if (k === depth - 1) {
      initialise(b, w, h, k, prev[0], prior);
    } else {
      upsample(this.buffers[k + 1], prev[k + 1].width, prev[k + 1].height, b, w, h);
    }
    structureTensor(prev[k], b);
    for (let it = 0; it < this.config.iterations; it++) {
      warpResidual(prev[k], next[k], b);
      binomialMean5(b.ex, w, h, b.tmp, b.bx);
      binomialMean5(b.ey, w, h, b.tmp, b.by);
      solveUpdate(b, n);
    }
  }
}
