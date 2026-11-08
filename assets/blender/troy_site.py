"""Site data (from the pinned OSM extract) plus ground, trees and street furniture.

OSM-derived: footprint, main-entrance node, street/sidewalk/crossing centrelines,
J Lot edge and the fire hydrant. Everything else in this file (widths, curbs,
tree and furniture placement) is an estimate and listed in scene.meta.json.
"""

import json
import math

from troy_geom import LocalFrame, dominant_angle, polygon_area, polygon_centroid, rectilinearize

SCENE_MIN = (-48.0, -34.0)
SCENE_MAX = (62.0, 58.0)
CURB_H = 0.15          # estimate: road surface 15 cm below lawn/sidewalk level
CURB_PROUD = 0.02      # curb and paving tops sit 2 cm above the lawn (visual only)
PEOPLES_WIDTH = 10.0   # estimate: curb-to-curb, 2 lanes (OSM lanes=2)
SIDE_STREET_WIDTH_14 = 9.0
SIDE_STREET_WIDTH_13 = 7.0
SIDEWALK_W = 1.5


def _q(v, step=0.05):
    return round(round(v / step) * step, 3)


class Site:
    """Snapped footprint and street lines in the site grid (see README: frames)."""

    def __init__(self, extract_path):
        with open(extract_path, encoding="utf-8") as handle:
            self.extract = json.load(handle)
        fp = self.extract["footprint"]
        ring = fp["nodes"][:-1]
        lat_m = sum(n[1] for n in ring) / len(ring)
        lon_m = sum(n[2] for n in ring) / len(ring)
        enu = LocalFrame(lat_m, lon_m)
        pts = [enu.enu(n[1], n[2]) for n in ring]
        theta = dominant_angle(pts)                      # building grid bearing offset
        rot = LocalFrame(lat_m, lon_m, theta)
        labelled = [(n[0],) + rot.to_site(n[1], n[2]) for n in ring]
        snapped, dropped, disp = rectilinearize(labelled)
        cx, cy = polygon_centroid([(p[1], p[2]) for p in snapped])
        self.frame = LocalFrame(lat_m, lon_m, theta, (cx, cy))
        self.ring = [(p[0], round(p[1] - cx, 3), round(p[2] - cy, 3)) for p in snapped]
        self.nodes = {p[0]: (p[1], p[2]) for p in self.ring}
        self.dropped = dropped
        self.snap_displacement = disp
        self.theta = theta                                # radians, ENU -> site rotation is -theta
        self.origin_latlon = self.frame.to_latlon(0.0, 0.0)
        poly = [(p[1], p[2]) for p in self.ring]
        self.area = abs(polygon_area(poly))
        self.polygon = poly if polygon_area(poly) > 0 else list(reversed(poly))   # CCW copy

        ent = next(n for n in self.extract["nodes"] if n["role"] == "main_entrance")
        self.entrance = self.frame.to_site(ent["lat"], ent["lon"])
        hyd = next(n for n in self.extract["nodes"] if n["role"] == "fire_hydrant")
        self.hydrant = self.frame.to_site(hyd["lat"], hyd["lon"])

        def way_pts(role):
            way = next(w for w in self.extract["ways"] if w["role"] == role)
            return [self.frame.to_site(lat, lon) for _, lat, lon in way["nodes"]]

        def node_mean(role, axis, lo, hi):
            """Mean of node coordinates (short straight ways) inside the scene window."""
            other = 1 - axis
            vals = [p[axis] for p in way_pts(role) if lo <= p[other] <= hi
                    and SCENE_MIN[0] <= p[0] <= SCENE_MAX[0] and SCENE_MIN[1] <= p[1] <= SCENE_MAX[1]]
            if not vals:
                raise ValueError("no OSM nodes for %s inside the scene window" % role)
            return _q(sum(vals) / len(vals))

        def line_mean(role, along, lo, hi):
            """Average offset of a polyline sampled every metre along `along` over [lo, hi]."""
            pts, other, samples = way_pts(role), 1 - along, []
            t = lo
            while t <= hi + 1e-9:
                vals = []
                for a, b in zip(pts, pts[1:]):
                    ta, tb = a[along], b[along]
                    length = math.hypot(b[0] - a[0], b[1] - a[1])
                    near = all(SCENE_MIN[k] - 20.0 <= q[k] <= SCENE_MAX[k] + 20.0 for q in (a, b) for k in (0, 1))
                    parallel = abs(tb - ta) >= 0.7 * length
                    if near and parallel and min(ta, tb) <= t <= max(ta, tb) and abs(tb - ta) > 1e-9:
                        vals.append(a[other] + (b[other] - a[other]) * (t - ta) / (tb - ta))
                if vals:
                    samples.append(sum(vals) / len(vals))
                t += 1.0
            if not samples:
                raise ValueError("no OSM samples for %s" % role)
            return _q(sum(samples) / len(samples))

        (wx0, wy0), (wx1, wy1) = SCENE_MIN, SCENE_MAX
        self.peoples_y = line_mean("peoples_avenue_centerline", 0, wx0, wx1)
        self.th13_x = line_mean("13th_street_centerline", 1, wy0, wy1)
        self.th14_x = line_mean("14th_street_centerline", 1, wy0, wy1)
        self.peoples_s_y = line_mean("sidewalk_peoples_south_and_13th_east", 0, -26.0, 36.0)
        self.th13_e_x = line_mean("sidewalk_peoples_south_and_13th_east", 1, wy0, 31.0)
        self.th14_w_x = line_mean("sidewalk_14th_west", 1, wy0, 31.0)
        self.peoples_n_y = line_mean("sidewalk_peoples_north", 0, -27.0, 38.0)
        self.th14_e_x = line_mean("sidewalk_14th_east", 1, wy0, 31.0)
        self.crossing13_y = node_mean("crossing_13th_street", 1, -40, -27)
        self.crossing14_y = node_mean("crossing_14th_street", 1, 36, 53)
        self.jlot_x = node_mean("parking_j_lot", 0, -36, 20)
        self.footway = way_pts("footway_main_entrance")

    def osm_sources(self, retrieved):
        ex = self.extract
        out = [{
            "title": "OpenStreetMap way %d (Heffner Alumni House footprint, building:levels=%s), version %d"
                     % (ex["footprint"]["wayId"], ex["footprint"]["tags"].get("building:levels", "?"),
                        ex["footprint"]["version"]),
            "url": "https://www.openstreetmap.org/way/%d" % ex["footprint"]["wayId"],
            "license": "ODbL 1.0 — © OpenStreetMap contributors",
            "retrieved": retrieved,
        }]
        for node in ex["nodes"]:
            out.append({
                "title": "OpenStreetMap node %d (%s), version %d" % (node["id"], node["role"].replace("_", " "),
                                                                     node["version"]),
                "url": "https://www.openstreetmap.org/node/%d" % node["id"],
                "license": "ODbL 1.0 — © OpenStreetMap contributors",
                "retrieved": retrieved,
            })
        for way in ex["ways"]:
            label = way["tags"].get("name") or way["role"].replace("_", " ")
            out.append({
                "title": "OpenStreetMap way %d (%s; %s), version %d" % (way["id"], label, way["role"].replace("_", " "),
                                                                        way["version"]),
                "url": "https://www.openstreetmap.org/way/%d" % way["id"],
                "license": "ODbL 1.0 — © OpenStreetMap contributors",
                "retrieved": retrieved,
            })
        return out


