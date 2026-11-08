"""Verify the exported Troy training scene and render small previews (headless).

    "/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
        -P assets/blender/verify_scene.py -- --scene public/scenes/troy-training [--previews DIR]

Checks the exported files only (it does not import the build modules): re-imports
scene.glb and colliders.glb, reads scene.meta.json (simulation world, Z up) and
exits non-zero if any check fails.
"""

import hashlib
import json
import math
import os
import struct
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

RESULTS = []
DRONE_SPAN, DRONE_H, MARGIN = 0.55, 0.20, 0.05


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"scene": None, "previews": None}
    for i in range(0, len(argv), 2):
        opts[argv[i].lstrip("-")] = argv[i + 1]
    if not opts["scene"]:
        raise SystemExit("usage: ... -- --scene DIR [--previews DIR]")
    return os.path.abspath(opts["scene"]), opts["previews"]


# ----------------------------------------------------------------------------- geometry helpers
def area2(poly):
    """Signed polygon area (positive = counter-clockwise)."""
    n = len(poly)
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n))


def pip(p, poly):
    x, y = p
    inside = False
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % len(poly)]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def seg_cross(a, b, c, d):
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return o1 * o2 < -1e-12 and o3 * o4 < -1e-12


def seg_dist(p, a, b):
    ax, ay = b[0] - a[0], b[1] - a[1]
    t = max(0.0, min(1.0, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / (ax * ax + ay * ay)))
    return math.hypot(p[0] - a[0] - t * ax, p[1] - a[1] - t * ay)


def in_room(p, room, tol=0.0):
    return room["zMin"] - tol <= p[2] <= room["zMax"] + tol and pip(p[:2], room["polygon"])


def ray_aabb(lo, hi, o, d, tmax):
    t0, t1 = 0.0, tmax
    for i in range(3):
        if abs(d[i]) < 1e-12:
            if o[i] < lo[i] or o[i] > hi[i]:
                return None
            continue
        a, b = (lo[i] - o[i]) / d[i], (hi[i] - o[i]) / d[i]
        if a > b:
            a, b = b, a
        t0, t1 = max(t0, a), min(t1, b)
        if t0 > t1:
            return None
    return t0


def overlap(lo1, hi1, lo2, hi2, eps=1e-6):
    return all(lo1[i] < hi2[i] - eps and lo2[i] < hi1[i] - eps for i in range(3))


def inside_box(p, lo, hi, eps=0.001):
    return all(lo[i] - eps < p[i] < hi[i] + eps for i in range(3))


