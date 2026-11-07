"""Building massing and the authored house shell.

Referenced: the OSM footprint (way 73141173, snapped to the site grid) and the OSM
main-entrance node. Estimated from the Commons photographs: wing boundaries,
heights, roof forms and window rhythm. Authored: the training house region
(the east part of the footprint), its openings and everything inside it.
The rest of the footprint is an unmodelled, sealed massing volume.
"""

import math

from troy_geom import Face, footprint_faces, merge_rects, slab_rectangles, split_rects, split_z, wall_rects

# Levels (metres, estimates consistent with two storeys of windows in the photos).
T_EXT, T_SEAL, T_PART = 0.35, 0.30, 0.15
F0, C0, F1, C1 = 0.0, 3.25, 3.60, 6.50
ROOF, PARAPET = 6.90, 7.80
TOWER_TOP, TOWER_APEX, TOWER_WIDTH = 9.40, 11.20, 5.20
SW_TOP, SW_APEX = 6.40, 8.20
GABLE_PITCH = math.radians(50.0)
CONS_DEPTH, CONS_WALL, CONS_HIGH = 2.71, 3.00, 5.20
BAND = (3.30, 3.55)
RISERS, TREAD = 20, 0.28
STAIR_W = 1.20

FACE_NAMES = {
    (368057865, 867637665): "north", (867637665, 867637648): "ra_east", (867637648, 5415547760): "plaza",
    (5415547760, 5415547759): "rd_west", (5415547759, 867637634): "rd_north", (867637634, 867637678): "east",
    (867637678, 867637670): "rear", (867637670, 12743734832): "court", (12743734832, 12743734831): "link_south",
    (12743734831, 12743734830): "gable_east", (12743734830, 867637657): "cons_south", (867637657, 12743734835): "cons_west",
    (12743734835, 12743734834): "wb_south", (12743734834, 12743734833): "sw_east", (12743734833, 867637637): "sw_south",
    (867637637, 12743734841): "sw_west", (12743734841, 12743734840): "sw_notch_s", (12743734840, 12743734839): "sw_notch_e",
    (12743734839, 12743734838): "sw_notch_n", (12743734838, 12743734837): "west", (12743734837, 12743734836): "recess_s",
    (12743734836, 5415547761): "recess_e", (5415547761, 5415547762): "tower_south", (5415547762, 368057865): "tower_west",
}
HOUSE_FACES = ("north", "ra_east", "plaza", "rd_west", "rd_north", "east", "rear", "court", "link_south")

WINDOW_STYLES = {  # muntin grid (columns, rows), frame material, casing material, keystone
    "ground": (3, 3, "white_frame", "stone_trim", False),
    "ground_teal": (3, 3, "teal_frame", "teal_frame", False),
    "upper": (2, 2, "white_frame", "stone_trim", True),
    "upper_teal": (2, 2, "teal_frame", "teal_frame", False),
    "small": (1, 2, "white_frame", "stone_trim", False),
    "big": (3, 4, "white_frame", "stone_trim", False),
}