# --------------------------------------------------------------------------
# Ground: roads, curbs, sidewalks, lawns, plaza, footway, crossings.
# --------------------------------------------------------------------------
def build_ground(spec, site, plaza):
    g = spec.mesh("ext_ground", "ENV_EXTERIOR")
    x0, y0 = SCENE_MIN
    x1, y1 = SCENE_MAX
    py, w13, w14 = site.peoples_y, SIDE_STREET_WIDTH_13, SIDE_STREET_WIDTH_14
    p_s, p_n = py - PEOPLES_WIDTH / 2, py + PEOPLES_WIDTH / 2
    a13, b13 = site.th13_x - w13 / 2, site.th13_x + w13 / 2
    a14, b14 = site.th14_x - w14 / 2, site.th14_x + w14 / 2
    zr = -CURB_H
    c = 0.15  # curb width

    # Roads (asphalt) and markings.
    for lo, hi in (((x0, p_s), (x1, p_n)), ((a13, y0), (b13, p_s)), ((a13, p_n), (b13, y1)),
                   ((a14, y0), (b14, p_s)), ((a14, p_n), (b14, y1))):
        g.flat([lo, (hi[0], lo[1]), hi, (lo[0], hi[1])], zr, "asphalt")
    for xa, xb in ((x0, a13), (b13, a14), (b14, x1)):
        for dy in (-0.10, 0.04):
            g.flat([(xa, py + dy), (xb, py + dy), (xb, py + dy + 0.06), (xa, py + dy + 0.06)], zr + 0.003, "paint_yellow")
    for (xa, xb), yc in (((a13, b13), site.crossing13_y), ((a14, b14), site.crossing14_y)):
        k = xa + 0.3
        while k + 0.45 <= xb - 0.2:
            g.flat([(k, yc - 1.5), (k + 0.45, yc - 1.5), (k + 0.45, yc + 1.5), (k, yc + 1.5)], zr + 0.003, "paint_white")
            k += 0.9

    # Curbs (granite), lawn blocks, verges and sidewalks.
    curb_boxes = []
    for xa, xb in ((x0, a13), (b13, a14), (b14, x1)):
        curb_boxes += [((xa, p_s - c, zr), (xb, p_s, CURB_PROUD)), ((xa, p_n, zr), (xb, p_n + c, CURB_PROUD))]
    for ya, yb in ((y0, p_s - c), (p_n + c, y1)):
        for xa in (a13 - c, b13, a14 - c, b14):
            curb_boxes.append(((xa, ya, zr), (xa + c, yb, CURB_PROUD)))
    for lo, hi in curb_boxes:
        g.box(lo, hi, "curb", skip=("-z",))
    lawns = [((b13 + c, y0), (a14 - c, p_s - c)), ((x0, y0), (a13 - c, p_s - c)), ((b14 + c, y0), (x1, p_s - c)),
             ((x0, p_n + c), (a13 - c, y1)), ((b13 + c, p_n + c), (a14 - c, y1)), ((b14 + c, p_n + c), (x1, y1))]
    for lo, hi in lawns:
        g.flat([lo, (hi[0], lo[1]), hi, (lo[0], hi[1])], 0.0, "grass")
    s = SIDEWALK_W / 2
    ps, pn = site.peoples_s_y, site.peoples_n_y
    assert ps + s <= p_s - c and pn - s >= p_n + c, "Peoples Avenue sidewalks overlap the curbs"
    assert site.th13_e_x - s >= b13 + c and site.th14_w_x + s <= a14 - c and site.th14_e_x - s >= b14 + c, \
        "side-street sidewalks overlap the curbs"
    walks = [  # sidewalks at their OSM centrelines (ways 946232027, 947753441, 1318242879, 1318154554)
        ((b13 + c, ps - s), (a14 - c, ps + s)),
        ((x0, ps - s), (a13 - c, ps + s)),
        ((b14 + c, ps - s), (x1, ps + s)),
        ((site.th13_e_x - s, y0), (site.th13_e_x + s, ps - s)),
        ((site.th14_w_x - s, y0), (site.th14_w_x + s, ps - s)),
        ((site.th14_e_x - s, y0), (site.th14_e_x + s, ps - s)),
        ((x0, pn - s), (a13 - c, pn + s)),
        ((b13 + c, pn - s), (a14 - c, pn + s)),
        ((b14 + c, pn - s), (x1, pn + s)),
    ]
    for lo, hi in walks:
        g.box((lo[0], lo[1], 0.0), (hi[0], hi[1], CURB_PROUD), "concrete", skip=("-z",))
    g.box((x0, y0, 0.0), (site.jlot_x, 16.0, 0.012), "asphalt", skip=("-z",))   # J Lot edge (OSM way 104737328)

    # Entrance plaza (brick pavers, photos) and the OSM footway to the 14th Street sidewalk.
    (px0, py0), (px1, py1) = plaza
    g.box((px0, py0, 0.0), (px1, py1, CURB_PROUD), "pavers", skip=("-z",))
    pts = [p for p in site.footway]
    path = []
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        if bx <= px1:
            continue
        if ax < px1:
            ay = ay + (by - ay) * (px1 - ax) / (bx - ax)
            ax = px1
        if bx > site.th14_w_x - s:
            by = ay + (by - ay) * (site.th14_w_x - s - ax) / (bx - ax)
            bx = site.th14_w_x - s
        path.append(((ax, ay), (bx, by)))
    for k, ((ax, ay), (bx, by)) in enumerate(path):
        h = CURB_PROUD + 0.002 * (k % 2)
        g.oriented_box((ax, ay, h / 2), (bx, by, h / 2), 2.0, h, "concrete")

    # Ground colliders: block/side lawns at z=0, roads at z=-0.15.
    spec.collider("col-ground-road", "ground", (x0, y0, -1.0), (x1, y1, zr))
    spec.collider("col-ground-block", "ground", (b13, y0, -1.0), (a14, p_s, 0.0))
    spec.collider("col-ground-west", "ground", (x0, y0, -1.0), (a13, p_s, 0.0))
    spec.collider("col-ground-east", "ground", (b14, y0, -1.0), (x1, p_s, 0.0))
    spec.collider("col-ground-north-w", "ground", (x0, p_n, -1.0), (a13, y1, 0.0))
    spec.collider("col-ground-north-c", "ground", (b13, p_n, -1.0), (a14, y1, 0.0))
    spec.collider("col-ground-north-e", "ground", (b14, p_n, -1.0), (x1, y1, 0.0))