class Colliders:
    def __init__(self, entries):
        self.entries = entries
        verts, polys = [], []
        for c in entries:
            (x0, y0, z0), (x1, y1, z1) = c["min"], c["max"]
            b = len(verts)
            verts += [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
            polys += [(b + 0, b + 3, b + 2, b + 1), (b + 4, b + 5, b + 6, b + 7), (b + 0, b + 1, b + 5, b + 4),
                      (b + 2, b + 3, b + 7, b + 6), (b + 3, b + 0, b + 4, b + 7), (b + 1, b + 2, b + 6, b + 5)]
        self.bvh = BVHTree.FromPolygons(verts, polys)

    def ray(self, o, d, tmax, exclude=()):
        best = (None, None)
        for c in self.entries:
            if c["id"] in exclude:
                continue
            t = ray_aabb(c["min"], c["max"], o, d, tmax)
            if t is not None and (best[0] is None or t < best[0]):
                best = (t, c["id"])
        return best

    def ray_fast(self, o, d, tmax):
        hit = self.bvh.ray_cast(Vector(o), Vector(d), tmax)
        return None if hit[0] is None else (hit[3], self.entries[hit[2] // 6]["id"])

    def hits_box(self, lo, hi, exclude=(), kinds=None):
        return [c["id"] for c in self.entries if c["id"] not in exclude and (kinds is None or c["kind"] in kinds)
                and overlap(lo, hi, c["min"], c["max"])]

    def contains(self, p, kinds=None):
        return [c["id"] for c in self.entries if (kinds is None or c["kind"] in kinds) and inside_box(p, c["min"], c["max"])]


# ----------------------------------------------------------------------------- GLB helpers
def glb_doc(path):
    data = open(path, "rb").read()
    length, _ = struct.unpack_from("<II", data, 12)
    return data, json.loads(data[20:20 + length])


def glb_triangles(doc):
    tris = 0
    for node in doc.get("nodes", []):
        if "mesh" in node:
            for prim in doc["meshes"][node["mesh"]]["primitives"]:
                if prim.get("mode", 4) == 4:
                    tris += doc["accessors"][prim.get("indices", prim["attributes"]["POSITION"])]["count"] // 3
    return tris


def import_glb(path):
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=path)
    return {name: bpy.data.objects[name] for name in bpy.data.objects.keys() if name not in before}


def world_aabb(obj):
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    return [min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]


# ----------------------------------------------------------------------------- checks
def check_files(scene_dir, meta):
    for name, hard_mb in (("scene.glb", 8.0), ("colliders.glb", 8.0)):
        data, doc = glb_doc(os.path.join(scene_dir, name))
        st = meta["assets"][name]
        tris = glb_triangles(doc)
        check("%s hash/bytes/triangles match metadata" % name,
              hashlib.sha256(data).hexdigest() == st["sha256"] and len(data) == st["bytes"] and tris == st["triangles"],
              "%d bytes, %d triangles" % (len(data), tris))
        check("%s within budget (< %.0f MB, < 200k triangles)" % (name, hard_mb), len(data) < hard_mb * 1e6 and tris < 200000,
              "%.2f MB" % (len(data) / 1e6))
        check("%s has no Draco compression" % name, "KHR_draco_mesh_compression" not in doc.get("extensionsUsed", []))
        if name == "scene.glb":
            check("scene.glb under the 3 MB target", len(data) < 3e6, "%.2f MB" % (len(data) / 1e6))


def check_schema(meta):
    keys = ["schema", "sceneId", "revision", "units", "frames", "origin", "provenance", "floors", "rooms", "openings",
            "stairs", "colliders", "exits", "assemblyPoint", "launchPoint", "scenarioAnchors", "drone", "bounds", "assets"]
    check("metadata has all schema keys", all(k in meta for k in keys), ", ".join(k for k in keys if k not in meta))
    check("schema/scene/units", meta.get("schema") == "flyfirefighter.scene-meta/1" and meta.get("sceneId") == "troy-training"
          and meta.get("units") == "m")
    pv = meta["provenance"]
    check("provenance labels exterior reference, authored interior and fictional incident",
          pv["interior"]["kind"] == "authored_fictional" and pv["incident"] == "fictional" and len(pv["exterior"]["sources"]) >= 3
          and len(pv["exterior"]["estimated"]) >= 5 and "scan" not in pv["exterior"]["method"].lower().replace("not a scan", ""))
    check("scenario anchors flagged scenario-only", meta["scenarioAnchors"].get("scenarioOnly") is True)
    ids = [r["id"] for r in meta["rooms"]] + [o["id"] for o in meta["openings"]] + [c["id"] for c in meta["colliders"]]
    check("room/opening/collider ids unique", len(ids) == len(set(ids)), "%d ids" % len(ids))
    finite = all(math.isfinite(v) for c in meta["colliders"] for v in c["min"] + c["max"])
    sized = all(c["max"][i] - c["min"][i] > 0.004 for c in meta["colliders"] for i in range(3))
    check("collider boxes finite and non-degenerate", finite and sized)


def check_rooms(meta, floors):
    rooms = meta["rooms"]
    bad = []
    for r in rooms:
        poly = r["polygon"]
        if area2(poly) <= 2.0:
            bad.append(r["id"] + " not CCW or too small")
        n = len(poly)
        for i in range(n):
            for j in range(i + 2, n):
                if (i == 0 and j == n - 1):
                    continue
                if seg_cross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n]):
                    bad.append(r["id"] + " self-intersects")
        f = floors[r["floor"]]
        if abs(r["zMin"] - f["elevationM"]) > 0.05 or r["zMax"] > f["ceilingM"] + 0.05:
            bad.append(r["id"] + " z range not within its floor")
    check("room polygons CCW, simple, each within one floor's [elevation, ceiling]", not bad, "; ".join(bad))
    overl = []
    for i, a in enumerate(rooms):
        for b in rooms[i + 1:]:
            if min(a["zMax"], b["zMax"]) - max(a["zMin"], b["zMin"]) <= 0.01:
                continue
            pa, pb = a["polygon"], b["polygon"]
            cross = any(seg_cross(pa[k], pa[(k + 1) % len(pa)], pb[m], pb[(m + 1) % len(pb)])
                        for k in range(len(pa)) for m in range(len(pb)))
            inside = False
            xs, ys = [q[0] for q in pa], [q[1] for q in pa]
            gx = min(xs) + 0.1
            while gx < max(xs) and not inside:  # 0.2 m grid of interior points of a, tested against b
                gy = min(ys) + 0.1
                while gy < max(ys):
                    q = (gx, gy)
                    if pip(q, pa) and pip(q, pb):
                        inside = True
                        break
                    gy += 0.2
                gx += 0.2
            if cross or inside:
                overl.append(a["id"] + "/" + b["id"])
    check("rooms do not overlap in 3D", not overl, ", ".join(overl))
    heights = [f["ceilingM"] - f["elevationM"] for f in meta["floors"]]
    check("ceiling heights plausible (2.4-3.6 m)", all(2.4 <= h <= 3.6 for h in heights), str([round(h, 2) for h in heights]))


