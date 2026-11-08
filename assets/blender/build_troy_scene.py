"""Build and export the FlyFireFighter Troy training scene (deterministic, headless).

    "/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
        -P assets/blender/build_troy_scene.py -- --out public/scenes/troy-training [--blend /tmp/troy.blend]

Writes scene.glb (appearance), colliders.glb (simulation debug layer) and
scene.meta.json (simulation world, Z up). Exterior = approximate massing of a real
reference (OSM footprint + estimates); interior and incident = authored fiction.
See README.md for provenance and attribution.
"""

import hashlib
import json
import math
import os
import struct
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # keep the recipe directory free of __pycache__
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from troy_building import C0, C1, F0, F1, Building, build_massing  # noqa: E402
from troy_drone import CAMERA_HFOV_DEG, CAMERA_PITCH_RAD, CAMERA_POSITION_BODY, HEIGHT_M, SPAN_M, build_drone  # noqa: E402
from troy_geom import SceneSpec, r3  # noqa: E402
from troy_interior import ASSEMBLY, FIRE_ORIGIN, LAUNCH, OCCUPANT_START, build_interior, build_targets  # noqa: E402
from troy_site import Site, build_ground, build_street_furniture, build_trees  # noqa: E402

RETRIEVED = "2026-11-07"
EXTRACT = os.path.join(SCRIPT_DIR, "troy_osm_extract.json")
COLLECTIONS = ("ENV_EXTERIOR", "ENV_INTERIOR", "SIM_COLLIDERS", "SIM_ROOMS_OPENINGS", "SIM_TARGETS", "ACTORS", "DRONE")
SCENE_GLB_COLLECTIONS = ("ENV_EXTERIOR", "ENV_INTERIOR", "DRONE")
COLLIDER_GLB_COLLECTIONS = ("SIM_COLLIDERS", "SIM_ROOMS_OPENINGS", "SIM_TARGETS")

COMMONS = "https://commons.wikimedia.org/wiki/File:RPI_Alumni_House_%02d.png"
PHOTOS = [  # Commons photographs consulted for massing estimates (not redistributed, no pixels used)
    (1, "south-east lawn: gabled south block, conservatory, glazed link, east wing pyramid"),
    (2, "east lawn toward 14th Street: east gable end with chimney, link, east wing, street trees"),
    (3, "south lawn: conservatory and gable end, site sloping west"),
    (5, "east wing east face: two storeys, parapet, glass pyramid skylight"),
    (7, "main entrance: teal glazed doors, curtain wall, sloped glass canopy, brick pavers"),
    (9, "north lawn: north wing with pyramid-roofed block and glazed link"),
    (10, "north facade east end: curved parapet, chimney, ground/upper window rhythm"),
    (12, "north facade: stone string course, keystones, tall ground-floor windows"),
    (15, "north facade west end and corner tower with pyramid roof"),
    (16, "north-west: tower, west facade bay, window rhythm"),
    (18, "west/service side: bay window, oculus, retaining walls and bins"),
]

