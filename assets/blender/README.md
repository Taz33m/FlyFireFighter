# Troy training scene recipe (Blender)

**Troy training scene — real exterior reference, authored interior and fictional incident.**

This folder is a deterministic, headless Blender 5.1 recipe that builds and exports `public/scenes/troy-training/`. The exterior is **approximate massing** of a real reference, Heffner Alumni House at 1301 Peoples Avenue in Troy, NY (RPI). It is derived from the OpenStreetMap footprint and estimated from openly licensed photographs; it is **not a scan**. The two-level interior, its furniture, the drone and the incident anchors are authored fiction. The interior is not the reference building's floor plan.

## Run

```sh
# Build and export (about 1 s; no network access).
"/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
  -P assets/blender/build_troy_scene.py -- --out public/scenes/troy-training

# Verify the exported files and render small Workbench previews (1280x720).
"/Applications/Blender 5.1.app/Contents/MacOS/Blender" -b --factory-startup \
  -P assets/blender/verify_scene.py -- --scene public/scenes/troy-training --previews /tmp/troy-previews

# Optional: rebuild the pinned OSM extract (two OSM API requests, or from saved responses).
python3 assets/blender/fetch_osm_extract.py --retrieved 2026-11-07
```

`build_troy_scene.py` also accepts `--blend file.blend` to save the generated Blender scene for inspection. The same inputs produce byte-identical GLB and JSON files. Verified by building twice into different directories.

| Output | Content | Current size |
| --- | --- | --- |
| `scene.glb` | Appearance only: `ENV_EXTERIOR`, `ENV_INTERIOR`, `DRONE`. Flat PBR colours, no textures, no Draco. | 0.94 MB, about 15.3k triangles |
| `colliders.glb` | Debug view of the simulation layer: collider boxes, room volumes, opening portals, stair, shell footprint, assembly/launch/exit targets. | 0.35 MB, about 3.5k triangles |
| `scene.meta.json` | Schema `flyfirefighter.scene-meta/1` in simulation-world coordinates, with hashes, byte sizes and triangle counts of both GLBs. | about 80 KB |

`scene.meta.json` is the authority for simulation geometry. Collider boxes are independent of visual tessellation, and the verifier checks that they coincide with the visual surfaces.

## Files

| File | Role |
| --- | --- |
| `build_troy_scene.py` | Blender entry point. Builds collections and materials, then exports the GLBs and metadata. |
| `troy_geom.py` | Pure-Python geodesy, footprint snapping and rectangle decomposition, plus the mesh builder and scene container. No `bpy`. |
| `troy_site.py` | Site grid from the OSM extract, streets, sidewalks, curbs, lawns, plaza, footway, trees and street furniture. |
| `troy_building.py` | Wings and massing, the authored house shell with real openings, facade details and opening visuals and colliders. |
| `troy_interior.py` | Rooms, partitions, slabs, stair, furniture, interior openings and targets/anchors. |
| `troy_drone.py` | Modular quad placeholder with the named `drone-camera-mount` empty. |
| `verify_scene.py` | Independent checks on the exported files, plus preview renders. |
| `fetch_osm_extract.py`, `troy_osm_extract.json` | How the OSM input was obtained, and the pinned extract (ODbL). |

The `ACTORS` collection exists and is intentionally empty. The rigged scanned adult is pending license verification.

## Frames and conventions