def check_openings(meta, rooms_by_id, shell):
    ops = meta["openings"]
    doors = [o for o in ops if o["kind"] == "door"]
    check("door widths 0.8-1.0 m", all(0.8 - 1e-6 <= o["widthM"] <= 1.0 + 1e-6 for o in doors),
          ", ".join("%s %.2f" % (o["id"], o["widthM"]) for o in doors))
    check("at least one narrow (<= 0.85 m) doorway", any(o["widthM"] <= 0.85 for o in doors))
    breach = next(o for o in ops if o["id"] == "win-u-rear-bedroom")
    check("breach window clear opening >= 0.8 x 1.0 m and > drone span", breach["widthM"] >= 0.8 and breach["heightM"] >= 1.0
          and breach["widthM"] >= DRONE_SPAN + 0.2, "%.2f x %.2f m (span %.2f)" % (breach["widthM"], breach["heightM"], DRONE_SPAN))
    bad = []
    for o in ops:
        n = o["outwardNormal"]
        if abs(math.sqrt(sum(c * c for c in n)) - 1.0) > 1e-6:
            bad.append(o["id"] + " normal not unit")
        c = o["center"]
        back = [c[i] - 0.3 * n[i] for i in range(3)]
        front = [c[i] + 0.3 * n[i] for i in range(3)]
        if not in_room(back, rooms_by_id[o["rooms"][0]], 0.01):
            bad.append(o["id"] + " back side not in " + o["rooms"][0])
        if o["rooms"][1] == "exterior":
            if pip(front[:2], shell):
                bad.append(o["id"] + " front side not outside the shell")
        elif not in_room(front, rooms_by_id[o["rooms"][1]], 0.01):
            bad.append(o["id"] + " front side not in " + o["rooms"][1])
    check("opening normals unit and point from rooms[0] to rooms[1]", not bad, "; ".join(bad))
    by_open = {}
    for c in meta["colliders"]:
        if "openingId" in c:
            by_open.setdefault(c["openingId"], []).append(c["kind"])
    bad = [o["id"] for o in ops if (o["kind"] == "window" and o["glazed"] and by_open.get(o["id"]) != ["glass"])
           or (o["kind"] == "door" and o["initialState"] == "closed" and by_open.get(o["id"]) != ["door"])
           or (o["kind"] != "window" and o["initialState"] == "open" and o["id"] in by_open)]
    check("glass panes and closed leaves are separate colliders with openingId", not bad, ", ".join(bad))


def check_opening_gaps(meta, cols):
    """Measure each door/window gap in the colliders and sweep a drone-sized box through it."""
    bad, sweep_bad, narrow = [], [], []
    stair_ids = {x["id"] for x in meta["colliders"] if x["kind"] == "stair"}
    for o in meta["openings"]:
        n = o["outwardNormal"]
        if abs(n[2]) > 0.5:
            _horizontal_gap(o, cols, stair_ids, bad, sweep_bad, narrow)
            continue
        axis = 0 if abs(n[0]) > 0.5 else 1
        uax = 1 - axis
        c, w, h = o["center"], o["widthM"], o["heightM"]
        own = {x["id"] for x in meta["colliders"] if x.get("openingId") == o["id"]}
        d = [0.0, 0.0, 0.0]
        d[axis] = 1.0
        for du, dz in ((0, 0), (w / 2 - 0.03, 0), (-w / 2 + 0.03, 0), (0, h / 2 - 0.03), (0, -h / 2 + 0.03)):
            q = list(c)
            q[uax] += du
            q[2] += dz
            q[axis] -= 0.2
            t, cid = cols.ray(q, d, 0.4, exclude=own)
            if t is not None:
                bad.append("%s blocked at (%.2f,%.2f) by %s" % (o["id"], du, dz, cid))
        if o["kind"] != "opening":
            for du in (w / 2 + 0.05, -w / 2 - 0.05):
                q = list(c)
                q[uax] += du
                q[axis] -= 0.2
                t, cid = cols.ray(q, d, 0.4, exclude=own)
                if t is None:
                    narrow.append("%s wider than stated" % o["id"])
        if w >= 0.8:
            zc = c[2] if o["kind"] == "window" else c[2] - h / 2 + 1.0
            lo, hi = [0.0] * 3, [0.0] * 3
            lo[axis], hi[axis] = c[axis] - 1.0, c[axis] + 1.0
            lo[uax], hi[uax] = c[uax] - DRONE_SPAN / 2 - MARGIN, c[uax] + DRONE_SPAN / 2 + MARGIN
            lo[2], hi[2] = zc - DRONE_H / 2 - MARGIN, zc + DRONE_H / 2 + MARGIN
            hit = cols.hits_box(lo, hi, exclude=own, kinds={"wall", "glass", "door", "furniture", "stair", "floor",
                                                            "ceiling", "roof", "tree", "street_furniture"})
            if hit:
                sweep_bad.append("%s: %s" % (o["id"], ",".join(hit[:3])))
    check("collider gaps match opening width/height (probes inside free)", not bad, "; ".join(bad[:6]))
    check("collider gaps not wider than stated (probes 5 cm outside hit walls)", not narrow, "; ".join(narrow[:6]))
    breach_ok = not any(s.startswith("win-u-rear-bedroom:") for s in sweep_bad)
    check("drone box (0.55 x 0.20 m + 5 cm margin) sweeps through the breach window", breach_ok)
    check("drone box sweeps through every opening >= 0.8 m wide", not sweep_bad, "; ".join(sweep_bad[:6]))


