"""Build the FALLBACK FlyFireFighter occupant (deterministic, headless Blender 5.1).

    "/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
        -P assets/actors/build_occupant.py -- [--cache assets/cache/characters/rocketbox] \
        [--out assets/cache/characters/rocketbox/build] [--blend /tmp/occupant.blend]

The shipped occupant is the licensed scan, built by build_scan_occupant.py. This recipe is kept
reproducible as a fallback and writes to the git-ignored cache by default; pass --out public/actors
only to deliberately replace the scan (and then change the runtime label and notices to match).

Fallback character: Microsoft Rocketbox "Male_Adult_01" (MIT; artist-made, NOT a scan) with
Rocketbox clips on the same 3ds Max Biped skeleton. Inputs are pinned in occupant_sources.json and
verified by SHA-256 (fetch them with fetch_rocketbox.py). Writes:

    occupant.glb              skinned mesh + actions idle, crouch, cough, walk, follow
    occupant.provenance.json  sources, licence, hashes, modifications, attribution

Frames: glTF Y up, metres, origin at the FEET point (ground contact between the feet), the
character faces glTF/render +X, so a three.js yaw psi about +Y faces world (cos psi, sin psi).
Locomotion is in place: the Biped root's horizontal drift is removed (the simulator drives
position); vertical bob and body rotation are kept.
"""

import hashlib
import json
import math
import os
import struct
import sys
import tempfile

import bpy
from bpy_extras import anim_utils
from mathutils import Vector

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FPS = 30
CLIPS = ("idle", "crouch", "cough", "walk", "follow")
LOCOMOTION = ("walk", "follow")
MAX_TRIANGLES = 60000
MAX_BYTES = 5 * 1024 * 1024
# Texture sizes (all <= 2K; the scene plan's limit). Normal and hair maps are halved to fit the
# 5 MB target; the drone camera is 320 x 180, so 1K normals are not visible there.
TEXTURES = {
    "body_color": ("texture.body.color", 2048, "JPEG", "sRGB", 88),
    "head_color": ("texture.head.color", 2048, "JPEG", "sRGB", 88),
    "body_normal": ("texture.body.normal", 1024, "JPEG", "Non-Color", 92),
    "head_normal": ("texture.head.normal", 1024, "JPEG", "Non-Color", 92),
    "hair_color": ("texture.hair.color_alpha", 1024, "PNG", "sRGB", 100),
}
LABEL = "Fallback character: Microsoft Rocketbox avatar (MIT, artist-made, not a scan)"
ATTRIBUTION = (
    "Occupant character and animations from the Microsoft Rocketbox Avatar Library "
    "(https://github.com/microsoft/Microsoft-Rocketbox), Copyright (c) 2020 Microsoft, MIT License. "
    "Avatar Male_Adult_01 (artist-made, not a scan) with clips m_idle_breathe_01, m_crouch_idle, "
    "m_idle_cough_01, m_walk_neutral_01 and m_walk_slow_01; retargeted, trimmed and modified for "
    "FlyFireFighter. Citation: Gonzalez-Franco et al., \"The Rocketbox library and the utility of freely "
    "available rigged avatars\", Frontiers in Virtual Reality (2020), doi:10.3389/frvir.2020.561558."
)
COPYRIGHT = "Microsoft Rocketbox Avatar Library, Copyright (c) 2020 Microsoft, MIT License; modified for FlyFireFighter (see occupant.provenance.json)"
BODY_ROOTS = {"Bip01 Pelvis", "Bip01 Spine", "Bip01 Spine1", "Bip01 Spine2", "Bip01 Neck", "Bip01 Head"}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"cache": os.path.join(ROOT, "assets", "cache", "characters", "rocketbox"), "out": os.path.join(ROOT, "assets", "cache", "characters", "rocketbox", "build"), "blend": None}
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