class Building:
    def __init__(self, site):
        n = site.nodes
        self.site = site
        self.X_TW_W, self.Y_N = n[368057865]
        self.X_RA_E = n[867637665][0]
        self.Y_PLAZA = n[867637648][1]
        self.X_RD_W = n[5415547760][0]
        self.Y_RD_N = n[5415547759][1]
        self.X_E = n[867637634][0]
        self.Y_EW_S = n[867637678][1]
        self.X_EW_W = n[867637670][0]
        self.Y_LINK_S = n[12743734832][1]
        self.X_H = n[12743734831][0]
        self.Y_S = n[12743734830][1]
        self.X_G = n[867637657][0]
        self.Y_WB_S = n[12743734835][1]
        self.Y_TW_S = n[5415547761][1]
        self.X_TW_E = round(self.X_TW_W + TOWER_WIDTH, 3)
        self.Y_CONS = round(self.Y_S + CONS_DEPTH, 3)
        self.door_y = round(site.entrance[1], 3)
        # Inner faces of the authored house.
        self.XI_W = round(self.X_H + T_SEAL, 3)
        self.XI_RA = round(self.X_RA_E - T_EXT, 3)
        self.XI_EW = round(self.X_EW_W + T_EXT, 3)
        self.XI_RD = round(self.X_RD_W + T_EXT, 3)
        self.XI_E = round(self.X_E - T_EXT, 3)
        self.YI_N = round(self.Y_N - T_EXT, 3)
        self.YI_RD = round(self.Y_RD_N - T_EXT, 3)
        self.YI_PL = round(self.Y_PLAZA - T_EXT, 3)
        self.YI_LINK = round(self.Y_LINK_S + T_EXT, 3)
        self.YI_EW = round(self.Y_EW_S + T_EXT, 3)
        # Stair along the inside of the plaza wall, rising east.
        self.RISE = (F1 - F0) / RISERS
        self.X_ST0 = round(self.X_RA_E + 0.35, 3)
        self.X_ST1 = round(self.X_ST0 + (RISERS - 1) * TREAD, 3)
        self.Y_ST0 = round(self.YI_PL - STAIR_W, 3)
        self.Y_G1 = round(self.Y_ST0 - T_PART, 3)
        # Authored partition lines (free design choices inside the shell).
        self.X_W1, self.Y_W2, self.Y_W3 = 22.0, 1.45, -0.35
        self.faces = {}
        for face in footprint_faces(site.ring):
            face.name = FACE_NAMES[face.labels]
            self.faces[face.name] = face
        self.openings = []

    # ---------------------------------------------------------------- parts
    def part_of(self, x, y):
        if x > self.X_H:
            return "HOUSE"
        if x < self.X_TW_E and y > self.Y_TW_S:
            return "TOWER"
        if y > self.Y_LINK_S:
            return "BODY"
        if x > self.X_G:
            return "GABLED" if y > self.Y_CONS else "CONSERVATORY"
        if y > self.Y_WB_S:
            return "BODY"
        return "SW"

    def part_rects(self):
        rects = split_rects(slab_rectangles(self.site.polygon), (self.X_TW_E, self.X_G, self.X_H),
                            (self.Y_TW_S, self.Y_LINK_S, self.Y_CONS, self.Y_WB_S))
        out = {}
        for r in rects:
            out.setdefault(self.part_of(0.5 * (r[0] + r[1]), 0.5 * (r[2] + r[3])), []).append(r)
        return {part: merge_rects(rs) for part, rs in sorted(out.items())}

    def face_segments(self, face):
        cuts = (self.X_TW_E, self.X_G, self.X_H) if face.axis == "y" else (self.Y_TW_S, self.Y_LINK_S, self.Y_CONS, self.Y_WB_S)
        us = [face.u0] + sorted(c for c in cuts if face.u0 + 1e-6 < c < face.u1 - 1e-6) + [face.u1]
        segs = []
        for a, b in zip(us, us[1:]):
            x, y, _ = face.point(0.5 * (a + b), 0.0, -0.05)
            segs.append((a, b, self.part_of(x, y)))
        return segs

    def house_wall_span(self, face):
        """Wall extent along a house face: horizontal walls own convex corners and extend at reflex ones."""
        lo, hi = face.u0, face.u1
        if face.name == "north":
            return self.X_H, self.X_RA_E
        if face.name == "link_south":
            return self.X_H, self.X_EW_W + T_EXT
        if face.axis == "y":
            lo = lo if face.convex_low else lo - T_EXT
            hi = hi if face.convex_high else hi + T_EXT
        else:
            lo = lo + T_EXT if face.convex_low else lo
            hi = hi - T_EXT if face.convex_high else hi
        return round(lo, 3), round(hi, 3)


