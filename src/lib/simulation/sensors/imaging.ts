/**
 * Camera tracing shared by the RGB and thermal models.
 *
 * Measurement rays (every frame): the field of view is divided into an nx × ny angular grid (azimuth ×
 * elevation) and one ray per cell is traced from the TRUE sensor pose through its centre. Each stops at its
 * first active collider (colliders the modality sees through are skipped), at the modality's reach, or where
 * the integrated smoke optical depth reaches what the measurement supports. The models estimate frame
 * quality, smoke and heat from these rays.
 *
 * Person-search footprint (frames that run a person search): a pinhole depth image (contracts/geometry.ts,
 * Region "depth_image") over the camera's frustum, `cols` cells across and as many rows as keep the cells
 * square in the image plane. Every cell is sampled by a lattice of LATTICE ray steps per edge, corners
 * shared with its neighbours (3 × 3 rays per cell). For each lattice ray from the TRUE pose:
 * - first hit on a surface that does not face up (walls, doors, glass for thermal, the sides of furniture,
 *   ceilings): the cell's depth is at most that hit's z-depth along the optical axis;
 * - first hit on an upward-facing surface (the top face of a floor, the ground, a roof or a table top): it
 *   does not shorten the depth, because the air above it is in view; instead the cell's floor height is at
 *   least that surface's height, so nothing below it is claimed;
 * - no hit: the ray supports the modality's reach.
 * Detectability caps every ray where a person in view would no longer be detected at the threshold confidence
 * (FootprintParams.detectableM, detectability.ts): smoke, range, glass and heat as the modality's person oracle
 * weighs them (an upward-facing hit reached before the cap leaves the reach). It is evaluated on the cell corners
 * and centres (the corner-and-centre lattice); the edge-midpoint rays check colliders only, because smoke,
 * range and heat, unlike an occluder, vary smoothly between neighbouring rays except at walls, which the corner
 * rays meet (a corner ray is also the most oblique, so the farthest from the camera at a given depth). A cell's
 * depth is the minimum over its lattice rays and its floor the maximum. The image is expressed from the
 * ESTIMATED pose (apex and axes; the floor heights shifted by the estimate's height error), like every other
 * reported geometry.
 *
 * Soundness: a contained point has line of sight from the camera unless an occluder narrower than the
 * lattice spacing slips between rays or a silhouette edge crosses a cell between rays (within one lattice
 * step: 1.4° across for a 90° camera with 32 cells), and the person oracle would report someone there at the
 * threshold confidence, to within how smoke, range and heat vary across one cell (detectability.test.ts finds
 * the margin positive on the fixture scenes). The earlier cone-union footprint lost the air just above floors,
 * because a cone that clipped the floor at one corner was cut short everywhere.
 *
 * Cost per frame: (cols·LATTICE + 1) × (rows·LATTICE + 1) collider traces, each against only the colliders a
 * frustum test keeps for its TILE × TILE-cell tile of the image, plus, on the corner-and-centre lattice, a
 * trace against the see-through colliders (glass for RGB) and the detectability cut.
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { DepthImageRegion } from "../../contracts/geometry.ts";
import { depthImage } from "../../contracts/geometry.ts";
import { visibilityAlong } from "../fire.ts";
import type { RuntimeCollider } from "../world-state.ts";
import type { SenseContext } from "./observation.ts";
import type { CameraFrame } from "./pose.ts";
import { cameraFrame, sensorDirection, sensorOrigin } from "./pose.ts";
import type { TraceSet } from "./trace.ts";
import { entersTopFace, traceNearest, traceNearestIn, traceSet } from "./trace.ts";

export interface ImagingParams {
  readonly nx: number;
  readonly ny: number;
  readonly reachM: number;
  /** Visible-light optical depth at which a measurement ray stops (quality, smoke and heat estimates; not the footprint). */
  readonly tauLimit: number;
  /** Colliders this modality sees through (visible light passes intact glass; LWIR does not). */
  readonly transparent?: (collider: RuntimeCollider) => boolean;
}