def _horizontal_gap(o, cols, stair_ids, bad, sweep_bad, narrow):
    """A floor opening (stairwell): widthM along X, heightM along Y, probed with vertical rays through the slab.

    The stair that rises through the well is excluded from the probes (it is meant to be there); the sweep keeps
    it, so a drone-sized box must clear the stair as well as the slab edges."""
    c, w, h = o["center"], o["widthM"], o["heightM"]
    up = [0.0, 0.0, 1.0]
    for dx, dy in ((0, 0), (w / 2 - 0.03, 0), (-w / 2 + 0.03, 0), (0, h / 2 - 0.03), (0, -h / 2 + 0.03)):
        q = [c[0] + dx, c[1] + dy, c[2] - 0.2]
        t, cid = cols.ray(q, up, 0.4, exclude=stair_ids)
        if t is not None:
            bad.append("%s blocked at (%.2f,%.2f) by %s" % (o["id"], dx, dy, cid))
    for dx, dy in ((w / 2 + 0.05, 0), (-w / 2 - 0.05, 0), (0, h / 2 + 0.05), (0, -h / 2 - 0.05)):
        q = [c[0] + dx, c[1] + dy, c[2] - 0.2]
        t, cid = cols.ray(q, up, 0.4, exclude=stair_ids)
        if t is None:
            narrow.append("%s wider than stated" % o["id"])
    if min(w, h) >= 0.8:
        lo = [c[0] - DRONE_SPAN / 2 - MARGIN, c[1] - DRONE_SPAN / 2 - MARGIN, c[2] - 1.0]
        hi = [c[0] + DRONE_SPAN / 2 + MARGIN, c[1] + DRONE_SPAN / 2 + MARGIN, c[2] + 1.0]
        hit = cols.hits_box(lo, hi, kinds={"wall", "glass", "door", "furniture", "stair", "floor", "ceiling", "roof"})
        if hit:
            sweep_bad.append("%s: %s" % (o["id"], ",".join(hit[:3])))


def check_alignment(meta, cols, bvh, owner):
    """Collider wall faces vs visual surfaces, and room-centric rays (both directions)."""
    aligned = misaligned = occluded = 0
    worst = []
    for c in meta["colliders"]:
        if c["kind"] != "wall":
            continue
        lo, hi = c["min"], c["max"]
        for axis in (0, 1):
            u = 1 - axis
            for sgn in (-1, 1):
                plane = hi[axis] if sgn > 0 else lo[axis]
                nu = max(2, int((hi[u] - lo[u]) / 0.5))
                nz = max(2, int((hi[2] - lo[2]) / 0.6))
                for iu in range(nu):
                    for iz in range(nz):
                        p = [0.0] * 3
                        p[u] = lo[u] + (hi[u] - lo[u]) * (iu + 0.5) / nu
                        p[2] = lo[2] + (hi[2] - lo[2]) * (iz + 0.5) / nz
                        p[axis] = plane + sgn * 0.25
                        q = list(p)
                        q[axis] = plane + sgn * 0.01
                        if cols.contains(p) or cols.contains(q):
                            continue  # sample start blocked, or face covered by an adjacent collider
                        d = [0.0] * 3
                        d[axis] = -sgn
                        hit = bvh.ray_cast(Vector(p), Vector(d), 0.6)
                        if hit[0] is None:
                            misaligned += 1
                            worst.append("%s face %s%d: no visual surface" % (c["id"], "xy"[axis], sgn))
                            continue
                        dist, name = hit[3], owner[hit[2]]
                        if 0.16 <= dist <= 0.28:
                            aligned += 1
                        elif name.startswith(("furn-", "tree", "conifer", "ext_shrubs", "ext_street", "ext_ground", "drone")):
                            occluded += 1
                        else:
                            misaligned += 1
                            worst.append("%s face %s%+d at %.2f m: visual %s at %.3f" % (c["id"], "xy"[axis], sgn, p[2], name, dist))
    total = aligned + misaligned
    check("wall collider faces coincide with visual walls (<= 1% misaligned)", total and misaligned <= 0.01 * total,
          "%d aligned, %d misaligned, %d occluded by furniture/plants; %s" % (aligned, misaligned, occluded, "; ".join(worst[:4])))
    match = miss = 0
    worst = []
    for r in meta["rooms"]:
        poly = r["polygon"]
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        z = r["zMin"] + 2.3
        for gx in range(1, 4):
            for gy in range(1, 4):
                p = (min(xs) + (max(xs) - min(xs)) * gx / 4, min(ys) + (max(ys) - min(ys)) * gy / 4, z)
                if not pip(p[:2], poly) or cols.contains(p):
                    continue
                for k in range(8):
                    a = math.pi * k / 4 + 0.13
                    d = (math.cos(a), math.sin(a), 0.0)
                    hv = bvh.ray_cast(Vector(p), Vector(d), 40.0)
                    hc = cols.ray_fast(p, d, 40.0)
                    dv = hv[3] if hv[0] is not None else None
                    dc = hc[0] if hc else None
                    if dv is not None and dc is not None and abs(dv - dc) <= 0.10:
                        match += 1
                    else:
                        miss += 1
                        worst.append("%s ray %d: visual %s (%s) vs collider %s (%s)" % (
                            r["id"], k, None if dv is None else round(dv, 2), None if hv[0] is None else owner[hv[2]],
                            None if dc is None else round(dc, 2), hc[1] if hc else None))
    check("room-centric rays: first visual hit = first collider hit (+-0.10 m, >= 98%)",
          match and miss <= 0.02 * (match + miss), "%d/%d match; %s" % (match, match + miss, "; ".join(worst[:3])))


