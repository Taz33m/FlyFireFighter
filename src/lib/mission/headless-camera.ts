/**
 * Headless collider renderer v1: a CPU luminance renderer for Node tests and batch evaluation.
 *
 * It renders the locked drone calibration (rgb-front/v1: 320 × 180, fx = fy = 160, mount pitched 10° down)
 * from the TRUE aircraft pose, by casting one primary ray per pixel against the simulator's active collider
 * boxes plus box proxies for occupants. Boxes are culled to the view and binned into 16-pixel screen tiles,
 * so each ray tests only the boxes whose projection overlaps its tile. Shading (headless-shading.ts): per-kind
 * albedo × deterministic value-noise texture on world coordinates × a fixed light plus ambient; a sky
 * gradient; an emissive flame per active fire. Smoke uses the simulator's own field: optical depth
 * (fire.ts opticalDepth) is evaluated on a coarse ray grid, its mean extinction is interpolated per pixel
 * and applied with Beer–Lambert toward a smoke luminance. Output is display-encoded with the calibration
 * exposure and gamma, row 0 at the top, without noise (the mission runtime adds the sensor read noise).
 *
 * It is NOT the presentation renderer: the browser path renders the Blender GLB with Three.js. Frames from
 * here are always attributed to "headless collider renderer v1" (renderer id "headless-collider/v1"). Intact glass is an opaque dark pane, there
 * are no shadows or interreflections, and occupants are boxes.
 */
import type { CameraCalibration, CameraFrame } from "../contracts/camera.ts";
import type { Tick } from "../contracts/clock.ts";
import type { Pose } from "../contracts/frames.ts";
import { bodyPointToWorld, opticalToBody, vec3 } from "../contracts/frames.ts";
import { fireExtent, opticalDepth } from "../simulation/fire.ts";
import { occupantHeightM } from "../simulation/occupant-body.ts";
import type { WorldState } from "../simulation/world-state.ts";
import type { FlameShape, ShadedKind } from "./headless-shading.ts";
import { displayEncoder, flameChord, flameShape, KIND_CODE, shadeHit, skyLuminance, SMOKE_LUMINANCE } from "./headless-shading.ts";

export const HEADLESS_RENDERER_LABEL = "headless collider renderer v1";
/** Renderer identity carried by frames (camera_frame.renderer), alongside the browser's "three-glb/procedural-detail/v1". */
export const HEADLESS_RENDERER_ID = "headless-collider/v1";

export interface HeadlessRendererOptions {
  readonly maxRangeM?: number;
  readonly tilePx?: number;
  /** Pixel stride of the coarse optical-depth grid. */
  readonly smokeStridePx?: number;
}

export interface HeadlessFrameRequest {
  readonly frameId: string;
  readonly tick: Tick;
  /** TRUE aircraft pose: the physical camera is where the aircraft really is. */
  readonly pose: Pose;
}

export interface HeadlessRenderStats {
  readonly ms: number;
  readonly boxes: number;
  readonly boxTests: number;
  readonly smokeRays: number;
}

const OCCUPANT_HALF_WIDTH_M = 0.22;
const NEAR_M = 0.02;
const INSIDE_LUMINANCE = 0.04;

export class HeadlessColliderRenderer {
  readonly label = HEADLESS_RENDERER_LABEL;
  readonly calibration: CameraCalibration;
  private readonly maxRangeM: number;
  private readonly tilePx: number;
  private readonly smokeStride: number;
  private readonly tilesX: number;
  private readonly tilesY: number;
  /** Per-pixel ray direction in the body frame (mount pitch and yaw applied). */
  private readonly bodyDir: Float64Array;
  private readonly depth: Float64Array;
  private readonly linear: Float64Array;
  private readonly scratch = new Float64Array(2);
  private readonly axisScratch = new Int8Array(1);
  private stats: HeadlessRenderStats = { ms: 0, boxes: 0, boxTests: 0, smokeRays: 0 };
  private readonly encode: (linear: number) => number;