# --------------------------------------------------------------------------
# Openings (doors/windows of the authored house). Positions u are along the face.
# --------------------------------------------------------------------------
def exterior_openings(b):
    mid_entry = round(0.5 * (b.XI_W + b.XI_RA), 3)
    mid_rear_bed = round(0.5 * (b.X_W1 + T_PART + b.XI_E), 3)
    rows = [
        # id, room, face, u, width, height, sill (above floor), floor, state, glazed, style
        ("door-front", "room-g-entry", "ra_east", b.door_y, 1.0, 2.2, 0.0, F0, "closed", False, "door_front"),
        ("win-g-entry-n", "room-g-entry", "north", mid_entry, 1.6, 2.4, 0.6, F0, "closed", True, "ground"),
        ("win-g-entry-e", "room-g-entry", "ra_east", 8.3, 1.0, 2.4, 0.6, F0, "closed", True, "ground"),
        ("win-g-living-s1", "room-g-living", "link_south", 11.6, 1.6, 2.4, 0.6, F0, "closed", True, "ground_teal"),
        ("win-g-living-s2", "room-g-living", "link_south", 15.0, 1.6, 2.4, 0.6, F0, "closed", True, "ground_teal"),
        ("win-g-living-s3", "room-g-living", "rear", 18.2, 1.4, 2.4, 0.6, F0, "closed", True, "ground"),
        ("win-g-kitchen-s", "room-g-kitchen", "rear", 23.2, 1.6, 1.4, 1.0, F0, "closed", True, "ground"),
        ("win-g-kitchen-e", "room-g-kitchen", "east", 1.2, 2.0, 1.6, 1.0, F0, "closed", True, "ground"),
        ("win-g-kitchen-n", "room-g-kitchen", "rd_north", 23.7, 1.6, 1.4, 1.0, F0, "closed", True, "ground"),
        ("win-u-rear-bedroom", "room-u-rear-bedroom", "rear", mid_rear_bed, 1.1, 1.4, 0.8, F1, "closed", True, "upper"),
        ("win-u-rear-bedroom-east", "room-u-rear-bedroom", "east", 0.6, 1.0, 1.4, 0.8, F1, "closed", True, "upper"),
        ("win-u-bath-s", "room-u-bath", "rear", 20.85, 0.7, 0.9, 1.2, F1, "closed", True, "small"),
        ("win-u-study-s1", "room-u-study", "rear", 18.2, 1.1, 1.4, 0.8, F1, "closed", True, "upper"),
        ("win-u-study-s2", "room-u-study", "link_south", 15.2, 1.1, 1.4, 0.8, F1, "closed", True, "upper_teal"),
        ("win-u-front-bedroom-e", "room-u-front-bedroom", "east", 4.6, 1.1, 1.4, 0.8, F1, "closed", True, "upper"),
        ("win-u-front-bedroom-n", "room-u-front-bedroom", "rd_north", 23.7, 1.1, 1.4, 0.8, F1, "closed", True, "upper"),
    ]
    out = []
    for oid, room, face_name, u, w, h, sill, floor, state, glazed, style in rows:
        face = b.faces[face_name]
        out.append({"id": oid, "kind": "door" if oid.startswith("door") else "window", "rooms": [room, "exterior"],
                    "face": face, "t": T_EXT, "u": round(u, 3), "w": w, "h": h, "z0": round(floor + sill, 3),
                    "sill": sill, "normal": face.normal(), "state": state, "glazed": glazed, "style": style})
    return out


def opening_holes(openings, face_name):
    return [(o["u"] - o["w"] / 2, o["u"] + o["w"] / 2, o["z0"], o["z0"] + o["h"])
            for o in openings if o["face"].name == face_name]