# --------------------------------------------------------------------------
# Trees (positions/sizes estimated from the Commons photographs; not surveyed).
# kind: deciduous (trunk + ellipsoid canopy) or conifer (trunk + cone).
# --------------------------------------------------------------------------
TREES = [
    # id, kind, (x, y), trunk radius, trunk top, canopy radius, canopy z-centre / cone top
    ("tree-north-1", "deciduous", (-10.5, 19.0), 0.28, 3.2, 3.6, 6.4),
    ("tree-north-2", "deciduous", (5.0, 22.5), 0.26, 3.0, 3.3, 6.0),
    ("tree-north-3", "deciduous", (-23.5, 26.0), 0.22, 2.8, 2.8, 5.4),
    ("tree-east-1", "deciduous", (33.6, 22.0), 0.20, 3.0, 2.6, 5.6),
    ("tree-east-2", "deciduous", (33.6, 4.0), 0.20, 3.0, 2.6, 5.6),
    ("tree-east-3", "deciduous", (33.6, -13.0), 0.20, 3.0, 2.6, 5.6),
    ("tree-obstacle", "deciduous", (29.8, 8.0), 0.14, 2.4, 1.7, 4.2),    # on the east-lawn approach to the rear facade
    ("tree-south-1", "deciduous", (1.0, -20.0), 0.30, 3.2, 3.8, 6.6),
    ("tree-west-1", "deciduous", (-24.0, 12.0), 0.22, 2.8, 2.7, 5.3),
    ("conifer-west-1", "conifer", (-24.5, -6.0), 0.18, 1.2, 2.0, 8.0),
    ("conifer-south-1", "conifer", (-24.0, -21.0), 0.20, 1.2, 2.2, 9.0),
]

