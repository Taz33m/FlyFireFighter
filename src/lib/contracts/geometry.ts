/**
 * Serializable regions in the world frame (metres) and conservative spatial queries.
 *
 * Regions describe affected volumes (spray sectors, debris spheres), sensor footprints, envelopes and
 * rooms. Queries are exact for containment/distance and sampling-based for overlap and coverage.
 */
import type { Vec3 } from "./frames.ts";
import { dot, norm, normalize, scale, sub, vec3 } from "./frames.ts";

export type Point2 = readonly [number, number];

export type Region =
  /** Axis-aligned box in the world frame. */
  | { readonly kind: "box"; readonly min: Vec3; readonly max: Vec3 }
  | { readonly kind: "sphere"; readonly center: Vec3; readonly radiusM: number }
  /** Spherical sector: points within rangeM of apex and within halfAngleRad of the unit axis. */
  | { readonly kind: "sector"; readonly apex: Vec3; readonly axis: Vec3; readonly halfAngleRad: number; readonly rangeM: number }
  /** Vertical prism: a counter-clockwise floor polygon extruded between zMin and zMax. */
  | { readonly kind: "prism"; readonly polygon: readonly Point2[]; readonly zMin: number; readonly zMax: number }
  /**
   * Camera footprint as a pinhole depth image. The image plane in front of `apex` is split into `cols` × `rows`
   * equal cells, like blocks of pixels, row-major from the top-left (row 0 at the top, towards `up`; col 0 at
   * the left, towards up × forward). Cell i holds the rays through its block out to depthsM[i], a distance
   * along `forward` (z-depth) within which the sensor saw no occluder, at heights of at least floorZM[i]: the
   * top of the highest upward-facing surface the cell's rays landed on, or null where they landed on none.
   * Keeping floors out of the depth keeps the air just above a floor in view at grazing angles, while space
   * below any surface the camera looked down onto stays outside. `forward` and `up` are orthonormal.
   */
  | {
      readonly kind: "depth_image";
      readonly apex: Vec3;
      readonly forward: Vec3;
      readonly up: Vec3;
      readonly hfovRad: number;
      readonly vfovRad: number;
      readonly cols: number;
      readonly rows: number;
      readonly depthsM: readonly number[];
      readonly floorZM: readonly (number | null)[];
    }
  /**
   * Flat union of non-union parts, e.g. an occlusion-aware sensor footprint made of narrow sectors that
   * each stop at their first hit, so coverage does not leak through walls.
   */
  | { readonly kind: "union"; readonly parts: readonly SimpleRegion[] };

export type SimpleRegion = Exclude<Region, { kind: "union" }>;

export const MAX_UNION_PARTS = 64;
export const MAX_DEPTH_IMAGE_CELLS = 64 * 48;
export const MAX_DEPTH_IMAGE_DEPTH_M = 1000;

export type DepthImageRegion = Extract<Region, { kind: "depth_image" }>;

/** Build a depth image (see Region), orthonormalizing `up` against `forward`. Throws on an invalid image. */
export function depthImage(spec: Omit<DepthImageRegion, "kind">): DepthImageRegion {
  const forward = normalize(spec.forward);
  const along = dot(spec.up, forward);
  const up = normalize(vec3(spec.up.x - forward.x * along, spec.up.y - forward.y * along, spec.up.z - forward.z * along));
  const region: DepthImageRegion = { ...spec, kind: "depth_image", forward, up };
  const problems = depthImageProblems(region);
  if (problems.length > 0) throw new RangeError(`Invalid depth image: ${problems.join("; ")}`);
  return region;
}

/** Constraints on a depth image beyond its field types; empty when valid. */
export function depthImageProblems(r: DepthImageRegion): string[] {
  const problems = depthImageFrameProblems(r);
  const cells = r.cols * r.rows;
  if (!(Number.isSafeInteger(r.cols) && Number.isSafeInteger(r.rows) && r.cols > 0 && r.rows > 0 && cells <= MAX_DEPTH_IMAGE_CELLS)) {
    return [...problems, `grid must be positive integers with at most ${MAX_DEPTH_IMAGE_CELLS} cells`];
  }
  if (r.depthsM.length !== cells || !r.depthsM.every(d => Number.isFinite(d) && d >= 0 && d <= MAX_DEPTH_IMAGE_DEPTH_M)) {
    problems.push(`needs ${cells} depths, each finite and within 0..${MAX_DEPTH_IMAGE_DEPTH_M} m`);
  }
  if (r.floorZM.length !== cells || !r.floorZM.every(z => z === null || Number.isFinite(z))) problems.push(`needs ${cells} floor heights, each finite or null`);
  return problems;
}

