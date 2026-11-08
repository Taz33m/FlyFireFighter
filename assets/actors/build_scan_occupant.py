"""Build the FlyFireFighter occupant from the licensed scan (deterministic, headless Blender 5.1).

    "/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
        -P assets/actors/build_scan_occupant.py -- [--out public/actors] [--blend /tmp/occupant.blend]

Character: "Rigged T-Pose Human Male w 50 Face Blendshapes" by Mike Alger (CC BY 4.0; scanned by
doob, optimized and rigged by High Fidelity, per the creator), from the two Sketchfab archives pinned
in scan_sources.json. Animations: five Microsoft Rocketbox clips (MIT, 3ds Max Biped) pinned in
occupant_sources.json, retargeted onto the scan's own skeleton. The Rocketbox avatar is used only as
the Biped's T-pose reference skeleton; none of its mesh or textures are exported. Writes:

    occupant.glb              skinned mesh + actions idle, crouch, cough, walk, follow
    occupant.provenance.json  sources, licences, hashes, modifications, attribution

Runtime contract (same as the interim build): glTF Y up, metres, origin at the FEET point (ground
contact between the feet), the character faces glTF/render +X, so a three.js yaw psi about +Y faces
world (cos psi, sin psi). Locomotion is in place (the simulator drives position); clips loop.

Retargeting. Each mapped bone's world rotation is the source bone's world rotation relative to the
Biped T-pose, applied to the scan bone's own rest (T-pose), after a per-bone swing that aligns the
two rest directions:  R_scan(t) = R_biped(t) . R_biped_T^-1 . Q^-1 . R_scan_rest,  Q = swing taking
the Biped T-pose bone direction to the scan's rest direction. Local pose rotations follow from the
parent's world rotation, so the scan keeps its own bone lengths and the mesh never stretches. The
hips follow the Biped pelvis's displacement from its T-pose, scaled by the hip-joint height ratio,
then a constant per-clip height offset puts the lowest deformed vertex on the floor.
"""

import hashlib
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import zipfile

import bpy
import numpy as np
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FPS = 30
CLIPS = ("idle", "crouch", "cough", "walk", "follow")
LOCOMOTION = ("walk", "follow")
MIN_TRIANGLES, MAX_TRIANGLES = 30000, 60000
MAX_BYTES = 8 * 1024 * 1024
MAX_TEXTURE = 2048
SCAN_CACHE = os.path.join(ROOT, "assets", "cache", "characters", "mike-alger")
ROCKETBOX_CACHE = os.path.join(ROOT, "assets", "cache", "characters", "rocketbox")
PREFIX = "mixamorig_"

LABEL = "Simulated occupant — scanned character (Mike Alger, CC BY 4.0) with Rocketbox animations (MIT); fictional person"
SKETCHFAB_CREDIT = (
    "This work is based on \"Rigged T-Pose Human Male w 50 Face Blendshapes\" "
    "(https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) "
    "by Mike Alger (https://sketchfab.com/mikealger) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)"
)
CHARACTER_ATTRIBUTION = (
    "Occupant character based on \"Rigged T-Pose Human Male w 50 Face Blendshapes\" "
    "(https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) "
    "by Mike Alger (https://sketchfab.com/mikealger), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). "
    "Scanned by doob and optimized and rigged by High Fidelity, per the creator. Modified for FlyFireFighter: "
    "blendshape target meshes and facial shape keys removed, meshes merged, transforms and units converted, "
    "skin weights limited to four influences, material rebuilt, animation retargeted from Microsoft Rocketbox clips, "
    "glTF export; no retopology or decimation. The creator does not endorse this project. The fictional occupant has "
    "no connection to him or to any real incident."
)
ANIMATION_ATTRIBUTION = (
    "Animations from the Microsoft Rocketbox Avatar Library (https://github.com/microsoft/Microsoft-Rocketbox), "
    "Copyright (c) 2020 Microsoft, MIT License: clips m_idle_breathe_01, m_crouch_idle, m_idle_cough_01, "
    "m_walk_neutral_01 and m_walk_slow_01, retargeted onto the scanned character's skeleton, trimmed and modified for "
    "FlyFireFighter. Citation: Gonzalez-Franco et al., \"The Rocketbox library and the utility of freely available "
    "rigged avatars\", Frontiers in Virtual Reality (2020), doi:10.3389/frvir.2020.561558."
)
COPYRIGHT = ("Character: Mike Alger, CC BY 4.0 (scan by doob, rig by High Fidelity); animations: Microsoft Rocketbox, "
             "Copyright (c) 2020 Microsoft, MIT License; modified for FlyFireFighter (see occupant.provenance.json)")

