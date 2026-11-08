"""Pure-Python geometry core for the Troy training scene recipe (no bpy).

Used by build_troy_scene.py. Everything here is deterministic: no randomness,
no set iteration, fixed rounding. Coordinates are simulation-world metres
(right-handed, Z up). See README.md for frames and provenance.
"""

import math

# --------------------------------------------------------------------------
# Geodesy: WGS84 local tangent plane (equirectangular with ellipsoidal radii).
# Error over the ~120 m site is far below the 1 cm output rounding.
# --------------------------------------------------------------------------
WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)


class LocalFrame:
    """Maps lat/lon to site-grid metres: ENU about (lat0, lon0), rotated by -theta, shifted."""

    def __init__(self, lat0, lon0, theta=0.0, shift=(0.0, 0.0)):
        self.lat0, self.lon0, self.theta, self.shift = lat0, lon0, theta, shift
        s = math.sin(math.radians(lat0))
        self.m = WGS84_A * (1.0 - WGS84_E2) / (1.0 - WGS84_E2 * s * s) ** 1.5
        self.n = WGS84_A / math.sqrt(1.0 - WGS84_E2 * s * s)
        self.coslat = math.cos(math.radians(lat0))

    def enu(self, lat, lon):
        return (math.radians(lon - self.lon0) * self.n * self.coslat, math.radians(lat - self.lat0) * self.m)

    def to_site(self, lat, lon):
        e, n = self.enu(lat, lon)
        c, s = math.cos(-self.theta), math.sin(-self.theta)
        return (e * c - n * s - self.shift[0], e * s + n * c - self.shift[1])

    def to_latlon(self, x, y):
        x, y = x + self.shift[0], y + self.shift[1]
        c, s = math.cos(self.theta), math.sin(self.theta)
        e, n = x * c - y * s, x * s + y * c
        return (self.lat0 + math.degrees(n / self.m), self.lon0 + math.degrees(e / (self.n * self.coslat)))


def dominant_angle(points):
    """Length-weighted circular mean of edge directions modulo 90 degrees (radians)."""
    sx = sy = 0.0
    for i in range(len(points)):
        (x0, y0), (x1, y1) = points[i], points[(i + 1) % len(points)]
        length = math.hypot(x1 - x0, y1 - y0)
        a = math.atan2(y1 - y0, x1 - x0)
        sx += length * math.cos(4.0 * a)
        sy += length * math.sin(4.0 * a)
    return math.atan2(sy, sx) / 4.0


def polygon_area(poly):
    """Signed area (positive = counter-clockwise)."""
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                     for i in range(len(poly)))


def polygon_centroid(poly):
    a2 = cx = cy = 0.0
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        cr = x0 * y1 - x1 * y0
        a2 += cr
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    return (cx / (3.0 * a2), cy / (3.0 * a2))


def point_in_polygon(p, poly):
    x, y = p
    inside = False
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def rectilinearize(labelled, collinear_deg=20.0):
    """Snap a nearly axis-aligned ring [(label, x, y)] to an exact rectilinear ring.

    Near-collinear vertices are dropped (returned separately). Each horizontal edge
    takes the mean y of its endpoints and each vertical edge the mean x.
    Returns (ring, dropped_labels, max_displacement).
    """
    keep, dropped = [], []
    count = len(labelled)
    for i in range(count):
        p0, p1, p2 = labelled[i - 1], labelled[i], labelled[(i + 1) % count]
        a1 = math.atan2(p1[2] - p0[2], p1[1] - p0[1])
        a2 = math.atan2(p2[2] - p1[2], p2[1] - p1[1])
        turn = abs((a2 - a1 + math.pi) % (2.0 * math.pi) - math.pi)
        (dropped if turn < math.radians(collinear_deg) else keep).append(p1)
    n = len(keep)
    horizontal = [abs(keep[(i + 1) % n][2] - keep[i][2]) < abs(keep[(i + 1) % n][1] - keep[i][1]) for i in range(n)]
    if any(horizontal[i] == horizontal[(i + 1) % n] for i in range(n)):
        raise ValueError("footprint edges do not alternate horizontal/vertical")
    xs, ys = [0.0] * n, [0.0] * n
    for i in range(n):
        j = (i + 1) % n
        if horizontal[i]:
            ys[i] = ys[j] = 0.5 * (keep[i][2] + keep[j][2])
        else:
            xs[i] = xs[j] = 0.5 * (keep[i][1] + keep[j][1])
    ring = [(keep[i][0], xs[i], ys[i]) for i in range(n)]
    disp = max(math.hypot(keep[i][1] - xs[i], keep[i][2] - ys[i]) for i in range(n))
    return ring, [d[0] for d in dropped], disp