def build_opening(spec, o):
    """Portal object, collider for glass/closed leaf and the visual glass/leaf/casing."""
    f, t, u, w, h, z0 = o["face"], o["t"], o["u"], o["w"], o["h"], o["z0"]
    ua, ub, z1 = u - w / 2, u + w / 2, z0 + h
    lo, hi = f.box(ua, ub, z0, z1, -t, 0.0)
    spec.mesh(o["id"], "SIM_ROOMS_OPENINGS", {
        "simKind": "opening", "openingKind": o["kind"], "rooms": ",".join(o["rooms"]), "initialState": o["state"],
        "glazed": o["glazed"], "widthM": w, "heightM": h, "sillHeightM": o["sill"]}).box(lo, hi, "dbg_opening")
    o["center"] = f.point(u, z0 + h / 2, -t / 2)
    if o["kind"] == "opening":
        return
    ext = o["rooms"][1] == "exterior"
    style = o["style"]
    trim_coll = "ENV_EXTERIOR" if ext else "ENV_INTERIOR"
    trim = spec.mesh("ext_opening_trim" if ext else "int_opening_trim", trim_coll)
    if o["kind"] == "window":
        cols, rows, frame_mat, casing_mat, keystone = WINDOW_STYLES[style]
        _casing(trim, f, ua, ub, z0, z1, 0.0, casing_mat, sill=True)
        if keystone:
            trim.box(*f.box(u - 0.22, u + 0.22, z1 + 0.12, z1 + 0.52, 0.0, 0.03), "stone_trim")
        g = spec.mesh(o["id"] + "_glass", "ENV_EXTERIOR", {"simKind": "visual", "openingId": o["id"], "role": "glass"})
        g.box(*f.box(ua, ub, z0, z1, -t / 2 - 0.006, -t / 2 + 0.006), "glass_clear")
        _muntins(g, f, ua, ub, z0, z1, -t / 2 - 0.02, -t / 2 + 0.02, cols, rows, frame_mat)
        spec.collider("col-glass-" + o["id"], "glass", *f.box(ua, ub, z0, z1, -t / 2 - 0.02, -t / 2 + 0.02),
                      opening=o["id"])
        return
    # Doors: casing on the outer face (and inner face for interior doors), leaf only when closed.
    _casing(trim, f, ua, ub, z0, z1, 0.0, "teal_frame" if style == "door_front" else "white_frame", sill=False)
    if not ext:
        _casing(trim, f, ua, ub, z0, z1, -t, "white_frame", sill=False, inward=True)
    if style == "door_front":
        trim.box(*f.box(ua - 0.55, ua - 0.09, z0, z1, 0.0, 0.03), "glass_dark")       # sidelights
        trim.box(*f.box(ub + 0.09, ub + 0.55, z0, z1, 0.0, 0.03), "glass_dark")
        trim.box(*f.box(ua - 0.55, ub + 0.55, z1 + 0.09, z1 + 0.7, 0.0, 0.03), "glass_dark")  # transom
        trim.box(*f.box(ua - 0.62, ub + 0.62, z1 + 0.7, z1 + 0.95, 0.0, 0.05), "slate")      # name band
        trim.box(*f.box(ua - 0.1, ub + 0.1, z0, z0 + 0.03, -t, 0.25), "stone_trim")         # threshold
    if o["state"] == "closed":
        leaf_mat = "door_teal" if style == "door_front" else "door_wood"
        leaf = spec.mesh(o["id"] + "_leaf", "ENV_EXTERIOR" if ext else "ENV_INTERIOR",
                         {"simKind": "visual", "openingId": o["id"], "role": "leaf"})
        leaf.box(*f.box(ua + 0.005, ub - 0.005, z0 + 0.005, z1 - 0.005, -t / 2 - 0.025, -t / 2 + 0.025), leaf_mat)
        if style == "door_front":
            leaf.box(*f.box(ua + 0.15, ub - 0.15, z0 + 0.9, z1 - 0.2, -t / 2 + 0.025, -t / 2 + 0.03), "glass_dark")
        spec.collider("col-door-" + o["id"], "door", *f.box(ua, ub, z0, z1, -t / 2 - 0.025, -t / 2 + 0.025),
                      opening=o["id"])


def _casing(m, f, ua, ub, z0, z1, d, mat, sill, inward=False, width=0.09, depth=0.035):
    da, db = (d - depth, d) if inward else (d, d + depth)
    m.box(*f.box(ua - width, ua, z0 if not sill else z0 - 0.01, z1 + width, da, db), mat)
    m.box(*f.box(ub, ub + width, z0 if not sill else z0 - 0.01, z1 + width, da, db), mat)
    m.box(*f.box(ua, ub, z1, z1 + width, da, db), mat)
    if sill:
        m.box(*f.box(ua - 0.16, ub + 0.16, z0 - 0.08, z0 - 0.01, d, d + 0.07), "stone_trim")


def _muntins(m, f, ua, ub, z0, z1, da, db, cols, rows, mat, bar=0.04, rim=0.05):
    m.box(*f.box(ua, ub, z0, z0 + rim, da, db), mat)
    m.box(*f.box(ua, ub, z1 - rim, z1, da, db), mat)
    m.box(*f.box(ua, ua + rim, z0 + rim, z1 - rim, da, db), mat)
    m.box(*f.box(ub - rim, ub, z0 + rim, z1 - rim, da, db), mat)
    for k in range(1, cols):
        uc = ua + (ub - ua) * k / cols
        m.box(*f.box(uc - bar / 2, uc + bar / 2, z0 + rim, z1 - rim, da, db), mat)
    for k in range(1, rows):
        zc = z0 + (z1 - z0) * k / rows
        m.box(*f.box(ua + rim, ub - rim, zc - bar / 2, zc + bar / 2, da, db), mat)


def applied_window(m, f, u, z0, w, h, style="upper", glass="glass_dark"):
    """Decorative window on an unmodelled facade: no opening, no collider."""
    cols, rows, frame_mat, casing_mat, keystone = WINDOW_STYLES[style]
    ua, ub, z1 = u - w / 2, u + w / 2, z0 + h
    m.box(*f.box(ua, ub, z0, z1, 0.0, 0.02), glass, skip=(f.inner_key(),))
    _muntins(m, f, ua, ub, z0, z1, 0.0, 0.035, cols, rows, frame_mat)
    _casing(m, f, ua, ub, z0, z1, 0.0, casing_mat, sill=True)
    if keystone:
        m.box(*f.box(u - 0.22, u + 0.22, z1 + 0.12, z1 + 0.52, 0.0, 0.03), "stone_trim")