  constructor(calibration: CameraCalibration, options: HeadlessRendererOptions = {}) {
    this.calibration = calibration;
    this.maxRangeM = options.maxRangeM ?? 80;
    this.tilePx = options.tilePx ?? 16;
    this.smokeStride = options.smokeStridePx ?? 16;
    const { width, height } = calibration;
    this.tilesX = Math.ceil(width / this.tilePx);
    this.tilesY = Math.ceil(height / this.tilePx);
    this.bodyDir = pixelDirections(calibration);
    this.depth = new Float64Array(width * height);
    this.linear = new Float64Array(width * height);
    this.encode = displayEncoder(calibration.exposure.gain, calibration.exposure.gamma);
  }

  get lastStats(): HeadlessRenderStats {
    return this.stats;
  }

  /** Hit distance per pixel of the last frame (maxRangeM where a ray hit nothing); a copy, for tests and diagnostics. */
  lastDepth(): Float64Array {
    return this.depth.slice();
  }

  render(world: WorldState, request: HeadlessFrameRequest): CameraFrame {
    const started = performance.now();
    const { width, height } = this.calibration;
    const origin = bodyPointToWorld(request.pose, this.calibration.mount.positionBody);
    const boxes = collectBoxes(world, origin, this.maxRangeM);
    const tiles = this.binBoxes(boxes, request.pose);
    const c = Math.cos(request.pose.yawRad);
    const s = Math.sin(request.pose.yawRad);
    let boxTests = 0;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        const bx = this.bodyDir[i * 3];
        const by = this.bodyDir[i * 3 + 1];
        const dz = this.bodyDir[i * 3 + 2];
        const dx = c * bx - s * by;
        const dy = s * bx + c * by;
        const list = tiles[Math.floor(row / this.tilePx) * this.tilesX + Math.floor(col / this.tilePx)];
        boxTests += list.length;
        this.linear[i] = this.castAndShade(boxes, list, origin.x, origin.y, origin.z, dx, dy, dz, i);
      }
    }
    const smokeRays = applySmokeAndFlames(world, this, origin, c, s);
    const luminance = new Float32Array(width * height);
    for (let i = 0; i < luminance.length; i++) luminance[i] = this.encode(this.linear[i]);
    this.stats = { ms: performance.now() - started, boxes: boxes.count, boxTests, smokeRays };
    return { frameId: request.frameId, captureTick: request.tick, calibrationId: this.calibration.id, width, height, luminance };
  }

  /** Internal buffers for the smoke/flame pass. */
  buffers(): { readonly bodyDir: Float64Array; readonly depth: Float64Array; readonly linear: Float64Array; readonly scratch: Float64Array; readonly smokeStride: number; readonly maxRangeM: number } {
    return { bodyDir: this.bodyDir, depth: this.depth, linear: this.linear, scratch: this.scratch, smokeStride: this.smokeStride, maxRangeM: this.maxRangeM };
  }

  private castAndShade(boxes: BoxList, list: readonly number[], ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, pixel: number): number {
    const ix = inverse(dx);
    const iy = inverse(dy);
    const iz = inverse(dz);
    const near = boxes.distance;
    const axis = this.axisScratch;
    let best = this.maxRangeM;
    let hit = -1;
    let hitAxis = -1;
    for (let n = 0; n < list.length; n++) {
      if (near[list[n]] >= best) break;
      const t = slabEntry(boxes.bounds, list[n] * 6, ox, oy, oz, ix, iy, iz, best, axis);
      if (t >= best) continue;
      best = t;
      hit = list[n];
      hitAxis = axis[0];
    }
    this.depth[pixel] = hit < 0 ? this.maxRangeM : best;
    if (hit < 0) return skyLuminance(dz);
    if (hitAxis < 0) return INSIDE_LUMINANCE;
    // Pixel footprint on the surface: distance over focal length, widened by the incidence angle.
    const incidence = Math.max(0.2, Math.abs(hitAxis === 0 ? dx : hitAxis === 1 ? dy : dz));
    return shadeHit(boxes.kinds[hit], hitAxis, faceSign(hitAxis, dx, dy, dz), ox + dx * best, oy + dy * best, oz + dz * best, best / this.calibration.fx / incidence);
  }

  /**
   * Cull boxes outside the view or range and bin the rest into screen tiles by the projected rectangle of
   * their part in front of the near plane (in-front corners plus the near-plane crossings of the 12 edges).
   * Each tile lists its boxes nearest first, so a ray stops testing once the next box is farther than its hit.
   */
  private binBoxes(boxes: BoxList, pose: Pose): number[][] {
    const tiles: number[][] = Array.from({ length: this.tilesX * this.tilesY }, () => []);
    const { width, height } = this.calibration;
    const optical = new Float64Array(24);
    const rect = new Float64Array(4);
    for (let n = 0; n < boxes.count; n++) {
      opticalCorners(boxes.bounds, n * 6, pose, this.calibration, optical);
      if (!projectedRect(optical, this.calibration, rect)) continue;
      const [uMin, vMin, uMax, vMax] = rect;
      if (uMax < -1 || vMax < -1 || uMin > width || vMin > height) continue;
      const tx0 = Math.max(0, Math.floor((uMin - 1) / this.tilePx));
      const tx1 = Math.min(this.tilesX - 1, Math.floor((uMax + 1) / this.tilePx));
      const ty0 = Math.max(0, Math.floor((vMin - 1) / this.tilePx));
      const ty1 = Math.min(this.tilesY - 1, Math.floor((vMax + 1) / this.tilePx));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles[ty * this.tilesX + tx].push(n);
    }
    const near = boxes.distance;
    for (const tile of tiles) tile.sort((a, b) => near[a] - near[b] || a - b);
    return tiles;
  }
}

