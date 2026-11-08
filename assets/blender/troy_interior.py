"""Authored, fictional two-level training interior inside the house region of the shell.

Nothing here is the reference building's floor plan. Room polygons are interior
free space (wall inner faces), counter-clockwise, in simulation-world metres.
"""

from troy_building import (C0, C1, F0, F1, RISERS, ROOF, STAIR_W, T_PART, TREAD, Face, build_opening)
from troy_geom import split_z, wall_rects

ASSEMBLY = ((16.0, 22.5, 0.0), (22.0, 28.5, 2.5))       # front lawn, >= 10 m from every facade
LAUNCH = ((30.5, 28.0, 0.1), -1.5707963)                 # lawn by Peoples Ave / 14th St, facing the house
FIRE_ORIGIN = (20.85, 2.1, F1)                            # upstairs hall, between bedroom door and stair top
OCCUPANT_START = (23.7, 0.2, F1)                          # upstairs rear bedroom


def room_defs(b):
    """(id, name, floor, zMin, zMax, floor material, polygon, floor-finish polygon, ceiling-finish polygon).

    Every room sits within one floor. The stair shaft belongs to room-g-entry below the upper slab and to
    room-u-hall above it; stairs[0] describes the vertical transition between them.
    """
    p = T_PART
    entry_west = [(b.XI_W, b.Y_ST0), (b.X_RA_E, b.Y_ST0), (b.X_RA_E, b.YI_PL), (b.XI_RA, b.YI_PL), (b.XI_RA, b.YI_N), (b.XI_W, b.YI_N)]
    hall_floor = [(b.X_ST1 + p, b.Y_W3 + p), (b.X_W1, b.Y_W3 + p), (b.X_W1, b.YI_PL), (b.X_ST1, b.YI_PL), (b.X_ST1, b.Y_ST0), (b.X_ST1 + p, b.Y_ST0)]
    return [
        ("room-g-entry", "Entry hall and stair foot", 0, F0, C0, "floor_stone",
         [(b.XI_W, b.Y_ST0), (b.X_ST1, b.Y_ST0), (b.X_ST1, b.YI_PL), (b.XI_RA, b.YI_PL), (b.XI_RA, b.YI_N), (b.XI_W, b.YI_N)],
         None, entry_west),
        ("room-g-living", "Living room", 0, F0, C0, "floor_wood",
         [(b.XI_W, b.YI_LINK), (b.XI_EW, b.YI_LINK), (b.XI_EW, b.YI_EW), (b.X_ST1, b.YI_EW), (b.X_ST1, b.Y_G1), (b.XI_W, b.Y_G1)], None, None),
        ("room-g-kitchen", "Kitchen and dining room", 0, F0, C0, "floor_tile",
         [(b.X_ST1 + p, b.YI_EW), (b.XI_E, b.YI_EW), (b.XI_E, b.YI_RD), (b.XI_RD, b.YI_RD), (b.XI_RD, b.YI_PL), (b.X_ST1 + p, b.YI_PL)], None, None),
        ("room-u-hall", "Upstairs hall, landing and stairwell", 1, F1, C1, "floor_wood",
         [(b.X_ST1 + p, b.Y_W3 + p), (b.X_W1, b.Y_W3 + p), (b.X_W1, b.YI_PL), (b.X_RA_E, b.YI_PL), (b.X_RA_E, b.Y_ST0), (b.X_ST1 + p, b.Y_ST0)],
         hall_floor, None),
        ("room-u-rear-bedroom", "Upstairs rear bedroom", 1, F1, C1, "floor_carpet",
         [(b.X_W1 + p, b.YI_EW), (b.XI_E, b.YI_EW), (b.XI_E, b.Y_W2), (b.X_W1 + p, b.Y_W2)], None, None),
        ("room-u-front-bedroom", "Upstairs front bedroom", 1, F1, C1, "floor_carpet",
         [(b.X_W1 + p, b.Y_W2 + p), (b.XI_E, b.Y_W2 + p), (b.XI_E, b.YI_RD), (b.XI_RD, b.YI_RD), (b.XI_RD, b.YI_PL + p), (b.X_W1 + p, b.YI_PL + p)], None, None),
        ("room-u-bath", "Upstairs bathroom", 1, F1, C1, "floor_tile",
         [(b.X_ST1 + p, b.YI_EW), (b.X_W1, b.YI_EW), (b.X_W1, b.Y_W3), (b.X_ST1 + p, b.Y_W3)], None, None),
        ("room-u-study", "Upstairs study", 1, F1, C1, "floor_wood",
         [(b.X_RA_E, b.YI_LINK), (b.XI_EW, b.YI_LINK), (b.XI_EW, b.YI_EW), (b.X_ST1, b.YI_EW), (b.X_ST1, b.Y_G1), (b.X_RA_E, b.Y_G1)], None, None),
    ]