# Scan bone (without the mixamorig_ prefix) -> Rocketbox Biped bone.
SIDES = (("Left", "L"), ("Right", "R"))
BONE_MAP = {"Hips": "Bip01 Pelvis", "Spine": "Bip01 Spine", "Spine1": "Bip01 Spine1", "Spine2": "Bip01 Spine2",
            "Neck": "Bip01 Neck", "Head": "Bip01 Head"}
# Direction used to align the two rest poses: (scan child, Biped child) for each mapped bone.
DIRECTION = {"Hips": ("Spine", "Bip01 Spine"), "Spine": ("Spine1", "Bip01 Spine1"), "Spine1": ("Spine2", "Bip01 Spine2"),
             "Spine2": ("Neck", "Bip01 Neck"), "Neck": ("Head", "Bip01 Head"), "Head": ("HeadTop_End", "Bip01 HeadNub")}
FINGERS = (("Thumb", "0"), ("Index", "1"), ("Middle", "2"), ("Ring", "3"), ("Pinky", "4"))
for side, s in SIDES:
    chain = ((side + "Shoulder", "Bip01 %s Clavicle" % s), (side + "Arm", "Bip01 %s UpperArm" % s),
             (side + "ForeArm", "Bip01 %s Forearm" % s), (side + "Hand", "Bip01 %s Hand" % s))
    for (a, b), (ca, cb) in zip(chain, chain[1:] + ((side + "HandMiddle1", "Bip01 %s Finger2" % s),)):
        BONE_MAP[a], DIRECTION[a] = b, (ca, cb)
    legs = ((side + "UpLeg", "Bip01 %s Thigh" % s), (side + "Leg", "Bip01 %s Calf" % s), (side + "Foot", "Bip01 %s Foot" % s),
            (side + "ToeBase", "Bip01 %s Toe0" % s))
    for (a, b), (ca, cb) in zip(legs, legs[1:] + ((side + "Toe_End", "Bip01 %s Toe0Nub" % s),)):
        BONE_MAP[a], DIRECTION[a] = b, (ca, cb)
    for finger, n in FINGERS:
        segs = [("%sHand%s%d" % (side, finger, i + 1), "Bip01 %s Finger%s%s" % (s, n, "" if i == 0 else str(i))) for i in range(3)]
        ends = segs[1:] + [("%sHand%s4" % (side, finger), "Bip01 %s Finger%sNub" % (s, n))]
        for (a, b), (ca, cb) in zip(segs, ends):
            BONE_MAP[a], DIRECTION[a] = b, (ca, cb)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"out": os.path.join(ROOT, "public", "actors"), "blend": None}
    i = 0
    while i < len(argv):
        key = argv[i].lstrip("-")
        if key not in opts:
            raise SystemExit("unknown option " + argv[i])
        opts[key] = os.path.abspath(argv[i + 1])
        i += 2
    return opts


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def log(*parts):
    print("SCAN", *parts, flush=True)


