import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vec3 } from "./frames.ts";
import type { Region } from "./geometry.ts";
import { box, depthImage, depthImageCell, distanceToRegion, prism, regionBounds, regionContains, regionsOverlap, representativePoint, samplePoints, sector, sphere, union } from "./geometry.ts";

/** Deterministic pseudo-random sequence for property tests (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Apex, lateral cone surface and spherical cap of a sector, sampled densely. */
function sectorSurface(s: Extract<Region, { kind: "sector" }>): ReturnType<typeof vec3>[] {
  const a = s.axis;
  const helper = Math.abs(a.x) < 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  const u = normalized(cross(a, helper));
  const v = cross(a, u);
  const at = (rho: number, polar: number, azimuth: number) => {
    const radial = rho * Math.sin(polar);
    return vec3(
      s.apex.x + rho * Math.cos(polar) * a.x + radial * (Math.cos(azimuth) * u.x + Math.sin(azimuth) * v.x),
      s.apex.y + rho * Math.cos(polar) * a.y + radial * (Math.cos(azimuth) * u.y + Math.sin(azimuth) * v.y),
      s.apex.z + rho * Math.cos(polar) * a.z + radial * (Math.cos(azimuth) * u.z + Math.sin(azimuth) * v.z),
    );
  };
  const points = [s.apex];
  for (let k = 0; k < 720; k++) {
    const azimuth = (k / 720) * 2 * Math.PI;
    for (let rho = 0.02; rho <= s.rangeM; rho += 0.02) points.push(at(rho, s.halfAngleRad, azimuth));
    for (let polar = 0; polar <= s.halfAngleRad; polar += 0.005) points.push(at(s.rangeM, polar, azimuth));
  }
  return points;
}

function cross(p: ReturnType<typeof vec3>, q: ReturnType<typeof vec3>) {
  return vec3(p.y * q.z - p.z * q.y, p.z * q.x - p.x * q.z, p.x * q.y - p.y * q.x);
}

function normalized(p: ReturnType<typeof vec3>) {
  const n = Math.hypot(p.x, p.y, p.z);
  return vec3(p.x / n, p.y / n, p.z / n);
}

describe("sector distance", () => {
  const s = sector(vec3(0, 0, 0), vec3(1, 0, 0), Math.PI / 6, 4);

  test("is zero inside, and measured from the apex for points behind it", () => {
    assert.equal(distanceToRegion(s, vec3(2, 0.5, 0)), 0);
    assert.ok(Math.abs(distanceToRegion(s, vec3(-3, 0, 0)) - 3) < 1e-12);
    assert.ok(Math.abs(distanceToRegion(s, vec3(-1, 1, 0)) - Math.SQRT2) < 1e-12);
  });

  test("beyond the range along the axis is measured to the spherical cap", () => {
    assert.ok(Math.abs(distanceToRegion(s, vec3(5.5, 0, 0)) - 1.5) < 1e-12);
  });

  test("beside the cone is measured perpendicular to the edge", () => {
    // Point at axial 2, radial 2: edge direction (cos30°, sin30°); perpendicular distance = 2cos30° − 2sin30°.
    const expected = 2 * Math.cos(Math.PI / 6) - 2 * Math.sin(Math.PI / 6);
    assert.ok(Math.abs(distanceToRegion(s, vec3(2, 0, 2)) - expected) < 1e-12);
  });

  test("matches brute-force distance to a dense sampling of the sector surface", () => {
    const apex = vec3(1, -2, 0.5);
    const tilted = sector(apex, vec3(0.3, 0.8, -0.2), 0.4, 3);
    if (tilted.kind !== "sector") throw new Error("expected a sector");
    const surface = sectorSurface(tilted);
    const next = random(7);
    let exteriorChecked = 0;
    for (let i = 0; i < 60; i++) {
      const p = vec3(next() * 10 - 4, next() * 10 - 6, next() * 6 - 3);
      const exact = distanceToRegion(tilted, p);
      if (exact === 0) continue;
      exteriorChecked++;
      const brute = surface.reduce((best, q) => Math.min(best, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)), Infinity);
      // The nearest point of a solid to an exterior point lies on its surface; samples are ≤ ~3 cm apart.
      assert.ok(exact <= brute + 1e-9 && brute - exact < 0.03, `point ${i}: exact ${exact}, brute ${brute}`);
    }
    assert.ok(exteriorChecked > 40);
  });
});