SHRUBS = [  # low shrubs in foundation beds (photos p05/p06/p10): centre, radii
    ((24.0, 8.3), (1.1, 0.6, 0.6)), ((27.4, 3.0), (0.6, 1.1, 0.6)), ((27.4, -1.6), (0.6, 1.0, 0.55)),
    ((-6.0, 10.7), (1.2, 0.6, 0.6)), ((2.0, 10.7), (1.2, 0.6, 0.6)), ((11.8, 10.7), (1.0, 0.6, 0.55)),
]


def build_trees(spec):
    for tid, kind, (x, y), rt, ztop, rc, zc in TREES:
        m = spec.mesh(tid, "ENV_EXTERIOR", {"simKind": "visual", "treeId": tid})
        m.cylinder((x, y), rt, 0.0, ztop + 0.3, "bark", segments=8)
        if kind == "deciduous":
            m.ellipsoid((x, y, zc), (rc, rc, rc * 0.85), "foliage", subdivisions=1)
            trunk_top = max(ztop, zc - rc * 0.68)  # trunk collider meets the canopy collider
            spec.collider("col-%s-trunk" % tid, "tree", (x - rt, y - rt, 0.0), (x + rt, y + rt, trunk_top))
            core = rc * 0.8
            spec.collider("col-%s-canopy" % tid, "tree", (x - core, y - core, zc - rc * 0.68),
                          (x + core, y + core, zc + rc * 0.68))
        else:
            m.cone((x, y), rc, ztop, zc, "foliage_dark", segments=10)
            spec.collider("col-%s-trunk" % tid, "tree", (x - rt, y - rt, 0.0), (x + rt, y + rt, ztop))
            spec.collider("col-%s-canopy" % tid, "tree", (x - rc * 0.7, y - rc * 0.7, ztop),
                          (x + rc * 0.7, y + rc * 0.7, ztop + (zc - ztop) * 0.55))
            spec.collider("col-%s-top" % tid, "tree", (x - rc * 0.3, y - rc * 0.3, ztop + (zc - ztop) * 0.55),
                          (x + rc * 0.3, y + rc * 0.3, zc - 0.5))
    m = spec.mesh("ext_shrubs", "ENV_EXTERIOR")
    for k, ((x, y), (rx, ry, rz)) in enumerate(SHRUBS):
        m.ellipsoid((x, y, rz * 0.9), (rx, ry, rz), "foliage_dark", subdivisions=1)
        spec.collider("col-shrub-%02d" % (k + 1), "tree", (x - rx * 0.85, y - ry * 0.85, 0.0),
                      (x + rx * 0.85, y + ry * 0.85, rz * 1.7))