def load_scan_sources(workdir):
    """Verify both archives and the members we use; extract them (only) into workdir."""
    with open(os.path.join(HERE, "scan_sources.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    extracted, records = {}, []
    for entry in manifest["files"]:
        path = os.path.join(SCAN_CACHE, entry["path"])
        if not os.path.exists(path):
            raise SystemExit("missing source " + path + " (download it from Sketchfab; see assets/actors/README.md)")
        got = sha256(path)
        if got != entry["sha256"]:
            raise SystemExit("hash mismatch for " + entry["path"] + ": " + got)
        with zipfile.ZipFile(path) as z:
            for member, digest in sorted(entry["members"].items()):
                data = z.read(member)
                if hashlib.sha256(data).hexdigest() != digest:
                    raise SystemExit("hash mismatch for " + entry["path"] + ":" + member)
                dst = os.path.join(workdir, "scan", os.path.basename(member))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, "wb") as out:
                    out.write(data)
                extracted[member] = dst
        records.append({"role": entry["role"], "path": "assets/cache/characters/mike-alger/" + entry["path"], "download": entry["download"],
                        "sha256": got, "bytes": os.path.getsize(path), "members": entry["members"]})
    return manifest, extracted, records


def load_rocketbox_sources():
    with open(os.path.join(HERE, "occupant_sources.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    by_role = {}
    for entry in manifest["files"]:
        if not (entry["role"] in ("licence", "avatar") or entry["role"].startswith("clip.")):
            continue
        path = os.path.join(ROCKETBOX_CACHE, entry["path"])
        if not os.path.exists(path):
            raise SystemExit("missing source " + path + " (run assets/actors/fetch_rocketbox.py)")
        got = sha256(path)
        if got != entry["sha256"]:
            raise SystemExit("hash mismatch for " + entry["path"] + ": " + got)
        by_role[entry["role"]] = dict(entry, abspath=path, bytes=os.path.getsize(path))
    return manifest, by_role


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def remove_objects(objects):
    for o in objects:
        bpy.data.objects.remove(o, do_unlink=True)


def purge_actions(keep):
    for action in list(bpy.data.actions):
        if action.name not in keep:
            bpy.data.actions.remove(action)


def channelbag(obj):
    ad = obj.animation_data
    return anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)


def world_rot(matrix):
    return matrix.decompose()[1]


# ---------------------------------------------------------------- scan character


def prepare_scan(fbx_path):
    new = import_fbx(fbx_path)
    arm = next(o for o in new if o.type == "ARMATURE")
    meshes = sorted((o for o in new if o.type == "MESH"), key=lambda o: o.name)
    # The FBX carries the 50 blendshape targets twice: as shape keys on "Body" and as separate
    # material-less, UV-less mesh objects under "Poses__Body" (Cinema 4D pose-morph targets). The
    # latter are the reported untextured face that "shows up over top of your face" in renders.
    targets = [o for o in meshes if o.parent is not None and o.parent.name == "Poses__Body"]
    skinned = [o for o in meshes if o not in targets and any(m.type == "ARMATURE" for m in o.modifiers)]
    body = next(o for o in skinned if o.name == "Body")
    shape_keys = [k.name for k in body.data.shape_keys.key_blocks][1:] if body.data.shape_keys else []
    inspection = {
        "fbxUnits": "centimetres (armature object scale 0.01, rotated +90 deg about X: FBX Y up)",
        "skeleton": {"bones": len(arm.data.bones), "prefix": PREFIX, "root": arm.data.bones[0].name,
                     "names": [b.name for b in arm.data.bones],
                     "note": "Mixamo-style humanoid naming (mixamorig: written as mixamorig_), T-pose; consistent with the creator's 'rigged by High Fidelity' and High Fidelity's Fuse/Mixamo-based pipeline. No Mixamo animation or Mixamo service is used here."},
        "meshes": [{"name": o.name, "triangles": sum(len(p.vertices) - 2 for p in o.data.polygons), "vertices": len(o.data.vertices)} for o in skinned],
        "shapeKeys": {"count": len(shape_keys), "on": "Body (head, hands, eyes, teeth)", "names": shape_keys,
                      "note": "Present in the source FBX; Sketchfab's converted glTF has none. Not exported (unused at runtime; 50 morph targets would add GPU memory)."},
        "removed": {"blendshapeTargetMeshes": len(targets), "emptyObjects": sorted(o.name for o in new if o.type == "EMPTY")},
    }
    log("skeleton", len(arm.data.bones), "bones:", " ".join(b.name for b in arm.data.bones))
    log("shape keys on Body:", len(shape_keys), " ".join(shape_keys))
    log("removing", len(targets), "material-less blendshape target meshes and", len(inspection["removed"]["emptyObjects"]), "empties")
    remove_objects(targets + [o for o in new if o.type == "EMPTY"])
    for o in skinned:
        if o.data.shape_keys:
            o.shape_key_clear()
        o.animation_data_clear()
    arm.animation_data_clear()
    purge_actions(set())

    # Bake FBX units and axes (cm, Y up) into metres, Z up; then yaw +90 deg so the scan, which faces
    # Blender -Y, faces +X (glTF/render +X).
    bpy.ops.object.select_all(action="DESELECT")
    for o in [arm] + skinned:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    arm.rotation_euler = (0.0, 0.0, math.pi / 2)
    bpy.context.view_layer.update()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Feet point at the origin: midway between the ankle joints horizontally, lowest vertex at z = 0.
    feet = (arm.data.bones[PREFIX + "LeftFoot"].head_local + arm.data.bones[PREFIX + "RightFoot"].head_local) / 2
    low = min(min((o.matrix_world @ v.co).z for v in o.data.vertices) for o in skinned)
    arm.location = (-feet.x, -feet.y, -low)
    bpy.context.view_layer.update()
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    for o in [arm] + skinned:
        if any(abs(a - b) > 1e-6 for ra, rb in zip(o.matrix_world, Matrix.Identity(4)) for a, b in zip(ra, rb)):
            raise SystemExit("transform not applied on " + o.name)

    # One skinned mesh: shared UV layer name so the join keeps a single UV map.
    for o in skinned:
        while len(o.data.uv_layers) > 1:
            o.data.uv_layers.remove(o.data.uv_layers[1])
        o.data.uv_layers[0].name = "UVMap"
    bpy.ops.object.select_all(action="DESELECT")
    for o in skinned:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    mods = [m for m in body.modifiers if m.type == "ARMATURE"]
    for m in mods[1:]:
        body.modifiers.remove(m)
    mods[0].object = arm
    arm.name = arm.data.name = "occupant-rig"
    body.name = body.data.name = "occupant-body"
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return arm, body, inspection


def build_material(mesh, texture_path, workdir):
    src = bpy.data.images.load(texture_path)
    width, height = src.size
    if width > MAX_TEXTURE or height > MAX_TEXTURE:
        raise SystemExit("texture larger than 2K: %dx%d" % (width, height))
    # The 2048 px source JPEG is embedded as is (no re-encoding).
    dst = os.path.join(workdir, "occupant_color.jpg")
    shutil.copyfile(texture_path, dst)
    bpy.data.images.remove(src)
    image = bpy.data.images.load(dst)
    image.name = "occupant_color"
    image.colorspace_settings.name = "sRGB"
    mat = bpy.data.materials.new("occupant-body")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.8
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = True
    mesh.data.materials.clear()
    mesh.data.materials.append(mat)
    for p in mesh.data.polygons:
        p.material_index = 0
    for m in list(bpy.data.materials):
        if m.name != "occupant-body":
            bpy.data.materials.remove(m)
    for img in list(bpy.data.images):
        if img.name != "occupant_color":
            bpy.data.images.remove(img)
    return {"name": "occupant_color", "size": [width, height], "format": "JPEG", "source": "textures/MikeAlger_Texture.jpeg",
            "sourceSize": [width, height], "reencoded": False}


# ---------------------------------------------------------------- Biped reference and clips


def biped_reference(path):
    """World rest rotations and joint positions of the Rocketbox Biped in its T-pose (avatar bind pose)."""
    new = import_fbx(path)
    arm = next(o for o in new if o.type == "ARMATURE")
    arm.rotation_euler = (0.0, 0.0, 0.0)  # the interim recipe's frame: yaw 0 faces +X
    bpy.context.view_layer.update()
    mw = arm.matrix_world.copy()
    ref = {b.name: (world_rot(mw @ b.matrix_local), mw @ b.head_local) for b in arm.data.bones}
    remove_objects(new)
    purge_actions(set())
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    for img in list(bpy.data.images):
        if img.name != "occupant_color" and img.users == 0:
            bpy.data.images.remove(img)
    return ref


def detrend_root(clip_arm):
    """Remove the Biped root's horizontal drift and mean yaw offset; return the drift speed (m/s)."""
    cb = channelbag(clip_arm)
    drift = [0.0, 0.0]
    for fc in cb.fcurves:
        if fc.data_path == "location" and fc.array_index in (0, 1):
            keys = fc.keyframe_points
            f0, v0 = keys[0].co
            f1, v1 = keys[-1].co
            drift[fc.array_index] = v1 - v0
            for k in keys:
                d = v0 + (v1 - v0) * (k.co[0] - f0) / max(f1 - f0, 1e-9)
                k.co[1] -= d
                k.handle_left[1] -= d
                k.handle_right[1] -= d
            fc.update()
        if fc.data_path == "rotation_euler" and fc.array_index == 2:
            keys = fc.keyframe_points
            offset = -math.pi / 2 - sum(k.co[1] for k in keys) / len(keys)
            for k in keys:
                k.co[1] += offset
                k.handle_left[1] += offset
                k.handle_right[1] += offset
            fc.update()
    f0, f1 = clip_arm.animation_data.action.frame_range
    duration = (f1 - f0) / FPS
    return math.hypot(*drift) / duration if duration > 0 else 0.0


class Retarget:
    """Per-bone constants for mapping Biped world rotations onto the scan's skeleton."""

    def __init__(self, arm, ref):
        self.arm = arm
        bones = arm.data.bones
        self.order = [b.name for b in bones]  # parents precede children
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.rest_rot = {b.name: world_rot(b.matrix_local) for b in bones}
        self.rest_head = {b.name: b.head_local.copy() for b in bones}
        self.source = {}
        self.offset = {}
        self.swing_deg = {}
        for short, biped in BONE_MAP.items():
            name = PREFIX + short
            if name not in bones or biped not in ref:
                raise SystemExit("bone map entry missing: %s -> %s" % (name, biped))
            q_align = Quaternion()
            child, biped_child = DIRECTION[short]
            if PREFIX + child in bones and biped_child in ref:
                d_scan = self.rest_head[PREFIX + child] - self.rest_head[name]
                d_biped = ref[biped_child][1] - ref[biped][1]
                if d_scan.length > 1e-3 and d_biped.length > 1e-3:
                    q_align = d_biped.normalized().rotation_difference(d_scan.normalized())
            self.swing_deg[short] = round(math.degrees(q_align.angle), 1)
            # R_scan(t) = R_biped(t) . offset,  offset = R_biped_T^-1 . Q^-1 . R_scan_rest
            self.source[name] = biped
            self.offset[name] = ref[biped][0].inverted() @ q_align.inverted() @ self.rest_rot[name]
        hips_scan = (self.rest_head[PREFIX + "LeftUpLeg"].z + self.rest_head[PREFIX + "RightUpLeg"].z) / 2
        hips_biped = (ref["Bip01 L Thigh"][1].z + ref["Bip01 R Thigh"][1].z) / 2
        self.scale = hips_scan / hips_biped
        self.pelvis_ref = ref["Bip01 Pelvis"][1]
        log("hip-joint height scan %.4f m, Biped %.4f m, motion scale %.4f" % (hips_scan, hips_biped, self.scale))
        log("rest swing per bone (deg):", json.dumps(self.swing_deg, sort_keys=True))

    def pose(self, clip_arm, height_offset):
        """Local pose (rotation quaternions, hips location) of every scan bone at the current frame."""
        mw = clip_arm.matrix_world
        world = {}
        local = {}
        for name in self.order:
            parent = self.parent[name]
            if name in self.source:
                w = world_rot(mw @ clip_arm.pose.bones[self.source[name]].matrix) @ self.offset[name]
            else:
                w = world[parent] @ self.rest_rot[parent].inverted() @ self.rest_rot[name]
            world[name] = w
            if parent is None:
                basis = self.rest_rot[name].inverted() @ w
            else:
                basis = self.rest_rot[name].inverted() @ self.rest_rot[parent] @ world[parent].inverted() @ w
            local[name] = basis.normalized()
        root = self.order[0]
        pelvis = mw @ clip_arm.pose.bones["Bip01 Pelvis"].head
        target = self.rest_head[root] + (pelvis - self.pelvis_ref) * self.scale + Vector((0.0, 0.0, height_offset))
        loc = self.rest_rot[root].inverted() @ (target - self.rest_head[root])
        return local, loc


def key_clip(arm, rt, clip_arm, f0, f1, height_offset, name):
    ad = arm.animation_data_create()
    ad.action = None
    scene = bpy.context.scene
    previous = {}
    root = rt.order[0]
    for frame in range(f0, f1 + 1):
        scene.frame_set(frame)
        local, loc = rt.pose(clip_arm, height_offset)
        for bone, q in local.items():
            if bone in previous:
                q.make_compatible(previous[bone])
            previous[bone] = q
            pb = arm.pose.bones[bone]
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=frame, group=bone)
        pb = arm.pose.bones[root]
        pb.location = loc
        pb.keyframe_insert("location", frame=frame, group=root)
    action = ad.action
    action.name = name
    action.use_fake_user = True
    for fc in channelbag(arm).fcurves:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"
    return action


def lowest_per_frame(arm, mesh, action, f0, f1):
    ad = arm.animation_data
    ad.action = action
    scene = bpy.context.scene
    lows, pelvis_reach = [], 0.0
    for frame in range(f0, f1 + 1):
        scene.frame_set(frame)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        me = ev.to_mesh()
        co = np.empty(len(me.vertices) * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        ev.to_mesh_clear()
        lows.append(float(co[2::3].min()))
        hips = arm.matrix_world @ arm.pose.bones[PREFIX + "Hips"].head
        pelvis_reach = max(pelvis_reach, math.hypot(hips.x, hips.y))
    ad.action = None
    return lows, pelvis_reach


def stash(arm, action, f0):
    ad = arm.animation_data
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = action.name
    strip = track.strips.new(action.name, f0, action)
    strip.name = action.name
    track.mute = True
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)


def bake_clip(arm, mesh, rt, name, path):
    new = import_fbx(path)
    clip_arm = next(o for o in new if o.type == "ARMATURE")
    remove_objects([o for o in new if o is not clip_arm])
    pivot = bpy.data.objects.new("clip-pivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    pivot.rotation_euler = (0.0, 0.0, math.pi / 2)  # same frame as the interim recipe: faces +X
    clip_arm.parent = pivot
    speed = detrend_root(clip_arm)
    f0, f1 = (int(round(v)) for v in clip_arm.animation_data.action.frame_range)
    source_action = clip_arm.animation_data.action

    # Pass 1 measures the lowest deformed vertex; pass 2 re-keys with a constant height offset that
    # puts the median per-frame lowest point on the floor.
    action = key_clip(arm, rt, clip_arm, f0, f1, 0.0, name + "-probe")
    lows, _ = lowest_per_frame(arm, mesh, action, f0, f1)
    bpy.data.actions.remove(action)
    offset = -float(np.median(lows))
    action = key_clip(arm, rt, clip_arm, f0, f1, offset, name)
    lows, reach = lowest_per_frame(arm, mesh, action, f0, f1)
    log("clip %s: frames %d-%d, height offset %+.4f m, lowest vertex %.4f..%.4f m, hips reach %.4f m, source speed %.3f m/s"
        % (name, f0, f1, offset, min(lows), max(lows), reach, speed))
    stash(arm, action, f0)
    remove_objects([clip_arm, pivot])
    bpy.data.actions.remove(source_action)
    stats = {"heightOffsetM": round(offset, 4), "minFootZ": round(min(lows), 4), "maxFootZ": round(max(lows), 4),
             "pelvisHorizontalMaxM": round(reach, 4)}
    return action, f0, f1, speed, stats


# ---------------------------------------------------------------- export


def glb_stats(path):
    data = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise RuntimeError("not a GLB: " + path)
    length, _ = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20:20 + length])
    tris = 0
    for mesh in doc.get("meshes", []):
        for prim in mesh["primitives"]:
            acc = prim.get("indices", prim["attributes"]["POSITION"])
            tris += doc["accessors"][acc]["count"] // 3
            if prim.get("targets"):
                raise RuntimeError("morph targets must not be exported")
    anims = []
    for a in doc.get("animations", []):
        end = max(doc["accessors"][s["input"]]["max"][0] for s in a["samplers"])
        anims.append({"name": a["name"], "durationS": round(end, 4), "channels": len(a["channels"])})
    images = [{"mimeType": im.get("mimeType"), "bytes": doc["bufferViews"][im["bufferView"]]["byteLength"]} for im in doc.get("images", [])]
    mats = [{"name": m["name"], "alphaMode": m.get("alphaMode", "OPAQUE"), "doubleSided": m.get("doubleSided", False)} for m in doc.get("materials", [])]
    joints = len(doc["skins"][0]["joints"]) if doc.get("skins") else 0
    if "KHR_draco_mesh_compression" in doc.get("extensionsUsed", []):
        raise RuntimeError("Draco compression must not be used")
    return {"bytes": len(data), "triangles": tris, "joints": joints, "animations": anims, "images": images, "materials": mats,
            "extensionsUsed": doc.get("extensionsUsed", [])}