# name: (sRGB 0-255, roughness, metallic, alpha, emission strength)
MATERIALS = {
    "brick": ((150, 64, 46), 0.9, 0.0, 1.0, 0.0), "brick_dark": ((122, 50, 38), 0.9, 0.0, 1.0, 0.0),
    "stone_trim": ((206, 197, 178), 0.8, 0.0, 1.0, 0.0), "slate": ((62, 66, 70), 0.6, 0.0, 1.0, 0.0),
    "roof_metal": ((118, 124, 128), 0.45, 0.5, 1.0, 0.0), "roof_metal_dark": ((84, 88, 92), 0.5, 0.5, 1.0, 0.0),
    "roof_membrane": ((92, 94, 96), 0.95, 0.0, 1.0, 0.0), "copper": ((96, 150, 134), 0.55, 0.3, 1.0, 0.0),
    "teal_frame": ((32, 92, 98), 0.5, 0.3, 1.0, 0.0), "white_frame": ((234, 230, 220), 0.6, 0.0, 1.0, 0.0),
    "glass_dark": ((44, 56, 66), 0.08, 0.1, 1.0, 0.0), "glass_conservatory": ((78, 104, 112), 0.08, 0.1, 1.0, 0.0),
    "glass_skylight": ((96, 130, 136), 0.08, 0.1, 1.0, 0.0), "glass_clear": ((196, 220, 228), 0.05, 0.0, 0.3, 0.0),
    "door_teal": ((28, 86, 94), 0.5, 0.2, 1.0, 0.0), "door_wood": ((146, 104, 66), 0.6, 0.0, 1.0, 0.0),
    "asphalt": ((60, 60, 62), 0.95, 0.0, 1.0, 0.0), "paint_yellow": ((220, 180, 40), 0.8, 0.0, 1.0, 0.0),
    "paint_white": ((235, 235, 230), 0.8, 0.0, 1.0, 0.0), "curb": ((156, 154, 148), 0.85, 0.0, 1.0, 0.0),
    "concrete": ((182, 180, 174), 0.9, 0.0, 1.0, 0.0), "pavers": ((148, 72, 56), 0.9, 0.0, 1.0, 0.0),
    "grass": ((86, 118, 58), 1.0, 0.0, 1.0, 0.0), "paint": ((228, 224, 214), 0.9, 0.0, 1.0, 0.0),
    "ceiling": ((242, 242, 238), 0.95, 0.0, 1.0, 0.0), "floor_wood": ((166, 120, 80), 0.6, 0.0, 1.0, 0.0),
    "floor_tile": ((202, 202, 198), 0.4, 0.0, 1.0, 0.0), "floor_stone": ((178, 170, 158), 0.7, 0.0, 1.0, 0.0),
    "floor_carpet": ((124, 130, 140), 1.0, 0.0, 1.0, 0.0), "wood_stair": ((150, 106, 68), 0.6, 0.0, 1.0, 0.0),
    "wood_light": ((192, 152, 106), 0.6, 0.0, 1.0, 0.0), "wood_dark": ((98, 66, 44), 0.6, 0.0, 1.0, 0.0),
    "fabric_blue": ((72, 94, 124), 1.0, 0.0, 1.0, 0.0), "fabric_red": ((152, 62, 52), 1.0, 0.0, 1.0, 0.0),
    "linen": ((218, 214, 204), 1.0, 0.0, 1.0, 0.0), "white_furn": ((230, 230, 226), 0.5, 0.0, 1.0, 0.0),
    "stone_counter": ((90, 90, 92), 0.4, 0.0, 1.0, 0.0), "metal": ((164, 168, 172), 0.35, 0.8, 1.0, 0.0),
    "metal_dark": ((48, 50, 54), 0.5, 0.6, 1.0, 0.0), "black": ((30, 30, 32), 0.6, 0.0, 1.0, 0.0),
    "cardboard": ((182, 152, 108), 0.9, 0.0, 1.0, 0.0), "plant": ((66, 110, 52), 0.9, 0.0, 1.0, 0.0),
    "bark": ((88, 70, 54), 0.95, 0.0, 1.0, 0.0), "foliage": ((74, 106, 52), 0.95, 0.0, 1.0, 0.0),
    "foliage_dark": ((44, 74, 48), 0.95, 0.0, 1.0, 0.0), "lamp_glass": ((240, 236, 210), 0.3, 0.0, 1.0, 0.0),
    "wood_bench": ((136, 96, 60), 0.7, 0.0, 1.0, 0.0), "hydrant_red": ((178, 34, 30), 0.5, 0.1, 1.0, 0.0),
    "bin_blue": ((40, 96, 160), 0.6, 0.0, 1.0, 0.0), "bin_black": ((34, 36, 40), 0.6, 0.0, 1.0, 0.0),
    "drone_body": ((52, 56, 62), 0.5, 0.2, 1.0, 0.0), "drone_accent": ((232, 96, 28), 0.5, 0.0, 1.0, 0.0),
    "drone_arm": ((36, 38, 42), 0.5, 0.2, 1.0, 0.0), "drone_tank": ((236, 236, 232), 0.4, 0.0, 1.0, 0.0),
    "lens": ((12, 12, 14), 0.1, 0.0, 1.0, 0.0), "guide_light": ((255, 245, 210), 0.3, 0.0, 1.0, 2.0),
    "dbg_ground": ((110, 84, 60), 0.9, 0.0, 1.0, 0.0), "dbg_wall": ((200, 200, 200), 0.9, 0.0, 1.0, 0.0),
    "dbg_floor": ((120, 160, 200), 0.9, 0.0, 1.0, 0.0), "dbg_ceiling": ((160, 200, 230), 0.9, 0.0, 1.0, 0.0),
    "dbg_roof": ((150, 110, 90), 0.9, 0.0, 1.0, 0.0), "dbg_stair": ((220, 170, 80), 0.9, 0.0, 1.0, 0.0),
    "dbg_furniture": ((190, 120, 200), 0.9, 0.0, 1.0, 0.0), "dbg_glass": ((80, 200, 255), 0.9, 0.0, 0.5, 0.0),
    "dbg_door": ((255, 140, 40), 0.9, 0.0, 1.0, 0.0), "dbg_tree": ((60, 170, 70), 0.9, 0.0, 1.0, 0.0),
    "dbg_street_furniture": ((230, 230, 70), 0.9, 0.0, 1.0, 0.0), "dbg_room": ((80, 140, 255), 0.9, 0.0, 0.18, 0.0),
    "dbg_opening": ((255, 220, 0), 0.9, 0.0, 0.5, 0.0), "dbg_target": ((255, 60, 60), 0.9, 0.0, 0.3, 0.0),
    "dbg_shell": ((240, 240, 240), 0.9, 0.0, 0.3, 0.0),
}