function depthImageFrameProblems(r: DepthImageRegion): string[] {
  const problems: string[] = [];
  const unit = (v: Vec3) => Math.abs(Math.hypot(v.x, v.y, v.z) - 1) <= 1e-6;
  if (!unit(r.forward) || !unit(r.up) || Math.abs(dot(r.forward, r.up)) > 1e-6) problems.push("forward and up must be orthonormal");
  const fov = (a: number) => a > 0 && a < Math.PI;
  if (!fov(r.hfovRad) || !fov(r.vfovRad)) problems.push("fields of view must be in (0, π)");
  return problems;
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export function box(min: Vec3, max: Vec3): Region {
  if (min.x > max.x || min.y > max.y || min.z > max.z) throw new RangeError("Box min must not exceed max");
  return { kind: "box", min, max };
}

export function sphere(center: Vec3, radiusM: number): Region {
  if (!(radiusM >= 0)) throw new RangeError("Sphere radius must be non-negative");
  return { kind: "sphere", center, radiusM };
}

export function sector(apex: Vec3, axis: Vec3, halfAngleRad: number, rangeM: number): Region {
  if (!(halfAngleRad >= 0 && halfAngleRad <= Math.PI)) throw new RangeError("Sector half-angle must be in [0, π]");
  if (!(rangeM >= 0)) throw new RangeError("Sector range must be non-negative");
  return { kind: "sector", apex, axis: normalize(axis), halfAngleRad, rangeM };
}

export function prism(polygon: readonly Point2[], zMin: number, zMax: number): Region {
  if (polygon.length < 3) throw new RangeError("Prism polygon needs at least three vertices");
  if (zMin > zMax) throw new RangeError("Prism zMin must not exceed zMax");
  return { kind: "prism", polygon, zMin, zMax };
}

export function union(parts: readonly Region[]): Region {
  const flat = parts.flatMap(part => (part.kind === "union" ? part.parts : [part]));
  if (flat.length === 0) throw new RangeError("Union needs at least one part");
  if (flat.length > MAX_UNION_PARTS) throw new RangeError(`Union is limited to ${MAX_UNION_PARTS} parts`);
  return flat.length === 1 ? flat[0] : { kind: "union", parts: flat };
}

export function regionBounds(r: Region): Bounds {
  switch (r.kind) {
    case "depth_image":
      return depthImageBounds(r);
    case "union":
      return r.parts.map(regionBounds).reduce((a, b) => ({
        min: vec3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
        max: vec3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
      }));
    case "box":
      return { min: r.min, max: r.max };
    case "sphere":
      return expandBounds({ min: r.center, max: r.center }, r.radiusM);
    case "sector":
      return sectorBounds(r);
    case "prism": {
      const xs = r.polygon.map(p => p[0]);
      const ys = r.polygon.map(p => p[1]);
      return { min: vec3(Math.min(...xs), Math.min(...ys), r.zMin), max: vec3(Math.max(...xs), Math.max(...ys), r.zMax) };
    }
  }
}

export function expandBounds(b: Bounds, marginM: number): Bounds {
  return {
    min: vec3(b.min.x - marginM, b.min.y - marginM, b.min.z - marginM),
    max: vec3(b.max.x + marginM, b.max.y + marginM, b.max.z + marginM),
  };
}

export function boundsIntersect(a: Bounds, b: Bounds, marginM = 0): boolean {
  return a.min.x - marginM <= b.max.x && b.min.x - marginM <= a.max.x
    && a.min.y - marginM <= b.max.y && b.min.y - marginM <= a.max.y
    && a.min.z - marginM <= b.max.z && b.min.z - marginM <= a.max.z;
}

/**
 * Euclidean distance from a point to the region; 0 when the point is inside or on the boundary. For a depth
 * image (a sensor footprint, queried for containment) the distance outside is a lower bound: the distance to
 * its bounding box, but never below 1e-6, so a zero distance still means containment.
 */
export function distanceToRegion(r: Region, p: Vec3): number {
  switch (r.kind) {
    case "depth_image": {
      if (depthImageContains(r, p)) return 0;
      const b = depthImageBounds(r);
      return Math.max(1e-6, boxDistance(b.min, b.max, p));
    }
    case "union":
      return r.parts.reduce((best, part) => Math.min(best, distanceToRegion(part, p)), Infinity);
    case "box":
      return boxDistance(r.min, r.max, p);
    case "sphere":
      return Math.max(0, norm(sub(p, r.center)) - r.radiusM);
    case "sector":
      return sectorDistance(r, p);
    case "prism":
      return prismDistance(r, p);
  }
}

/**
 * Containment with fast paths for the shapes on hot coverage paths (sensor footprints are depth images or
 * unions of sectors, tested thousands of times per frame). Equivalent to distanceToRegion(r, p) <= 1e-9.
 */
export function regionContains(r: Region, p: Vec3): boolean {
  switch (r.kind) {
    case "union":
      return r.parts.some(part => regionContains(part, p));
    case "sector":
      return sectorContains(r, p);
    case "depth_image":
      return depthImageContains(r, p);
    case "box":
      return p.x >= r.min.x - 1e-9 && p.x <= r.max.x + 1e-9 && p.y >= r.min.y - 1e-9 && p.y <= r.max.y + 1e-9 && p.z >= r.min.z - 1e-9 && p.z <= r.max.z + 1e-9;
    default:
      return distanceToRegion(r, p) <= 1e-9;
  }
}

/** The camera's left axis (up × forward, so forward × left = up as in the body frame). */
function depthImageLeft(r: DepthImageRegion): Vec3 {
  return vec3(r.up.y * r.forward.z - r.up.z * r.forward.y, r.up.z * r.forward.x - r.up.x * r.forward.z, r.up.x * r.forward.y - r.up.y * r.forward.x);
}

/** Index of the cell whose rays pass through `p`, or -1 when `p` is not in front of the camera within its fields of view. */
export function depthImageCell(r: DepthImageRegion, p: Vec3): number {
  const dx = p.x - r.apex.x;
  const dy = p.y - r.apex.y;
  const dz = p.z - r.apex.z;
  const f = dx * r.forward.x + dy * r.forward.y + dz * r.forward.z;
  if (f <= 1e-9) return -1;
  const left = depthImageLeft(r);
  const tanH = Math.tan(r.hfovRad / 2);
  const tanV = Math.tan(r.vfovRad / 2);
  const u = ((tanH - (dx * left.x + dy * left.y + dz * left.z) / f) / (2 * tanH)) * r.cols;
  const v = ((tanV - (dx * r.up.x + dy * r.up.y + dz * r.up.z) / f) / (2 * tanV)) * r.rows;
  if (u < -1e-9 || u > r.cols + 1e-9 || v < -1e-9 || v > r.rows + 1e-9) return -1;
  const col = Math.min(r.cols - 1, Math.max(0, Math.floor(u)));
  const row = Math.min(r.rows - 1, Math.max(0, Math.floor(v)));
  return row * r.cols + col;
}

function depthImageContains(r: DepthImageRegion, p: Vec3): boolean {
  const cell = depthImageCell(r, p);
  if (cell < 0) return false;
  const f = (p.x - r.apex.x) * r.forward.x + (p.y - r.apex.y) * r.forward.y + (p.z - r.apex.z) * r.forward.z;
  if (f > r.depthsM[cell] + 1e-9) return false;
  const floor = r.floorZM[cell];
  return floor === null || p.z >= floor - 1e-9;
}

/** Ray direction through image-plane tangents (x towards left, y towards up), scaled so its forward component is 1. */
function depthImageRay(r: DepthImageRegion, left: Vec3, x: number, y: number): Vec3 {
  return vec3(r.forward.x + left.x * x + r.up.x * y, r.forward.y + left.y * x + r.up.y * y, r.forward.z + left.z * x + r.up.z * y);
}

const depthImageBoundsCache = new WeakMap<DepthImageRegion, Bounds>();

/** Exact bounds of the cell pyramids (apex plus far corners), with the floor clip applied to the bottom when every cell has one. */
function depthImageBounds(r: DepthImageRegion): Bounds {
  const cached = depthImageBoundsCache.get(r);
  if (cached) return cached;
  const left = depthImageLeft(r);
  const tanH = Math.tan(r.hfovRad / 2);
  const tanV = Math.tan(r.vfovRad / 2);
  const lo = [r.apex.x, r.apex.y, r.apex.z];
  const hi = [r.apex.x, r.apex.y, r.apex.z];
  let lowestFloor = Infinity;
  let unclipped = false;
  let nonEmpty = false;
  for (let row = 0; row < r.rows; row++) {
    for (let col = 0; col < r.cols; col++) {
      const cell = row * r.cols + col;
      const depth = r.depthsM[cell];
      if (!(depth > 0)) continue;
      nonEmpty = true;
      const floor = r.floorZM[cell];
      if (floor === null) unclipped = true;
      else lowestFloor = Math.min(lowestFloor, floor);
      for (const a of [col, col + 1]) {
        for (const b of [row, row + 1]) {
          const ray = depthImageRay(r, left, tanH - (2 * tanH * a) / r.cols, tanV - (2 * tanV * b) / r.rows);
          const corner = [r.apex.x + ray.x * depth, r.apex.y + ray.y * depth, r.apex.z + ray.z * depth];
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], corner[k]);
            hi[k] = Math.max(hi[k], corner[k]);
          }
        }
      }
    }
  }
  if (nonEmpty && !unclipped) lo[2] = Math.max(lo[2], Math.min(lowestFloor, hi[2]));
  const bounds = { min: vec3(lo[0], lo[1], lo[2]), max: vec3(hi[0], hi[1], hi[2]) };
  depthImageBoundsCache.set(r, bounds);
  return bounds;
}