export interface FootprintParams {
  /** Depth-image cells across the image; rows follow from the aspect ratio (square cells). */
  readonly cols: number;
  readonly reachM: number;
  readonly transparent?: (collider: RuntimeCollider) => boolean;
  /**
   * How far along a lattice ray (from the TRUE sensor origin, unit direction) a person in view would still be
   * detected at the threshold confidence, at most hitM (the first surface the modality cannot see through, or
   * the reach); glassM is the distance to the first see-through collider on the way, Infinity when none.
   */
  readonly detectableM: (origin: Vec3, dir: Vec3, hitM: number, glassM: number) => number;
}

export interface CameraRay {
  readonly dir: Vec3;
  readonly cutM: number;
  /** Visible-light optical depth from the sensor to the cut. */
  readonly tau: number;
  readonly end: Vec3;
  /** The surface the ray reached, or null when reach or smoke cut it first. */
  readonly hit: RuntimeCollider | null;
}

export interface ImagingTrace {
  /** One ray per measurement-grid cell, through its centre. */
  readonly centers: readonly CameraRay[];
  readonly set: TraceSet;
  readonly origin: Vec3;
}

/** Lattice ray steps per cell edge (3 × 3 rays per cell, corners shared). */
export const LATTICE = 2;
/** Cells per culling-tile edge. */
const TILE = 4;
const RAD = Math.PI / 180;
const gridCache = new WeakMap<SensorSpec, Map<string, readonly (readonly [number, number])[]>>();

/** The measurement rays: one per nx × ny grid cell through its centre (see the header). */
export function traceCamera(ctx: SenseContext, spec: SensorSpec, params: ImagingParams): ImagingTrace {
  const origin = sensorOrigin(ctx.truth, spec);
  const set = traceSet(ctx.world, origin, params.reachM);
  const centers = cellCenters(spec, params.nx, params.ny).map(([az, el]) => castCameraRay(ctx, set, origin, spec, az, el, params));
  return { centers, set, origin };
}

function castCameraRay(ctx: SenseContext, set: TraceSet, origin: Vec3, spec: SensorSpec, az: number, el: number, params: ImagingParams): CameraRay {
  const dir = sensorDirection(ctx.truth, spec, az, el);
  const index = traceNearest(set, origin, dir, params.reachM, params.transparent);
  const hitM = index < 0 ? params.reachM : set.distance;
  const visible = visibilityAlong(ctx.world, origin, dir, hitM, params.tauLimit);
  const cutM = visible.distanceM;
  const end = vec3(origin.x + dir.x * cutM, origin.y + dir.y * cutM, origin.z + dir.z * cutM);
  return { dir, cutM, tau: visible.tau, end, hit: index >= 0 && cutM >= hitM - 1e-9 ? set.colliders[index] : null };
}

function cellCenters(spec: SensorSpec, nx: number, ny: number): readonly (readonly [number, number])[] {
  const key = `${nx}x${ny}`;
  const bySize = gridCache.get(spec) ?? new Map<string, readonly (readonly [number, number])[]>();
  gridCache.set(spec, bySize);
  const cached = bySize.get(key);
  if (cached) return cached;
  const h = (spec.horizontalFovDeg ?? 0) * RAD;
  const v = (spec.verticalFovDeg ?? 0) * RAD;
  const centers: (readonly [number, number])[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) centers.push([-h / 2 + ((i + 0.5) * h) / nx, -v / 2 + ((j + 0.5) * v) / ny]);
  bySize.set(key, centers);
  return centers;
}

/** Depth-image rows for `cols` columns: square cells in the image plane, at least one. */
export function footprintRows(spec: SensorSpec, cols: number): number {
  const tanH = Math.tan(((spec.horizontalFovDeg ?? 0) * RAD) / 2);
  const tanV = Math.tan(((spec.verticalFovDeg ?? 0) * RAD) / 2);
  return Math.max(1, Math.round((cols * tanV) / tanH));
}

interface Lattice {
  readonly frame: CameraFrame;
  /** Lattice points per row (stepsX + 1). */
  readonly width: number;
  readonly tanH: number;
  readonly tanV: number;
  readonly stepsX: number;
  readonly stepsY: number;
}

