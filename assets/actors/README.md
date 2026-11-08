# Occupant character recipe (Blender)

Builds `public/actors/occupant.glb` and `public/actors/occupant.provenance.json` deterministically in headless Blender 5.1. The character is a **licensed scan: "Rigged T-Pose Human Male w 50 Face Blendshapes" by Mike Alger (CC BY 4.0; scanned by doob, rigged by High Fidelity, per the creator)**, animated with **Microsoft Rocketbox clips (MIT)** retargeted onto its own skeleton. The occupant it depicts is fictional. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [character research](../../docs/reference/character-assets.md).

## Run

```sh
# Inputs: the two Sketchfab archives (original FBX; auto-converted glTF with license.txt), downloaded
# manually while signed in, unmodified, in assets/cache/characters/mike-alger/ (git-ignored).
# The Rocketbox clips and reference skeleton (about 100 MB, verified by SHA-256):
python3 -I assets/actors/fetch_rocketbox.py

# Build. Same inputs give a byte-identical GLB and provenance (about 10 s).
"/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
  -P assets/actors/build_scan_occupant.py -- [--out public/actors] [--blend /tmp/occupant.blend]
```

| File | Role |
| --- | --- |
| `scan_sources.json` | Pinned scan inputs: archive and member SHA-256. The build refuses mismatched files and extracts only the FBX, texture and licence into a temporary directory. |
| `occupant_sources.json` | Pinned Rocketbox inputs: repository commit, paths, SHA-256. |
| `fetch_rocketbox.py` | Fetches only the listed Rocketbox files from raw.githubusercontent.com; never clones the 4 GB repository. |
| `build_scan_occupant.py` | Imports and cleans the scan, retargets and bakes the clips, validates and exports. |
| `build_occupant.py` | Fallback: the earlier interim Rocketbox-avatar character. Writes to `assets/cache/characters/rocketbox/build/` by default and is not shipped. |
| `THIRD_PARTY_NOTICES.md` | CC BY 4.0 credit and modification notice for the scan; full MIT notice for the animations. |

## Source findings

- `source/MikeAlger.fbx` (FBX 7500, Cinema 4D export): centimetres, Y up, feet at the floor, facing -Y in Blender. 67-bone Mixamo-style humanoid named `mixamorig_*` (Hips, Spine–Spine2, Neck, Head, eyes, four-segment fingers, ToeBase/Toe_End) in a T-pose.
- Seven skinned meshes, 54,683 triangles in total: `Body` (head, hands, eyes and teeth), `Sweatshirt`, `Pants`, `Shoes`, `Shirt`, `Hair`, `Bracelet`. One 2048 px colour JPEG; no normal or roughness maps.
- The 50 facial blendshapes exist as shape keys on `Body` (for example `Blink_Left`, `BrowsUp_Right`, `Jaw_Down`, `MouthOpen`, `Smile_Left`; the full list is in the provenance). Sketchfab's converted glTF has none. They are not exported.
- The same 50 targets also appear as separate material-less, UV-less meshes under `Poses__Body`; these are the reported untextured face over the face. The build deletes them, with the empty placeholder objects.

## Output contract

- glTF Y up, metres. Origin at the feet point (midway between the ankles, lowest vertex at 0); the character faces glTF/render **+X**, so the runtime applies `RenderSnapshot.yawRad` as a rotation about +Y and places the root at the snapshot position.
- Actions `idle` (m_idle_breathe_01), `crouch` (m_crouch_idle), `cough` (m_idle_cough_01), `walk` (m_walk_neutral_01, 1.043 m/s native) and `follow` (m_walk_slow_01, 0.847 m/s native), all loops at 30 fps. Native speeds are the source clips' root drift scaled to the scan's hip height.
- One skinned mesh, one opaque material `occupant-body`, 67 joints, 4 influences per vertex, no morph targets, no Draco. Checks: 30k–60k triangles, textures ≤ 2K, ≤ 8 MB; every clip's per-frame lowest vertex within 5 cm of the floor and hips within 12 cm horizontally.

## Retargeting

Each mapped scan bone gets the Biped bone's world rotation relative to the Biped T-pose, applied to the scan bone's own rest, after a per-bone swing that aligns the two rest directions. The Biped T-pose comes from the Rocketbox avatar's bind pose (the clip files' rest pose is just their first frame). Local rotations follow from the parent's world rotation, so the scan keeps its own bone lengths. The hips follow the Biped pelvis's displacement from its T-pose scaled by the hip-joint height ratio (1.031), and a constant per-clip height offset puts the median per-frame lowest vertex on the floor. Biped facial bones are dropped; the scan's eye, head-top, finger-tip and toe-end bones stay at rest.