def slab_rectangles(poly):
    """Exact decomposition of a rectilinear polygon into axis-aligned rectangles."""
    ys = sorted({round(p[1], 6) for p in poly})
    verticals = []
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        if abs(x0 - x1) < 1e-9 and abs(y0 - y1) > 1e-9:
            verticals.append((x0, min(y0, y1), max(y0, y1)))
    rects = []
    for ya, yb in zip(ys, ys[1:]):
        mid = 0.5 * (ya + yb)
        xs = sorted(x for x, lo, hi in verticals if lo < mid < hi)
        for k in range(0, len(xs) - 1, 2):
            rects.append([xs[k], xs[k + 1], ya, yb])
    merged = []  # merge vertically adjacent rectangles with identical x-intervals
    for r in rects:
        for m in merged:
            if abs(m[0] - r[0]) < 1e-9 and abs(m[1] - r[1]) < 1e-9 and abs(m[3] - r[2]) < 1e-9:
                m[3] = r[3]
                break
        else:
            merged.append(list(r))
    return [tuple(r) for r in merged]


def merge_rects(rects):
    """Merge rectangles that share a full edge (deterministic order)."""
    rects = sorted(tuple(r) for r in rects)
    changed = True
    while changed:
        changed = False
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                same_x = abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9
                same_y = abs(a[2] - b[2]) < 1e-9 and abs(a[3] - b[3]) < 1e-9
                if same_x and (abs(a[3] - b[2]) < 1e-9 or abs(b[3] - a[2]) < 1e-9):
                    m = (a[0], a[1], min(a[2], b[2]), max(a[3], b[3]))
                elif same_y and (abs(a[1] - b[0]) < 1e-9 or abs(b[1] - a[0]) < 1e-9):
                    m = (min(a[0], b[0]), max(a[1], b[1]), a[2], a[3])
                else:
                    continue
                rects = sorted(rects[:i] + rects[i + 1:j] + rects[j + 1:] + [m])
                changed = True
                break
            if changed:
                break
    return rects


def split_rects(rects, xcuts=(), ycuts=()):
    out = []
    for x0, x1, y0, y1 in rects:
        xs = [x0] + sorted(c for c in xcuts if x0 + 1e-6 < c < x1 - 1e-6) + [x1]
        ys = [y0] + sorted(c for c in ycuts if y0 + 1e-6 < c < y1 - 1e-6) + [y1]
        for xa, xb in zip(xs, xs[1:]):
            for ya, yb in zip(ys, ys[1:]):
                out.append((xa, xb, ya, yb))
    return out


def wall_rects(u0, u1, z0, z1, holes):
    """Solid rectangles of a wall [u0,u1]x[z0,z1] minus holes [(ua, ub, za, zb)]."""
    cuts = sorted({u0, u1} | {h[0] for h in holes} | {h[1] for h in holes})
    cuts = [c for c in cuts if u0 - 1e-9 <= c <= u1 + 1e-9]
    strips = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-6:
            continue
        mid = 0.5 * (a + b)
        z, solids = z0, []
        for za, zb in sorted((h[2], h[3]) for h in holes if h[0] < mid < h[1]):
            if za > z + 1e-6:
                solids.append((z, za))
            z = max(z, zb)
        if z1 > z + 1e-6:
            solids.append((z, z1))
        if strips and strips[-1][2] == tuple(solids) and abs(strips[-1][1] - a) < 1e-9:
            strips[-1] = (strips[-1][0], b, strips[-1][2])
        else:
            strips.append((a, b, tuple(solids)))
    return [(a, b, za, zb) for a, b, solids in strips for za, zb in solids]


