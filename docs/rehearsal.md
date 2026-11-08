# Rehearsal script and checklist

November 8, 2026 · For the three-minute loop in [DemoLoop.md](../DemoLoop.md) · Status per [PLAN.md](../PLAN.md)

This is the operating script for the people on stage: what the presenter says and does at each phase-rail stage, what the commander (the judge) approves, and what to do when something fails. It describes the app as it is. Where the demo needs something that does not work yet, the script says so instead of working around it.

**Current state.** The integrated end-to-end rescue does not pass yet (PLAN.md, stages 4 and 5). The live loop below is therefore a rehearsal target. Each stage can be rehearsed up to the point where the current build stops, and that stopping point has to be named on stage, not hidden. No saved full rescue exists yet. The replay fallback plays whatever a saved bundle actually recorded, and its outcome reads exactly as the evaluator scored it.

## Roles

| Role | Does | Never does |
| --- | --- | --- |
| Presenter | Narrates. Points at the phase rail, the action card and the drone view. | Approves or rejects for the judge. Calls a detection a rescue. |
| Operator (can also be the presenter) | Starts and resets runs, sets speed, enters the typed report if the judge doesn't, presses the experiment presets, cuts to the replay. | Changes the outcome, skips a gate or reruns silently. |
| Commander (the judge) | Approves or rejects each glass-breaking and water action on the action card (or presses A or R), and can abort at any time (Abort button, or Esc twice). | Approves anything except the card in front of them. Each approval covers one proposal only. |

## What is implemented and what is still required

| Capability used on stage | Status | Where |
| --- | --- | --- |
| Mission workspace with simulation worker, typed report intake, authorization, action card, abort | Implemented | `/` |
| Phase rail derived from the truth-free mission view and this run's evaluator outcome; refused gates hold the rail | Implemented | `/`, rail above the drone view |
| Projector stage layout: Presenter view keeps the 3D view above the fold under the stage-size rail | Implemented, needs a headed check at projector resolution | `/` → Presenter view |
| Commander shortcuts A (approve, after a 0.9 s review delay), R (reject), Esc Esc (abort) | Implemented | `/` |
| Camera director (Auto), judge challenge, localization-loss preset, Q&A drawer, local-only guidance voice (off by default) | Implemented | `/` presenter bar and twin toolbar |
| Labeled classical fallback when FlyVis is unavailable | Implemented: the run switches for good to "Optical-flow baseline (classical fallback — FlyVis unavailable)" | Controller label in the fly reflex panel and status |
| Local planner when OpenAI Decisions is unavailable | Implemented: refusal, timeout, error or a missing key falls back to the local planner; the planner label reads "Local planner" | Status strip "Mission planner" |
| Recorded replay of a saved bundle with phase rail, timeline and outcome | Implemented, needs a production build and a headed check | `/replay` (stage), `/results` (detail) |
| Integrated end-to-end rescue (breach → search → suppress → reassess → guide → assembly point) | **Required, does not pass yet** | `npm run test:e2e` |
| FlyVis + trained readout in the mission | **Not available in the mission yet.** The trained readout exists for the course comparison only; selecting it makes a run refuse to start. Use "FlyVis + engineered readout". | [controller comparison](results/controller-comparison.md) |
| A labeled saved full rescue for the replay fallback | **Required, does not exist yet** (no run completes) | `public/runs/` (local, not committed) |
| Live caller voice intake | **Not connected** (P1). Typed intake only. | Report intake panel |
| Paired seeded batch results | **Required.** No full batch has run. | `/results` |
| Headed three-minute rehearsal with live FlyVis | **Required**, not yet done | This document |

## Before the session (T-30 minutes)

The machine is a shared 16 GB Mac. Run one heavy process at a time and use one headed Chrome window. Never open the 3D view in headless Chromium.