# --------------------------------------------------------------------------
# Massing: unmodelled wings (solid colliders) and the authored house shell.
# --------------------------------------------------------------------------
def build_massing(spec, b):
    parts = b.part_rects()
    shell = spec.mesh("ext_massing", "ENV_EXTERIOR")
    roofs = spec.mesh("ext_roofs", "ENV_EXTERIOR")
    det = spec.mesh("ext_facade_details", "ENV_EXTERIOR")
    brick_top = {"+z": "roof_membrane"}

    for k, (x0, x1, y0, y1) in enumerate(parts["BODY"]):
        shell.box((x0, y0, 0.0), (x1, y1, ROOF), "brick", faces=brick_top, skip=("-z",))
        spec.collider("col-mass-body-%02d" % (k + 1), "wall", (x0, y0, 0.0), (x1, y1, ROOF))
    for k, (x0, x1, y0, y1) in enumerate(parts["SW"]):
        shell.box((x0, y0, 0.0), (x1, y1, SW_TOP), "brick", faces=brick_top, skip=("-z",))
        spec.collider("col-mass-sw-%02d" % (k + 1), "wall", (x0, y0, 0.0), (x1, y1, SW_TOP))
    sw = max(parts["SW"], key=lambda r: (r[1] - r[0]) * (r[3] - r[2]))
    _pyramid_roof(spec, roofs, det, "sw", sw, SW_TOP, SW_APEX)

    (tx0, tx1, ty0, ty1), = parts["TOWER"]
    shell.box((tx0, ty0, 0.0), (tx1, ty1, TOWER_TOP), "brick", skip=("-z", "+z"))
    spec.collider("col-mass-tower", "wall", (tx0, ty0, 0.0), (tx1, ty1, TOWER_TOP))
    _pyramid_roof(spec, roofs, det, "tower", (tx0, tx1, ty0, ty1), TOWER_TOP, TOWER_APEX)

    (gx0, gx1, gy0, gy1), = parts["GABLED"]
    ymid, half = 0.5 * (gy0 + gy1), 0.5 * (gy1 - gy0)
    ridge = round(ROOF + half * math.tan(GABLE_PITCH), 3)
    b.ridge = ridge
    shell.poly([(gx0, gy0, 0.0), (gx1, gy0, 0.0), (gx1, gy0, ROOF), (gx0, gy0, ROOF)], "brick", outward=(0, -1, 0))
    for x, sgn in ((gx0, -1), (gx1, 1)):
        shell.poly([(x, gy0, 0.0), (x, gy1, 0.0), (x, gy1, ROOF), (x, ymid, ridge), (x, gy0, ROOF)], "brick",
                   outward=(sgn, 0, 0))
    roofs.poly([(gx0, gy0, ROOF), (gx1, gy0, ROOF), (gx1, ymid, ridge), (gx0, ymid, ridge)], "roof_metal", outward=(0, -1, 1))
    roofs.poly([(gx0, gy1, ROOF), (gx1, gy1, ROOF), (gx1, ymid, ridge), (gx0, ymid, ridge)], "roof_metal", outward=(0, 1, 1))
    roofs.box((gx0 - 0.08, ymid - 0.12, ridge - 0.06), (gx1 + 0.08, ymid + 0.12, ridge + 0.07), "roof_metal_dark")
    for x in (gx0 - 0.06, gx1 + 0.06):
        for ys in (gy0 - 0.12, gy1 + 0.02):
            roofs.oriented_box((x, ys, ROOF - 0.12), (x, ymid, ridge - 0.02), 0.12, 0.22, "roof_metal_dark")
    for xv in (gx0 + 4.0, 0.5 * (gx0 + gx1), gx1 - 4.0):
        roofs.cylinder((xv, ymid), 0.2, ridge - 0.1, ridge + 0.6, "metal_dark", segments=8)
    spec.collider("col-mass-gabled", "wall", (gx0, gy0, 0.0), (gx1, gy1, ROOF))
    for k in range(4):
        w = half * (1.0 - k / 4.0)
        za = ROOF + (ridge - ROOF) * k / 4.0
        zb = ROOF + (ridge - ROOF) * (k + 1) / 4.0
        spec.collider("col-roof-gabled-%d" % (k + 1), "roof", (gx0, ymid - w, za), (gx1, ymid + w, zb))

    (cx0, cx1, cy0, cy1), = parts["CONSERVATORY"]
    _conservatory(spec, shell, roofs, det, cx0, cx1, cy0, cy1)

    # Chimneys (photos p01-p03, p09-p12); positions estimated.
    for cid, lo, hi in (("chimney-gable-east", (b.X_H, -2.4, 0.0), (b.X_H + 0.5, -1.4, ridge + 1.0)),
                        ("chimney-body-ne", (8.2, 8.2, ROOF), (9.1, 8.9, 9.0)),
                        ("chimney-body-mid", (-3.35, 4.2, ROOF), (-2.65, 4.9, 8.4)),
                        ("chimney-body-west", (-12.35, 3.8, ROOF), (-11.65, 4.5, 8.4))):
        shell.box(lo, hi, "brick_dark", skip=("-z",))
        det.box((lo[0] - 0.06, lo[1] - 0.06, hi[2]), (hi[0] + 0.06, hi[1] + 0.06, hi[2] + 0.12), "stone_trim")
        spec.collider("col-" + cid, "wall", lo, (hi[0], hi[1], hi[2] + 0.12))

    _remainder_facades(spec, b, det)
    _house_shell(spec, b, shell, det)