def partition_defs(b):
    p = T_PART
    return [  # name, thickness axis, (a, b) along that axis, (u0, u1) along the wall, (z0, z1)
        ("g-seal-west", "x", (b.X_H, b.XI_W), (b.YI_LINK, b.YI_N), (F0, C0)),
        ("g-entry-living", "y", (b.Y_G1, b.Y_ST0), (b.XI_W, b.X_ST1), (F0, C0)),
        ("g-living-kitchen", "x", (b.X_ST1, b.X_ST1 + p), (b.YI_EW, b.YI_PL), (F0, C0)),
        ("u-stair-study", "y", (b.Y_G1, b.Y_ST0), (b.X_RA_E, b.X_ST1), (F1, C1)),
        ("u-hall-study", "x", (b.X_ST1, b.X_ST1 + p), (b.YI_EW, b.Y_ST0), (F1, C1)),
        ("u-hall-bedrooms", "x", (b.X_W1, b.X_W1 + p), (b.YI_EW, b.YI_PL + p), (F1, C1)),
        ("u-bedrooms", "y", (b.Y_W2, b.Y_W2 + p), (b.X_W1 + p, b.XI_E), (F1, C1)),
        ("u-bath-hall", "y", (b.Y_W3, b.Y_W3 + p), (b.X_ST1 + p, b.X_W1), (F1, C1)),
        ("u-hall-front", "y", (b.YI_PL, b.YI_PL + p), (b.XI_RD, b.X_W1), (F1, C1)),
    ]


def interior_openings(b, faces):
    rows = [  # id, kind, rooms, wall, u, width, height, floor, normal (rooms[0] -> rooms[1]), state
        ("door-g-entry-living", "door", ["room-g-entry", "room-g-living"], "g-entry-living", 11.85, 1.0, 2.2, F0, (0, -1, 0), "open"),
        ("door-g-living-kitchen", "door", ["room-g-living", "room-g-kitchen"], "g-living-kitchen", 0.6, 0.9, 2.1, F0, (1, 0, 0), "open"),
        ("door-u-rear-bedroom", "door", ["room-u-rear-bedroom", "room-u-hall"], "u-hall-bedrooms", 0.55, 0.8, 2.1, F1, (-1, 0, 0), "open"),
        ("door-u-front-bedroom", "door", ["room-u-front-bedroom", "room-u-hall"], "u-hall-bedrooms", 3.2, 0.9, 2.1, F1, (-1, 0, 0), "closed"),
        ("door-u-bath", "door", ["room-u-bath", "room-u-hall"], "u-bath-hall", 20.85, 0.8, 2.1, F1, (0, 1, 0), "open"),
        ("door-u-study", "door", ["room-u-study", "room-u-hall"], "u-hall-study", 1.2, 0.9, 2.1, F1, (1, 0, 0), "open"),
    ]
    out = []
    for oid, kind, rooms, wall, u, w, h, floor, normal, state in rows:
        face, t = faces[wall]
        out.append({"id": oid, "kind": kind, "rooms": rooms, "face": face, "t": t, "u": u, "w": w, "h": h,
                    "z0": floor, "sill": 0.0, "normal": tuple(float(c) for c in normal), "state": state,
                    "glazed": False, "style": "interior"})
    return out


def stairwell_opening(spec, b):
    """The open stairwell: the hole in the upper slab over the stair, joining the entry hall and the upstairs hall.

    Unframed and horizontal (normal +Z, entry -> hall), with widthM along X and heightM along Y, like the fixture
    scene's stairwell. It has no collider; it gives the fire/smoke model its gas path between the floors.
    """
    lo, hi = (b.X_RA_E, b.Y_ST0, C0), (b.X_ST1, b.YI_PL, F1)
    w, h = round(hi[0] - lo[0], 3), round(hi[1] - lo[1], 3)
    o = {"id": "opening-stairwell", "kind": "opening", "rooms": ["room-g-entry", "room-u-hall"], "w": w, "h": h,
         "sill": 0.0, "normal": (0.0, 0.0, 1.0), "state": "open", "glazed": False, "style": "interior",
         "center": tuple(round((lo[i] + hi[i]) / 2, 4) for i in range(3))}
    spec.mesh(o["id"], "SIM_ROOMS_OPENINGS", {
        "simKind": "opening", "openingKind": o["kind"], "rooms": ",".join(o["rooms"]), "initialState": o["state"],
        "glazed": o["glazed"], "widthM": w, "heightM": h, "sillHeightM": o["sill"]}).box(lo, hi, "dbg_opening")
    return o