# --------------------------------------------------------------------------
# Street furniture (generic shapes; placement estimated except the OSM hydrant).
# --------------------------------------------------------------------------
def build_street_furniture(spec, site):
    m = spec.mesh("ext_street_furniture", "ENV_EXTERIOR")
    verge_y = (site.peoples_s_y + SIDEWALK_W / 2 + site.peoples_y - PEOPLES_WIDTH / 2) / 2
    lamps = [("lamp-1", (-12.0, verge_y)), ("lamp-2", (14.0, verge_y)), ("lamp-3", (24.5, 11.6))]
    for lid, (x, y) in lamps:
        m.cylinder((x, y), 0.08, 0.0, 4.6, "metal_dark", segments=8)
        m.box((x - 0.2, y - 0.2, 4.6), (x + 0.2, y + 0.2, 4.9), "lamp_glass")
        m.box((x - 0.24, y - 0.24, 4.9), (x + 0.24, y + 0.24, 4.98), "metal_dark")
        spec.collider("col-sf-%s" % lid, "street_furniture", (x - 0.24, y - 0.24, 0.0), (x + 0.24, y + 0.24, 4.98))
    # Bench on the plaza edge.
    bx, by = 18.4, 10.6
    m.box((bx, by, 0.42), (bx + 1.6, by + 0.45, 0.48), "wood_bench")
    m.box((bx, by + 0.4, 0.48), (bx + 1.6, by + 0.48, 0.88), "wood_bench")
    for lx in (bx + 0.1, bx + 1.42):
        m.box((lx, by, 0.0), (lx + 0.08, by + 0.48, 0.42), "metal_dark")
    spec.collider("col-sf-bench", "street_furniture", (bx, by, 0.0), (bx + 1.6, by + 0.48, 0.88))
    # Litter bin by the entrance (photo p08).
    tx, ty = 14.35, 9.3
    m.cylinder((tx, ty), 0.28, CURB_PROUD, 0.95, "metal_dark", segments=10)
    spec.collider("col-sf-litter-bin", "street_furniture", (tx - 0.28, ty - 0.28, 0.0), (tx + 0.28, ty + 0.28, 0.95))
    # Fire hydrant: OSM node 12541056051 (north verge of Peoples Avenue).
    hx, hy = site.hydrant
    m.cylinder((hx, hy), 0.13, 0.0, 0.62, "hydrant_red", segments=10)
    m.cylinder((hx, hy), 0.17, 0.62, 0.7, "hydrant_red", segments=10)
    m.box((hx - 0.24, hy - 0.06, 0.32), (hx + 0.24, hy + 0.06, 0.44), "hydrant_red")
    spec.collider("col-sf-hydrant", "street_furniture", (hx - 0.24, hy - 0.17, 0.0), (hx + 0.24, hy + 0.17, 0.7))
    # Wheeled bins at the service corner (photo p18).
    for k in range(3):
        x0, y0 = -20.2, -12.6 - 0.8 * k
        m.box((x0, y0, 0.0), (x0 + 0.7, y0 + 0.62, 1.05), "bin_blue" if k == 0 else "bin_black")
        spec.collider("col-sf-wheelie-bin-%d" % (k + 1), "street_furniture", (x0, y0, 0.0), (x0 + 0.7, y0 + 0.62, 1.05))