def check_layout(meta, cols, shell, rooms_by_id):
    rooms = meta["rooms"]
    mass = [c for c in meta["colliders"] if c["id"].startswith("col-mass-")]
    bad = []
    for r in rooms:
        poly = r["polygon"]
        cx, cy = sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)
        for x, y in poly:
            q = (x + 0.02 * (cx - x) / max(1e-9, math.hypot(cx - x, cy - y)), y + 0.02 * (cy - y) / max(1e-9, math.hypot(cx - x, cy - y)))
            if not pip(q, shell):
                bad.append("%s vertex (%.2f,%.2f) outside shell" % (r["id"], x, y))
            for m in mass:
                if inside_box((q[0], q[1], r["zMin"] + 0.5), m["min"], m["max"], eps=-0.005):
                    bad.append("%s inside sealed %s" % (r["id"], m["id"]))
    check("rooms lie inside the exterior shell (OSM footprint) and outside sealed volumes", not bad, "; ".join(bad[:4]))
    # Reachability from door-front through doors/openings, stairs linking floors.
    adj = {r["id"]: set() for r in rooms}
    for o in meta["openings"]:
        if o["kind"] in ("door", "opening") and o["rooms"][1] != "exterior":
            adj[o["rooms"][0]].add(o["rooms"][1])
            adj[o["rooms"][1]].add(o["rooms"][0])
    for s in meta["stairs"]:
        ends = [next((r["id"] for r in rooms if r["floor"] == fl and abs(p[2] - r["zMin"]) < 0.1 and pip(p[:2], r["polygon"])
                      and min(seg_dist(p[:2], r["polygon"][k], r["polygon"][(k + 1) % len(r["polygon"])])
                              for k in range(len(r["polygon"]))) > 0.05), None)
                for p, fl in ((s["bottom"], s["fromFloor"]), (s["top"], s["toFloor"]))]
        if None not in ends and ends[0] != ends[1]:
            adj[ends[0]].add(ends[1])
            adj[ends[1]].add(ends[0])
        check("stair %s ends lie strictly inside rooms on floors %d/%d" % (s["id"], s["fromFloor"], s["toFloor"]), None not in ends,
              str(ends))
    start = next(o["rooms"][0] for o in meta["openings"] if o["id"] == "door-front")
    seen, todo = {start}, [start]
    while todo:
        for nb in adj[todo.pop()]:
            if nb not in seen:
                seen.add(nb)
                todo.append(nb)
    check("every room reachable from door-front", len(seen) == len(rooms), "unreached: %s" % sorted(set(adj) - seen))
    # Stair geometry.
    steps = sorted((c for c in meta["colliders"] if c["kind"] == "stair"), key=lambda c: c["min"][0])
    rises = [round(steps[0]["max"][2], 3)] + [round(b["max"][2] - a["max"][2], 3) for a, b in zip(steps, steps[1:])]
    s = meta["stairs"][0]
    run = math.hypot(s["top"][0] - s["bottom"][0], s["top"][1] - s["bottom"][1])
    slope = math.degrees(math.atan2(s["top"][2] - s["bottom"][2], run))
    check("stair: uniform risers, ends at floor elevations, slope <= 38 deg",
          len(set(rises)) == 1 and abs(s["bottom"][2] - meta["floors"][0]["elevationM"]) < 1e-6
          and abs(s["top"][2] - meta["floors"][1]["elevationM"]) < 1e-6 and slope <= 38.0
          and abs(steps[-1]["max"][2] + rises[0] - s["top"][2]) < 0.01,
          "%d steps, rise %.3f m, slope %.1f deg" % (len(steps), rises[0], slope))
    # Assembly point, launch point, scenario anchors.
    ap = meta["assemblyPoint"]
    dist = min(seg_dist(p, shell[i], shell[(i + 1) % len(shell)])
               for p in ((ap["min"][0], ap["min"][1]), (ap["max"][0], ap["min"][1]), (ap["max"][0], ap["max"][1]), (ap["min"][0], ap["max"][1]))
               for i in range(len(shell)))
    blocked = cols.hits_box([ap["min"][0], ap["min"][1], 0.05], ap["max"], kinds={"wall", "tree", "street_furniture", "furniture"})
    check("assembly point on open ground >= 10 m from the facade", dist >= 10.0 and ap["min"][2] >= 0 and not blocked,
          "%.1f m from shell; %s" % (dist, blocked))
    lp = meta["launchPoint"]["position"]
    lo = [lp[0] - 0.3, lp[1] - 0.3, lp[2] - 0.09]
    hi = [lp[0] + 0.3, lp[1] + 0.3, lp[2] + 0.1]
    check("launch point outside the building and clear", not pip(lp[:2], shell) and not cols.hits_box(lo, hi, kinds={
        "wall", "tree", "street_furniture", "roof"}))
    sa = meta["scenarioAnchors"]
    door = next(o for o in meta["openings"] if o["id"] == "door-u-rear-bedroom")
    stair_top = s["top"]
    fd = seg_dist(sa["fireOrigin"][:2], door["center"][:2], stair_top[:2])
    check("fire origin in upstairs hall between rear-bedroom door and stair top",
          in_room([sa["fireOrigin"][0], sa["fireOrigin"][1], sa["fireOrigin"][2] + 0.5], rooms_by_id["room-u-hall"]) and fd <= 0.6,
          "%.2f m from door-stair segment" % fd)
    oc = sa["occupantStart"]
    clear = not cols.hits_box([oc[0] - 0.25, oc[1] - 0.25, oc[2] + 0.05], [oc[0] + 0.25, oc[1] + 0.25, oc[2] + 1.7],
                              kinds={"wall", "furniture", "door"})
    check("occupant start inside upstairs rear bedroom with 0.25 m clearance",
          in_room([oc[0], oc[1], oc[2] + 0.5], rooms_by_id["room-u-rear-bedroom"]) and clear)