/** The 8 corners of box k in camera optical coordinates (x right, y down, z forward), into out[3·corner]. */
function opticalCorners(bounds: Float64Array, k: number, pose: Pose, calibration: CameraCalibration, out: Float64Array): void {
  const { positionBody, yawRad, pitchRad } = calibration.mount;
  const cy = Math.cos(pose.yawRad + yawRad);
  const sy = Math.sin(pose.yawRad + yawRad);
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const camera = bodyPointToWorld(pose, positionBody);
  for (let corner = 0; corner < 8; corner++) {
    const wx = bounds[k + (corner & 1 ? 3 : 0)] - camera.x;
    const wy = bounds[k + 1 + (corner & 2 ? 3 : 0)] - camera.y;
    const wz = bounds[k + 2 + (corner & 4 ? 3 : 0)] - camera.z;
    // World → camera-mount frame (FLU), then the optical frame for a mount pitched down by pitchRad.
    const fwd = cy * wx + sy * wy;
    const left = -sy * wx + cy * wy;
    out[corner * 3] = -left;
    out[corner * 3 + 1] = -(sp * fwd + cp * wz);
    out[corner * 3 + 2] = cp * fwd - sp * wz;
  }
}

const BOX_EDGES: readonly (readonly [number, number])[] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/** Pixel rectangle [uMin, vMin, uMax, vMax] of the box's visible part; false when it lies behind the near plane. */
function projectedRect(optical: Float64Array, calibration: CameraCalibration, rect: Float64Array): boolean {
  const { fx, fy, cx, cy } = calibration;
  let any = false;
  rect[0] = Infinity;
  rect[1] = Infinity;
  rect[2] = -Infinity;
  rect[3] = -Infinity;
  const include = (x: number, y: number, z: number) => {
    const u = cx + (fx * x) / z;
    const v = cy + (fy * y) / z;
    rect[0] = Math.min(rect[0], u);
    rect[1] = Math.min(rect[1], v);
    rect[2] = Math.max(rect[2], u);
    rect[3] = Math.max(rect[3], v);
    any = true;
  };
  for (let corner = 0; corner < 8; corner++) {
    if (optical[corner * 3 + 2] >= NEAR_M) include(optical[corner * 3], optical[corner * 3 + 1], optical[corner * 3 + 2]);
  }
  for (const [a, b] of BOX_EDGES) {
    const za = optical[a * 3 + 2];
    const zb = optical[b * 3 + 2];
    if ((za < NEAR_M) === (zb < NEAR_M)) continue;
    const t = (NEAR_M - za) / (zb - za);
    include(optical[a * 3] + t * (optical[b * 3] - optical[a * 3]), optical[a * 3 + 1] + t * (optical[b * 3 + 1] - optical[a * 3 + 1]), NEAR_M);
  }
  return any;
}