describe("sector bounds", () => {
  test("are exact: every surface sample lies inside and each face is touched", () => {
    const cases = [
      sector(vec3(1, -2, 0.5), vec3(0.3, 0.8, -0.2), 0.4, 3),
      sector(vec3(0, 0, 3), vec3(1, 0, -0.3), (8 * Math.PI) / 180, 2.6),
      sector(vec3(0, 0, 0), vec3(0, 0, 1), 2.5, 1),
    ];
    for (const s of cases) {
      if (s.kind !== "sector") throw new Error("expected a sector");
      const b = regionBounds(s);
      const surface = sectorSurface(s);
      const tolerance = 1e-9;
      assert.ok(surface.every(p => p.x >= b.min.x - tolerance && p.x <= b.max.x + tolerance && p.y >= b.min.y - tolerance && p.y <= b.max.y + tolerance && p.z >= b.min.z - tolerance && p.z <= b.max.z + tolerance));
      const near = (value: number, target: number) => Math.abs(value - target) < 0.02;
      for (const axis of ["x", "y", "z"] as const) {
        assert.ok(surface.some(p => near(p[axis], b.min[axis])), `${axis} min is touched`);
        assert.ok(surface.some(p => near(p[axis], b.max[axis])), `${axis} max is touched`);
      }
    }
  });

  test("keep a narrow spray sector's samples at the requested spacing", () => {
    const spray = sector(vec3(1.5, 0.75, 4.2), vec3(2.5, 0, -0.8), (8 * Math.PI) / 180, 3.1);
    const coarse = samplePoints(spray, 0.25, 1.0, 4096);
    // With loose sphere-sized bounds the cap forced ~0.46 m spacing (about 200 points).
    assert.ok(coarse.length > 600, `got ${coarse.length} samples`);
  });
});

describe("prism (room) regions", () => {
  // L-shaped room: the notch at x > 2, y > 2 is outside.
  const room = prism([[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]], 3, 5.6);

  test("contains points inside the polygon and height band only", () => {
    assert.ok(regionContains(room, vec3(1, 3, 4)));
    assert.ok(!regionContains(room, vec3(3, 3, 4)), "notch is outside");
    assert.ok(!regionContains(room, vec3(1, 1, 6)), "above the ceiling is outside");
  });

  test("distance combines nearest wall and height offsets", () => {
    assert.ok(Math.abs(distanceToRegion(room, vec3(3, 3, 4)) - 1) < 1e-12);
    assert.ok(Math.abs(distanceToRegion(room, vec3(1, 1, 6.6)) - 1) < 1e-12);
    assert.ok(Math.abs(distanceToRegion(room, vec3(5, 1, 2)) - Math.SQRT2) < 1e-12);
  });
});

describe("sampling and overlap", () => {
  test("samples lie within region plus margin, stay under the cap and are deterministic", () => {
    const regions: Region[] = [box(vec3(0, 0, 0), vec3(2, 1, 1)), sphere(vec3(1, 1, 1), 0.7), sector(vec3(0, 0, 0), vec3(0, 1, 0), 0.3, 2)];
    for (const region of regions) {
      const points = samplePoints(region, 0.1, 0.25, 3000);
      assert.ok(points.length > 0 && points.length <= 3000);
      assert.ok(points.every(p => distanceToRegion(region, p) <= 0.25 + 1e-9));
      assert.deepEqual(samplePoints(region, 0.1, 0.25, 3000), points);
    }
  });

  test("a region smaller than the spacing still yields a representative point", () => {
    const tiny = sphere(vec3(5, 5, 5), 0.01);
    const points = samplePoints(tiny, 1);
    assert.equal(points.length, 1);
    assert.ok(regionContains(tiny, points[0]));
  });

  test("overlap: disjoint, touching and sector-into-box cases", () => {
    const a = box(vec3(0, 0, 0), vec3(1, 1, 1));
    assert.equal(regionsOverlap(a, box(vec3(1.5, 0, 0), vec3(2, 1, 1))), false);
    assert.equal(regionsOverlap(a, sphere(vec3(1.4, 0.5, 0.5), 0.5)), true);
    assert.equal(regionsOverlap(sector(vec3(-3, 0.5, 0.5), vec3(1, 0, 0), 0.1, 3.2), a), true);
    assert.equal(regionsOverlap(sector(vec3(-3, 0.5, 0.5), vec3(-1, 0, 0), 0.1, 3.2), a), false);
  });
});