- **World:** metres, right-handed, Z up. The origin is the area centroid of the rectilinearised OSM footprint (lat 42.7328844, lon -73.6781612). z = 0 is ground level, at the front-door threshold.
- **Site grid (important):** the building's walls and Peoples Avenue run 11.10° clockwise of true east. So that collider boxes can stay axis-aligned and still fit the walls, the world axes form a site grid: +X runs along Peoples Avenue toward 14th Street (true bearing 101.10°), and +Y points toward Peoples Avenue (bearing 11.10°). `origin.description` gives the exact conversion to geodetic east/north. "X east, Y north" in `frames.world` therefore means site east/north.
- **glTF:** Y up, so glTF (x, y, z) = world (x, z, -y). Blender's exporter applies this; metadata never uses glTF axes.
- **Drone body frame:** X forward, Y left, Z up. The camera mount is at `positionBody` (0.135, 0, 0.01), level (`pitchRad` 0), with 90° horizontal FOV. Rotor guards fit within the 0.55 m span; the envelope is 0.2 m tall.
- **Rooms** are interior free space (wall inner faces), counter-clockwise. The partition or wall thickness inside a doorway lies outside every room, and openings define the passable portals.
- **Openings:** `center` is on the wall mid-plane, and `outwardNormal` points from `rooms[0]` toward `rooms[1]`. `sillHeightM` is measured above the floor of `rooms[0]`.
- **Stair:** each room sits within one floor, matching `src/lib/simulation/scene-validate.ts`. The stair shaft belongs to `room-g-entry` below the upper slab (z 0–3.25 m) and to `room-u-hall` above it (z 3.6–6.5 m). `stairs[0]` gives the transition: 20 risers of 0.18 m, 19 treads of 0.28 m, 1.2 m wide. Both stair ends lie strictly inside those rooms. The 0.35 m slab band inside the open stairwell (z 3.25–3.6 m) belongs to no room prism, so consumers that classify "outside all rooms" as wall should treat the stair volume as passable. The stairwell itself is `opening-stairwell`, an unframed horizontal opening (`outwardNormal` +Z, `widthM` along X, `heightM` along Y) through that slab band from `room-g-entry` to `room-u-hall`. It has no collider; it is the gas path that lets the compartment fire model pass smoke and heat between the floors, as the physically open stairwell does.
- **Initial states:** all windows are closed and glazed. `door-front` is closed: the exit door has a leaf collider, so the drone has no open entry and must request the window breach. `door-u-front-bedroom` is closed. All other interior doors are open, and open doors have no leaf geometry.
- **Naming:** every room, opening and collider object is named with its metadata id in `colliders.glb`. In `scene.glb`, each window's breakable pane (plus its muntins) is `<openingId>_glass`, and each closed door's leaf is `<openingId>_leaf`. Furniture is named `furn-<id>`, with colliders `col-furn-<id>`. Trees are `tree-*` or `conifer-*`, with colliders `col-<tree>-trunk|canopy`. Object custom properties are exported as glTF `extras` (`simKind`, `colliderKind`, `openingId`, ...).
- **Scenario anchors** (fire origin, occupant start) exist only in `scene.meta.json` under `scenarioAnchors`. They are left out of both GLBs so they cannot leak into a map prior.

## Referenced, estimated, authored

**Referenced: OpenStreetMap** (© OpenStreetMap contributors, ODbL 1.0, retrieved 2026-11-07; see `troy_osm_extract.json`):

- Footprint: way 73141173 (version 7), snapped with a maximum vertex shift of 0.013 m.
- Main entrance: node 12743734842 (`entrance=main`), used as the front door location.
- Centrelines of Peoples Avenue (way 5626991), 13th Street (5637663) and 14th Street (5638062).
- Sidewalks 946232027, 947753441, 1318242879 and 1318154554; crossings 1362771419 and 1318240544; entrance footway 1376363931.
- J Lot edge (104737328) and fire hydrant node 12541056051.