def capsule_free(cols, a, b, r, kinds):
    n = max(2, int(math.dist(a, b) / 0.2))
    for k in range(n + 1):
        p = [a[i] + (b[i] - a[i]) * k / n for i in range(3)]
        hit = cols.hits_box([p[0] - r, p[1] - r, p[2] - r], [p[0] + r, p[1] + r, p[2] + r], kinds=kinds)
        if hit:
            return hit
    return []


def check_routes(meta, cols):
    kinds = {"wall", "tree", "street_furniture", "roof", "furniture", "glass", "door"}
    breach = next(o for o in meta["openings"] if o["id"] == "win-u-rear-bedroom")
    c, n = breach["center"], breach["outwardNormal"]
    approach = [c[0] + 3.0 * n[0], c[1] + 3.0 * n[1], c[2]]
    lp = meta["launchPoint"]["position"]
    yard = [[lp[0], lp[1], 3.5], [27.6, 13.0, 3.5], [27.6, 4.0, 3.5], [29.2, -2.0, 4.5], [28.6, -6.5, 5.0], approach]
    blocked = [capsule_free(cols, a, b, 0.4, kinds) for a, b in zip(yard, yard[1:])]
    check("navigable yard path from the street around to the rear-bedroom window (0.4 m radius)", not any(blocked),
          "; ".join(",".join(x[:2]) for x in blocked if x))
    direct = capsule_free(cols, yard[0], yard[3], 0.4, kinds)  # straight down the east lawn
    trees = [h for h in direct if "tree" in h]
    check("an exterior obstacle (tree) sits on the direct approach to the rear facade", bool(trees), ",".join(direct[:3]))
    door = next(o for o in meta["openings"] if o["id"] == "door-front")
    dc, dn = door["center"], door["outwardNormal"]
    ap = meta["assemblyPoint"]
    target = [(ap["min"][0] + ap["max"][0]) / 2, (ap["min"][1] + ap["max"][1]) / 2, 1.0]
    walk = [[dc[0] + 0.6 * dn[0], dc[1] + 0.6 * dn[1], 1.0], [16.0, 11.8, 1.0], target]
    blocked = [capsule_free(cols, a, b, 0.3, kinds) for a, b in zip(walk, walk[1:])]
    check("open walking route from door-front to the assembly point", not any(blocked),
          "; ".join(",".join(x[:2]) for x in blocked if x))
    return yard


# ----------------------------------------------------------------------------- previews
def section(objs, z, poche):
    """Preview-only section: remove geometry above z and cap cut volumes with a dark poche fill."""
    for ob in objs:
        me = ob.data
        if max((ob.matrix_world @ v.co).z for v in me.vertices) <= z:
            continue
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)  # glTF import splits vertices per face
        res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-5,
                                     plane_co=(0.0, 0.0, z), plane_no=(0.0, 0.0, 1.0), clear_outer=True)
        cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if cut:
            filled = bmesh.ops.holes_fill(bm, edges=cut, sides=4096)
            if poche.name not in me.materials:
                me.materials.append(poche)
            idx = list(me.materials).index(poche)
            for f in filled["faces"]:
                f.material_index = idx
        bm.to_mesh(me)
        bm.free()