describe("union regions (occlusion-aware footprints)", () => {
  // Two narrow sectors standing in for a camera footprint whose middle ray hit a wall at 1.5 m.
  const left = sector(vec3(0, 0, 1), vec3(1, 0.4, 0), 0.15, 5);
  const blocked = sector(vec3(0, 0, 1), vec3(1, 0, 0), 0.15, 1.5);
  const footprint = union([left, blocked]);

  test("contains a point when any part does, and not points beyond a part's first hit", () => {
    assert.ok(regionContains(footprint, vec3(1, 0, 1)));
    assert.ok(!regionContains(footprint, vec3(3, 0, 1)), "behind the wall along the blocked ray");
    assert.ok(regionContains(footprint, vec3(4, 1.6, 1)), "far along the clear ray");
  });

  test("distance is the minimum over parts and bounds enclose every part", () => {
    const p = vec3(3, 0, 1);
    assert.equal(distanceToRegion(footprint, p), Math.min(distanceToRegion(left, p), distanceToRegion(blocked, p)));
    const samples = samplePoints(footprint, 0.2);
    assert.ok(samples.length > 0 && samples.every(q => regionContains(footprint, q)));
  });

  test("unions flatten, collapse a single part and reject empty or oversized input", () => {
    const nested = union([footprint, sphere(vec3(0, 0, 0), 1)]);
    assert.equal(nested.kind, "union");
    assert.ok(nested.kind === "union" && nested.parts.every(part => (part as Region).kind !== "union") && nested.parts.length === 3);
    assert.deepEqual(union([left]), left);
    assert.throws(() => union([]), RangeError);
    assert.throws(() => union(Array.from({ length: 65 }, () => sphere(vec3(0, 0, 0), 1))), RangeError);
  });
});

describe("fast containment", () => {
  test("agrees with distanceToRegion for sectors, boxes and unions away from the boundary", () => {
    const next = random(11);
    const regions: Region[] = [
      sector(vec3(1, 2, 3), vec3(0.4, -0.7, 0.2), 0.3, 4),
      sector(vec3(0, 0, 0), vec3(0, 0, -1), 1.9, 2),
      box(vec3(-1, -2, 0), vec3(2, 1, 3)),
      union([sector(vec3(0, 0, 1), vec3(1, 0, 0), 0.2, 3), sector(vec3(0, 0, 1), vec3(0, 1, 0), 0.2, 3), box(vec3(4, 4, 0), vec3(5, 5, 1))]),
    ];
    let compared = 0;
    for (const region of regions) {
      for (let i = 0; i < 4000; i++) {
        const p = vec3(next() * 12 - 6, next() * 12 - 6, next() * 8 - 2);
        const d = distanceToRegion(region, p);
        if (d > 0 && d < 1e-6) continue;
        compared++;
        assert.equal(regionContains(region, p), d <= 1e-9, `${region.kind} at ${JSON.stringify(p)} (distance ${d})`);
      }
    }
    assert.ok(compared > 15000);
  });
});