ESTIMATED = [
    "All heights. Two above-grade storeys are visible in the photographs (OSM building:levels=3 is not used): ground floor 0.00-3.25 m, upper floor 3.60-6.50 m, flat roofs 6.90 m, parapets 7.80 m.",
    "Subdivision of the OSM footprint into wings (north wing, north-west tower, south gabled block, conservatory, south-west pavilion, east wing) and the positions of their internal boundaries; tower width 5.2 m and conservatory depth 2.71 m.",
    "Roof forms and heights: 50-degree standing-seam gable over the south block (ridge %.2f m), copper pyramids on the tower (11.2 m) and south-west pavilion (8.2 m), conservatory glass roof 3.0-5.2 m, glass pyramid skylight on the east wing.",
    "Window and door counts, positions and sizes on every facade (rhythm only), facade trim (stone string course, coping, keystones, sills) and all colours.",
    "Chimney positions and heights.",
    "Front door size (1.0 m x 2.2 m), leaf and surround; only its location comes from the OSM entrance=main node.",
    "Entrance plaza extent, glazed entrance canopy and footway width; the footway centreline is OSM way 1376363931.",
    "Street widths (Peoples Avenue 10.0 m, 14th Street 9.0 m, 13th Street 7.0 m curb to curb), curb height 0.15 m, sidewalk width 1.5 m and verges; centrelines come from OSM.",
    "Flat ground at z = 0 m; the real site slopes down to the west and south.",
    "Tree, shrub, lamp, bench and bin positions and sizes (from photographs, not surveyed); the fire hydrant position is OSM node 12541056051.",
    "Site grid: the footprint is rotated by %.2f degrees and snapped to a rectilinear outline (maximum vertex shift %.3f m); street centrelines are snapped to the same grid.",
    "The house region (east part of the footprint) is an authored training interior with authored openings; the rest of the footprint is a sealed volume with decorative windows.",
]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out, blend = None, None
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out, i = argv[i + 1], i + 2
        elif argv[i] == "--blend":
            blend, i = argv[i + 1], i + 2
        else:
            raise SystemExit("unknown argument: " + argv[i])
    if not out:
        raise SystemExit("usage: ... -- --out public/scenes/troy-training [--blend file.blend]")
    return os.path.abspath(out), blend


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_materials():
    mats = {}
    for name in sorted(MATERIALS):
        rgb, rough, metal, alpha, emit = MATERIALS[name]
        lin = tuple(srgb_to_linear(c) for c in rgb)
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = lin + (1.0,)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Alpha"].default_value = alpha
        if emit > 0:
            bsdf.inputs["Emission Color"].default_value = lin + (1.0,)
            bsdf.inputs["Emission Strength"].default_value = emit
        if alpha < 1.0:
            mat.surface_render_method = "BLENDED"
        # Appearance meshes are closed or outward-facing: export single-sided (glTF doubleSided=false).
        mat.use_backface_culling = not name.startswith("dbg_")
        mat.diffuse_color = lin + (alpha,)
        mats[name] = mat
    return mats


