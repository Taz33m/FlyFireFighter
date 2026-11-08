# Troy scene and asset plan

November 7, 2026 · [Architecture](../architecture.md)

## First scene

Use **Peoples Avenue near RPI, with Heffner Alumni House as the initial exterior reference**. RPI identifies it at 1301 Peoples Avenue. Record this as the exterior source location, not a reported emergency. The main label is “Troy training scene — real exterior reference, authored interior and fictional incident.” [RPI location](https://doso.rpi.edu/parents-families/family-weekend)

The first mission uses an authored two-level training interior with an upstairs rear room, stairs, a small obstructing fire and an exterior assembly point. This is not a verified floor plan of Heffner or a claim about its occupancy, hazards or suitability for residential rescue. The exterior reference is a recognizable local setting; residential fire behavior remains a simplified simulation. Preserve the exterior/interior distinction in the scene manifest and UI. The 13th Street fatal-fire property and family are excluded.

Model a compact walkable street segment, not the whole city: pavement/grade, curb, sidewalk, building facade and rear, roof/eaves, nearby trees, visible windows and a few pieces of street furniture. Use our own or appropriately licensed photographs for facade detail. An address is not sufficient evidence for dimensions or interior geometry. A photographed facade is a reconstruction reference; call the asset a scan only if capture and reconstruction actually produced one.

OpenStreetMap can supply street alignment and available footprints. Retain map-source attribution and keep the source-data license distinct from mesh/material licenses. No assumption that Zillow, satellite imagery or a listing's floor plan is redistributable. [OSM copyright and licensing](https://www.openstreetmap.org/copyright)

## Blender production

Blender 5.1.2 is available at `/Applications/Blender 5.1.app/Contents/MacOS/Blender`. Use one scene with named collections:

| Collection | Export |
| --- | --- |
| `ENV_EXTERIOR` | Street and building appearance, with LODs. |
| `ENV_INTERIOR` | Authored rooms, materials and furniture; align with the shell in metres. |
| `SIM_COLLIDERS` | Simple collision meshes, independent of visual tessellation. |
| `SIM_ROOMS_OPENINGS` | Stable IDs, room volumes, portals, door/window states and material/thermal parameters. |
| `SIM_TARGETS` | Exit/assembly volumes, intervention targets and scenario-only initialization anchors. |
| `ACTORS` | Rigged scanned adults with reusable animation clips. |
| `DRONE` | Aircraft appearance and calibrated camera/sensor mounts; dynamics come from the capability profile. |

Export `scene.glb`, `colliders.glb` and `scene.meta.json`; keep actor assets reusable. Metadata records coordinate transforms, source/exterior versus authored-interior provenance, hashes, room/opening IDs, material parameters and bounds. Scenario-only initialization never enters the planner's map prior. Check scale, normals, skinning, root motion, animations, collider alignment and door transitions after browser import.

Blender reference renders establish the intended look. The live Three.js camera uses textured geometry, physically based materials, moving light, smoke and dynamic actors. Bake static lighting, not the changing smoke/fire. Give the drone view a believable lens and exposure while preserving a calibrated sensor image. Avoid heavy cinematic blur that is disconnected from the evaluated observation model.

## Scanned, rigged people

The target is a realistic **scanned and rigged adult**, not a capsule standing in for the final character. An anonymous primitive can unblock initial physics; it does not satisfy the visual acceptance criterion.

First candidate: Mike Alger's **Rigged T-Pose Human Male w 50 Face Blendshapes**, described as a Doob scan optimized/rigged by High Fidelity. The indexed model listing advertises Creative Commons attribution. The full download and included license have not been verified, and no character asset has been imported yet. Verify the downloaded license, attribution chain and reusable texture/rig files before bundling it. [Model listing](https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07)

Retarget idle, crouch, cough, walk and follow clips in Blender. Use deterministic root motion driven by simulation, with foot placement/animation following actual movement. Record animation licenses separately. Keep the scanned person's attribution in credits; the fictional occupant has no connection to the Troy incident.

Renderpeople free assets are **not selected**: their general terms restrict computer-vision research and related dataset/model/simulation uses without separate permission. A commercial-render license alone would not cover this workflow. Choose a suitable CC0/CC BY or explicitly licensed alternative instead of making those assets a dependency. [Renderpeople terms, section 4.2](https://renderpeople.com/general-terms-and-conditions/)

## Asset manifest and initial budgets

Each imported asset needs `id`, source URL, creator, source/download date, exact license/license file, SHA-256, modifications, units, rig/animation metadata, redistribution/training permissions and required attribution. Store source and optimized-export hashes separately. Raw scans and bulky source textures stay in an ignored local asset cache; redistribute only files allowed by the asset license.

Initial budgets, to be profiled on the shared 16 GB Mac:

- One visible street block and one detailed interior; roughly 500,000 visible triangles as a starting ceiling.
- One or two active skinned adults, about 30,000–60,000 triangles each after retopology/LOD.
- Mostly 1K/2K textures, with selected higher-resolution source textures baked down for runtime. No unbounded 8K texture import.
- One renderer/context with reused targets. Cap the main display at 1280×720 and drone preview at 640×360 initially; neural/sensor targets have a fixed, separately calibrated size.
- Reuse lighting/shadow resources, cap smoke resolution, dispose assets/targets on reset and release the context on teardown. Avoid `flat` shader varyings on this Mac.

These are initial implementation budgets, not performance measurements. Quality controls may lower presentation cost but must preserve benchmark observation settings. Finish with a headed-browser memory check and an exported replay showing exterior, interior, smoke, rigged movement and the actual controller input together.

## Current assets

| Item | State |
| --- | --- |
| Blender | Installed (5.1.2). A deterministic headless recipe in [assets/blender](../assets/blender/README.md) builds, exports and verifies the scene. |
| Troy reference location | Selected and verified against RPI's published address; OSM way 73141173 carries the same address. |
| Exterior reference massing | Exported. Approximate massing, not a scan: OSM footprint (ODbL) plus heights, wings and roofs estimated from CC BY-SA 4.0 Commons photographs. World axes are a site grid rotated 11.1° from true north. The shell outside the authored house is a sealed volume. |
| Authored interior and simulation layer | Exported to `public/scenes/troy-training/`: `scene.glb` (0.94 MB, about 15k triangles), `colliders.glb` and `scene.meta.json`. Fictional two-level house: 8 rooms, 23 openings and 255 axis-aligned colliders. 44/44 verification checks pass; browser import is not yet tested. |
| Drone placeholder | Modular quad (0.55 m span) with a named camera-mount empty in `scene.glb`; visual only. |
| Rigged scanned adult | Exported to `public/actors/occupant.glb` (3.2 MB; 54,683 triangles, no decimation; 67 joints; one 2048 px colour texture; no morph targets). **"Rigged T-Pose Human Male w 50 Face Blendshapes" by Mike Alger (CC BY 4.0; doob scan, High Fidelity rig)**, depicting a fictional occupant, with five **Microsoft Rocketbox clips (MIT)** `idle`, `crouch`, `cough`, `walk`, `follow` retargeted onto its Mixamo-style skeleton and baked in place. Feet at the origin, facing +X. The untextured blendshape-target meshes are removed; the 50 facial shape keys exist in the source but are not exported. Built deterministically by [assets/actors](../assets/actors/README.md) from hash-pinned archives; credits in its `THIRD_PARTY_NOTICES.md`, hashes and modifications in `occupant.provenance.json`. Rendered in the twin and the drone camera with a placeholder fallback. Not placed in the Blender scene; the scene's `ACTORS` collection is empty. |
| Interim occupant character | Replaced by the scan. The Rocketbox Male_Adult_01 recipe (MIT, artist-made, not a scan) remains reproducible as a fallback and writes only to the git-ignored cache. |
| FlyVis source subset | Copied and hash-verified; see [reuse notes](../vendor/flyvis-reference/README.md). |
| Pretrained weights and trained rescue readout | Not installed/trained in this repository yet. |

Scene acceptance requires a recognizable reference exterior, an explicitly authored interior, licensed rigged actor, correct collider/coordinate alignment and matching smoke/occlusion in the drone input. Visual realism does not establish fire-model or real-flight accuracy.