/** 1/d with a signed floor, so axis-parallel rays give ±huge slab distances instead of NaN. */
function inverse(d: number): number {
  if (Math.abs(d) >= 1e-12) return 1 / d;
  return d < 0 ? -1e12 : 1e12;
}

/**
 * Slab test of a unit ray against box k: the entry distance (0 when the ray starts inside), or Infinity when
 * it misses or enters at or beyond `limit`. The entry face's axis goes to axisOut[0] (−1 when inside).
 */
function slabEntry(b: Float64Array, k: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, limit: number, axisOut: Int8Array): number {
  const x1 = (b[k] - ox) * ix;
  const x2 = (b[k + 3] - ox) * ix;
  const y1 = (b[k + 1] - oy) * iy;
  const y2 = (b[k + 4] - oy) * iy;
  const z1 = (b[k + 2] - oz) * iz;
  const z2 = (b[k + 5] - oz) * iz;
  const tx = Math.min(x1, x2);
  const ty = Math.min(y1, y2);
  const tz = Math.min(z1, z2);
  const tmin = Math.max(tx, ty, tz);
  const tmax = Math.min(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
  if (tmax < 0 || tmin > tmax || tmin >= limit) return Infinity;
  if (tmin < 0) {
    axisOut[0] = -1;
    return 0;
  }
  axisOut[0] = tmin === tx ? 0 : tmin === ty ? 1 : 2;
  return tmin;
}

/** Sign of the outward normal of the face a ray with direction (dx, dy, dz) entered along `axis`. */
function faceSign(axis: number, dx: number, dy: number, dz: number): number {
  const component = axis === 0 ? dx : axis === 1 ? dy : dz;
  return component > 0 ? -1 : 1;
}

interface BoxList {
  readonly count: number;
  readonly bounds: Float64Array;
  readonly kinds: Uint8Array;
  /** Distance from the camera to each box: a lower bound on any ray's hit distance. */
  readonly distance: Float64Array;
}

/** Active colliders within range of the camera, then one standing/crouched/lying box per occupant. */
function collectBoxes(world: WorldState, origin: { x: number; y: number; z: number }, rangeM: number): BoxList {
  const boxes: { min: readonly [number, number, number]; max: readonly [number, number, number]; kind: ShadedKind; distance: number }[] = [];
  const distanceTo = (min: readonly number[], max: readonly number[]) =>
    Math.hypot(Math.max(min[0] - origin.x, 0, origin.x - max[0]), Math.max(min[1] - origin.y, 0, origin.y - max[1]), Math.max(min[2] - origin.z, 0, origin.z - max[2]));
  for (const collider of world.scene.colliders) {
    if (!world.activeColliderIds.has(collider.id)) continue;
    const min = [collider.min.x, collider.min.y, collider.min.z] as const;
    const max = [collider.max.x, collider.max.y, collider.max.z] as const;
    const distance = distanceTo(min, max);
    if (distance <= rangeM) boxes.push({ min, max, kind: collider.kind, distance });
  }
  for (const occupant of world.occupants) {
    const p = occupant.position;
    const min = [p.x - OCCUPANT_HALF_WIDTH_M, p.y - OCCUPANT_HALF_WIDTH_M, p.z] as const;
    const max = [p.x + OCCUPANT_HALF_WIDTH_M, p.y + OCCUPANT_HALF_WIDTH_M, p.z + occupantHeightM(occupant)] as const;
    boxes.push({ min, max, kind: "person", distance: distanceTo(min, max) });
  }
  const bounds = new Float64Array(boxes.length * 6);
  const kinds = new Uint8Array(boxes.length);
  const distance = new Float64Array(boxes.length);
  boxes.forEach((box, n) => {
    bounds.set([...box.min, ...box.max], n * 6);
    kinds[n] = KIND_CODE.get(box.kind) ?? 0;
    distance[n] = box.distance;
  });
  return { count: boxes.length, bounds, kinds, distance };
}

/** Per-pixel unit ray directions in the body frame for the calibration's pinhole model and mount. */
function pixelDirections(calibration: CameraCalibration): Float64Array {
  const { width, height, fx, fy, cx, cy } = calibration;
  const { pitchRad, yawRad } = calibration.mount;
  const out = new Float64Array(width * height * 3);
  const cm = Math.cos(yawRad);
  const sm = Math.sin(yawRad);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = (col - cx) / fx;
      const y = (row - cy) / fy;
      const n = Math.hypot(x, y, 1);
      const body = opticalToBody(vec3(x / n, y / n, 1 / n), pitchRad);
      const i = (row * width + col) * 3;
      out[i] = cm * body.x - sm * body.y;
      out[i + 1] = sm * body.x + cm * body.y;
      out[i + 2] = body.z;
    }
  }
  return out;
}