def instantiate(spec, mats):
    scene = bpy.context.scene
    cols = {}
    for name in COLLECTIONS:
        col = bpy.data.collections.new(name)
        scene.collection.children.link(col)
        cols[name] = col
    objs = {}
    for entry in spec.objects:
        name = entry["name"]
        if entry["kind"] == "empty":
            obj = bpy.data.objects.new(name, None)
            obj.empty_display_type = "PLAIN_AXES"
            obj.empty_display_size = entry.get("size", 0.3)
        else:
            b = entry["builder"]
            me = bpy.data.meshes.new(name)
            me.from_pydata(b.verts, [], b.faces)
            order = []
            for m in b.mats:
                if m not in order:
                    order.append(m)
            for m in order:
                me.materials.append(mats[m])
            index = {m: i for i, m in enumerate(order)}
            me.polygons.foreach_set("material_index", [index[m] for m in b.mats])
            if me.validate(verbose=False):
                print("WARNING: mesh %s needed cleanup" % name)
            me.update()
            obj = bpy.data.objects.new(name, me)
            if entry["collection"].startswith("SIM_"):
                obj.display_type = "WIRE"
        cols[entry["collection"]].objects.link(obj)
        obj.location = entry["location"]
        obj.rotation_euler = entry["rotation"]
        for key in sorted(entry["props"]):
            obj[key] = entry["props"][key]
        if entry["parent"]:
            obj.parent = objs[entry["parent"]]
        objs[name] = obj
    bpy.context.view_layer.update()
    return objs


def export_glb(path, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=path, check_existing=False, export_format="GLB", use_selection=True, export_yup=True,
        export_extras=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_vertex_color="NONE", export_attributes=False, export_cameras=False,
        export_lights=False, export_animations=False, export_skins=False, export_morph=False,
        export_draco_mesh_compression_enable=False, export_apply=False, export_gpu_instances=False)


def glb_stats(path):
    data = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise RuntimeError("not a GLB: " + path)
    length, ctype = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20:20 + length])
    tris = 0
    for node in doc.get("nodes", []):
        if "mesh" not in node:
            continue
        for prim in doc["meshes"][node["mesh"]]["primitives"]:
            if prim.get("mode", 4) != 4:
                continue
            acc = prim.get("indices", prim["attributes"]["POSITION"])
            tris += doc["accessors"][acc]["count"] // 3
    if "KHR_draco_mesh_compression" in doc.get("extensionsUsed", []):
        raise RuntimeError("Draco compression must not be used")
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "triangles": tris}


def scene_bounds(objs):
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for obj in objs:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            w = mw @ v.co
            for i in range(3):
                lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
    return r3(lo), r3(hi)


def clean(v):
    return [round(float(c), 3) + 0.0 for c in v]