def _pyramid_roof(spec, roofs, det, name, rect, top, apex):
    x0, x1, y0, y1 = rect
    det.box((x0 - 0.08, y0 - 0.08, top - 0.3), (x1 + 0.08, y1 + 0.08, top), "stone_trim", skip=("-z",))
    o = 0.15
    roofs.pyramid((x0 - o, y0 - o), (x1 + o, y1 + o), top, apex, "copper", base_mat="copper")
    for k in range(3):
        f = 1.0 - k / 3.0
        cx, cy, hx, hy = 0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (x1 - x0) * f, 0.5 * (y1 - y0) * f
        za, zb = top + (apex - top) * k / 3.0, top + (apex - top) * (k + 1) / 3.0
        spec.collider("col-roof-%s-%d" % (name, k + 1), "roof", (cx - hx, cy - hy, za), (cx + hx, cy + hy, zb))


def _conservatory(spec, shell, roofs, det, x0, x1, y0, y1):
    shell.box((x0, y0, 0.0), (x1, y1, 0.6), "brick", skip=("-z", "+z"))
    glass, frame = "glass_conservatory", "teal_frame"
    for (ax, ay), (bx, by), n in (((x0, y0), (x1, y0), (0, -1, 0)), ((x1, y0), (x1, y1), (1, 0, 0)),
                                  ((x0, y0), (x0, y1), (-1, 0, 0))):
        if ay == by:
            roofs.box((ax, ay, 0.6), (bx, ay + 0.04, CONS_WALL), glass, skip=("+y",))
        else:
            xa = ax - 0.04 if n[0] > 0 else ax
            roofs.box((xa, ay, 0.6), (xa + 0.04, by, CONS_WALL), glass, skip=("-x" if n[0] > 0 else "+x",))
    count = max(2, int(round((x1 - x0) / 1.7)))
    for k in range(count + 1):
        xc = min(max(x0 + (x1 - x0) * k / count, x0 + 0.05), x1 - 0.05)
        det.box((xc - 0.05, y0 - 0.03, 0.6), (xc + 0.05, y0 + 0.07, CONS_WALL), frame, skip=("-z",))
        roofs.oriented_box((xc, y0, CONS_WALL + 0.03), (xc, y1, CONS_HIGH + 0.03), 0.07, 0.06, frame)
    for yc in (y0 + 0.05, 0.5 * (y0 + y1), y1 - 0.05):
        for xc in (x0 + 0.03, x1 - 0.03):
            det.box((xc - 0.05, yc - 0.05, 0.6), (xc + 0.05, yc + 0.05, CONS_WALL), frame, skip=("-z",))
    det.box((x0, y0 - 0.04, CONS_WALL - 0.1), (x1, y0 + 0.08, CONS_WALL + 0.02), frame)
    roofs.poly([(x0, y0, CONS_WALL), (x1, y0, CONS_WALL), (x1, y1, CONS_HIGH), (x0, y1, CONS_HIGH)], glass, outward=(0, -1, 1))
    for x, sgn in ((x0, -1), (x1, 1)):
        roofs.poly([(x, y0, CONS_WALL), (x, y1, CONS_WALL), (x, y1, CONS_HIGH)], glass, outward=(sgn, 0, 0))
    spec.collider("col-mass-conservatory", "wall", (x0, y0, 0.0), (x1, y1, CONS_WALL))
    ym = 0.5 * (y0 + y1)
    spec.collider("col-roof-conservatory-1", "roof", (x0, y0, CONS_WALL), (x1, y1, 0.5 * (CONS_WALL + CONS_HIGH)))
    spec.collider("col-roof-conservatory-2", "roof", (x0, ym, 0.5 * (CONS_WALL + CONS_HIGH)), (x1, y1, CONS_HIGH))