def build_interior(spec, b):
    walls = spec.mesh("int_walls", "ENV_INTERIOR")
    faces = {}
    for name, axis, (a, c), (u0, u1), z in partition_defs(b):
        faces[name] = (Face(axis, c, 1, u0, u1, name), round(c - a, 3))
    openings = interior_openings(b, faces)
    for name, axis, (a, c), (u0, u1), (z0, z1) in partition_defs(b):
        face, t = faces[name]
        holes = [(o["u"] - o["w"] / 2, o["u"] + o["w"] / 2, o["z0"], o["z0"] + o["h"]) for o in openings if o["face"] is face]
        rects = wall_rects(u0, u1, z0, z1, holes)
        for k, (ua, ub, za, zb) in enumerate(rects):
            lo, hi = face.box(ua, ub, za, zb, -t, 0.0)
            spec.collider("col-wall-%s-%02d" % (name, k + 1), "wall", lo, hi)
            skip = tuple(s for s, cond in (("-z", abs(za - z0) < 1e-6), ("+z", abs(zb - z1) < 1e-6)) if cond)
            walls.box(lo, hi, "paint", skip=skip)
    for o in openings:
        build_opening(spec, o)
    openings.append(stairwell_opening(spec, b))
    # Seal between the upstairs study/stair shaft and the sealed volume above the entry hall.
    walls.box((b.X_RA_E - 0.15, b.YI_LINK, C0), (b.X_RA_E, b.YI_PL, C1), "paint", skip=("-z", "+z"))

    # Upper floor slab (around the stairwell) and roof slab; inner-face extents only.
    slab = spec.mesh("int_slabs", "ENV_INTERIOR")
    f1 = [((b.X_RA_E, b.YI_LINK), (b.XI_E, b.Y_ST0)), ((b.X_ST1, b.Y_ST0), (b.XI_E, b.YI_PL)),
          ((b.XI_EW, b.YI_EW), (b.XI_E, b.YI_LINK)), ((b.XI_RD, b.YI_PL), (b.XI_E, b.YI_RD))]
    for k, ((x0, y0), (x1, y1)) in enumerate(f1):
        spec.collider("col-floor-f1-%02d" % (k + 1), "floor", (x0, y0, C0), (x1, y1, F1))
        slab.box((x0, y0, C0), (x1, y1, F1), "paint", faces={"+z": "floor_wood", "-z": "ceiling"})
    roof = [((b.X_RA_E, b.YI_LINK), (b.XI_E, b.YI_PL)), ((b.XI_EW, b.YI_EW), (b.XI_E, b.YI_LINK)),
            ((b.XI_RD, b.YI_PL), (b.XI_E, b.YI_RD))]
    for k, ((x0, y0), (x1, y1)) in enumerate(roof):
        spec.collider("col-ceiling-f1-%02d" % (k + 1), "ceiling", (x0, y0, C1), (x1, y1, ROOF))
        slab.box((x0, y0, C1), (x1, y1, ROOF), "paint", faces={"+z": "roof_membrane", "-z": "ceiling"})

    # Room volumes and finishes.
    fin = spec.mesh("int_finishes", "ENV_INTERIOR")
    rooms = []
    for rid, name, floor, z0, z1, floor_mat, poly, floor_poly, ceil_poly in room_defs(b):
        poly = [(round(x, 3), round(y, 3)) for x, y in poly]
        rooms.append({"id": rid, "name": name, "floor": floor, "polygon": [list(p) for p in poly],
                      "zMin": round(z0, 3), "zMax": round(z1, 3)})
        spec.mesh(rid, "SIM_ROOMS_OPENINGS", {"simKind": "room", "floor": floor, "displayName": name}).prism(
            poly, z0, z1, "dbg_room")
        fin.flat(floor_poly or poly, z0 + 0.004, floor_mat)        # no floor over the open stairwell
        fin.flat(ceil_poly or poly, z1 - 0.004, "ceiling", up=False)  # no entry ceiling under the stairwell

    # Straight stair: 20 risers x 0.18 m, 19 treads x 0.28 m, rising east.
    st = spec.mesh("int_stair", "ENV_INTERIOR")
    for i in range(RISERS - 1):
        x0 = round(b.X_ST0 + i * TREAD, 3)
        top = round((i + 1) * b.RISE, 3)
        lo, hi = (x0, b.Y_ST0, F0), (round(x0 + TREAD, 3), b.YI_PL, top)
        st.box(lo, hi, "paint", faces={"+z": "wood_stair", "-x": "wood_stair"}, skip=("-z",))
        spec.collider("col-stair-%02d" % (i + 1), "stair", lo, hi)
    st.oriented_box((b.X_ST0, b.YI_PL - 0.06, 0.9), (b.X_ST1, b.YI_PL - 0.06, F1 + 0.9), 0.05, 0.05, "wood_dark")
    stairs = [{"id": "stair-main", "fromFloor": 0, "toFloor": 1,
               "bottom": [b.X_ST0, round(b.Y_ST0 + STAIR_W / 2, 3), F0],
               "top": [b.X_ST1, round(b.Y_ST0 + STAIR_W / 2, 3), F1], "widthM": STAIR_W}]
    spec.mesh("stair-main", "SIM_ROOMS_OPENINGS", {"simKind": "stair", "fromFloor": 0, "toFloor": 1}).box(
        (b.X_ST0, b.Y_ST0, F0), (b.X_ST1, b.YI_PL, F1), "dbg_stair")
    build_furniture(spec)
    return rooms, openings, stairs