def build_meta(site, b, spec, rooms, openings, stairs, bounds, assets):
    sources = site.osm_sources(RETRIEVED)
    sources.append({"title": "Wikimedia Commons category: Heffner Alumni House (19 photographs by RPI2026F1, 2023-03-22)",
                    "url": "https://commons.wikimedia.org/wiki/Category:Heffner_Alumni_House",
                    "license": "CC BY-SA 4.0 (photographs consulted only; not redistributed)", "retrieved": RETRIEVED})
    for number, use in PHOTOS:
        sources.append({"title": "Wikimedia Commons: RPI Alumni House %02d.png by RPI2026F1 — %s" % (number, use),
                        "url": COMMONS % number, "license": "CC BY-SA 4.0", "retrieved": RETRIEVED})
    theta = abs(math.degrees(site.theta))
    estimated = list(ESTIMATED)
    estimated[2] = estimated[2] % b.ridge
    estimated[10] = estimated[10] % (theta, site.snap_displacement)
    lat, lon = site.origin_latlon
    c, s = math.cos(math.radians(theta)), math.sin(math.radians(theta))
    origin_desc = (
        "Area centroid of the rectilinearised OSM footprint of way 73141173 at ground level; z = 0 is the front-door "
        "threshold (flat site). World axes are a site grid aligned with the building and Peoples Avenue: +X points "
        "along Peoples Avenue toward 14th Street (true bearing %.2f deg), +Y toward Peoples Avenue (bearing %.2f deg). "
        "Geodetic local ENU metres from origin.latLon: east = %.5f*x + %.5f*y, north = -%.5f*x + %.5f*y."
        % (90.0 + theta, theta, c, s, s, c))
    meta = {
        "schema": "flyfirefighter.scene-meta/1",
        "sceneId": "troy-training",
        "revision": 1,
        "units": "m",
        "frames": {
            "world": "right-handed, Z up, X east, Y north, metres (site grid: +X follows Peoples Avenue, %.2f deg clockwise of true east; see origin)" % theta,
            "gltf": "Y up: gltf (x, y, z) = world (x, z, -y)",
        },
        "origin": {"description": origin_desc, "latLon": [round(lat, 7), round(lon, 7)]},
        "provenance": {
            "exterior": {
                "reference": "Heffner Alumni House, 1301 Peoples Avenue, Troy, NY (RPI)",
                "method": (
                    "Approximate massing, not a scan. The OSM footprint (way 73141173) is projected to a local WGS84 "
                    "tangent plane, rotated by the building's dominant edge bearing so walls and Peoples Avenue align "
                    "with the world axes, snapped to a rectilinear outline and extruded with heights, wings and roof "
                    "forms estimated from openly licensed photographs. Street, sidewalk, crossing and footway "
                    "positions come from OSM centrelines. Flat procedural colours only; no photo pixels or textures."),
                "sources": sources,
                "estimated": estimated,
            },
            "interior": {"kind": "authored_fictional",
                         "statement": "Authored training interior; not the reference building's floor plan."},
            "incident": "fictional",
        },
        "floors": [{"index": 0, "elevationM": F0, "ceilingM": C0}, {"index": 1, "elevationM": F1, "ceilingM": C1}],
        "rooms": rooms,
        "openings": [{
            "id": o["id"], "kind": o["kind"], "rooms": list(o["rooms"]), "center": clean(o["center"]),
            "widthM": o["w"], "heightM": o["h"], "sillHeightM": o["sill"], "outwardNormal": clean(o["normal"]),
            "initialState": o["state"], "glazed": o["glazed"]} for o in openings],
        "stairs": stairs,
        "colliders": spec.colliders,
        "exits": [{"id": "exit-front-door", "openingId": "door-front"}],
        "assemblyPoint": {"id": "assembly-point", "min": clean(ASSEMBLY[0]), "max": clean(ASSEMBLY[1])},
        "launchPoint": {"position": clean(LAUNCH[0]), "yawRad": round(LAUNCH[1], 4)},
        "scenarioAnchors": {"scenarioOnly": True,
                            "note": "Scenario initialization only; never part of the planner's map prior.",
                            "fireOrigin": clean(FIRE_ORIGIN), "occupantStart": clean(OCCUPANT_START)},
        "drone": {"spanM": SPAN_M, "heightM": HEIGHT_M,
                  "camera": {"positionBody": clean(CAMERA_POSITION_BODY), "pitchRad": CAMERA_PITCH_RAD,
                             "horizontalFovDeg": CAMERA_HFOV_DEG}},
        "bounds": {"min": bounds[0], "max": bounds[1]},
        "assets": assets,
    }
    return meta


def main():
    out_dir, blend = parse_args()
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    site = Site(EXTRACT)
    b = Building(site)
    spec = SceneSpec()
    build_ground(spec, site, ((b.X_RA_E, b.Y_PLAZA), (b.X_RD_W, 11.6)))
    build_massing(spec, b)
    rooms, interior_openings, stairs = build_interior(spec, b)
    build_trees(spec)
    build_street_furniture(spec, site)
    openings = b.openings + interior_openings
    build_targets(spec, b, site, openings)
    build_drone(spec, LAUNCH[0], LAUNCH[1])

    mats = make_materials()
    objs = instantiate(spec, mats)
    by_col = {name: [] for name in COLLECTIONS}
    for entry in spec.objects:
        by_col[entry["collection"]].append(objs[entry["name"]])
    scene_objs = [o for c in SCENE_GLB_COLLECTIONS for o in by_col[c]]
    debug_objs = [o for c in COLLIDER_GLB_COLLECTIONS for o in by_col[c] if not o.get("scenarioOnly", False)]
    scene_path = os.path.join(out_dir, "scene.glb")
    colliders_path = os.path.join(out_dir, "colliders.glb")
    export_glb(scene_path, scene_objs)
    export_glb(colliders_path, debug_objs)
    assets = {"scene.glb": glb_stats(scene_path), "colliders.glb": glb_stats(colliders_path)}
    meta = build_meta(site, b, spec, rooms, openings, stairs, scene_bounds(scene_objs), assets)
    with open(os.path.join(out_dir, "scene.meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    if blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(blend), check_existing=False)
    print("BUILD OK: %d objects, %d colliders, %d rooms, %d openings" % (len(spec.objects), len(spec.colliders),
                                                                        len(rooms), len(openings)))
    for name, st in assets.items():
        print("  %-14s %8d bytes %7d triangles sha256 %s" % (name, st["bytes"], st["triangles"], st["sha256"][:16]))


if __name__ == "__main__":
    main()
