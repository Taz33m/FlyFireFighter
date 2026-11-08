# Third-party notices: occupant character

These notices cover `public/actors/occupant.glb` and its recipe inputs. Machine-readable provenance (source URLs, SHA-256 hashes, licence texts, modifications) is in `public/actors/occupant.provenance.json`. The simulated occupant is a **fictional person**; the character is not named after the scan's subject, and nothing here implies that he, doob, High Fidelity or Microsoft endorses FlyFireFighter.

## Character: scanned adult (CC BY 4.0)

Credit line, as supplied in the download's `license.txt`:

> This work is based on "Rigged T-Pose Human Male w 50 Face Blendshapes" (https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) by Mike Alger (https://sketchfab.com/mikealger) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)

Occupant character based on "Rigged T-Pose Human Male w 50 Face Blendshapes" by Mike Alger, licensed under Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/). Scanned by doob and optimized and rigged by High Fidelity, per the creator. The creator does not endorse this project. The fictional occupant has no connection to him or to any real incident.

**Modified** for FlyFireFighter: no retopology or decimation (54,683 triangles kept); the 50 material-less blendshape target meshes (the untextured duplicate face) and the 50 facial shape keys removed from the export; seven meshes merged into one skinned mesh; converted to metres, Y-up glTF, facing +X with the feet at the origin; skin weights limited to four influences; materials rebuilt as one glTF PBR material using the original 2048 px colour texture unchanged; animation retargeted from the Microsoft Rocketbox clips below; glTF export.

Source: the two Sketchfab archives (original FBX and auto-converted glTF with `license.txt`) pinned by SHA-256 in [scan_sources.json](scan_sources.json). They stay in the git-ignored cache and are not redistributed; only the modified derivative ships.

## Animations: Microsoft Rocketbox Avatar Library (MIT)

Animations from the Microsoft Rocketbox Avatar Library (https://github.com/microsoft/Microsoft-Rocketbox), Copyright (c) 2020 Microsoft, MIT License: clips m_idle_breathe_01, m_crouch_idle, m_idle_cough_01, m_walk_neutral_01 and m_walk_slow_01, retargeted onto the scanned character's skeleton, trimmed and modified for FlyFireFighter. The Rocketbox avatar Male_Adult_01 is used at build time only as the Biped T-pose reference skeleton; none of its mesh or textures ship. Citation: Gonzalez-Franco et al., "The Rocketbox library and the utility of freely available rigged avatars", Frontiers in Virtual Reality (2020), doi:10.3389/frvir.2020.561558.

Source: repository commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`. The licence below was read from that commit's `LICENSE.md` (SHA-256 `17474e386e0b9e1a700cc3d06b2b0882a2c376d9c6b49c7f8274409b8f8d2352`); the repository README states "12/2020: Updated license to MIT."

Modifications: imported from FBX; root motion removed (in-place locomotion, linear horizontal drift subtracted, mean yaw offset removed); retargeted by world-space bone rotation relative to the Biped T-pose onto the scanned character's own skeleton, with the hip motion scaled to its hip height and a constant per-clip floor offset; Biped facial bones dropped; baked at 30 fps; actions renamed idle, crouch, cough, walk and follow.

```text
MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fallback recipe

`build_occupant.py` still builds the earlier interim character (Rocketbox avatar Male_Adult_01 with the same clips, entirely MIT, artist-made and not a scan) into the git-ignored cache. It is not shipped. If it ever replaces the scan, its own MIT credit applies: "Occupant character and animations from the Microsoft Rocketbox Avatar Library, Copyright (c) 2020 Microsoft, MIT License."