# --------------------------------------------------------------------------
# Furniture: obstacle blocks. Each item is a visual object plus AABB collider(s).
# --------------------------------------------------------------------------
def _f(z):
    return F1 + z


FURNITURE = [
    # id, parts [(lo, hi, material)], colliders [(suffix, lo, hi)] or None for one AABB
    ("u-rear-bedroom-bed", [((24.1, -1.9, F1), (26.2, -0.3, _f(0.45)), "wood_light"),
                            ((24.1, -1.92, _f(0.45)), (25.6, -0.28, _f(0.62)), "fabric_red"),
                            ((25.6, -1.8, _f(0.45)), (26.05, -0.4, _f(0.62)), "linen"),
                            ((26.1, -1.9, _f(0.45)), (26.2, -0.3, _f(0.75)), "wood_light")],
     [("", (24.1, -1.92, F1), (26.2, -0.28, _f(0.62))), ("-headboard", (26.1, -1.9, F1), (26.2, -0.3, _f(0.75)))]),
    ("u-rear-bedroom-nightstand", [((25.65, 0.0, F1), (26.2, 0.45, _f(0.55)), "wood_light")], None),
    ("u-rear-bedroom-wardrobe", [((22.2, -2.73, F1), (22.8, -1.53, _f(2.0)), "wood_dark")], None),
    ("u-rear-bedroom-desk", [((22.2, -1.3, _f(0.72)), (22.8, -0.1, _f(0.76)), "wood_light"),
                             ((22.2, -1.3, F1), (22.8, -1.22, _f(0.72)), "wood_light"),
                             ((22.2, -0.18, F1), (22.8, -0.1, _f(0.72)), "wood_light")], None),
    ("u-rear-bedroom-chair", [((22.85, -0.95, F1), (23.3, -0.5, _f(0.45)), "black"),
                              ((23.22, -0.95, _f(0.45)), (23.3, -0.5, _f(0.9)), "black")], None),
    ("u-rear-bedroom-laundry", [((23.4, 0.6, F1), (24.0, 1.2, _f(0.4)), "fabric_blue")], None),
    ("u-rear-bedroom-boxes", [((24.6, 0.7, F1), (25.2, 1.3, _f(0.35)), "cardboard"),
                              ((24.65, 0.75, _f(0.35)), (25.1, 1.2, _f(0.6)), "cardboard")], None),
    ("u-front-bedroom-bed", [((23.4, 1.75, F1), (25.0, 3.75, _f(0.45)), "wood_light"),
                             ((23.38, 2.2, _f(0.45)), (25.02, 3.77, _f(0.62)), "fabric_blue"),
                             ((23.5, 1.8, _f(0.45)), (24.9, 2.2, _f(0.62)), "linen"),
                             ((23.4, 1.65, F1), (25.0, 1.75, _f(0.95)), "wood_light")],
     [("", (23.38, 1.75, F1), (25.02, 3.77, _f(0.62))), ("-headboard", (23.4, 1.65, F1), (25.0, 1.75, _f(0.95)))]),
    ("u-front-bedroom-wardrobe", [((21.3, 6.5, F1), (22.5, 7.06, _f(2.0)), "wood_dark")], None),
    ("u-front-bedroom-dresser", [((25.65, 5.2, F1), (26.2, 6.4, _f(0.9)), "wood_light")], None),
    ("u-front-bedroom-chair", [((25.4, 2.4, F1), (25.85, 2.85, _f(0.9)), "fabric_red")], None),
    ("u-bath-tub", [((19.75, -2.73, F1), (21.45, -2.03, _f(0.55)), "white_furn")], None),
    ("u-bath-toilet", [((21.45, -1.9, F1), (21.95, -1.3, _f(0.45)), "white_furn"),
                       ((21.75, -1.9, _f(0.45)), (21.95, -1.3, _f(0.8)), "white_furn")], None),
    ("u-bath-vanity", [((19.75, -1.65, F1), (20.3, -0.75, _f(0.85)), "white_furn")], None),
    ("u-study-desk", [((14.0, 2.3, _f(0.72)), (15.6, 2.95, _f(0.76)), "wood_dark"),
                      ((14.0, 2.3, F1), (14.08, 2.95, _f(0.72)), "wood_dark"),
                      ((15.52, 2.3, F1), (15.6, 2.95, _f(0.72)), "wood_dark")], None),
    ("u-study-chair", [((14.55, 1.7, F1), (15.0, 2.15, _f(0.45)), "black"),
                       ((14.55, 1.7, _f(0.45)), (15.0, 1.78, _f(0.9)), "black")], None),
    ("u-study-bookshelf", [((16.6, 2.62, F1), (18.4, 2.97, _f(2.0)), "wood_light")], None),
    ("u-study-boxes", [((17.6, -2.6, F1), (18.4, -1.9, _f(0.5)), "cardboard")], None),
    ("u-study-daybed", [((14.1, -0.33, F1), (16.1, 0.52, _f(0.42)), "fabric_blue"),
                        ((14.1, -0.33, _f(0.42)), (16.1, -0.13, _f(0.8)), "fabric_blue")], None),
    ("g-entry-bench", [((10.25, 5.4, 0.0), (10.7, 6.9, 0.45), "wood_dark")], None),
    ("g-entry-coat-rack", [((10.25, 8.5, 0.0), (10.65, 9.3, 1.8), "wood_dark")], None),
    ("g-entry-shoe-cabinet", [((12.75, 8.95, 0.0), (13.45, 9.42, 0.9), "white_furn")], None),
    ("g-living-sofa", [((10.6, -0.36, 0.0), (12.8, 0.54, 0.45), "fabric_blue"),
                       ((10.6, -0.36, 0.45), (12.8, -0.12, 0.85), "fabric_blue"),
                       ((10.6, -0.12, 0.45), (10.8, 0.54, 0.62), "fabric_blue"),
                       ((12.6, -0.12, 0.45), (12.8, 0.54, 0.62), "fabric_blue")], None),
    ("g-living-coffee-table", [((11.1, 1.0, 0.0), (12.3, 1.6, 0.45), "wood_dark")], None),
    ("g-living-armchair", [((13.4, 0.3, 0.0), (14.2, 1.1, 0.45), "fabric_red"),
                           ((13.4, 0.3, 0.45), (13.6, 1.1, 0.85), "fabric_red")], None),
    ("g-living-tv", [((14.6, 2.55, 0.0), (16.2, 2.95, 0.55), "wood_dark"),
                     ((14.8, 2.72, 0.55), (16.0, 2.8, 1.25), "black")], None),
    ("g-living-bookshelf", [((16.9, -2.7, 0.0), (17.3, -1.2, 2.0), "wood_light")], None),
    ("g-living-plant", [((18.85, -2.65, 0.0), (19.35, -2.15, 0.4), "cardboard"),
                        ((18.75, -2.75, 0.4), (19.45, -2.05, 1.2), "plant")], None),
    ("g-kitchen-counter-east", [((25.65, -2.75, 0.0), (26.23, 3.6, 0.88), "white_furn"),
                                ((25.62, -2.75, 0.88), (26.23, 3.6, 0.92), "stone_counter")], None),
    ("g-kitchen-counter-south", [((22.0, -2.75, 0.0), (25.65, -2.15, 0.88), "white_furn"),
                                 ((22.0, -2.75, 0.88), (25.65, -2.12, 0.92), "stone_counter")], None),
    ("g-kitchen-fridge", [((19.75, -2.75, 0.0), (20.5, -2.05, 1.85), "metal")], None),
    ("g-kitchen-island", [((22.6, -0.6, 0.0), (24.6, 0.4, 0.88), "wood_dark"),
                          ((22.55, -0.65, 0.88), (24.65, 0.45, 0.92), "stone_counter")], None),
    ("g-kitchen-table", [((22.4, 2.6, 0.72), (24.2, 3.6, 0.76), "wood_light"),
                         ((22.45, 2.65, 0.0), (22.55, 2.75, 0.72), "wood_light"),
                         ((24.05, 2.65, 0.0), (24.15, 2.75, 0.72), "wood_light"),
                         ((22.45, 3.45, 0.0), (22.55, 3.55, 0.72), "wood_light"),
                         ((24.05, 3.45, 0.0), (24.15, 3.55, 0.72), "wood_light")], None),
    ("g-kitchen-chair-1", [((22.6, 2.05, 0.0), (23.05, 2.5, 0.45), "wood_dark"), ((22.6, 2.05, 0.45), (23.05, 2.12, 0.95), "wood_dark")], None),
    ("g-kitchen-chair-2", [((23.55, 2.05, 0.0), (24.0, 2.5, 0.45), "wood_dark"), ((23.55, 2.05, 0.45), (24.0, 2.12, 0.95), "wood_dark")], None),
    ("g-kitchen-chair-3", [((22.6, 3.7, 0.0), (23.05, 4.15, 0.45), "wood_dark"), ((22.6, 4.08, 0.45), (23.05, 4.15, 0.95), "wood_dark")], None),
    ("g-kitchen-chair-4", [((23.55, 3.7, 0.0), (24.0, 4.15, 0.45), "wood_dark"), ((23.55, 4.08, 0.45), (24.0, 4.15, 0.95), "wood_dark")], None),
    ("g-kitchen-boxes", [((21.3, 6.4, 0.0), (22.1, 7.05, 0.7), "cardboard")], None),
    ("g-kitchen-bin", [((20.0, 3.8, 0.0), (20.4, 4.2, 0.7), "metal")], None),
]