/** Unnormalized ray through lattice point (a, b): forward + left·x + up·y, so its forward component is 1. */
function latticeRay(l: Lattice, a: number, b: number): Vec3 {
  const x = l.tanH - (2 * l.tanH * a) / l.stepsX;
  const y = l.tanV - (2 * l.tanV * b) / l.stepsY;
  const { forward: f, left, up } = l.frame;
  return vec3(f.x + left.x * x + up.x * y, f.y + left.y * x + up.y * y, f.z + left.z * x + up.z * y);
}

/** The person-search footprint as a depth image (see the header). `set` must hold every active collider within reach. */
export function depthFootprint(ctx: SenseContext, spec: SensorSpec, set: TraceSet, params: FootprintParams): DepthImageRegion {
  const hfovRad = (spec.horizontalFovDeg ?? 0) * RAD;
  const vfovRad = (spec.verticalFovDeg ?? 0) * RAD;
  const cols = params.cols;
  const rows = footprintRows(spec, cols);
  const frame = cameraFrame(ctx.truth, spec);
  const lattice: Lattice = { frame, width: cols * LATTICE + 1, tanH: Math.tan(hfovRad / 2), tanV: Math.tan(vfovRad / 2), stepsX: cols * LATTICE, stepsY: rows * LATTICE };
  const points = lattice.width * (rows * LATTICE + 1);
  const depth = new Float64Array(points);
  const floor = new Float64Array(points).fill(Number.NaN);
  const opaque = opaqueIndices(set, params.transparent);
  const seeThrough = seeThroughIndices(set, params.transparent);
  const candidates = new Int32Array(opaque.length);
  for (let ty = 0; ty * TILE < rows; ty++) {
    for (let tx = 0; tx * TILE < cols; tx++) {
      const a0 = tx * TILE * LATTICE;
      const b0 = ty * TILE * LATTICE;
      const a1 = Math.min(cols, (tx + 1) * TILE) * LATTICE;
      const b1 = Math.min(rows, (ty + 1) * TILE) * LATTICE;
      const count = cullToTile(set, opaque, candidates, lattice, a0, a1, b0, b1);
      // Each lattice point is traced once: a tile owns its far edges only at the image border.
      const aEnd = a1 === lattice.stepsX ? a1 : a1 - 1;
      const bEnd = b1 === lattice.stepsY ? b1 : b1 - 1;
      for (let b = b0; b <= bEnd; b++) {
        for (let a = a0; a <= aEnd; a++) traceLatticePoint(set, candidates, count, seeThrough, lattice, a, b, params, depth, floor);
      }
    }
  }
  const dz = sensorOrigin(ctx.estimatePose, spec).z - frame.origin.z;
  const depthsM: number[] = [];
  const floorZM: (number | null)[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [cellDepth, cellFloor] = cellExtent(lattice, depth, floor, c, r);
      depthsM.push(cellDepth);
      floorZM.push(cellFloor === null ? null : cellFloor + dz);
    }
  }
  const estimate = cameraFrame(ctx.estimatePose, spec);
  return depthImage({ apex: estimate.origin, forward: estimate.forward, up: estimate.up, hfovRad, vfovRad, cols, rows, depthsM, floorZM });
}

/** Minimum depth and highest floor over a cell's lattice rays. */
function cellExtent(l: Lattice, depth: Float64Array, floor: Float64Array, c: number, r: number): readonly [number, number | null] {
  let cellDepth = Infinity;
  let cellFloor: number | null = null;
  for (let b = r * LATTICE; b <= (r + 1) * LATTICE; b++) {
    for (let a = c * LATTICE; a <= (c + 1) * LATTICE; a++) {
      const k = b * l.width + a;
      cellDepth = Math.min(cellDepth, depth[k]);
      if (!Number.isNaN(floor[k]) && (cellFloor === null || floor[k] > cellFloor)) cellFloor = floor[k];
    }
  }
  return [cellDepth, cellFloor];
}