**Referenced: photographs consulted, not redistributed.** "RPI Alumni House" 01–19 on Wikimedia Commons, by RPI2026F1, taken 2023-03-22, licensed CC BY-SA 4.0 ([category](https://commons.wikimedia.org/wiki/Category:Heffner_Alumni_House)). Files 01, 02, 03, 05, 07, 09, 10, 12, 15, 16 and 18 informed:

- The storey count and wing layout.
- The steep standing-seam gable and chimney, the glazed conservatory and the teal glazed links.
- The north-west tower and south-west pavilion with copper pyramid roofs, and the pyramid skylight.
- The window rhythm and stone trim.
- The glazed entrance and brick-paver plaza.

No photo pixels, textures, Google, Zillow or listing imagery are used.

**Estimated** (listed in `provenance.exterior.estimated`):

- All heights. Two storeys are used, although OSM gives `building:levels=3`.
- Wing boundaries.
- Roof forms and pitches.
- Window and door counts, positions and sizes, and colours.
- Chimneys.
- The front door's size.
- The plaza and canopy.
- Street widths and curbs.
- Flat ground (the real site slopes west and south).
- Tree and furniture placement.

**Authored:** the house region (east part of the footprint) as a fictional training house with:

- Ground floor: entry hall with front door and stair foot, living room, kitchen and dining room.
- Upper floor: hall and landing, rear bedroom (the reported room), front bedroom, bathroom, study.

The authored interior also includes all furniture, the openings inside the house, the drone, and the scenario anchors. The rest of the footprint is a sealed solid volume with decorative windows and is not enterable.

Key ids:

- `win-u-rear-bedroom`: breach target, 1.1 × 1.4 m clear opening on the rear (south) facade.
- `door-front`: exit.
- `door-u-rear-bedroom`: the narrow 0.8 m doorway.
- `assembly-point`: front lawn, 12.9 m from the facade.
- `tree-obstacle`: on the east-lawn approach to the rear.
- `scenarioAnchors.fireOrigin`: upstairs hall, between the rear-bedroom door and the stair top.

## Verification

`verify_scene.py` reads only the exported files and exits non-zero on any failure. The current result is 44 of 44 checks passing:

- **Files:** hashes, sizes and triangle counts match the metadata; budgets met; no Draco.
- **Metadata:** schema keys and provenance labels present; ids unique; collider boxes finite and non-degenerate.
- **Room polygons:** counter-clockwise, simple, each within one floor's elevation and ceiling, and not overlapping in 3D.
- **Scale:** door widths are 0.8–1.0 m (at least one ≤ 0.85 m); the breach window opening exceeds the drone span; ceiling heights are plausible.
- **Openings:** normals point from `rooms[0]` to `rooms[1]`. Glass panes and closed leaves are separate colliders that carry `openingId`.
- **Opening gaps:** each door and window gap is measured in the colliders (probes inside free, probes 5 cm outside blocked). The floor opening over the stair is probed with vertical rays through the slab band (the stair itself excluded). A 0.55 × 0.2 m drone box plus a 5 cm margin sweeps through every opening at least 0.8 m wide, including the breach window.
- **Named objects:** every room, opening and collider id is a named node, and each collider node matches its metadata box after the Y-up round trip.
- **Geometry integrity:** no NaN vertices or zero-area polygons.
- **Collider–visual alignment:** wall collider faces were checked against the visual surfaces by raycast (about 6,200 samples, under 1% misaligned). Room-centric rays found the first visual hit equal to the first collider hit within 0.10 m.
- **Shell:** rooms lie inside the OSM shell and outside the sealed volumes.
- **Reachability:** every room is reachable from `door-front` through doors and the stair, and both stair ends lie strictly inside rooms.
- **Stair:** risers are uniform and the slope is 34°.
- **Anchors and targets:** the assembly point is at least 10 m from the facade and on open ground; the launch point is clear; the fire origin and occupant start are valid.
- **Routes:** a 0.4 m-radius yard path runs from the street around to the breach window, and the obstacle tree blocks the straight line down the east lawn. A clear walking route runs from the front door to the assembly point.

Previews are written for review: exterior street view, rear view with the breach window highlighted, upper- and ground-floor section cutaways, an oblique upper-floor cutaway, a site overview and a drone close-up.

## Known gaps

- **Facade fidelity:** massing-level only. Window counts are approximate. The curved parapet, west bay and oculus, and stone details are simplified or omitted. There are no LODs or baked lighting yet.
- **Unmodelled interior:** only the east wing and link hold an interior. The rest of the shell is sealed and not explorable.
- **Site and trees:** the site is flat, and trees and shrubs are generic low-poly shapes.
- **Orientation:** the site grid is rotated 11.10° from true north (documented in the metadata).
- **Window glass:** the authored house's window glass is semi-transparent (`alphaMode` BLEND), so the camera can see in. Decorative windows on the sealed volume are opaque.
- **Not included:** thermal or material parameters, fire geometry and actors are left to later work.
