# Character assets: scanned occupant and animation sources

Research snapshot: November 7, 2026 · [Scene and asset plan](../scene-and-assets.md)

This is web research only. Nothing has been downloaded into `assets/cache/`, imported into Blender or exported. Facts about Sketchfab models come from Sketchfab's public, no-login model metadata: the Data API record `api.sketchfab.com/v3/models/{uid}` and the viewer's model JSON `sketchfab.com/i/models/{uid}`. Licences were read from their actual text, not just a badge. Rig details marked *expected* have not been inspected. This is an engineering licence review, not legal advice.

## Recommendation

| Rank | Character | Animation sources | Why |
| --- | --- | --- | --- |
| 1 | **Mike Alger, "Rigged T-Pose Human Male w 50 Face Blendshapes"** (doob scan, High Fidelity rig) · CC BY 4.0 | **Microsoft Rocketbox animations** (MIT) for idle, crouch, cough, walk and turns, plus **100STYLE** (CC BY 4.0) for crouched and following walks. Optionally add **CMU mocap** ("free for all uses"). | It is a real rigged scan within the triangle budget. The subject is also the licensor. Each licence permits redistribution, modification and AI/simulation use. Rocketbox is the only permissive source found with a cough clip. |
| 2 | **Eric Neuman, "Doob / High Fidelity Avatar"** · CC BY 4.0 | Same as rank 1 | Same pipeline, self-uploaded likeness and a 4K diffuse texture. However, it has 71.7k triangles, a rig the creator says is Mixamo, and an embedded canned (likely Mixamo) animation that must be removed. |
| 3 | **Microsoft Rocketbox avatar** (MIT; not a scan) | Rocketbox's own clips, with no retargeting | This is the cleanest licence chain, but the avatar is sculpted, not scanned, at 10k triangles. It fails the "scanned adult" acceptance criterion unless the scene plan changes. |