def load_sources(cache):
    with open(os.path.join(HERE, "occupant_sources.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    by_role = {}
    for entry in manifest["files"]:
        path = os.path.join(cache, entry["path"])
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


def channelbag(obj):
    ad = obj.animation_data
    return anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)


def remove_objects(objects):
    for o in objects:
        bpy.data.objects.remove(o, do_unlink=True)


def purge_actions(keep):
    for action in list(bpy.data.actions):
        if action.name not in keep:
            bpy.data.actions.remove(action)


# ---------------------------------------------------------------- avatar


def prepare_avatar(path):
    new = import_fbx(path)
    arm = next(o for o in new if o.type == "ARMATURE")
    mesh = next(o for o in new if o.type == "MESH")
    remove_objects([o for o in new if o not in (arm, mesh)])
    arm.animation_data_clear()
    mesh.animation_data_clear()
    purge_actions(set())
    # The Biped faces -Y with the imported object yaw of -90 deg; yaw 0 faces +X (glTF/render +X).
    arm.rotation_euler = (0.0, 0.0, 0.0)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    arm.name = arm.data.name = "occupant-rig"
    mesh.name = mesh.data.name = "occupant-body"
    # glTF/three.js skin with four influences per vertex: limit and renormalise explicitly.
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    return arm, mesh


def convert_textures(by_role, workdir):
    out = {}
    for key, (role, size, fmt, colorspace, quality) in TEXTURES.items():
        src = bpy.data.images.load(by_role[role]["abspath"])
        src.colorspace_settings.name = colorspace
        width, height = src.size
        if width > size or height > size:
            src.scale(size, size)
        src.file_format = fmt
        dst = os.path.join(workdir, "occupant_" + key + (".jpg" if fmt == "JPEG" else ".png"))
        src.save(filepath=dst, quality=quality)
        bpy.data.images.remove(src)
        image = bpy.data.images.load(dst)
        image.name = "occupant_" + key
        image.colorspace_settings.name = colorspace
        out[key] = {"image": image, "size": [size, size], "format": fmt, "source": role, "sourceSize": [width, height]}
    return out


def build_material(name, color, normal, roughness, hair=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = color
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    if normal is not None:
        ntex = nodes.new("ShaderNodeTexImage")
        ntex.image = normal
        nmap = nodes.new("ShaderNodeNormalMap")
        links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if hair:
        # Alpha-tested hair cards (glTF alphaMode MASK, cutoff 0.5): a Math "Round" on alpha is
        # how Blender's glTF exporter expresses alpha clipping. Deterministic, no sorting.
        rnd = nodes.new("ShaderNodeMath")
        rnd.operation = "ROUND"
        links.new(tex.outputs["Alpha"], rnd.inputs[0])
        links.new(rnd.outputs["Value"], bsdf.inputs["Alpha"])
        mat.use_backface_culling = False
    else:
        mat.use_backface_culling = True
    return mat


def assign_materials(mesh, tex):
    mats = {
        "m002_body": build_material("occupant-body", tex["body_color"]["image"], tex["body_normal"]["image"], 0.75),
        "m002_head": build_material("occupant-head", tex["head_color"]["image"], tex["head_normal"]["image"], 0.6),
        "m002_opacity": build_material("occupant-hair", tex["hair_color"]["image"], None, 0.8, hair=True),
    }
    for slot in mesh.material_slots:
        old = slot.material
        slot.material = mats[old.name]
    for m in list(bpy.data.materials):
        if m.name not in {"occupant-body", "occupant-head", "occupant-hair"}:
            bpy.data.materials.remove(m)
    for img in list(bpy.data.images):
        if not img.name.startswith("occupant_"):
            bpy.data.images.remove(img)


# ---------------------------------------------------------------- clips


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
    # FBX location is in the parent's units: the armature object is unscaled at the scene level (m).
    return math.hypot(*drift) / duration if duration > 0 else 0.0


def is_body_bone(name):
    return name in BODY_ROOTS or name.startswith("Bip01 L ") or name.startswith("Bip01 R ")


def bake_clip(avatar, name, path):
    new = import_fbx(path)
    clip_arm = next(o for o in new if o.type == "ARMATURE")
    remove_objects([o for o in new if o is not clip_arm])
    pivot = bpy.data.objects.new("clip-pivot", None)
    bpy.context.scene.collection.objects.link(pivot)
    pivot.rotation_euler = (0.0, 0.0, math.pi / 2)  # same +90 deg yaw as the avatar: face +X
    clip_arm.parent = pivot
    speed = detrend_root(clip_arm)
    f0, f1 = (int(round(v)) for v in clip_arm.animation_data.action.frame_range)

    # World-space retarget: body bones copy the clip bone's world rotation; the pelvis also copies
    # its world location. Facial bones stay at the avatar's rest relative to the head. Bone lengths
    # are the avatar's own, so the mesh never stretches.
    for pb in avatar.pose.bones:
        if not is_body_bone(pb.name) or pb.name not in clip_arm.pose.bones:
            continue
        rot = pb.constraints.new("COPY_ROTATION")
        rot.target, rot.subtarget = clip_arm, pb.name
        rot.owner_space = rot.target_space = "WORLD"
        if pb.name == "Bip01 Pelvis":
            loc = pb.constraints.new("COPY_LOCATION")
            loc.target, loc.subtarget = clip_arm, pb.name
            loc.owner_space = loc.target_space = "WORLD"

    bpy.ops.object.select_all(action="DESELECT")
    avatar.select_set(True)
    bpy.context.view_layer.objects.active = avatar
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.nla.bake(frame_start=f0, frame_end=f1, step=1, only_selected=False, visual_keying=True,
                     clear_constraints=True, clear_parents=False, use_current_action=False,
                     clean_curves=False, bake_types={"POSE"}, channel_types={"LOCATION", "ROTATION", "SCALE"})
    bpy.ops.object.mode_set(mode="OBJECT")
    action = avatar.animation_data.action
    action.name = name
    action.use_fake_user = True

    remove_objects([clip_arm, pivot])
    return action, f0, f1, speed


def stash(avatar, action, f0):
    ad = avatar.animation_data
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = action.name
    strip = track.strips.new(action.name, f0, action)
    strip.name = action.name
    track.mute = True
    for pb in avatar.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)


def measure_clip(avatar, mesh, action, f0, f1):
    """Lowest deformed vertex and pelvis horizontal excursion over the clip (validation)."""
    ad = avatar.animation_data
    ad.action = action
    scene = bpy.context.scene
    lows, reach = [], 0.0
    for frame in range(f0, f1 + 1, max(1, (f1 - f0) // 12)):
        scene.frame_set(frame)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        me = ev.to_mesh()
        lows.append(min((ev.matrix_world @ v.co).z for v in me.vertices))
        ev.to_mesh_clear()
        pel = avatar.matrix_world @ avatar.pose.bones["Bip01 Pelvis"].head
        reach = max(reach, math.hypot(pel.x, pel.y))
    ad.action = None
    scene.frame_set(0)
    return {"minFootZ": round(min(lows), 4), "maxFootZ": round(max(lows), 4), "pelvisHorizontalMaxM": round(reach, 4)}


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
    manifest, by_role = load_sources(opts["cache"])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0

    arm, mesh = prepare_avatar(by_role["avatar"]["abspath"])
    workdir = tempfile.mkdtemp(prefix="occupant-tex-")
    tex = convert_textures(by_role, workdir)
    assign_materials(mesh, tex)

    rest_low = min((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
    rest_high = max((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)

    clips = []
    for name in CLIPS:
        src = by_role["clip." + name]
        action, f0, f1, speed = bake_clip(arm, name, src["abspath"])
        stats = measure_clip(arm, mesh, action, f0, f1)
        stash(arm, action, f0)
        clips.append({"name": name, "source": os.path.basename(src["path"]).replace(".max.fbx", ""), "frames": f1 - f0 + 1,
                      "fps": FPS, "durationS": round((f1 - f0) / FPS, 4), "loop": True,
                      "nativeSpeedMps": round(speed, 3) if name in LOCOMOTION else 0.0, **stats})
    purge_actions(set(CLIPS))
    scene.frame_set(0)

    triangles = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    if triangles > MAX_TRIANGLES:
        raise SystemExit("triangle budget exceeded: %d" % triangles)
    for c in clips:
        if abs(c["minFootZ"]) > 0.05 or c["pelvisHorizontalMaxM"] > 0.12:
            raise SystemExit("clip %s is not grounded/in place: %s" % (c["name"], c))

    os.makedirs(opts["out"], exist_ok=True)
    glb_path = os.path.join(opts["out"], "occupant.glb")
    export_glb(arm, mesh, glb_path)
    stats = glb_stats(glb_path)
    names = sorted(a["name"] for a in stats["animations"])
    if names != sorted(CLIPS):
        raise SystemExit("unexpected animation set " + str(names))
    if stats["bytes"] > MAX_BYTES:
        raise SystemExit("occupant.glb is %d bytes (> 5 MB)" % stats["bytes"])

    licence_text = open(by_role["licence"]["abspath"], encoding="utf-8").read().strip()
    base_url = manifest["repository"] + "/blob/" + manifest["commit"] + "/"
    provenance = {
        "schema": "flyfirefighter.actor-provenance/1",
        "id": "actor.occupant.rocketbox_male_adult_01",
        "status": "fallback",
        "label": LABEL,
        "isScan": False,
        "kind": "artist-made (sculpted) rigged avatar; not a scan",
        "export": {
            "path": "public/actors/occupant.glb", "sha256": sha256(glb_path), "bytes": stats["bytes"],
            "triangles": stats["triangles"], "vertices": len(mesh.data.vertices), "joints": stats["joints"],
            "materials": stats["materials"], "extensionsUsed": stats["extensionsUsed"],
            "textures": [{"name": "occupant_" + k, "size": v["size"], "format": v["format"], "source": v["source"], "sourceSize": list(v["sourceSize"])} for k, v in tex.items()],
            "glbImages": stats["images"],
            "animations": clips,
            "restHeightM": round(rest_high - rest_low, 4), "restMinZ": round(rest_low, 4),
        },
        "frames": {"up": "+Y (glTF)", "forward": "+X (glTF/render)", "units": "metres", "origin": "feet point (ground contact)",
                   "yaw": "three.js rotation psi about +Y faces world (cos psi, sin psi), matching RenderSnapshot.yawRad"},
        "sources": [{"role": e["role"], "path": "assets/cache/characters/rocketbox/" + e["path"], "url": base_url + e["repoPath"],
                     "sha256": e["sha256"], "bytes": by_role[e["role"]]["bytes"]} for e in manifest["files"] if e["role"] != "readme"],
        "repository": manifest["repository"], "commit": manifest["commit"],
        "licence": {"spdx": "MIT", "copyright": "Copyright (c) 2020 Microsoft", "verifiedFrom": base_url + "LICENSE.md", "text": licence_text,
                    "note": "Rocketbox README: \"12/2020: Updated license to MIT.\" The paper's earlier research-only wording is superseded."},
        "attribution": ATTRIBUTION,
        "modifications": [
            "Imported FBX (3ds Max Biped) in Blender; rotated +90 deg about Z so the character faces +X; applied scale (cm to m) and transforms; feet at the origin.",
            "Limited skin weights to 4 influences per vertex and renormalised.",
            "Rebuilt materials as glTF PBR: base colour + normal map; specular maps dropped; constant roughness; hair cards alpha-tested (MASK 0.5), double-sided.",
            "Re-encoded textures: colour maps 2048 JPEG, normal and hair maps downscaled to 1024 (JPEG / RGBA PNG).",
            "Retargeted each clip by world-space bone rotations (pelvis also location) onto the avatar's own skeleton; facial bones left at rest.",
            "Removed root motion: the Biped root's linear horizontal drift over each clip is subtracted (in-place locomotion); mean yaw offset removed; vertical motion kept.",
            "Renamed actions to idle (m_idle_breathe_01), crouch (m_crouch_idle), cough (m_idle_cough_01), walk (m_walk_neutral_01), follow (m_walk_slow_01).",
        ],
        "tool": {"blender": bpy.app.version_string, "recipe": "assets/actors/build_occupant.py", "recipeSha256": sha256(os.path.abspath(__file__)),
                 "sourcesManifestSha256": sha256(os.path.join(HERE, "occupant_sources.json"))},
    }
    with open(os.path.join(opts["out"], "occupant.provenance.json"), "w", encoding="utf-8") as f:
        json.dump(provenance, f, indent=2, sort_keys=False)
        f.write("\n")
    if opts["blend"]:
        bpy.ops.wm.save_as_mainfile(filepath=opts["blend"])
    print("OCCUPANT", json.dumps({"bytes": stats["bytes"], "triangles": stats["triangles"], "joints": stats["joints"],
                                  "animations": stats["animations"], "images": stats["images"], "materials": stats["materials"],
                                  "clips": clips, "rest": [round(rest_low, 4), round(rest_high, 4)]}))


main()