function traceLatticePoint(set: TraceSet, candidates: Int32Array, count: number, seeThrough: Int32Array, l: Lattice, a: number, b: number, params: FootprintParams, depth: Float64Array, floor: Float64Array): void {
  const ray = latticeRay(l, a, b);
  const length = Math.hypot(ray.x, ray.y, ray.z);
  const dir = vec3(ray.x / length, ray.y / length, ray.z / length);
  const origin = l.frame.origin;
  const index = traceNearestIn(set, candidates, count, origin, dir, params.reachM);
  const hitM = index < 0 ? params.reachM : set.distance;
  const upward = index >= 0 && entersTopFace(set, index, origin, dir);
  let extentM = hitM;
  // Detectability on the cell corners (both lattice indices even) and centres (both odd); see the header.
  if (a % LATTICE === b % LATTICE) {
    const glassM = seeThrough.length > 0 && traceNearestIn(set, seeThrough, seeThrough.length, origin, dir, hitM) >= 0 ? set.distance : Infinity;
    extentM = Math.min(hitM, params.detectableM(origin, dir, hitM, glassM));
  }
  const k = b * l.width + a;
  // Distances become z-depths along the optical axis: the ray's forward component is 1 / length per metre.
  depth[k] = (upward && extentM >= hitM - 1e-9 ? params.reachM : extentM) / length;
  if (upward) floor[k] = set.bounds[index * 6 + 5];
}

/** Indices (ascending) of the colliders in the set the modality cannot see through. */
function opaqueIndices(set: TraceSet, transparent: FootprintParams["transparent"]): Int32Array {
  const kept: number[] = [];
  for (let i = 0; i < set.colliders.length; i++) if (transparent === undefined || !transparent(set.colliders[i])) kept.push(i);
  return Int32Array.from(kept);
}

/** Indices (ascending) of the colliders in the set the modality sees through (few: glass panes for RGB). */
function seeThroughIndices(set: TraceSet, transparent: FootprintParams["transparent"]): Int32Array {
  const kept: number[] = [];
  if (transparent !== undefined) for (let i = 0; i < set.colliders.length; i++) if (transparent(set.colliders[i])) kept.push(i);
  return Int32Array.from(kept);
}

/** Inward normals of the four planes through the apex and a tile's corner rays. */
function tilePlanes(l: Lattice, a0: number, a1: number, b0: number, b1: number): Vec3[] {
  const corners = [latticeRay(l, a0, b0), latticeRay(l, a1, b0), latticeRay(l, a1, b1), latticeRay(l, a0, b1)];
  const centre = latticeRay(l, (a0 + a1) / 2, (b0 + b1) / 2);
  return corners.map((p, i) => {
    const q = corners[(i + 1) % 4];
    const n = vec3(p.y * q.z - p.z * q.y, p.z * q.x - p.x * q.z, p.x * q.y - p.y * q.x);
    const sign = n.x * centre.x + n.y * centre.y + n.z * centre.z >= 0 ? 1 : -1;
    return vec3(n.x * sign, n.y * sign, n.z * sign);
  });
}

/**
 * Keep the colliders whose boxes are not entirely outside the tile's frustum; returns how many were written
 * to `out`, in ascending order. A box is outside when even its corner farthest along an inward plane normal
 * lies behind that plane.
 */
function cullToTile(set: TraceSet, opaque: Int32Array, out: Int32Array, l: Lattice, a0: number, a1: number, b0: number, b1: number): number {
  const normals = tilePlanes(l, a0, a1, b0, b1);
  const o = l.frame.origin;
  const b = set.bounds;
  let count = 0;
  for (let m = 0; m < opaque.length; m++) {
    const k = opaque[m] * 6;
    const outside = normals.some(n => n.x * ((n.x >= 0 ? b[k + 3] : b[k]) - o.x) + n.y * ((n.y >= 0 ? b[k + 4] : b[k + 1]) - o.y) + n.z * ((n.z >= 0 ? b[k + 5] : b[k + 2]) - o.z) < -1e-9);
    if (!outside) out[count++] = opaque[m];
  }
  return count;
}