def export_glb(arm, mesh, path):
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=path, check_existing=False, export_format="GLB", use_selection=True, export_yup=True,
        export_extras=False, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_image_format="AUTO", export_vertex_color="NONE", export_attributes=False,
        export_cameras=False, export_lights=False, export_skins=True, export_influence_nb=4, export_all_influences=False,
        export_def_bones=False, export_leaf_bone=False, export_morph=False, export_animations=True,
        export_animation_mode="ACTIONS", export_nla_strips=True, export_force_sampling=True, export_frame_step=1,
        export_anim_slide_to_zero=True, export_optimize_animation_size=True, export_anim_single_armature=True,
        export_reset_pose_bones=True, export_rest_position_armature=True, export_bake_animation=False,
        export_draco_mesh_compression_enable=False, export_apply=False, export_gpu_instances=False,
        export_copyright=COPYRIGHT)


def main():
    opts = parse_args()
    workdir = tempfile.mkdtemp(prefix="scan-occupant-")
    try:
        build(opts, workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def build(opts, workdir):
    scan_manifest, extracted, scan_records = load_scan_sources(workdir)
    rb_manifest, by_role = load_rocketbox_sources()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0

    arm, mesh, inspection = prepare_scan(extracted["source/MikeAlger.fbx"])
    texture = build_material(mesh, extracted["textures/MikeAlger_Texture.jpeg"], workdir)
    rest = np.empty(len(mesh.data.vertices) * 3, dtype=np.float64)
    mesh.data.vertices.foreach_get("co", rest)
    rest_low, rest_high = float(rest[2::3].min()), float(rest[2::3].max())
    triangles = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    log("merged mesh: %d triangles, %d vertices, rest height %.4f m" % (triangles, len(mesh.data.vertices), rest_high - rest_low))
    if not MIN_TRIANGLES <= triangles <= MAX_TRIANGLES:
        raise SystemExit("triangle budget (30k-60k) not met: %d" % triangles)

    rt = Retarget(arm, biped_reference(by_role["avatar"]["abspath"]))
    clips = []
    for name in CLIPS:
        src = by_role["clip." + name]
        action, f0, f1, speed, stats = bake_clip(arm, mesh, rt, name, src["abspath"])
        clips.append({"name": name, "source": os.path.basename(src["path"]).replace(".max.fbx", ""), "frames": f1 - f0 + 1,
                      "fps": FPS, "durationS": round((f1 - f0) / FPS, 4), "loop": True,
                      "nativeSpeedMps": round(speed * rt.scale, 3) if name in LOCOMOTION else 0.0,
                      "sourceSpeedMps": round(speed, 3) if name in LOCOMOTION else 0.0, **stats})
    purge_actions(set(CLIPS))
    scene.frame_set(0)
    for c in clips:
        if abs(c["minFootZ"]) > 0.05 or c["pelvisHorizontalMaxM"] > 0.12:
            raise SystemExit("clip %s is not grounded/in place: %s" % (c["name"], c))

    os.makedirs(opts["out"], exist_ok=True)
    glb_path = os.path.join(opts["out"], "occupant.glb")
    export_glb(arm, mesh, glb_path)
    stats = glb_stats(glb_path)
    if sorted(a["name"] for a in stats["animations"]) != sorted(CLIPS):
        raise SystemExit("unexpected animation set " + str(stats["animations"]))
    if stats["bytes"] > MAX_BYTES:
        raise SystemExit("occupant.glb is %d bytes (> 8 MB)" % stats["bytes"])

    cc_text = open(extracted["license.txt"], encoding="utf-8").read().strip()
    mit_text = open(by_role["licence"]["abspath"], encoding="utf-8").read().strip()
    rb_url = rb_manifest["repository"] + "/blob/" + rb_manifest["commit"] + "/"
    provenance = {
        "schema": "flyfirefighter.actor-provenance/1",
        "id": "actor.occupant_a.scan_alger",
        "status": "licensed",
        "label": LABEL,
        "isScan": True,
        "kind": "rigged photogrammetry scan of a real adult (doob booth scan, High Fidelity rig); depicts a fictional occupant",
        "fictionalPerson": "The simulated occupant is fictional. It is not named after, and implies no endorsement by, the scan's subject.",
        "export": {
            "path": "public/actors/occupant.glb", "sha256": sha256(glb_path), "bytes": stats["bytes"],
            "triangles": stats["triangles"], "vertices": len(mesh.data.vertices), "joints": stats["joints"],
            "materials": stats["materials"], "extensionsUsed": stats["extensionsUsed"], "morphTargets": 0,
            "textures": [texture], "glbImages": stats["images"], "animations": clips,
            "restHeightM": round(rest_high - rest_low, 4), "restMinZ": round(rest_low, 4),
        },
        "frames": {"up": "+Y (glTF)", "forward": "+X (glTF/render)", "units": "metres", "origin": "feet point (ground contact)",
                   "yaw": "three.js rotation psi about +Y faces world (cos psi, sin psi), matching RenderSnapshot.yawRad"},
        "sourceInspection": inspection,
        "retargeting": {
            "method": "World-space rotation transfer relative to the Biped T-pose (Rocketbox Male_Adult_01 bind pose, used as a reference skeleton only) with a per-bone rest-direction swing; hips follow the pelvis displacement scaled by the hip-joint height ratio; constant per-clip height offset to the floor.",
            "motionScale": round(rt.scale, 4),
            "restSwingDeg": rt.swing_deg,
            "boneMap": {PREFIX + k: v for k, v in sorted(BONE_MAP.items())},
            "unmapped": sorted(b for b in rt.order if b not in rt.source),
        },
        "sources": scan_records + [
            {"role": e["role"], "path": "assets/cache/characters/rocketbox/" + e["path"], "url": rb_url + e["repoPath"],
             "sha256": e["sha256"], "bytes": by_role[e["role"]]["bytes"],
             **({"use": "Biped T-pose reference skeleton only; no mesh or texture exported"} if e["role"] == "avatar" else {})}
            for e in rb_manifest["files"] if e["role"] in by_role
        ],
        "licences": [
            {"covers": "character (mesh, skin, texture)", "spdx": "CC-BY-4.0", "url": scan_manifest["model"]["licence"]["url"],
             "licensor": "Mike Alger", "source": scan_manifest["model"]["url"], "text": cc_text},
            {"covers": "animations", "spdx": "MIT", "copyright": "Copyright (c) 2020 Microsoft", "verifiedFrom": rb_url + "LICENSE.md",
             "repository": rb_manifest["repository"], "commit": rb_manifest["commit"], "text": mit_text,
             "note": "Rocketbox README: \"12/2020: Updated license to MIT.\" The paper's earlier research-only wording is superseded."},
        ],
        "attribution": {"character": CHARACTER_ATTRIBUTION, "sketchfabCredit": SKETCHFAB_CREDIT, "animations": ANIMATION_ATTRIBUTION},
        "modifications": [
            "Imported source/MikeAlger.fbx (FBX 7500, centimetres, Y up) in Blender; converted to metres, Z up; rotated +90 deg about Z so the character faces +X; feet point moved to the origin.",
            "Removed the 50 material-less, UV-less blendshape target meshes (children of Poses__Body; the reported untextured duplicate face) and seven empty objects (Poses__Body and six Subdivision_Surface placeholders).",
            "Removed the 50 facial shape keys from the exported mesh (kept in the source); no morph targets exported.",
            "Merged the seven meshes (Body, Sweatshirt, Shirt, Pants, Shoes, Hair, Bracelet) into one skinned mesh; no retopology or decimation (54,683 triangles kept).",
            "Limited skin weights to 4 influences per vertex and renormalised; skeleton and remaining weights are the source's.",
            "Rebuilt the seven materials as one glTF PBR material using the source 2048 px colour JPEG unchanged; constant roughness 0.8; no normal map.",
            "Retargeted five Microsoft Rocketbox clips onto the scan's skeleton (bone map Biped -> mixamorig_*), baked at 30 fps; Biped facial bones dropped; scan eye, head-top, finger-tip and toe-end bones left at rest.",
            "Removed root motion: the Biped root's linear horizontal drift is subtracted (in-place locomotion) and its mean yaw offset removed; vertical motion kept and scaled.",
            "Renamed actions to idle (m_idle_breathe_01), crouch (m_crouch_idle), cough (m_idle_cough_01), walk (m_walk_neutral_01), follow (m_walk_slow_01).",
        ],
        "tool": {"blender": bpy.app.version_string, "recipe": "assets/actors/build_scan_occupant.py",
                 "recipeSha256": sha256(os.path.abspath(__file__)),
                 "scanSourcesManifestSha256": sha256(os.path.join(HERE, "scan_sources.json")),
                 "rocketboxSourcesManifestSha256": sha256(os.path.join(HERE, "occupant_sources.json"))},
    }
    with open(os.path.join(opts["out"], "occupant.provenance.json"), "w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2, sort_keys=False, ensure_ascii=False)
        f.write("\n")
    if opts["blend"]:
        bpy.ops.wm.save_as_mainfile(filepath=opts["blend"])
    print("OCCUPANT", json.dumps({"bytes": stats["bytes"], "triangles": stats["triangles"], "joints": stats["joints"],
                                  "animations": stats["animations"], "images": stats["images"], "materials": stats["materials"],
                                  "clips": clips, "rest": [round(rest_low, 4), round(rest_high, 4)]}))


main()