def preview(previews, meta, scene_objs, debug_objs, yard):
    os.makedirs(previews, exist_ok=True)
    for ob in debug_objs.values():
        ob.hide_render = True  # appearance only; the debug layer coincides with it
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1280, 720, 100
    sh = scene.display.shading
    sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = "STUDIO", "MATERIAL", True, True
    sh.shadow_intensity = 0.35
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0.35
    scene.display.light_direction = (0.35, -0.45, 0.82)
    world = bpy.data.worlds.new("preview") if not scene.world else scene.world
    scene.world = world
    world.color = (0.62, 0.72, 0.85)
    sh.background_type = "WORLD"
    for mat in bpy.data.materials:
        if mat.node_tree:
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                col = bsdf.inputs["Base Color"].default_value
                alpha = bsdf.inputs["Alpha"].default_value
                mat.diffuse_color = (col[0], col[1], col[2], alpha)
    glass = bpy.data.objects.get("win-u-rear-bedroom_glass")
    hi = bpy.data.materials.new("preview_breach")
    hi.diffuse_color = (1.0, 0.35, 0.0, 1.0)
    if glass:
        for slot in glass.material_slots:
            slot.material = hi
    marks = []

    def marker(name, loc, radius, color):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, segments=12, ring_count=8)
        ob = bpy.context.active_object
        ob.name = name
        m = bpy.data.materials.new(name)
        m.diffuse_color = color
        ob.data.materials.append(m)
        marks.append(ob)
        return ob

    sa = meta["scenarioAnchors"]
    marker("fire", [sa["fireOrigin"][0], sa["fireOrigin"][1], sa["fireOrigin"][2] + 0.3], 0.3, (1.0, 0.1, 0.0, 1.0))
    marker("occupant", [sa["occupantStart"][0], sa["occupantStart"][1], sa["occupantStart"][2] + 0.9], 0.25, (0.1, 0.4, 1.0, 1.0))
    ap = meta["assemblyPoint"]
    bpy.ops.mesh.primitive_cube_add(location=[(ap["min"][i] + ap["max"][i]) / 2 for i in range(2)] + [0.03])
    apo = bpy.context.active_object
    apo.scale = ((ap["max"][0] - ap["min"][0]) / 2, (ap["max"][1] - ap["min"][1]) / 2, 0.02)
    m = bpy.data.materials.new("assembly")
    m.diffuse_color = (0.1, 0.9, 0.3, 1.0)
    apo.data.materials.append(m)
    for a, b in zip(yard, yard[1:]):
        mid = [(a[i] + b[i]) / 2 for i in range(3)]
        d = Vector(b) - Vector(a)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.06, depth=d.length, location=mid, vertices=8)
        cyl = bpy.context.active_object
        cyl.rotation_mode = "QUATERNION"
        cyl.rotation_quaternion = d.to_track_quat("Z", "Y")
        mm = bpy.data.materials.new("path")
        mm.diffuse_color = (1.0, 0.9, 0.0, 1.0)
        cyl.data.materials.append(mm)
        marks.append(cyl)
    labels = []
    for r in meta["rooms"]:
        poly = r["polygon"]
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        best = (-1.0, xs[0], ys[0])  # interior point farthest from the boundary (0.2 m grid)
        gx = min(xs) + 0.1
        while gx < max(xs):
            gy = min(ys) + 0.1
            while gy < max(ys):
                if pip((gx, gy), poly):
                    d = min(seg_dist((gx, gy), poly[k], poly[(k + 1) % len(poly)]) for k in range(len(poly)))
                    if d > best[0]:
                        best = (d, gx, gy)
                gy += 0.2
            gx += 0.2
        cx, cy = best[1], best[2]
        bpy.ops.object.text_add(location=(cx - 1.2, cy, r["zMin"] + 0.05))
        t = bpy.context.active_object
        t.data.body = r["id"].replace("room-", "")
        t.data.size = 0.5
        tm = bpy.data.materials.new("label")
        tm.diffuse_color = (1.0, 0.92, 0.25, 1.0)
        t.data.materials.append(tm)
        t.hide_render = True  # shown only in the cutaways
        labels.append(t)

    def shot(name, loc, target, lens=28.0, ortho=None, clip=None):
        cam_data = bpy.data.cameras.new(name)
        cam = bpy.data.objects.new(name, cam_data)
        scene.collection.objects.link(cam)
        cam.location = loc
        cam.rotation_mode = "QUATERNION"
        cam.rotation_quaternion = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y")
        if ortho:
            cam_data.type = "ORTHO"
            cam_data.ortho_scale = ortho
        else:
            cam_data.lens = lens
        cam_data.clip_start, cam_data.clip_end = (clip, 400.0) if clip else (0.1, 400.0)
        scene.camera = cam
        scene.render.filepath = os.path.join(previews, name + ".png")
        bpy.ops.render.render(write_still=True)
        return scene.render.filepath

    files = [
        shot("01_exterior_street", (36.5, 34.5, 1.7), (12.0, 2.0, 3.6), lens=24.0),
        shot("02_rear_breach_window", (31.5, -16.5, 3.2), (21.0, -2.5, 4.4), lens=26.0),
        shot("05_site_overview", (60.0, 55.0, 38.0), (4.0, 0.0, 0.0), lens=30.0),
    ]
    lp = meta["launchPoint"]["position"]
    files.append(shot("06_drone_closeup", (lp[0] + 0.9, lp[1] + 0.7, lp[2] + 0.45), (lp[0], lp[1], lp[2]), lens=35.0))
    poche = bpy.data.materials.new("poche")
    poche.diffuse_color = (0.12, 0.12, 0.13, 1.0)
    meshes = [ob for name, ob in scene_objs.items() if ob.type == "MESH" and not name.startswith("drone")]
    floors = {f["index"]: f for f in meta["floors"]}
    for t in labels:
        t.hide_render = False
    for level, cut, center, scale in ((1, floors[1]["elevationM"] + 2.0, (19.6, 2.2), 20.0),
                                      (0, floors[0]["elevationM"] + 2.2, (18.2, 3.35), 23.5)):
        section(meshes, cut, poche)
        for t, r in zip(labels, meta["rooms"]):
            t.hide_render = r["floor"] != level
            t.location.z = r["zMin"] + 1.9
        for ob in marks:
            ob.hide_render = level == 0 and ob.name in ("fire", "occupant")
        tag = "03_upper_floor" if level == 1 else "04_ground_floor"
        files.append(shot(tag + "_cutaway", (center[0], center[1], 40.0), (center[0], center[1], 0.0), ortho=scale))
        if level == 1:
            files.append(shot("03b_upper_floor_cutaway_oblique", (center[0] + 9.0, center[1] - 15.0, 16.0),
                              (center[0], center[1] + 0.5, 3.6), lens=30.0))
    return files