def _band_and_coping(det, f, ua, ub, with_band, coping_depth, lift=0.0):
    eps = (0.01 if f.axis == "x" else 0.0) + lift
    if with_band:
        det.box(*f.box(ua, ub, BAND[0] + eps, BAND[1] + eps, 0.0, 0.04), "stone_trim", skip=(f.inner_key(),))
    if coping_depth:
        det.box(*f.box(ua - 0.05, ub + 0.05, PARAPET + eps, PARAPET + 0.1 + eps, -coping_depth - 0.05, 0.05), "stone_trim")


def _remainder_facades(spec, b, det):
    """Parapets, bands, coping and decorative windows on the unmodelled wings."""
    k = 0
    for name, f in b.faces.items():
        if name in HOUSE_FACES[1:]:
            continue
        for ua, ub, part in b.face_segments(f):
            if part == "BODY":
                lo, hi = f.box(ua, ub, ROOF, PARAPET, -0.3, 0.0)
                det.box(lo, hi, "brick", skip=("-z",))
                k += 1
                spec.collider("col-parapet-%02d" % k, "wall", lo, hi)
                _band_and_coping(det, f, ua, ub, True, 0.3)
            elif part in ("TOWER", "SW"):
                _band_and_coping(det, f, ua, ub, True, 0.0)
    fn = b.faces["north"]
    for u in [b.X_TW_E + 2.0 + 4.0 * i for i in range(6)]:
        applied_window(det, fn, u, 0.5, 2.0, 2.6, "big")
        applied_window(det, fn, u, 4.4, 1.1, 1.4, "upper")
    tu = 0.5 * (b.X_TW_W + b.X_TW_E)
    fw = b.faces["tower_west"]
    for f, u in ((fn, tu), (fw, 0.5 * (fw.u0 + fw.u1))):
        applied_window(det, f, u, 0.6, 1.2, 2.2, "ground")
        applied_window(det, f, u, 4.4, 1.1, 1.4, "upper")
        applied_window(det, f, u, 7.3, 1.1, 1.3, "upper")
    fwst = b.faces["west"]
    for u in (-6.4, -1.6):
        applied_window(det, fwst, u, 0.5, 2.0, 2.6, "big")
    for u in (-6.4, -1.6, 1.4):
        applied_window(det, fwst, u, 4.4, 1.1, 1.4, "upper")
    applied_window(det, b.faces["wb_south"], 0.5 * (b.faces["wb_south"].u0 + b.faces["wb_south"].u1), 4.4, 1.1, 1.4, "upper")
    for name in ("sw_south", "sw_east"):
        f = b.faces[name]
        u = 0.5 * (f.u0 + f.u1)
        applied_window(det, f, u, 0.6, 1.4, 2.2, "ground")
        ring = [f.point(u + 0.5 * math.cos(math.pi / 8 + k8 * math.pi / 4), 4.6 + 0.5 * math.sin(math.pi / 8 + k8 * math.pi / 4), 0.02)
                for k8 in range(8)]
        det.poly(ring, "glass_dark", outward=f.normal())
    # East gable end of the south block: door, windows and the arched attic window.
    fg = b.faces["gable_east"]
    det.box(*fg.box(-6.3, -5.3, 0.0, 2.2, 0.0, 0.04), "white_frame")
    applied_window(det, fg, -3.9, 0.8, 1.2, 2.0, "ground")
    for u in (-5.6, -3.6):
        applied_window(det, fg, u, 4.4, 1.0, 1.4, "upper")
    for f, sgn in ((fg, 1), (None, -1)):
        if f is None:
            f = Face("x", b.X_G, -1, b.Y_CONS, b.Y_LINK_S, "gable_west")
        uc = -4.2
        applied_window(det, f, uc, 7.3, 1.1, 1.0, "small")
        arc = [f.point(uc + 0.55 * math.cos(math.pi * i / 10), 8.3 + 0.55 * math.sin(math.pi * i / 10), 0.02)
               for i in range(11)]
        det.poly(arc, "glass_dark", outward=f.normal())
    # Upper-floor windows of the house region that sit in front of the sealed volume.
    applied_window(det, fn, 0.5 * (b.XI_W + b.XI_RA), 4.4, 1.1, 1.4, "upper")
    fr = b.faces["ra_east"]
    for u in (b.door_y, 8.3):
        applied_window(det, fr, u, 4.4, 1.1, 1.4, "upper")
    applied_window(det, b.faces["link_south"], 11.6, 4.4, 1.1, 1.4, "upper_teal")