/** A point inside the depth image: the most central usable cell's centre ray, halfway along its span above the floor. */
function depthImagePoint(r: DepthImageRegion): Vec3 {
  const left = depthImageLeft(r);
  const tanH = Math.tan(r.hfovRad / 2);
  const tanV = Math.tan(r.vfovRad / 2);
  const centre = Math.floor(r.rows / 2) * r.cols + Math.floor(r.cols / 2);
  const order = [centre, ...r.depthsM.keys()];
  for (const cell of order) {
    const depth = r.depthsM[cell];
    if (!(depth > 0)) continue;
    const row = Math.floor(cell / r.cols);
    const col = cell % r.cols;
    const ray = depthImageRay(r, left, tanH - (2 * tanH * (col + 0.5)) / r.cols, tanV - (2 * tanV * (row + 0.5)) / r.rows);
    let from = 0;
    let to = depth;
    const floor = r.floorZM[cell];
    if (floor !== null) {
      // z along the ray is apex.z + t·ray.z; keep it at or above the floor.
      if (ray.z < 0) to = Math.min(to, (r.apex.z - floor) / -ray.z);
      else if (ray.z > 0) from = Math.max(from, (floor - r.apex.z) / ray.z);
      else if (r.apex.z < floor) continue;
    }
    if (!(to > from)) continue;
    const t = (from + to) / 2;
    return vec3(r.apex.x + ray.x * t, r.apex.y + ray.y * t, r.apex.z + ray.z * t);
  }
  return r.apex;
}