/**
 * Smoke and flames. Optical depth to each coarse-grid pixel's surface comes from the simulator's smoke field;
 * its mean extinction (τ / distance) is bilinearly interpolated per pixel, τ = k̄ · depth, and the surface
 * fades toward the smoke luminance by Beer–Lambert. Flames add emission attenuated by the smoke in front.
 * Returns the number of optical-depth rays evaluated (0 when the air is clear and nothing burns).
 */
function applySmokeAndFlames(world: WorldState, renderer: HeadlessColliderRenderer, origin: { x: number; y: number; z: number }, c: number, s: number): number {
  const smoky = world.compartments.some(compartment => compartment.smokeExtinctionPerM > 1e-6);
  const flames: FlameShape[] = world.fires.filter(fire => !fire.extinguished && fire.heatReleaseKW > 0).map(fire => {
    const extent = fireExtent(fire.region);
    return flameShape(extent.center.x, extent.center.y, extent.center.z, extent.radiusM, fire.heatReleaseKW);
  });
  if (!smoky && flames.length === 0) return 0;
  const { width, height } = renderer.calibration;
  const { bodyDir, depth, linear, scratch, smokeStride, maxRangeM } = renderer.buffers();
  const gx = Math.ceil((width - 1) / smokeStride) + 1;
  const gy = Math.ceil((height - 1) / smokeStride) + 1;
  const k = new Float64Array(gx * gy);
  const direction = (i: number) => [c * bodyDir[i * 3] - s * bodyDir[i * 3 + 1], s * bodyDir[i * 3] + c * bodyDir[i * 3 + 1], bodyDir[i * 3 + 2]] as const;
  for (let j = 0; j < gy; j++) {
    for (let g = 0; g < gx; g++) {
      const i = Math.min(height - 1, j * smokeStride) * width + Math.min(width - 1, g * smokeStride);
      const length = Math.min(depth[i], maxRangeM);
      const [dx, dy, dz] = direction(i);
      k[j * gx + g] = length > 1e-6 ? opticalDepth(world, origin, vec3(origin.x + dx * length, origin.y + dy * length, origin.z + dz * length)) / length : 0;
    }
  }
  for (let row = 0; row < height; row++) {
    const fy = Math.min(gy - 1.000001, row / smokeStride);
    const j = Math.floor(fy);
    const ty = fy - j;
    for (let col = 0; col < width; col++) {
      const fx = Math.min(gx - 1.000001, col / smokeStride);
      const g = Math.floor(fx);
      const tx = fx - g;
      const kk = (k[j * gx + g] * (1 - tx) + k[j * gx + g + 1] * tx) * (1 - ty) + (k[(j + 1) * gx + g] * (1 - tx) + k[(j + 1) * gx + g + 1] * tx) * ty;
      const i = row * width + col;
      const transmission = Math.exp(-kk * depth[i]);
      let value = linear[i] * transmission + SMOKE_LUMINANCE * (1 - transmission);
      for (let f = 0; f < flames.length; f++) {
        const bx = bodyDir[i * 3];
        const by = bodyDir[i * 3 + 1];
        flameChord(flames[f], origin.x, origin.y, origin.z, c * bx - s * by, s * bx + c * by, bodyDir[i * 3 + 2], scratch);
        if (scratch[0] < depth[i]) value += flames[f].emission * scratch[1] * Math.exp(-kk * scratch[0]);
      }
      linear[i] = value;
    }
  }
  return gx * gy;
}