def split_z(rects, levels):
    out = []
    for ua, ub, za, zb in rects:
        cuts = [za] + sorted(l for l in levels if za + 1e-6 < l < zb - 1e-6) + [zb]
        out.extend((ua, ub, a, b) for a, b in zip(cuts, cuts[1:]))
    return out


# --------------------------------------------------------------------------
# Wall faces: a vertical plane (x = c or y = c) with an outward normal sign.
# Face coordinates: u along the wall, z up, d along the outward normal.
# --------------------------------------------------------------------------
class Face:
    def __init__(self, axis, c, n, u0, u1, name=""):
        self.axis, self.c, self.n, self.u0, self.u1, self.name = axis, c, n, u0, u1, name

    def box(self, ua, ub, za, zb, da, db):
        d0, d1 = sorted((self.c + self.n * da, self.c + self.n * db))
        ua, ub = min(ua, ub), max(ua, ub)
        if self.axis == "x":
            return (d0, ua, za), (d1, ub, zb)
        return (ua, d0, za), (ub, d1, zb)

    def point(self, u, z, d=0.0):
        if self.axis == "x":
            return (self.c + self.n * d, u, z)
        return (u, self.c + self.n * d, z)

    def normal(self):
        return (float(self.n), 0.0, 0.0) if self.axis == "x" else (0.0, float(self.n), 0.0)

    def outer_key(self):
        return ("+" if self.n > 0 else "-") + self.axis

    def inner_key(self):
        return ("-" if self.n > 0 else "+") + self.axis