def build_furniture(spec):
    for fid, parts, colliders in FURNITURE:
        m = spec.mesh("furn-" + fid, "ENV_INTERIOR", {"simKind": "visual", "furnitureId": fid})
        for lo, hi, mat in parts:
            m.box(lo, hi, mat, skip=("-z",) if abs(lo[2] - (F1 if lo[2] >= F1 - 1e-6 else 0.0)) < 1e-6 else ())
        if colliders is None:
            lo = tuple(min(p[0][i] for p in parts) for i in range(3))
            hi = tuple(max(p[1][i] for p in parts) for i in range(3))
            colliders = [("", lo, hi)]
        for suffix, lo, hi in colliders:
            spec.collider("col-furn-%s%s" % (fid, suffix), "furniture", lo, hi)


def build_targets(spec, b, site, openings):
    spec.mesh("assembly-point", "SIM_TARGETS", {"simKind": "target", "targetKind": "assembly"}).box(
        ASSEMBLY[0], ASSEMBLY[1], "dbg_target")
    (lx, ly, lz), yaw = LAUNCH
    spec.empty("launch-point", "SIM_TARGETS", (lx, ly, lz), (0.0, 0.0, yaw), props={"simKind": "target", "targetKind": "launch"})
    door = next(o for o in openings if o["id"] == "door-front")
    spec.empty("exit-front-door", "SIM_TARGETS", tuple(door["center"]), props={"simKind": "target", "targetKind": "exit",
                                                                                "openingId": "door-front"})
    spec.mesh("shell-footprint", "SIM_ROOMS_OPENINGS", {"simKind": "shell", "source": "OSM way 73141173 (snapped)"}).flat(
        site.polygon, 0.01, "dbg_shell")
    for name, pos in (("scenario-fire-origin", FIRE_ORIGIN), ("scenario-occupant-start", OCCUPANT_START)):
        spec.empty(name, "SIM_TARGETS", pos, props={"simKind": "scenario", "scenarioOnly": True})