def main():
    scene_dir, previews = parse_args()
    meta = json.load(open(os.path.join(scene_dir, "scene.meta.json")))
    floors = {f["index"]: f for f in meta["floors"]}
    rooms_by_id = {r["id"]: r for r in meta["rooms"]}
    check_files(scene_dir, meta)
    check_schema(meta)
    check_rooms(meta, floors)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene_objs = import_glb(os.path.join(scene_dir, "scene.glb"))
    debug_objs = import_glb(os.path.join(scene_dir, "colliders.glb"))
    shell_obj = debug_objs.get("shell-footprint")
    shell = [tuple((shell_obj.matrix_world @ v.co)[:2]) for v in shell_obj.data.vertices] if shell_obj else []
    if shell and area2(shell) < 0:
        shell = shell[::-1]
    check("shell footprint present in colliders.glb", len(shell) >= 4, "%d vertices" % len(shell))
    check_openings(meta, rooms_by_id, shell)

    missing = [x["id"] for x in meta["rooms"] + meta["openings"] + meta["colliders"] if x["id"] not in debug_objs]
    check("every room/opening/collider id is a named object in colliders.glb", not missing, ", ".join(missing[:6]))
    vis_missing = [o["id"] + ("_glass" if o["kind"] == "window" else "_leaf") for o in meta["openings"]
                   if (o["kind"] == "window" or o["initialState"] == "closed")
                   and o["id"] + ("_glass" if o["kind"] == "window" else "_leaf") not in scene_objs]
    check("every window has <id>_glass and every closed door <id>_leaf in scene.glb", not vis_missing, ", ".join(vis_missing))
    check("drone and named camera-mount present", "drone" in scene_objs and "drone-camera-mount" in scene_objs
          and scene_objs["drone-camera-mount"].parent == scene_objs["drone"])
    off = []
    for c in meta["colliders"]:
        lo, hi = world_aabb(debug_objs[c["id"]])
        if any(abs(lo[i] - c["min"][i]) > 0.002 or abs(hi[i] - c["max"][i]) > 0.002 for i in range(3)):
            off.append(c["id"])
    check("collider GLB nodes match metadata boxes (after Y-up round trip, 2 mm)", not off, ", ".join(off[:6]))

    verts, polys, owner = [], [], []
    nan = degenerate = 0
    for name, obj in sorted(scene_objs.items()):
        if obj.type != "MESH" or name.startswith("drone"):
            continue
        mw = obj.matrix_world
        base = len(verts)
        for v in obj.data.vertices:
            w = mw @ v.co
            if not all(math.isfinite(c) for c in w):
                nan += 1
            verts.append(w)
        for p in obj.data.polygons:
            if p.area < 1e-7:
                degenerate += 1
            polys.append([base + i for i in p.vertices])
            owner.append(name)
    check("no NaN vertices or zero-area polygons in scene.glb", nan == 0 and degenerate == 0,
          "%d NaN, %d degenerate" % (nan, degenerate))
    bvh = BVHTree.FromPolygons(verts, polys)
    cols = Colliders(meta["colliders"])
    check_opening_gaps(meta, cols)
    check_alignment(meta, cols, bvh, owner)
    check_layout(meta, cols, shell, rooms_by_id)
    yard = check_routes(meta, cols)

    files = preview(previews, meta, scene_objs, debug_objs, yard) if previews else []
    print("\n=== Troy training scene verification ===")
    for name, ok, detail in RESULTS:
        print("[%s] %s%s" % ("PASS" if ok else "FAIL", name, (" -- " + detail) if detail else ""))
    failed = sum(1 for _, ok, _ in RESULTS if not ok)
    print("%d checks, %d failed" % (len(RESULTS), failed))
    for f in files:
        print("preview:", f)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
