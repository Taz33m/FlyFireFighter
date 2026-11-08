# Project provenance

FlyFireFighter began as a product discussion around Standard Response and its Headcount prototype. On November 7, 2026, the user chose an independent greenfield repository.

Carried forward: the approved PRD, demo loop, earlier harness design/review and prior-art research. No Standard Response application code, dependency tree, database, recordings, secrets or Git history was copied. References to its demos describe a separate project, not capabilities or routes in this app.

## Design sources

- Standard Response: voice intake and confirmation-based honesty patterns.
- Headcount: attributed person reports and separate crew confirmations.
- [FlyBy](https://github.com/monishramj/flyby): camera-to-fly-model reflex integration reference.
- [flyvis](https://turagalab.github.io/flyvis/): pretrained connectome-constrained fly visual-system model.
- [Saranga](https://github.com/pearwpi/Saranga): ultrasound obstacle-avoidance research.
- [Earlier harness draft](harness-draft.md) and [review](harness-review.md): implementation inputs with unresolved contract details.
- [Prior-art research](prior-art.md): background references.

## Copied source

On November 7, 2026, ten files from [TuragaLab/flyvis](https://github.com/TuragaLab/flyvis/tree/0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa) were copied unchanged into [vendor/flyvis-reference](../../vendor/flyvis-reference/README.md). Commit: `0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa`. The upstream MIT license and copyright notice are preserved; the [manifest](../../vendor/flyvis-reference/manifest.json) records verified Git blob hashes. This is a reference subset, not a complete installed package, weights or a flight controller. No FlyBy implementation was copied.

The user-provided FlyBy_Expo_3min_v3 (1).pdf was reviewed for presentation structure and its visual-model demonstration. The PDF and its visual assets were not imported. It is presentation reference material, not evidence of FlyFireFighter performance.

When additional code, model or scene artifacts are integrated, record their exact revision, applicable license and modifications here. A design reference does not mean its implementation is already included.

The current scene direction uses a real Peoples Avenue/Heffner exterior reference with an authored training interior and fictional incident/occupants. See the [asset plan](../scene-and-assets.md) for source status, scanned-character candidates and licensing. No building or character asset has been imported yet. Character and animation licensing research (November 7, 2026) is in [character-assets.md](character-assets.md): the Mike Alger scan (CC BY 4.0) ranks first, with Microsoft Rocketbox (MIT), 100STYLE (CC BY 4.0) and CMU mocap clips; Mixamo is excluded for its AI/ML restriction. Obtaining the scan requires the user's own Sketchfab download. Interview recordings and full transcripts stay outside this repository. The real Troy fatal fire is background motivation only; quotation approval remains separate from permission to develop locally.

## Integrated sources (November 7, 2026)

- **FlyVis runtime:** TuragaLab/flyvis installed at commit `0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa` (MIT) in `services/flyvis/.venv`; our adapter and service are original code with attribution. Pretrained archive `results_pretrained_models.zip` (SHA-256 `71c78d40…1db1`, matching upstream's checksum) and checkpoint `flow/0000/000` (SHA-256 `d0e42857…cc3f`) are cached outside Git. Upstream states no licence for the weights: local evaluation only, no redistribution. See [weights.manifest.json](../../services/flyvis/weights.manifest.json).
- **Troy exterior:** OpenStreetMap data © OpenStreetMap contributors (ODbL 1.0) — Heffner Alumni House footprint way 73141173 and nearby streets, pinned in [troy_osm_extract.json](../../assets/blender/troy_osm_extract.json). Proportions were estimated from Wikimedia Commons photographs "RPI Alumni House 01–19" by RPI2026F1 (CC BY-SA 4.0); no image pixels are used or redistributed. The building is massing, not a scan; the interior, incident and occupant are fictional.
- **Character:** the occupant is Mike Alger's scan "Rigged T-Pose Human Male w 50 Face Blendshapes" (CC BY 4.0; scanned by doob, optimized and rigged by High Fidelity per the creator), downloaded by the user on November 7, 2026, with Microsoft Rocketbox animation clips (MIT) retargeted onto its skeleton. Exact credits, modifications and hashes: [THIRD_PARTY_NOTICES](../../assets/actors/THIRD_PARTY_NOTICES.md) and [provenance](../../public/actors/occupant.provenance.json). The rig uses Mixamo-style bone names from High Fidelity's 2017 pipeline; no Mixamo animations or service were used. Re-weighting on a project-owned skeleton remains an open question before any public training-data release. The occupant is fictional and unconnected to the scanned person.
- **Prior art used:** FlyBy informed the camera → fly model → readout presentation; no FlyBy code was copied. Saranga informed the ultrasound requirement; our ultrasound model is a simulated range model, not the published echo network.