1. **Close other heavy work.** Stop batch runs, other dev servers and other browsers.
2. **FlyVis (optional, for the fly-model loop).** `services/flyvis/.venv/bin/python -m flyvis_service.server` from `services/flyvis` (binds 127.0.0.1:3201). If it doesn't start, use the FlyVis-down fallback below. Don't debug it on stage.
3. **OpenAI Decisions (optional).** `OPENAI_API_KEY` in the ignored `.env.local`. Without it the local planner decides, with the same authority and harness checks.
4. **App.** Prefer the production build: `npm run build`, then `npm start`. Both bind 127.0.0.1:3200, which matters on public Wi-Fi. `npm run dev` also binds 127.0.0.1:3200. Reuse a server that is already running.
5. **Saved replay.** Put the bundle you will fall back to in `public/runs/<id>/` (`results.json`, `events.jsonl`, `replay.jsonl`) and list it in `public/runs/index.json`, e.g. `{ "runs": [{ "id": "run-rehearsal-1", "label": "Recorded run, Nov 8 rehearsal" }] }`. The first listed run is the one **Saved replay** opens. The label must describe what the run achieved; the outcome shown always comes from the evaluator result in the bundle. Recordings are not committed.
6. **Browser.** One headed Chrome window at the projector's resolution (test 1280×720 and 1920×1080). Open `/`, wait for the scene to load (twin toolbar reads "Blender export (scene.glb)"), then switch on **Presenter view**.
7. **Fold check.** With Presenter view on, the stage-size phase rail and the whole 3D view must be visible without scrolling, with the action card beside the view. The labels "Digital-twin simulation" and "Troy training scene — real exterior reference; fictional interior and incident" and the pacing badge must be readable from the back of the room.
8. **Run settings.** Controller: **FlyVis + engineered readout** (or **Optical-flow baseline** if FlyVis is down). Mission planner: **OpenAI Decisions (local fallback)** if the key is set, otherwise **Local planner**. Seed: the pinned rehearsal seed (default `demo-001`). Sim speed 1×, raised only visibly (the pacing badge says when time is accelerated).
9. **Open `/replay` once** to confirm the saved bundle loads and has no validation problems listed, then return to `/` and close any extra tab. Only one 3D view should be open at a time.

## The three-minute loop, stage by stage

Times are targets from DemoLoop.md. The phase rail is the audience's map. Its caption is derived from the mission view, so read it rather than ad-libbing a state the rail doesn't show.