describe("depth image footprint", () => {
  // Camera 1.5 m up looking along +x; image left is +y, image up is +z. 4 × 2 cells over 90° × 60°.
  const cols = 4;
  const rows = 2;
  const camera = (depthsM: number[], floorZM: (number | null)[]) =>
    depthImage({ apex: vec3(0, 0, 1.5), forward: vec3(1, 0, 0), up: vec3(0, 0, 1), hfovRad: Math.PI / 2, vfovRad: Math.PI / 3, cols, rows, depthsM, floorZM });
  const tanV = Math.tan(Math.PI / 6);

  test("cells are row-major from the top-left of the image, with left towards up × forward", () => {
    const image = camera(Array(8).fill(5), Array(8).fill(null));
    assert.equal(depthImageCell(image, vec3(3, 2.9, 2.5)), 0, "top, far left");
    assert.equal(depthImageCell(image, vec3(3, -2.9, 2.5)), 3, "top, far right");
    assert.equal(depthImageCell(image, vec3(3, 0.1, 0.5)), 5, "bottom, just left of centre");
    assert.equal(depthImageCell(image, vec3(-1, 0, 1.5)), -1, "behind the camera");
    assert.equal(depthImageCell(image, vec3(3, 3.2, 1.5)), -1, "outside the horizontal field of view");
    assert.equal(depthImageCell(image, vec3(3, 0, 1.5 + 3 * tanV + 0.05)), -1, "above the vertical field of view");
  });

  test("a point is inside only within its cell's z-depth and at or above its cell's floor", () => {
    const depths = [5, 5, 5, 5, 5, 1, 5, 5];
    const floors = [null, null, null, null, 0, 0, 0.4, 0];
    const image = camera(depths, floors);
    assert.ok(regionContains(image, vec3(4.9, 0.5, 2)), "top row within depth");
    assert.ok(!regionContains(image, vec3(5.1, 0.5, 2)), "beyond the depth (measured along forward, not range)");
    assert.ok(regionContains(image, vec3(4.9, 4.8, 3.3)), "a far corner: range about 7.6 m but z-depth 4.9 m");
    assert.ok(regionContains(image, vec3(0.9, 0.2, 1.2)) && !regionContains(image, vec3(1.1, 0.2, 1.2)), "the short cell stops at 1 m");
    assert.ok(regionContains(image, vec3(4, -0.5, 0.45)) && !regionContains(image, vec3(4, -0.5, 0.35)), "cell 6 is clipped at 0.4 m");
    assert.ok(regionContains(image, vec3(4, 2.5, 0.05)), "the air just above a floor at a grazing angle stays in view");
    assert.ok(!regionContains(image, vec3(4, 2.5, -0.05)), "nothing below a floor the camera looked down onto");
    assert.equal(distanceToRegion(image, vec3(4.9, 0.5, 2)), 0);
    assert.ok(distanceToRegion(image, vec3(4, 2.5, -0.05)) > 0, "a zero distance still means containment");
  });

  test("bounds hold every contained point, exclude space behind the camera, and apply a full floor clip", () => {
    const next = random(5);
    const depths = Array.from({ length: 8 }, () => 0.5 + next() * 6);
    const floors = Array.from({ length: 8 }, () => next() * 0.6);
    const image = camera(depths, floors);
    const b = regionBounds(image);
    assert.equal(b.min.x, 0, "nothing behind the apex");
    assert.ok(b.min.z >= Math.min(...floors) - 1e-12, "clipped at the lowest floor");
    let inside = 0;
    for (let i = 0; i < 20000; i++) {
      const p = vec3(next() * 8 - 1, next() * 16 - 8, next() * 10 - 4);
      if (!regionContains(image, p)) continue;
      inside++;
      assert.ok(p.x >= b.min.x - 1e-9 && p.x <= b.max.x + 1e-9 && p.y >= b.min.y - 1e-9 && p.y <= b.max.y + 1e-9 && p.z >= b.min.z - 1e-9 && p.z <= b.max.z + 1e-9);
    }
    assert.ok(inside > 500, `sampled ${inside} contained points`);
    // The bounds are tight: the far top-left corner of cell 0 is attained.
    const corner = vec3(depths[0], depths[0], 1.5 + depths[0] * tanV);
    assert.ok(Math.abs(b.max.y - Math.max(depths[0], depths[4])) < 1e-9 && b.max.z >= corner.z - 1e-9);
  });

  test("the representative point is inside even when the central cells are clipped or empty", () => {
    const next = random(9);
    for (let trial = 0; trial < 200; trial++) {
      const depths = Array.from({ length: 8 }, () => (next() < 0.3 ? 0 : next() * 6));
      const floors = Array.from({ length: 8 }, () => (next() < 0.3 ? null : next() * 1.4));
      if (depths.every(d => d === 0)) continue;
      const image = camera(depths, floors);
      assert.ok(regionContains(image, representativePoint(image)), JSON.stringify({ depths, floors }));
    }
  });

  test("samples without a margin are only contained points; the builder validates and orthonormalizes", () => {
    const image = camera([3, 3, 3, 3, 3, 3, 3, 3], [0, 0, 0, 0, 0, 0, 0, 0]);
    const points = samplePoints(image, 0.25);
    assert.ok(points.length > 50 && points.every(p => regionContains(image, p)));
    const tilted = depthImage({ apex: vec3(0, 0, 0), forward: vec3(2, 0, 0), up: vec3(0.3, 0, 1), hfovRad: 1, vfovRad: 1, cols: 1, rows: 1, depthsM: [1], floorZM: [null] });
    assert.deepEqual([tilted.forward, tilted.up], [vec3(1, 0, 0), vec3(0, 0, 1)]);
    const bad = { apex: vec3(0, 0, 0), forward: vec3(1, 0, 0), up: vec3(0, 0, 1), hfovRad: 1, vfovRad: 1, cols: 2, rows: 1 };
    assert.throws(() => depthImage({ ...bad, depthsM: [1], floorZM: [null, null] }), /2 depths/);
    assert.throws(() => depthImage({ ...bad, depthsM: [1, Number.NaN], floorZM: [null, null] }), /depths/);
    assert.throws(() => depthImage({ ...bad, depthsM: [1, 1], floorZM: [null] }), /floor heights/);
    assert.throws(() => depthImage({ ...bad, hfovRad: Math.PI, depthsM: [1, 1], floorZM: [null, null] }), /fields of view/);
    assert.throws(() => depthImage({ ...bad, forward: vec3(0, 0, 1), depthsM: [1, 1], floorZM: [null, null] }), /orthonormal|normalize/);
  });
});