def _house_shell(spec, b, shell, det):
    """Exterior walls of the authored house (with real openings), parapet and entrance canopy."""
    b.openings = exterior_openings(b)
    walls_vis = spec.mesh("ext_house_walls", "ENV_EXTERIOR")
    for name in HOUSE_FACES:
        f = b.faces[name]
        u0, u1 = b.house_wall_span(f)
        holes = opening_holes(b.openings, name)
        rects = wall_rects(u0, u1, 0.0, PARAPET, holes)
        for k, (ua, ub, za, zb) in enumerate(rects):
            spec.collider("col-wall-%s-%02d" % (name.replace("_", "-"), k + 1), "wall", *f.box(ua, ub, za, zb, -T_EXT, 0.0))
        for ua, ub, za, zb in split_z(rects, (ROOF,)):
            faces = {f.outer_key(): "brick", f.inner_key(): "paint" if zb <= ROOF + 1e-6 else "brick"}
            skip = ("-z",) if za < 1e-6 else ()
            walls_vis.box(*f.box(ua, ub, za, zb, -T_EXT, 0.0), "brick", faces=faces, skip=skip)
        _band_and_coping(det, f, u0, u1, True, T_EXT, lift=0.005)
    for o in b.openings:
        build_opening(spec, o)
    # Sealed volume above the entry hall (house region's west strip, upper level).
    spec.collider("col-mass-ra-upper", "wall", (b.X_H, b.Y_LINK_S, C0), (b.X_RA_E, b.Y_N, ROOF))
    shell.box((b.X_H, b.YI_LINK, C1), (b.X_RA_E, b.YI_PL, ROOF), "paint", faces={"+z": "roof_membrane"})
    shell.box((b.X_H, b.YI_PL, C1), (b.XI_RA, b.YI_N, ROOF), "paint", faces={"+z": "roof_membrane"})
    shell.box((b.X_H, b.YI_LINK, C0 + 0.01), (b.X_RA_E - 0.15, b.YI_PL, C1), "paint", skip=("+z",))  # sealed fill
    shell.box((b.X_H, b.YI_PL, C0 + 0.01), (b.XI_RA, b.YI_N, C1), "paint", skip=("+z",))
    # Glazed entrance canopy (photo p07), pyramid skylight on the east wing (photos p05/p06).
    f = b.faces["ra_east"]
    ya, yb = b.door_y - 0.95, b.door_y + 0.95
    xa, xb = b.X_RA_E, b.X_RA_E + 1.6
    det.poly([(xa, ya, 3.42), (xb, ya, 3.02), (xb, yb, 3.02), (xa, yb, 3.42)], "glass_dark", outward=(0.3, 0, 1))
    det.poly([(xa, ya, 3.40), (xb, ya, 3.00), (xb, yb, 3.00), (xa, yb, 3.40)], "glass_dark", outward=(-0.3, 0, -1))
    for y in (ya, yb):
        det.oriented_box((xa, y, 3.38), (xb, y, 2.98), 0.07, 0.08, "teal_frame")
    det.box((xb - 0.07, ya, 2.92), (xb, yb, 3.04), "teal_frame")
    spec.collider("col-roof-entrance-canopy", "roof", (xa, ya - 0.04, 2.92), (xb, yb + 0.04, 3.46))
    sx0, sx1, sy0, sy1 = 22.4, 25.4, 0.4, 3.4
    det.box((sx0, sy0, ROOF), (sx1, sy1, ROOF + 0.3), "teal_frame", skip=("-z",))
    det.pyramid((sx0, sy0), (sx1, sy1), ROOF + 0.3, ROOF + 1.8, "glass_skylight")
    spec.collider("col-roof-skylight-1", "roof", (sx0, sy0, ROOF), (sx1, sy1, ROOF + 0.8))
    spec.collider("col-roof-skylight-2", "roof", (sx0 + 0.75, sy0 + 0.75, ROOF + 0.8), (sx1 - 0.75, sy1 - 0.75, ROOF + 1.55))