| Time | Rail stage | Presenter says | Operator / commander does | Audience should see | If it stalls |
| --- | --- | --- | --- | --- | --- |
| 0:00–0:20 | Report | The paraphrased opening (DemoLoop.md; no direct quotation without approval): after a fire near RPI, a student who helped someone escape described how incomplete the picture was. FlyFireFighter explores what a drone could do in the first minutes. | Operator presses **Start run** before speaking. | Troy exterior, drone outside, the simulation and scene labels, rail at **Report**: "Waiting for the caller's report." | If the scene hasn't loaded, keep talking over the collider view; it is the same simulation. |
| 0:20–0:35 | Report → Approach | "A caller's report is a lead, not a confirmed person." | Judge types (or operator enters) "Someone may be in the upstairs rear bedroom." → **Record report**. Commander presses **Authorize mission**. This approves the bounded envelope, not any intervention. | The report in the rescue record in the caller's words; rail moves to **Approach**: "Approaching the reported upstairs rear bedroom from outside." | If a notice appears instead, read it aloud and use **Reset as new run**; old approvals do not carry over. |
| 0:35–0:55 | Approach | "We turned a model of a fly's visual brain into the drone's reflexes." Point at the fly reflex panel: input frame, model response, readout, executed motion, and where the harness limited the request. | No approvals. Optionally add the prepared obstruction. | Controller label "FlyVis flow/0000/000 + engineered readout" (or the fallback label); braking or turning in the executed motion. | If the label reads the classical fallback, say so: "The fly model is unavailable, so this is the conventional optical-flow controller under its own name." |
| 0:55–1:15 | **Window access** (gate) | "Breaking glass is destructive, so it waits for the commander. The card shows the target, rationale, fresh evidence and modeled effects, including what the exterior camera could not see." | **Commander approves window access** (A or Approve, after the 0.9 s review delay). Rejecting is also a valid demo: honor it. | Gate chip "Needs your approval", then "Approved", "In progress", "Completed"; the drone enters. Nothing breaks before approval. | **Current build: the mission can stop at this gate** (PLAN.md stage 4). If the harness refuses the breach, read the rail caption ("Safety checks refused…") and cut to the saved replay. |
| 1:15–1:40 | Search | "Smoke degrades the same camera the controller uses. Position support is estimated separately." | Operator picks the room the drone is in and presses **Add smoke** (+0.6 /m is the default step) in the experiment controls. | Drone view darkens; rail **Search**; a possible occupant appears as a detection: "a detection is not an evacuation." | If no detection comes, say "no person has been observed yet; the room is not cleared", and cut to the replay if time runs out. |
| 1:40–2:05 | **Suppress fire** (gate) | "The water jet has its own approval: target, dose and constraints. The harness rechecks current evidence before and during discharge." | **Commander approves the water spray.** This approval covers this spray only. | Gate chip states; water remaining falls in the status strip; the fire responds. | If the spray is invalidated (for example by a new observation), say why from the caption. A new spray needs a new approval. |
| 2:05–2:35 | Reassess route → Guide out → Outside | "The action changed conditions, so the route has to be checked again with fresh observations." | No approvals. Optionally switch on **Guidance voice** (local OS voice; disclose it). | Rail **Reassess route**, then **Guide out**. **Outside** is shown only after the simulation evaluator's outcome: "Simulated evacuation completed" only for an evaluator-verified exterior arrival; otherwise "Incomplete: human assistance needed". | Integrated guidance-to-arrival is not passing yet. Do not narrate an arrival the rail doesn't show; cut to the replay. |
| 2:35–2:50 | (outcome visible) | "Here is the record: observations, approvals, executed actions and the outcome." Then the controller comparison, stated as measured: on 24 held-out courses the trained FlyVis readout did **not** improve on the optical-flow baseline, and no controller solved the course family ([controller comparison](results/controller-comparison.md)). | Operator presses **Export run**, opens **Results and replay** or the Q&A drawer. | Rescue record, timeline, outcome, and the actual counts with their denominator. | Use the Q&A drawer's links instead of navigating. |
| 2:50–3:00 | (outcome visible) | "Fly-inspired reflexes, rescue tools, and a firefighter in command. That's FlyFireFighter." | — | Outcome, unresolved occupancy ("no automatic all-clear"), labels. | — |

Never remove waiting, revalidation or a failure from a run you are presenting as live. If you shorten, cut narration or raise sim speed visibly.

## Fallbacks

| Failure | What to do | What to say | What the screen shows |
| --- | --- | --- | --- |
| **FlyVis down** (service not running, or it fails mid-run) | Before the run: choose **Optical-flow baseline**, or start with the FlyVis readout and let it fall back. Mid-run: continue; the switch is permanent for that run. | "The fly model is unavailable, so the drone is flying on the conventional optical-flow controller, under its own label." Don't use the fly-brain line for this run. | Controller label "Optical-flow baseline (classical fallback — FlyVis unavailable)" or "Optical-flow baseline"; a "Controller fallback" timeline entry with the reason. |
| **OpenAI down** (no key, network, refusal, timeout) | Nothing. The worker falls back per decision, and switches the run to local planning if the server is unconfigured. | "Mission choices are coming from the local deterministic planner. Approvals and harness checks are unchanged." | Status strip "Mission planner: Local planner" with the reason. OpenAI is named only when a cloud choice was actually used. |
| **A stage stalls** (refused breach, no progress, contingency with no way forward, or the clock is about to run out) | Say what stopped and why, using the rail caption. Then press **Saved replay** in the presenter bar. It opens `/replay` on the first published bundle. Leaving the live run stops its worker; that's intended. | "That's where this live run stops, and the rail shows why. Here is a recorded run from rehearsal. It's a recording, not live inference." | `/replay`: "Recorded replay — not live inference" banner, stage phase rail, 3D view, timeline. The outcome follows the playhead and appears only when the recording reaches the evaluator's outcome. |
| **Graphics slow** | Reduce load: switch off the drone-camera preview, use the collider view. Don't open a second browser. | "Rendering is reduced; the simulation clock and observation model are unchanged." | Pacing badge, twin toolbar. |
| **Judge rejects an action** | Honor it. The rail holds at that gate and the caption says it was rejected. | "Rejected. The drone needs another way, or the run ends incomplete." | Gate chip "Rejected". |
| **Run ends incomplete** | Leave it on screen. | "Incomplete: human assistance needed. A detection or a safe abort is not a rescue." | Outcome panel and rail halt banner. |
| **Worker unavailable** (fixture banner appears) | Stop. Reload once. If the banner persists, go to the replay. Never present the fixture as a run. | "That's a UI fixture, not a simulation; here is a recorded run instead." | Striped "UI fixture — not a simulation run" banner. |

