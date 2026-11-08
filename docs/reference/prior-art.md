> Research carried forward from the earlier CloudBreak design. Current scope and name: [FlyFireFighter](../../PRD.md).

# CloudBreak: comparable projects and prior art

Research snapshot: November 7, 2026. This is a product and engineering comparison, not an exhaustive novelty search. Devpost submissions, official product documentation, research papers and selected GitHub source files were reviewed. The projects were not installed, executed or independently benchmarked. Current repository contents can include changes made after their hackathon submissions.

## What the research changes

Several close precedents already combine autonomous rescue search, simulated environments, person detection, uncertainty, operator approval and evidence logging. Hardware abstraction and next-best-view exploration also have substantial research and commercial precedents. CloudBreak needs a specific, measured contribution within this field. A promising hypothesis is better rescue-search decisions when a prior floor plan is wrong and sensors deteriorate during the mission.

The earlier assertion that the missing layer is simply a rescue harness was too broad. The following projects implement meaningful parts of that layer.

## Closest hackathon projects

| Project | Event | Relevant work and evidence boundary |
| --- | --- | --- |
| [AeroNav](https://devpost.com/software/aeronav) · [GitHub](https://github.com/SakritUser123/AeroNavFinal) | hackPHS 2026 | Very close: two simulated drones search a four-storey burning building, use sonar and run a person detector on rendered camera images. Separate viewpoints support confirmation. The published implementation uses known building dimensions, floor heights and stair geometry; interior obstacles are sensed. This is simulation evidence, not demonstrated smoke-flight localization. |
| [Eye in the Sky / Overwatch](https://devpost.com/software/bub-45wxdf) · [GitHub](https://github.com/SuryaThirukonda/hacktx) | HackTX 2026 | Very close to the harness: detection, rescue beacons, crew access routes, voice, evidence provenance and a deterministic safety supervisor. Current code also invalidates control state across incident changes and rejects stale designations. Its README explicitly separates simulated rescue behavior from unestablished real rescue navigation. |
| [FlyBy](https://devpost.com/software/flyby-fdxcua) · [GitHub](https://github.com/monishramj/flyby) | HackGT 13 | Seeded flood search, synthetic detections, local-model triage, operator approvals and an optional fly-inspired collision reflex. Useful for review workflow. The README discloses that inspection can resolve from simulation truth without an external result; that path is not proof of perception-based autonomous search. |
| [SearchandRescue.online](https://devpost.com/software/searchandrescue-online) | OxHack 2026 | Bayesian hiker-location beliefs and adaptive multi-drone search. Authors report 75% discovery versus 62% expanding-square and 25% lawnmower across 100 paired synthetic missions. Targets came from their own prior, so the result supports performance under that assumption. Incorrect-prior testing is a useful extension. Repository not verified in this review. |
| [FireScout](https://devpost.com/software/firescout) | SMathHacks 2025; Hardware second place | Wildfire reconnaissance concept with a browser simulation and IMU/servo work. The described implementation uses three canvases and maps observations from the simulated aircraft. Useful presentation precedent; the writeup does not establish autonomous interior rescue in smoke. |
| [BOSCO](https://devpost.com/software/bosco) | Hack the Valley 11 | Reports a live Parrot ANAFI observation feed, person leads with location uncertainty, named human review and a four-drone simulated perimeter search. The dashboard does not control flight or dispatch responders. This is another precedent for separating sightings, identities and human decisions. |

## Source-code observations worth carrying into our design

**AeroNav's map assumption is explicit in code.** `SearchGrid` reads the generated building's dimensions, floor count, origin and stairwell; `ClimbUp` supplies a fixed sequence through that stair geometry. This is a reasonable declared prior, but it is narrower than the Devpost phrase about having no map. CloudBreak should publish exactly which map information its planner receives, and test incorrect versions of it. [Inspected SearchGrid](https://github.com/SakritUser123/AeroNavFinal/blob/f175e6d03bf3fa2ed6a170146471b29c58c1d31c/Building2/Assets/Scripts/Search/SearchGrid.cs), [mission documentation](https://github.com/SakritUser123/AeroNavFinal/blob/f175e6d03bf3fa2ed6a170146471b29c58c1d31c/RESCUE.md).

**Overwatch's safety layer is implemented.** Its supervisor checks movement limits, geofencing, people underneath, battery and link status. Integration tests exercise incident isolation, stale designations and re-confirmation tied to fresh evidence. Human approval and revocation alone would therefore be weak novelty claims for CloudBreak. Tests were read, not run. [Supervisor](https://github.com/SuryaThirukonda/hacktx/blob/b2f1b68f35a8b834c5f8ffefba24d5a01a0ba187/backend/overwatch/autonomy/safety.py), [control-scope tests](https://github.com/SuryaThirukonda/hacktx/blob/b2f1b68f35a8b834c5f8ffefba24d5a01a0ba187/backend/tests/integration/test_incident_control_scope.py).

## Robotics projects to study

| Project | What it contributes | Boundary relevant to CloudBreak |
| --- | --- | --- |
| [PX4–ROS 2 drone navigation](https://github.com/formiat/px4-ros2-drone-nav) | PX4/Gazebo simulation, onboard-style state estimation, occupancy mapping, D* Lite and MPPI. Its smoke code alters camera and ranging observations using extinction and backscatter. | A stronger sensor-simulation reference than visual fog alone. Current README says ordinary flights have carried no smoke since October 24 and no onboard hardware run is claimed. Do not equate its clear-flight results with validated smoke autonomy. |
| [OmniPlanner / GBPlanner](https://github.com/ntnu-arl/gbplanner_ros) · [project and experiments](https://ntnu-arl.github.io/omniplanner/) | Exploration, viewpoint inspection and target navigation across aerial, ground and underwater platforms. Current work reports field deployments; it builds on the CERBERUS exploration lineage. | Both hardware abstraction and information-gain exploration already exist. A useful serious baseline or architecture reference; the published examples do not establish CloudBreak's complete house-fire mission. |
| [Coordinated Autonomous Drones for Human-Centered Fire Evacuation](https://arxiv.org/html/2510.23899v1) | GHTC 2025 paper: recurrent PPO coordinates two UAV roles under partial observability to locate and guide an evacuee in simulated urban fire. | Direct precedent for learned rescue decisions. Its simplified urban evacuation setting differs from navigating a smoky house. Learning a rescue policy is an implementation choice, not a novelty claim by itself. |
| [AI-Enhanced Thermal–Visual–Inertial Odometry and Autonomous Planning](https://pmc.ncbi.nlm.nih.gov/articles/PMC13119551/) | 2026 ground-robot work combining thermal, visual, inertial and acoustic information, survivor detection and PPO-assisted navigation. | Close sensor-fusion precedent, with simulation and bounded internal evaluations. The paper explicitly presents integration and adaptation rather than a fundamentally new SLAM or search method. |
| [Bonn autonomous firefighting at MBZIRC 2020](https://arxiv.org/abs/2106.06444) · [official demonstrations](https://ais.uni-bonn.de/videos/icuas_2021_mbzirc/) | Aerial and ground robots use LiDAR localization, thermal fire tracking and autonomous extinguishing in a robotics competition. | Water delivery and autonomous firefighting have physical precedents. Competition success is narrower than reliable search and suppression in an occupied house fire. |
| [CMU SMoRes](https://mrsdprojects.ri.cmu.edu/2025teamg/system-implementation/) · [performance](https://mrsdprojects.ri.cmu.edu/2025teamg/system-performance/) · [GitHub](https://github.com/castacks/smores_drone_software) | Physical thermal-camera drone with onboard odometry, depth mapping, person detection and a ground-control interface. | A particularly close structural-fire reference. The published flight requirements cover teleoperation with altitude hold, position hold and landing; those results should not be described as a demonstrated autonomous room-by-room rescue search. |
| [AF-RLIO](https://arxiv.org/html/2507.18317v1) · [GitHub](https://github.com/QCL0920/AF-RLIO) | Adaptive radar/LiDAR/inertial odometry, with GPS fusion, evaluated on datasets and a ground robot in generated outdoor smoke. | Direct precedent for changing sensor reliance as LiDAR degrades. Radar remains noisy and sparse. These odometry results do not establish indoor aerial rescue performance or make radar an infallible fallback. |
| [Fire as a Service](https://arxiv.org/html/2603.19063v1) | Co-simulation of fire, smoke and thermal exposure with Isaac Sim, Gazebo and MuJoCo; demonstrations include radiation-aware A* and learned heat avoidance. | Strong reference for making the simulator affect sensor observations and planning costs. Its behavior-cloning example uses 20 demonstration paths in a simple avoidance task; it does not establish general rescue-policy performance in unseen houses. |

The PX4 simulator is particularly useful to inspect: its `activeRange` implementation models surface attenuation and smoke returns, while the thermal image is explicitly left untouched by that smoke model. That is a declared simplification, not validation of thermal performance in every fire. [Smoke interfaces](https://github.com/formiat/px4-ros2-drone-nav/blob/0f849b8d6a6e55ffabd377f5735a6d5b0db3637c/drone_city_nav/src/simulation_smoke_model.hpp), [range implementation](https://github.com/formiat/px4-ros2-drone-nav/blob/0f849b8d6a6e55ffabd377f5735a6d5b0db3637c/drone_city_nav/src/simulation_smoke_model.cpp).

## Commercial overlap

**Emesent Hovermap is an important addition to the competitor list.** It sells mapping and autonomous exploration for GPS-denied environments, with return behavior and failsafes. Its documentation also describes loss of localization and resulting loss of autonomy. CloudBreak should distinguish rescue-specific evidence and task decisions from existing general navigation products. [Autonomy](https://www.emesent.com/autonomy), [navigation limitations](https://knowledge3.emesent.com/understanding-hovermap).

**FireDrone overlaps with more than heat protection.** Its manufacturer describes an autonomous high-temperature system, victim/hotspot detection and a broader hardware/software ecosystem, while some components remain marked coming soon. Treat it as both an adjacent competitor and a possible future integration partner. [Official product site](https://www.firedrone.com/).

**Flyability Elios 3 remains an adjacent mapping platform.** Its inspection platform and autonomy features mean mapping and repeatable flight are existing capabilities to build around. [Elios 3](https://www.flyability.com/elios-3), [autonomy software](https://www.flyability.com/software/drone-autonomy).

## A contribution CloudBreak could test

Proposed research question: **Can a rescue planner find and localize people more effectively when its floor plan is inaccurate and its sensors become unreliable, while staying within an explicit mission envelope?**

This is a candidate product focus, not a claim that no other group studies it. The literature above already covers many of its components.

The second survey's proposed claim that none of the prior projects decides what an aircraft may do as evidence changes is not supported. Overwatch already has control invalidation and evidence-related checks. Likewise, building-fire search, adaptive sensor fusion and hardware abstraction each have precedents. Reconciling caller reports, distinct drone tracks and crew confirmations remains a useful application focus; its novelty is unestablished. The defensible pitch is the concrete combination we implement and evaluate, with explicit credit for the underlying methods.

Build a small, reproducible evaluation around:

1. **Map mismatch.** Correct plans, a closed doorway, a missing partition and misplaced furniture. The planner sees its supplied prior and observations; the evaluator retains actual geometry.
2. **Changing sensor quality.** Smoke affects observations used by the planner, not just the rendered scene. Include dropouts, false returns, heat clutter and localization drift. Avoid making any fallback sensor perfect.
3. **Useful observations.** Score correct localization and distinct people, with duplicate tracks and false positives accounted for. A suspected detection does not become an identity or an all-clear.
4. **Action validity over time.** A detection, obstacle or localization failure can invalidate a previously approved action. Demonstrate this for a bounded simulated intervention, such as a spray request. Generic approval buttons are already common.
5. **Compatible aircraft profiles.** Evaluate the same mission with different sensing, size, endurance and payload limits. Make clear what the abstraction supports; software does not supply absent hardware capabilities.

Use identical held-out missions, sensor assumptions and compute budgets for each planner. Include a fixed room-order baseline and a competent frontier/next-best-view baseline; a weak sweep alone would overstate progress. If training is used, split by building layout, freeze the policy before evaluation and test priors unlike the training distribution. Ground truth can supply training targets and scoring, but must be excluded from runtime observations and action selection.

Report time-to-first-correct localization alongside detection recall, false detections, duplicate counts, collision/constraint violations, mission termination and return success. Include missions where nobody was found rather than reporting discovery time only among successes. Ablations should reveal whether sensor adaptation, map revision or action checking produced the improvement. Report simulated results as simulated.

## What to study first

1. AeroNav's rescue loop and map assumptions: closest burning-building hackathon comparison.
2. Overwatch's evidence and control lifecycle: closest mission-harness comparison.
3. The PX4 project's smoke model: concrete sensor corruption implementation.
4. OmniPlanner's experiments: the standard for a credible exploration comparison.
5. MBZIRC demonstrations: prior work for the water-jet extension.

Add SMoRes for measured thermal-flight limitations, AF-RLIO for adaptive sensor fusion, and Fire as a Service for thermal exposure and simulation architecture. Their primary sources were recovered from the second survey; its other damaged URLs and unsupported company claims have not been adopted as verified facts.

For the pitch, lead with the measured failure that CloudBreak handles and show it live. The strongest demonstration would have a judge invalidate the map or a sensor, then show the changed search decision, evidence and outcome against the baseline. The rescue story gives that engineering result its purpose.

The existing harness draft was also reviewed against this direction. Implementation questions and proposed acceptance cases are recorded in [the harness review](harness-review.md); they are recommendations, not changes to the shared action contract.