Not selected: the Renderpeople Sketchfab samples, which are tagged `noai` and are also covered by Renderpeople terms §4.2. Also rejected: Mixamo characters and animations (Adobe's AI/ML restriction), Bandai Namco motion data (NonCommercial) and Ubisoft LAFAN1 (NonCommercial-NoDerivatives).

**Blocker:** none on licensing. Getting the rank 1 files needs the user's Sketchfab sign-in, and the original FBX is only available from the website. See [User actions](#user-actions-for-the-top-choice).

## 1. Current candidate: Mike Alger

[Model page](https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) · uid `cc7e4596bcd145208a6992c757854c07` · creator [Mike Alger](https://sketchfab.com/mikealger) · published 2020-01-28 · updated 2022-07-21 · 37,487 downloads.

| Item | Verified value |
| --- | --- |
| Licence on the model page | "CC Attribution", meaning Creative Commons Attribution 4.0. API licence slug `by`; URL `http://creativecommons.org/licenses/by/4.0/`. Requirements: "Author must be credited. Commercial use is allowed." `downloadType: free`. |
| AI opt-out | Not tagged `NoAI`. The tags are `blendshapes, man, human, male, rigged`, and the creator account has `isAiRestricted: false`. |
| Creator's statement | "This is a rigged scan of me free to download and use in whatever weird thing you want to put it in. Scanned by Doob, optimized and rigged by High Fidelity. I've retargeted animations, used it as a game character in Unity, an avatar in VR, and rendered videos with it." |
| Creator replies | On 2020-02-13 he answered a request to use the model as a game avatar: "Absolutely. I'd love for people to use it for anything they want." On 2025-07-15 he answered "Can I use this model in my game?" with "yeah". [Comments API](https://api.sketchfab.com/v3/comments?model=cc7e4596bcd145208a6992c757854c07) |
| Geometry | 54,683 triangles (26,977 quads + 729 triangles) and 27,829 vertices. It has normals and UVs, has no tangents and is rigged. Sketchfab's processing reports **0 morph targets**, so the claimed 50 blendshapes are unverified. |
| Materials and textures | 7 materials and **one 2048×2048 RGB JPEG diffuse** (`textures/MikeAlger_Texture.jpeg`, 877 KB). There are no normal or roughness maps; the creator says "The only texture is a color diffuse." The 512² `internal_ground_ao_texture` belongs to Sketchfab's viewer, not the model. |
| Formats | Source: `source/MikeAlger.fbx`, FBX 2017, 30,211,264 bytes. Sketchfab also generated glTF, GLB and USDZ archives. The FBX size would fit embedded shape keys, but that is not evidence they are present. |
| Skeleton | *Expected* to be a High Fidelity/Mixamo-style humanoid (`Hips`, `Spine`…`Spine2`, `Neck`, `Head`, `LeftShoulder`/`LeftArm`/`LeftForeArm`/`LeftHand`, `LeftUpLeg`/`LeftLeg`/`LeftFoot`/`LeftToeBase`, fingers, possibly with a `mixamorig:` prefix). That would suit retargeting. The evidence: High Fidelity's avatar standard uses a HumanIK skeleton "with some modifications made for Mixamo" and Faceshift-style blendshape names (`EyeBlink_L`, `JawOpen`, `BrowsU_C`, `MouthSmile_L`…), with +Z forward and +Y up ([Overte docs, derived from High Fidelity](https://docs.overte.org/en/latest/create/avatars/avatar-standards.html)). High Fidelity's 2017 doob write-up says "The Fuse auto-rigger produced the control rigs", and a sibling doob/High Fidelity avatar states "the body is rigged using Adobe Mixamo". Verify after download. |
| Budget fit | Fits the 30,000–60,000 triangle budget per skinned adult and the 1K/2K texture guidance. Add normal and roughness maps, and make an LOD1 around 20–25k triangles. |

### Attribution chain

1. **doob 3D** captured the subject in a multi-camera booth ("64 pictures simultaneously"). High Fidelity and doob announced a scan-to-avatar pipeline in June 2017: the first 100 scans were free, then $450 per scan. ([PR Newswire](https://prnewswire.com/news-releases/high-fidelity-and-doob3d-announce-partnership-for-realistic-scanned-avatars-300469899.html), [High Fidelity promo, June 7, 2017](https://www.highfidelity.com/backlog/doob-3d-high-fidelity-partnership-promo-first-100-scans-free-7a5a57993b27))
2. **High Fidelity** "optimized and rigged" the scan. In their own 2017 pipeline, doob delivered high-resolution scans "too heavy for real-time rendering". High Fidelity used Wrap3 "to shrink-wrap the standard High Fidelity avatar mesh onto each scan", transferred the textures and rigged with the Fuse auto-rigger. ([Scanning A Digital Self With Doob 3D, May 18, 2017](https://www.highfidelity.com/backlog/scanning-a-digital-self-with-doob-3d-1b2bccd6654d)) That article also mentions Fuse/Daz clothing for staff avatars. Mike Alger's thumbnail shows scanned clothing (hoodie, T-shirt, jeans, sneakers), but the file has not been inspected.
3. **Mike Alger** is the subject, uploader and licensor. He applied CC BY 4.0 on Sketchfab on 2020-01-28.

Neither doob nor High Fidelity published customer terms on who owns the scan or avatar data that this research could find. The High Fidelity posts make no ownership statement.

### Licence verdict

| Requirement | Verdict | Basis |
| --- | --- | --- |
| Redistribute an optimized model in a public repo/web app | **Permitted with attribution** | CC BY 4.0 §2(a)(1) grants an irrevocable licence to "reproduce and Share" the material and to "produce, reproduce, and Share Adapted Material". Attribution under §3(a)(1) may be met "in any reasonable manner" (§3(a)(2)). The adapter's licence must not prevent downstream compliance (§3(a)(4)). No DRM or terms that restrict recipients (§2(a)(5)(B)). |
| Simulation, training/evaluation renders and AI/CV experiments | **Permitted** | CC BY 4.0 has no field-of-use restriction. Creative Commons' guidance says BY/SA/ND conditions are "triggered only upon public sharing", and "attribution could be a simple link to the source of the dataset used to train the model" ([CC: Using CC-licensed works for AI training](https://creativecommons.org/using-cc-licensed-works-for-ai-training/)). Sketchfab's AI clauses (§5 item 14, §15(a)) apply only to content tagged `NoAI`, and only to "Generative AI Programs". This model is not tagged, and our use is not generative AI. |
| Modify (retopology, retargeting, re-skinning, texture baking) | **Permitted** | We must "indicate if You modified the Licensed Material and retain an indication of any previous modifications" (§3(a)(1)(B)). |

Sketchfab platform terms (operator **KitBash SF Operations LLC**, which acquired Sketchfab and ArtStation from Epic as announced on August 10, 2026; terms effective October 27, 2026; [terms](https://sketchfab.com/terms), [Epic announcement](https://www.epicgames.com/site/news/kitbash-acquires-artstation-and-sketchfab)):

- §4.1 makes downloaded content "subject to the most-current version of the License Agreement or Creative Commons license". §4.2.2 requires downloaders to "adhere to the terms of the license".
- §4.2.4 requires that download-API users "shall be authenticated".
- §5 item 13 forbids collecting, mining or scraping content "for the purposes of publishing, selling, distributing or otherwise making the content available to others to use, download or copy" "except where explicitly allowed by this Agreement". Our reading: one manual download, shared under its CC BY licence as §4.1/§4.2.2 allow, is within the terms. Do not mirror the raw Sketchfab archives or bulk-download; ship only our optimized derivative with credits.

Residual risks, none blocking:

- **Likeness.** This is an identifiable real person. CC BY 4.0 §2(b)(1) does not license personality rights, but "the Licensor waives and/or agrees not to assert any such rights held by the Licensor to the limited extent necessary to allow You to exercise the Licensed Rights". Here the licensor is the subject, which is the best case. §2(a)(6) forbids implying endorsement. Do not name the fictional occupant after him.
- **Undocumented upstream components.** These may include High Fidelity's base mesh and, possibly, Adobe Fuse/Mixamo rig output. Adobe's Mixamo Additional Terms (§1, effective June 23, 2021) restrict Mixamo *users* from using derived content for ML. They post-date this 2020 upload and do not bind downstream CC licensees who never used Mixamo. Re-weighting from scratch on a project-owned skeleton is the only way to fully remove any Mixamo-derived data. See [Open questions](#open-questions).
- **Import QA.** Two 2022 comments report "a non texture face shows up over top of your face" "only when i render". This is probably a duplicate or hidden head mesh; check it on import. Lighting appears baked into the diffuse.

## 2. Alternatives compared

| Candidate | Scan / realism | Rig | Triangles | Textures | Licence (actual text) | Redistribute · AI/sim · modify | Download | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Mike Alger** (above) | doob booth scan; good at medium/wide distance | High Fidelity, *expected* Mixamo-style; 50 blendshapes claimed, 0 detected by Sketchfab | 54,683 | 1× 2048² diffuse | CC BY 4.0; not `NoAI` | Yes · yes · yes | Sketchfab login; source FBX via website only | **Rank 1** |
| [Eric Neuman Doob / High Fidelity Avatar](https://sketchfab.com/3d-models/eric-neuman-doob-high-fidelity-avatar-c30b13c1de1144308c6767b9c95fa276) (2017) | Same doob/High Fidelity pipeline; self-uploaded ("my likeness") | "rigged using Adobe Mixamo" (creator); one embedded animation, which the creator says were "canned animations that I simply applied" | 71,737 (35,491 quads + 755 triangles) | 1× 4096² diffuse | CC BY 4.0; not `NoAI` | Yes · yes · yes. Strip the canned (likely Mixamo) animation, which is not the creator's to license. | Sketchfab login; FBX 2017 source, 9.4 MB | **Rank 2** backup or second occupant; decimate |
| [in3D smartphone scan](https://sketchfab.com/3d-models/3d-body-head-scan-done-with-smartphone-ba278d0f7800428a9f243d1d8b555234) (and [iPhone X scan](https://sketchfab.com/3d-models/human-3d-model-scanned-with-iphone-x-73e467dfc8a04914bb314a9410077858)) | Automated phone scan; visibly lower fidelity | "mixamo-compatible rig", T-pose `model_T.fbx`. The iPhone X model is posed and has one animation of unknown origin. | 18,220 (37,210 for iPhone X) | 1× 2048² diffuse | CC BY 4.0; not `NoAI` | Yes · yes · yes. The licensor is the app company, not the identifiable subject, so the §2(b)(1) waiver does not cover the subject. | Sketchfab login | Rank 4 |
| Unrigged CC BY photogrammetry: [3d scan man 1](https://sketchfab.com/3d-models/3d-scan-man-1-ad42febfaeb64aa0992e804acc9e7ccd), [deep3dstudio surgical doctor](https://sketchfab.com/3d-models/free-download-male-surgical-doctor-working-222-79e23af07d1243c789b3372c6ec72c27), [Full Body Scan - Clean Pose](https://sketchfab.com/3d-models/full-body-scan-clean-pose-ae9559912f6240a8a87057911b69edd0) | High-resolution scans with good realism. The doctor wears surgical PPE and is posed, so it does not suit a home occupant. | None: needs retopology, rig and skinning | 259,648 / 99,998 / 153,880 | 4096² albedo/normal/roughness/metallic · 8192² diffuse/normal/specular · 8192² diffuse | CC BY 4.0; not `NoAI` | Yes · yes · yes. Subject consent or model release is unknown; "3d scan man 1" shows brand logos. | Sketchfab login | Only if ranks 1–2 fail QA |
| [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) (115 avatars) | **Not scans.** "based on sculpting", using studio photos as references, mixed into "generic humans that do not exist in reality" ([paper](https://www.frontiersin.org/articles/10.3389/frvir.2020.561558/full)) | 3ds Max Biped (`Bip01 Pelvis`, `Bip01 L Thigh`…), 53–56 body bones + 28 facial bones; facial blendshapes added 2/2022, ARKit-compatible ones 6/2022 | hipoly 10,000 · midpoly 5,000 · lowpoly 2,500 · ultralowpoly 500 | Usually 2048² head + body: diffuse, specular, normal | MIT: [LICENSE.md](https://github.com/microsoft/Microsoft-Rocketbox/blob/master/LICENSE.md) "Copyright (c) 2020 Microsoft"; README: "12/2020: Updated license to MIT". The paper's earlier "free for research and academic use" wording is superseded. | Yes · yes · yes (keep the MIT notice) | GitHub, no login. The repo is about 4 GB and archived (Oct 2022), so fetch individual files rather than cloning. | **Rank 3**, the cleanest fallback |
| [MPFB2](https://github.com/makehumancommunity/mpfb2) / MakeHuman | Parametric, not a scan; lowest realism | Selectable rigs: `default`, `default_no_toes`, `game_engine`, `mixamo`, `mixamo_unity`, `cmu_mb` (matches CMU BVH), `openpose` | hm08 base mesh: 13,380 body vertices, 14,766 quad faces per MakeHuman docs, plus clothes and hair | CC0 system-asset skins | Assets "released under CC0 1.0 Universal". On output: "the MakeHuman team makes no claim whatsoever over output such as: Exports to files (FBX, OBJ, DAE, MHX2...)". Code is GPLv3. ([MPFB LICENSE.md](https://github.com/makehumancommunity/mpfb2/blob/master/LICENSE.md), [MakeHuman LICENSE.md](https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md)) | Yes · yes · yes. Third-party community assets carry their own licences. | Blender extension/GitHub, no login | Anonymous extras |
| [Renderpeople Sketchfab samples](https://sketchfab.com/3d-models/eric-rigged-001-rigged-3d-business-man-a46bc9f67aaa415bb4f3241eef900e7f) | Scans | Rigged, "~10k polycount" | 20,542 | 8192² diffuse + normal | CC BY 4.0 badge, but tagged **`noai`**, account `isAiRestricted: true`. Sketchfab §5 item 14 also applies, on top of [Renderpeople terms §4.2](https://renderpeople.com/general-terms-and-conditions/). | AI-use conflict | — | **Excluded** |
| Mixamo characters | Not scans | Mixamo | — | — | [Mixamo Additional Terms §1](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf) (see §3) | AI use prohibited | Adobe ID | **Excluded** |

Not evaluated in depth: commercial scan stores such as 3D Scan Store/Ten24 and AXYZ, and research body-scan datasets. This review found no published permissive licence from them that covers both redistribution and AI use.

## 3. Animation sources

### Licences

| Source | Licence (actual text) | Retargeted clips in a public repo/app? | Training/evaluation/simulation use? | Access |
| --- | --- | --- | --- | --- |
| **Microsoft Rocketbox animations** (`Assets/Animations`, added 4/2022; the README says 417 animations, and the three folders list 326/71/74 files) | MIT, same repo licence as above | **Yes**; include the MIT notice | **Yes** | GitHub raw files, no login; files are not in LFS (e.g. `m_idle_cough_01.max.fbx` is 1.6 MB) |
| **[100STYLE](https://www.ianxmason.com/100style/)** (Mason, Starke & Komura 2022; XSens, 60 fps BVH, 28-bone skeleton) | "This work is licensed under a Creative Commons Attribution 4.0 International License". The [Zenodo record](https://zenodo.org/records/8127870) licence is `cc-by-4.0`. Requested credit: "The 100STYLE Dataset - Ian Mason". | **Yes**, with attribution and a modification notice | **Yes** | Zenodo `100STYLE.zip` (1.47 GB) or per-file Google Drive BVH links, no login. The [retargeted version](https://github.com/orangeduck/100style-retarget) is CC BY 4.0 for the motion data, but its `Geno.fbx` character is "free for non-commercial research use", so do not ship Geno. |
| **[CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu/)** | Home page: "This dataset of motions is free for all uses." "You may include this data in commercially-sold products, but you may not resell this data directly, even in converted form." [FAQ](http://mocap.cs.cmu.edu/faqs.php): "The motion capture data may be copied, modified, or redistributed without permission." The cgspeed BVH conversion [READMEFIRST](https://github.com/meshula/cmu-mocap/blob/master/READMEFIRST.txt) says "CMU places no restrictions on the use of the original dataset, and I (Bruce) place no additional restrictions on the use of this particular BVH conversion." | **Yes** (redistribution in a repo is not resale) | **Yes** | No login. The site asks "Please don't crawl this database!", so fetch named trials only. |
| [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) | CC0 ("Free to use in personal, educational and commercial projects") | Yes | Yes | The free Standard tier is a subset, and the clip names are not published on the pack page. Stylized, hand-animated game motion; fallback only. |
| **Mixamo** | Adobe General Terms plus [Mixamo Additional Terms](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf), effective June 23, 2021, §1 "Restriction on AI/ML": "You will not, and will not instruct or allow third parties to, use the Services or Software (or any content, data, output, or other information received or derived from the Services or Software) to directly or indirectly create, train, test, or otherwise improve any machine learning algorithms or artificial intelligence systems, including, but not limited to, any architectures, models, or weights." | **No.** An Adobe Community Mixamo FAQ post (Sep 29, 2022) says "the only thing you can't do is distribute the raw character and animation files". GLB clips in a public repo are extractable raw animation data. | **No.** The same post: "The only research application Mixamo content can't be used in is training machine-learning models." | Adobe ID required. **Excluded.** |
| [Bandai Namco Research Motiondataset](https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset) | CC BY-NC 4.0 | Non-commercial only | Non-commercial only; CC says NC "applies to all uses requiring permission under copyright" | **Excluded** |
| [Ubisoft LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset) | CC BY-NC-ND 4.0 | No: NoDerivatives bars sharing retargeted clips | Non-commercial | **Excluded** |

### Clips actually available

| Needed clip | Rocketbox (MIT, male `m_` files; `f_` equivalents exist) | 100STYLE (CC BY 4.0) | CMU (free for all uses) |
| --- | --- | --- | --- |
| Idle | `m_idle_neutral_01`–`09`, `m_idle_breathe_01`–`03`, `m_idle_look_around_01`–`03`, `m_idle_nervous_01`–`03`, `m_idle_waiting_01`–`02` | `Neutral_ID` (every style has an `ID` idle take) | #140 trials 6–7 "Idle"; #77 trial 2 "standing" |
| Crouch | `m_crouch_in`, `m_crouch_idle`, `m_crouch_out`, `m_crouch_gestic` | `Crouched_ID`, `Crouched_FW/BW/SW`, `Crouched_TR*`, `OnToesCrouched_*` | #136 trials 9–10 "Walk Crouched" (no static crouch idle) |
| Cough | **`m_idle_cough_01`, `m_idle_cough_02`** (standing); `m_sit_chair_idle_cough`, `m_sit_table_idle_cough` | None | None (keyword search: no results) |
| Walk | `m_walk_neutral`, `_01`–`03`, `m_walk_slow_01`–`02`, `m_walk_start`, `m_walk_stop`, `m_walk_bruised`, `m_walk_stroll_01`–`02`; turns `m_turn_left/right_60/90/120/180` and `*_to_walk` | `Neutral_FW` and many styles | Many, e.g. #82 trial 8 "stand still; casual walk forward" |
| Walk while following | No dedicated clip: use `m_walk_slow_*`, `m_waiting_walk` and turn-to-walk clips plus a runtime look-at | Style labels to review: `LookUp_FW` (gaze up toward a drone), `InTheDark_FW` (cautious), `Crouched_FW` (staying low in smoke), `Followed_FW` | #139 "Looking Around" (trials 1, 3, 4, 26, 27); #91 and #105 trial 18 "CarefulWalk LookingAround"; #54 trials 20–22 "follow path, walk around obstacles" (from a pantomime set); #139 trials 19–24 "Walk Wounded Leg" |

Rocketbox clips are 3ds Max Biped FBX. The folder names `all_animations_max_motextr_static`, `_xy` and `_xyz` suggest root-motion-extracted variants; confirm on import. 100STYLE and CMU are BVH; MPFB2's `cmu_mb` rig matches CMU's skeleton. Retarget everything in Blender 5.1 onto one target skeleton, then bake in-place loops. Per the scene plan, simulation drives the root and playback rate follows actual speed. The cough can become an additive upper-body layer over idle, crouch or walk, and gaze toward the drone a deterministic runtime layer.

## 4. Attribution text (drafts)

**Character (CC BY 4.0).** Occupant character based on "Rigged T-Pose Human Male w 50 Face Blendshapes" (https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) by Mike Alger (https://sketchfab.com/mikealger), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Scanned by doob and optimized and rigged by High Fidelity, per the creator. Modified for FlyFireFighter: *[decimation/LODs, added normal and roughness maps, skeleton/skin changes, animation retargeting, glTF export]*. The creator does not endorse this project. The fictional occupant has no connection to him or to any real incident.

Sketchfab's credit-line format, which download archives typically include as `license.txt`, is: `This work is based on "<title>" (<url>) by <author> (<profile>) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)`.

**Rocketbox (MIT).** Animations from the Microsoft Rocketbox Avatar Library (https://github.com/microsoft/Microsoft-Rocketbox), Copyright (c) 2020 Microsoft, MIT License; retargeted and trimmed for FlyFireFighter. Ship the full MIT permission notice in third-party notices. Optional citation: Gonzalez-Franco et al., "The Rocketbox library and the utility of freely available rigged avatars", *Frontiers in Virtual Reality* (2020), doi:10.3389/frvir.2020.561558.

**100STYLE (CC BY 4.0).** Locomotion clips derived from The 100STYLE Dataset - Ian Mason (Mason, Starke & Komura 2022; https://www.ianxmason.com/100style/), licensed under CC BY 4.0; retargeted, trimmed and looped for FlyFireFighter.

**CMU (if used).** "The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217." BVH conversion by Bruce Hahne (cgspeed).

Any public release of rendered datasets should carry the same credits or a link to them.

## User actions for the top choice

1. Sign in at sketchfab.com with a free account. One report at the KitBash acquisition said Epic credentials still work for now.
2. Open the [model page](https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07) and choose **Download 3D Model**.
3. Download **Original format (fbx)**, about 30 MB with `source/MikeAlger.fbx` and the 2048² texture. Also download the auto-converted **glTF** archive, which should contain Sketchfab's `license.txt`. Note the download date and the licence shown in the dialog.
4. Put both archives, unmodified, in `assets/cache/characters/mike-alger/`. That folder is git-ignored by `assets/cache/`; do not commit it.

After that, agents can hash the files, inspect the skeleton, shape keys, duplicate face mesh and units in Blender, and fill in the manifest entry below.

Alternative: put a personal Sketchfab API token (from Sketchfab account settings) in a git-ignored environment file. Never paste it into chat or commit it. The [Download API](https://sketchfab.com/developers/download-api/downloading-models) (`GET https://api.sketchfab.com/v3/models/{uid}/download`, authenticated) returns signed, short-lived glTF/GLB/USDZ URLs only. Source formats such as FBX "are not currently available" through the API. The docs show an OAuth bearer token; third-party clients also use `Authorization: Token <api token>`. Because Sketchfab detected 0 morph targets, converted files may lack the blendshapes, so the website FBX download is preferred.

Rocketbox, 100STYLE and CMU need no account. Fetch individual named files into the git-ignored cache. Do not clone the 4 GB Rocketbox repo or download the 1.47 GB 100STYLE archive on the shared Mac.

## Draft manifest entry (to complete after download)

| Field | Value |
| --- | --- |
| `id` | `actor.occupant_a.scan_alger` (proposed) |
| Source URL | Model page above; uid `cc7e4596bcd145208a6992c757854c07` |
| Creator | Mike Alger (subject/licensor); scan: doob; optimization/rig: High Fidelity |
| Download date / terms version | TBD / Sketchfab terms effective 2026-10-27 |
| Licence / licence file | CC BY 4.0 / `license.txt` from the glTF archive (TBD) plus the Sketchfab metadata snapshot |
| SHA-256 (source, optimized) | TBD, TBD |
| Units, orientation | TBD; the High Fidelity standard is +Z forward, +Y up |
| Rig | TBD (*expected* Mixamo-style humanoid); shape keys TBD |
| Modifications | TBD |
| Redistribution / training | Optimized derivative may be redistributed under CC BY 4.0 with credits and a modification notice. Training/evaluation use is permitted; the model was not `NoAI`-tagged when checked on 2026-11-07. |
| Animation entries | Separate records per source (Rocketbox MIT, 100STYLE CC BY 4.0, CMU) |

## Open questions

1. **Rig and blendshapes.** After download, check the bone names (and any `mixamorig:` prefix), whether the FBX contains the 50 shape keys, the duplicate untextured face reported in renders, and the unit scale.
2. **Mixamo provenance.** If the rig is Mixamo/Fuse-derived, keep the supplied skin weights (low risk: the Adobe clause binds Mixamo users and post-dates the upload) or re-weight from scratch on a project-owned skeleton (removes all doubt, at the cost of weight-painting a clothed scan). The coordinator should decide before any public training-data release.
3. **Upstream rights.** No doob or High Fidelity customer terms were found. Optionally message Mike Alger on Sketchfab to confirm he could license the scan and rig under CC BY 4.0, and whether Fuse/Mixamo was involved. This is a courtesy, not a licence requirement.
4. **Fallback acceptance.** If neither scan passes QA, would a sculpted Rocketbox avatar be acceptable, or does the scene plan require a scan? The current plan requires a scan.
5. **Second occupant.** If two adults are needed, the Eric Neuman scan has the same licence terms. Rocketbox female avatars and clips are the clean-licence option.
6. **Terms drift.** Sketchfab's terms changed after the KitBash acquisition. Record the licence and terms version at download time, and re-check the `NoAI` status before release.

## Sources

- Sketchfab: [model page](https://sketchfab.com/3d-models/rigged-t-pose-human-male-w-50-face-blendshapes-cc7e4596bcd145208a6992c757854c07), [Data API record](https://api.sketchfab.com/v3/models/cc7e4596bcd145208a6992c757854c07), [comments](https://api.sketchfab.com/v3/comments?model=cc7e4596bcd145208a6992c757854c07), [terms (effective Oct 27, 2026)](https://sketchfab.com/terms), [Download API](https://sketchfab.com/developers/download-api/downloading-models), [crediting help](https://help.sketchfab.com/en/articles/16152215-crediting-users-for-3d-model-downloads)
- KitBash acquisition: [Epic Games](https://www.epicgames.com/site/news/kitbash-acquires-artstation-and-sketchfab), [80.lv](https://80.lv/articles/artstation-and-sketchfab-have-been-acquired-by-kitbash)
- High Fidelity / doob: [pipeline write-up](https://www.highfidelity.com/backlog/scanning-a-digital-self-with-doob-3d-1b2bccd6654d), [partnership promo](https://www.highfidelity.com/backlog/doob-3d-high-fidelity-partnership-promo-first-100-scans-free-7a5a57993b27), [press release](https://prnewswire.com/news-releases/high-fidelity-and-doob3d-announce-partnership-for-realistic-scanned-avatars-300469899.html), [avatar standards (Overte)](https://docs.overte.org/en/latest/create/avatars/avatar-standards.html)
- Licences: [CC BY 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode), [CC AI-training guidance](https://creativecommons.org/using-cc-licensed-works-for-ai-training/), [Mixamo Additional Terms](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf), [Adobe Community Mixamo FAQ post](https://community.adobe.com/t5/mixamo-discussions/mixamo-faq-licensing-royalties-ownership-eula-and-tos/td-p/13234775), [Renderpeople terms](https://renderpeople.com/general-terms-and-conditions/)
- Rocketbox: [repository](https://github.com/microsoft/Microsoft-Rocketbox), [animations](https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Animations), [paper](https://www.frontiersin.org/articles/10.3389/frvir.2020.561558/full)
- MakeHuman/MPFB: [MPFB2](https://github.com/makehumancommunity/mpfb2), [MakeHuman licence](https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md), [2020 licence change](https://static.makehumancommunity.org/oldsite/faq/what_changed_regarding_the_license_in_2020.html)
- Motion: [CMU](http://mocap.cs.cmu.edu/), [CMU FAQ](http://mocap.cs.cmu.edu/faqs.php), [cgspeed BVH READMEFIRST mirror](https://github.com/meshula/cmu-mocap/blob/master/READMEFIRST.txt), [100STYLE](https://www.ianxmason.com/100style/), [100STYLE Zenodo](https://zenodo.org/records/8127870), [100style-retarget](https://github.com/orangeduck/100style-retarget), [Quaternius UAL](https://quaternius.com/packs/universalanimationlibrary.html), [Bandai Namco](https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset), [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset)