def footprint_faces(ring):
    """Faces for each edge of a rectilinear ring [(label, x, y)], with corner convexity."""
    pts = [(p[1], p[2]) for p in ring]
    ccw = polygon_area(pts) > 0
    faces = []
    n = len(pts)
    for i in range(n):
        (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        nx, ny = (dy, -dx) if ccw else (-dy, dx)
        convex = []
        for k in (i, (i + 1) % n):
            (ax, ay), (bx, by), (cx, cy) = pts[k - 1], pts[k], pts[(k + 1) % n]
            cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
            convex.append((cross > 0) == ccw)
        if abs(dy) < 1e-9:
            face = Face("y", y0, 1 if ny > 0 else -1, min(x0, x1), max(x0, x1))
            start_is_low = x0 < x1
        else:
            face = Face("x", x0, 1 if nx > 0 else -1, min(y0, y1), max(y0, y1))
            start_is_low = y0 < y1
        face.convex_low = convex[0] if start_is_low else convex[1]
        face.convex_high = convex[1] if start_is_low else convex[0]
        face.labels = (ring[i][0], ring[(i + 1) % n][0])
        faces.append(face)
    return faces


# --------------------------------------------------------------------------
# Mesh builder: shared-vertex polygons with per-face material names.
# All polygons are wound counter-clockwise seen from outside (outward normals).
# --------------------------------------------------------------------------
def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def newell(points):
    nx = ny = nz = 0.0
    for i in range(len(points)):
        a, b = points[i], points[(i + 1) % len(points)]
        nx += (a[1] - b[1]) * (a[2] + b[2])
        ny += (a[2] - b[2]) * (a[0] + b[0])
        nz += (a[0] - b[0]) * (a[1] + b[1])
    return (nx, ny, nz)


BOX_FACES = {  # corner indices v0..v7 (see box()) -> outward quads
    "-z": (0, 3, 2, 1), "+z": (4, 5, 6, 7), "-y": (0, 1, 5, 4),
    "+y": (2, 3, 7, 6), "-x": (3, 0, 4, 7), "+x": (1, 2, 6, 5),
}
FACE_ORDER = ("-z", "+z", "-y", "+y", "-x", "+x")


class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.mats = [], [], []

    def _v(self, p):
        self.verts.append((round(p[0], 4), round(p[1], 4), round(p[2], 4)))
        return len(self.verts) - 1

    def poly(self, points, mat, outward=None):
        if outward is not None and _dot(newell(points), outward) < 0:
            points = list(reversed(points))
        self.faces.append(tuple(self._v(p) for p in points))
        self.mats.append(mat)

    def box(self, lo, hi, mat, faces=None, skip=()):
        """Axis-aligned box; `faces` maps face keys ('+x', ...) to material names."""
        (x0, y0, z0), (x1, y1, z1) = lo, hi
        if not (x1 > x0 and y1 > y0 and z1 > z0):
            raise ValueError("degenerate box %r %r" % (lo, hi))
        corners = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                   (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        self.hexa(corners, mat, faces, skip)

    def hexa(self, corners, mat, faces=None, skip=()):
        base = len(self.verts)
        for p in corners:
            self._v(p)
        for key in FACE_ORDER:
            if key in skip:
                continue
            self.faces.append(tuple(base + k for k in BOX_FACES[key]))
            self.mats.append((faces or {}).get(key, mat))

    def oriented_box(self, a, b, width, height, mat, up=(0.0, 0.0, 1.0)):
        """Box of given width/height centred on segment a->b (for beams, arms, strips)."""
        d = _sub(b, a)
        length = math.sqrt(_dot(d, d))
        fx = (d[0] / length, d[1] / length, d[2] / length)
        side = _cross(up, fx)
        sl = math.sqrt(_dot(side, side))
        if sl < 1e-9:  # segment parallel to `up`: pick another reference axis
            side = _cross((1.0, 0.0, 0.0), fx)
            sl = math.sqrt(_dot(side, side))
        side = (side[0] / sl, side[1] / sl, side[2] / sl)
        top = _cross(fx, side)
        hw, hh = width / 2.0, height / 2.0
        def corner(p, s, t):
            return tuple(p[i] + side[i] * s + top[i] * t for i in range(3))
        # order matches box(): x along fx, y along side, z along top
        c = [corner(a, -hw, -hh), corner(b, -hw, -hh), corner(b, hw, -hh), corner(a, hw, -hh),
             corner(a, -hw, hh), corner(b, -hw, hh), corner(b, hw, hh), corner(a, hw, hh)]
        # side = up x fx points left of travel, so (fx, side, top) is right-handed
        self.hexa(c, mat)

    def cylinder(self, center, radius, z0, z1, mat, segments=12, caps=True, cap_mat=None):
        cx, cy = center
        ring = [(cx + radius * math.cos(2 * math.pi * k / segments), cy + radius * math.sin(2 * math.pi * k / segments))
                for k in range(segments)]
        for k in range(segments):
            (ax, ay), (bx, by) = ring[k], ring[(k + 1) % segments]
            self.poly([(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)], mat)
        if caps:
            self.poly([(x, y, z1) for x, y in ring], cap_mat or mat, outward=(0, 0, 1))
            self.poly([(x, y, z0) for x, y in ring], cap_mat or mat, outward=(0, 0, -1))

    def cylinder_x(self, center, radius, x0, x1, mat, segments=10):
        """Cylinder along X (tanks, nozzles); center = (y, z)."""
        cy, cz = center
        ring = [(cy + radius * math.cos(2 * math.pi * k / segments), cz + radius * math.sin(2 * math.pi * k / segments))
                for k in range(segments)]
        for k in range(segments):
            (ay, az), (by, bz) = ring[k], ring[(k + 1) % segments]
            pts = [(x0, ay, az), (x1, ay, az), (x1, by, bz), (x0, by, bz)]
            mid = ((ay + by) / 2 - cy, (az + bz) / 2 - cz)
            self.poly(pts, mat, outward=(0.0, mid[0], mid[1]))
        self.poly([(x1, y, z) for y, z in ring], mat, outward=(1, 0, 0))
        self.poly([(x0, y, z) for y, z in ring], mat, outward=(-1, 0, 0))

    def cone(self, center, radius, z0, z1, mat, segments=10):
        cx, cy = center
        ring = [(cx + radius * math.cos(2 * math.pi * k / segments), cy + radius * math.sin(2 * math.pi * k / segments))
                for k in range(segments)]
        for k in range(segments):
            (ax, ay), (bx, by) = ring[k], ring[(k + 1) % segments]
            self.poly([(ax, ay, z0), (bx, by, z0), (cx, cy, z1)], mat)
        self.poly([(x, y, z0) for x, y in ring], mat, outward=(0, 0, -1))

    def pyramid(self, lo, hi, z0, apex_z, mat, base_mat=None):
        (x0, y0), (x1, y1) = lo, hi
        base = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
        apex = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, apex_z)
        for k in range(4):
            self.poly([base[k], base[(k + 1) % 4], apex], mat)
        if base_mat:
            self.poly(list(reversed(base)), base_mat)

    def prism(self, polygon, z0, z1, mat, top_mat=None, bottom=True):
        pts = list(polygon) if polygon_area(polygon) > 0 else list(reversed(polygon))
        for k in range(len(pts)):
            (ax, ay), (bx, by) = pts[k], pts[(k + 1) % len(pts)]
            self.poly([(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)], mat)
        self.poly([(x, y, z1) for x, y in pts], top_mat or mat, outward=(0, 0, 1))
        if bottom:
            self.poly([(x, y, z0) for x, y in pts], mat, outward=(0, 0, -1))

    def flat(self, polygon, z, mat, up=True):
        self.poly([(x, y, z) for x, y in polygon], mat, outward=(0, 0, 1 if up else -1))

    def ellipsoid(self, center, radii, mat, subdivisions=1):
        verts, faces = icosphere(subdivisions)
        for f in faces:
            pts = [tuple(center[i] + verts[k][i] * radii[i] for i in range(3)) for k in f]
            self.poly(pts, mat)

    def tri_count(self):
        return sum(len(f) - 2 for f in self.faces)


def icosphere(subdivisions):
    t = (1.0 + math.sqrt(5.0)) / 2.0
    verts = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t),
             (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    verts = [tuple(c / math.sqrt(_dot(v, v)) for c in v) for v in verts]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4),
             (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8),
             (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    for _ in range(subdivisions):
        cache, new_faces = {}, []
        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                m = tuple((verts[a][i] + verts[b][i]) / 2.0 for i in range(3))
                ln = math.sqrt(_dot(m, m))
                verts.append(tuple(c / ln for c in m))
                cache[key] = len(verts) - 1
            return cache[key]
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            new_faces += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = new_faces
    return verts, faces


# --------------------------------------------------------------------------
# Scene container shared by the layout modules and the bpy builder.
# --------------------------------------------------------------------------
def r3(v):
    return [round(float(c), 3) for c in v]


class SceneSpec:
    def __init__(self):
        self.objects = []      # dicts: name, collection, kind ('mesh'|'empty'), builder, props, parent, location, rotation
        self._by_name = {}
        self.colliders, self.rooms, self.openings, self.stairs = [], [], [], []

    def _add(self, entry):
        if entry["name"] in self._by_name:
            raise ValueError("duplicate object name " + entry["name"])
        self._by_name[entry["name"]] = entry
        self.objects.append(entry)
        return entry

    def mesh(self, name, collection, props=None, parent=None, location=(0, 0, 0), rotation=(0, 0, 0)):
        entry = self._by_name.get(name)
        if entry is None:
            entry = self._add({"name": name, "collection": collection, "kind": "mesh", "builder": MeshBuilder(),
                               "props": dict(props or {}), "parent": parent, "location": location, "rotation": rotation})
        return entry["builder"]

    def empty(self, name, collection, location=(0, 0, 0), rotation=(0, 0, 0), parent=None, props=None, size=0.3):
        self._add({"name": name, "collection": collection, "kind": "empty", "builder": None, "props": dict(props or {}),
                   "parent": parent, "location": location, "rotation": rotation, "size": size})

    def collider(self, cid, kind, lo, hi, opening=None):
        lo, hi = r3(lo), r3(hi)
        if not all(hi[i] - lo[i] > 0.004 for i in range(3)):
            raise ValueError("degenerate collider %s %r %r" % (cid, lo, hi))
        entry = {"id": cid, "kind": kind, "min": lo, "max": hi}
        if opening:
            entry["openingId"] = opening
        self.colliders.append(entry)
        props = {"simKind": "collider", "colliderKind": kind}
        if opening:
            props["openingId"] = opening
        self.mesh(cid, "SIM_COLLIDERS", props).box(lo, hi, "dbg_" + kind)
        return entry