/** Inside a spherical sector: within range of the apex and within the half-angle of the axis. */
function sectorContains(r: Extract<Region, { kind: "sector" }>, p: Vec3): boolean {
  const dx = p.x - r.apex.x;
  const dy = p.y - r.apex.y;
  const dz = p.z - r.apex.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const reach = r.rangeM + 1e-9;
  if (d2 > reach * reach) return false;
  if (d2 <= 1e-18) return true;
  const along = dx * r.axis.x + dy * r.axis.y + dz * r.axis.z;
  return along >= Math.sqrt(d2) * Math.cos(r.halfAngleRad) - 1e-9;
}

/** A point guaranteed to be inside (or, for degenerate shapes, on) the region. */
export function representativePoint(r: Region): Vec3 {
  switch (r.kind) {
    case "depth_image":
      return depthImagePoint(r);
    case "union":
      return representativePoint(r.parts[0]);
    case "box":
      return vec3((r.min.x + r.max.x) / 2, (r.min.y + r.max.y) / 2, (r.min.z + r.max.z) / 2);
    case "sphere":
      return r.center;
    case "sector": {
      const d = scale(r.axis, r.rangeM / 2);
      return vec3(r.apex.x + d.x, r.apex.y + d.y, r.apex.z + d.z);
    }
    case "prism":
      return prismInteriorPoint(r);
  }
}

/**
 * Deterministic grid samples of all points within `marginM` of the region. Spacing grows when needed to
 * stay under `maxPoints`. Always returns at least one point.
 */
export function samplePoints(r: Region, spacingM: number, marginM = 0, maxPoints = 4096): Vec3[] {
  if (!(spacingM > 0)) throw new RangeError("Sample spacing must be positive");
  const b = expandBounds(regionBounds(r), marginM);
  const extent = sub(b.max, b.min);
  let spacing = spacingM;
  let counts = gridCounts(extent, spacing);
  while (counts[0] * counts[1] * counts[2] > maxPoints) {
    spacing *= Math.cbrt((counts[0] * counts[1] * counts[2]) / maxPoints) * 1.01;
    counts = gridCounts(extent, spacing);
  }
  const points: Vec3[] = [];
  const [nx, ny, nz] = counts;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const p = vec3(b.min.x + ((i + 0.5) * extent.x) / nx, b.min.y + ((j + 0.5) * extent.y) / ny, b.min.z + ((k + 0.5) * extent.z) / nz);
        if (marginM === 0 ? regionContains(r, p) : distanceToRegion(r, p) <= marginM + 1e-9) points.push(p);
      }
    }
  }
  return points.length > 0 ? points : [representativePoint(r)];
}