### Cutting to the saved replay

1. Presenter bar → **Saved replay** (or `/replay` in the address bar; `/replay?run=<id>` picks a specific published run).
2. Check the banner reads "Recorded replay — not live inference" and the scene labels are visible.
3. Press Play (or Space). Use the speed control (up to 16×) to fit the remaining time, and say so when it is accelerated.
4. Use the previous/next approval-gate buttons to jump between gate events, or click a timeline entry to seek to it. Each entry's reason is the recorded harness or commander text.
5. The side column's "Presenter note" tells you in advance how this recording ends. The outcome panel and the rail reveal it only when the playhead reaches the evaluator's outcome. Do not announce it early.
6. Return to `/` afterwards for Q&A. A new live run gets a new run identity; nothing carries over.

The replay rail cannot show **Search** yet, because bundles do not record the estimated pose. It moves from the access gate straight to the spray gate. Replay plays recorded snapshots and events only. No simulator, controller, planner, harness or cloud call runs. The camera and thermal panels are re-rendered from recorded world snapshots, not the frames the controller received. The bundle is validated on load. Problems such as a missing file, a mismatched run id or a stored label that disagrees with the evaluator result are listed, and the outcome wording is recomputed from the evaluator result.

## Judge challenge and localization loss (follow-up, after the main loop)

- **Judge challenge** (presenter bar, available while a spray is pending, approved or discharging): places a simulated person inside the spray's harness-derived region through the ordinary experiment path. The harness is not told. It has to detect them through sensing and refuse or stop the spray. Say: "Approval is not a blank check."
- **Localization loss** (presenter bar): adds 3 m to the simulated localization error. The drone must stop advancing and select a supported contingency; if none exists, the run fails. A refusal is never counted as a rescue.
- DemoLoop.md's saved-checkpoint version of the challenge (load a checkpoint before the water action) needs checkpoint loading, which is **not implemented**. Run the challenge live instead.

## Ninety-second version

Follow the DemoLoop.md table. A teammate should be able to run it alone. Use the same stage view, skip the obstruction and smoke presets, approve both gates promptly, and go to the replay at the first stall.

## Final pre-show checklist

Tick only what was actually exercised on this machine today.

- [ ] Production build passes; server bound to 127.0.0.1:3200.
- [ ] One headed Chrome window; Presenter view keeps the stage rail and the full 3D view above the fold at the projector resolution.
- [ ] FlyVis status known (running, or the classical fallback rehearsed and its line ready).
- [ ] Planner status known (OpenAI configured, or the local planner line ready).
- [ ] Clean start → report → authorize, from a fresh run.
- [ ] Window-access gate reached; approve and reject both rehearsed (the rail holds on reject).
- [ ] Water gate reached and approved; payload decreases. **(Blocked until the integrated mission passes the breach gate.)**
- [ ] Reassess → guide → evaluator outcome shown. **(Blocked until the integrated rescue passes.)**
- [ ] Abort (button and Esc Esc) stops remaining actuation.
- [ ] Judge challenge and localization loss exercised once.
- [ ] Saved bundle published in `public/runs/`, opens from **Saved replay** with no validation problems; its label matches its evaluator outcome.
- [ ] Replay played start to finish with the stage rail, timeline and outcome; outcome appears only at the end.
- [ ] Controller comparison numbers ready exactly as reported, including that the trained readout did not improve on the baseline.
- [ ] Paraphrased opening used, or the exact quotation approved.
- [ ] Browser closed and temporary servers stopped after the rehearsal.