/** Sampling-based overlap test; exact for disjoint bounds. */
export function regionsOverlap(a: Region, b: Region, spacingM = 0.2): boolean {
  if (!boundsIntersect(regionBounds(a), regionBounds(b))) return false;
  if (regionContains(b, representativePoint(a)) || regionContains(a, representativePoint(b))) return true;
  return samplePoints(a, spacingM).some(p => regionContains(b, p)) || samplePoints(b, spacingM).some(p => regionContains(a, p));
}

export function pointInPolygon(x: number, y: number, polygon: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed area; positive for counter-clockwise polygons. */
export function polygonArea(polygon: readonly Point2[]): number {
  let twice = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    twice += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  return twice / 2;
}

/**
 * Exact axis-aligned bounds of a spherical sector. Along a world direction e, the farthest point lies at
 * range R in the cone direction closest to e: extent = R · max(0, cos(max(0, φ − θ))), where φ is the
 * angle between the axis and e; the apex bounds the other side.
 */
function sectorBounds(r: Extract<Region, { kind: "sector" }>): Bounds {
  const extent = (component: number): number => {
    const phi = Math.acos(Math.max(-1, Math.min(1, component)));
    return r.rangeM * Math.max(0, Math.cos(Math.max(0, phi - r.halfAngleRad)));
  };
  const { x, y, z } = r.axis;
  return {
    min: vec3(r.apex.x - extent(-x), r.apex.y - extent(-y), r.apex.z - extent(-z)),
    max: vec3(r.apex.x + extent(x), r.apex.y + extent(y), r.apex.z + extent(z)),
  };
}

function gridCounts(extent: Vec3, spacing: number): [number, number, number] {
  return [extent.x, extent.y, extent.z].map(e => Math.max(1, Math.ceil(e / spacing))) as [number, number, number];
}

function boxDistance(min: Vec3, max: Vec3, p: Vec3): number {
  const dx = Math.max(min.x - p.x, 0, p.x - max.x);
  const dy = Math.max(min.y - p.y, 0, p.y - max.y);
  const dz = Math.max(min.z - p.z, 0, p.z - max.z);
  return Math.hypot(dx, dy, dz);
}

/** Distance to a spherical sector, computed in the (axial, radial) half-plane. */
function sectorDistance(r: Extract<Region, { kind: "sector" }>, p: Vec3): number {
  const d = sub(p, r.apex);
  const axial = dot(d, r.axis);
  const radial = norm(sub(d, scale(r.axis, axial)));
  const rho = Math.hypot(axial, radial);
  if (Math.atan2(radial, axial) <= r.halfAngleRad) return Math.max(0, rho - r.rangeM);
  const c = Math.cos(r.halfAngleRad);
  const s = Math.sin(r.halfAngleRad);
  const along = axial * c + radial * s;
  if (along <= 0) return rho;
  if (along >= r.rangeM) return Math.hypot(axial - r.rangeM * c, radial - r.rangeM * s);
  return radial * c - axial * s;
}

function prismDistance(r: Extract<Region, { kind: "prism" }>, p: Vec3): number {
  const dxy = pointInPolygon(p.x, p.y, r.polygon) ? 0 : polygonBoundaryDistance(p.x, p.y, r.polygon);
  const dz = Math.max(r.zMin - p.z, 0, p.z - r.zMax);
  return Math.hypot(dxy, dz);
}

function polygonBoundaryDistance(x: number, y: number, polygon: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    best = Math.min(best, segmentDistance(x, y, polygon[j], polygon[i]));
  }
  return best;
}

function segmentDistance(px: number, py: number, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function prismInteriorPoint(r: Extract<Region, { kind: "prism" }>): Vec3 {
  const z = (r.zMin + r.zMax) / 2;
  const cx = r.polygon.reduce((sum, p) => sum + p[0], 0) / r.polygon.length;
  const cy = r.polygon.reduce((sum, p) => sum + p[1], 0) / r.polygon.length;
  if (pointInPolygon(cx, cy, r.polygon)) return vec3(cx, cy, z);
  // Concave polygon: fall back to the first interior grid sample.
  const samples = samplePoints({ kind: "box", ...regionBounds(r) }, 0.1).filter(p => pointInPolygon(p.x, p.y, r.polygon));
  return samples.length > 0 ? vec3(samples[0].x, samples[0].y, z) : vec3(r.polygon[0][0], r.polygon[0][1], z);
}
