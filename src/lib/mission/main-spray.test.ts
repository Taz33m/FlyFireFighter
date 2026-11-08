/**
 * Regression (main mission at ded7b9e): the hall fire was first seen from the upstairs study through its door at
 * 215.25 s and the planner went straight to a return; no spray was ever offered, so no water, no fire out, no
 * route support and no guidance. Cause: steering's stricter opening-centre rule (5025f6b: an opening's centre
 * links only to a start or goal within 1 m) had been applied to the reachability search, not only to the
 * preferred path. The study door's hall-side portal lies inside the burning fire's clearance, so the only way in
 * is the leg from the door's centre to the standoff, and every hall spray standoff was reported unreachable; the
 * factory then drops the spray ("No spray standoff ..."). Fixed in steering-graph.ts (legPenalty).
 *
 * 1. On the recorded belief at that sighting (main-fire-sighting.recording.json, an excerpt of the simulated run,
 *    with the runtime's own flight-path test): a spray is offered, reachable through the study door, with water
 *    allowed (H19) and no H14 finding; from the study the harness asks only for fresh coverage (H6), which the
 *    planner gets by flying to the standoff and dwelling facing the fire.
 * 2. That last step through the sensor → evidence → planner → harness path in the staged_spray world (main's fire
 *    after the skipped entry): from the standoff, after a 1.5 s dwell, the spray validates and awaits the
 *    commander with the unconfirmed-class disclosure. (The aircraft is held there, not flown: in that world the
 *    localization estimate puts the fire 7.5 cm farther west, and the leg from the door's centre to the standoff
 *    then passes 1.2 cm inside the fire clearance; in the main run it passed 6 mm outside. The way in is that tight.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { EventLog } from "../contracts/events.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { yawBetween } from "../contracts/frames.ts";
import { digestOf } from "../contracts/canonical.ts";
import { defaultEvidenceConfig } from "../evidence/config.ts";
import { interpretReport } from "../evidence/interpret.ts";
import { EvidenceStore } from "../evidence/store.ts";
import { ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { sprayFireClass, validateProposal } from "../harness/rules.ts";
import { buildCandidateSet } from "../navigation/planner/candidates.ts";
import type { ProposalCandidate } from "../navigation/planner/types.ts";
import { aircraftStatus, estimatedPose, landingSupport } from "../simulation/localization.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";
import { troyMeta } from "./mission-driver.ts";
import { flightPathExists } from "./planner-step.ts";
import { createPresetWorld, loadPreset } from "./scenario.ts";
import { SensingPipeline } from "./sensing.ts";
import { findFlightPath } from "./steering-graph.ts";

interface Recording {
  readonly label: "recording";
  readonly envelope: MissionEnvelope;
  readonly lastInterventionTick: number | null;
  readonly belief: Omit<BeliefSnapshot, "mapPrior">;
}

function offeredSpray(ctx: HarnessContext, lastInterventionTick: number | null): ProposalCandidate | undefined {
  return buildCandidateSet({ belief: ctx.belief, profile: ctx.profile, envelope: ctx.envelope, policy: ctx.policy, lastInterventionTick, proposer: "local_planner", reachable: station => flightPathExists(ctx, station) })
    .candidates.find((c): c is ProposalCandidate => c.tool === "request_suppression" && c.proposal !== null);
}

describe("main mission: the hall fire seen from the study is offered a spray", () => {
  test("on the recorded belief at the first sighting: offered, reachable through the study door, water allowed", () => {
    const recording = JSON.parse(readFileSync(new URL("./main-fire-sighting.recording.json", import.meta.url), "utf8")) as Recording;
    assert.equal(recording.label, "recording");
    const belief: BeliefSnapshot = { ...recording.belief, mapPrior: floorPlanPriorFromScene(troyMeta().meta) };
    const preset = loadPreset(troyMeta().meta, "main", "troy-seed-1", belief.runId);
    const ctx: HarnessContext = { tick: belief.tick, missionStartTick: 0, profile: preset.scenario.profile, policy: DEFAULT_POLICY, envelope: recording.envelope, belief };
    assert.equal(belief.reports[0]?.originalText, "Someone may be in the upstairs rear bedroom.");

    const spray = offeredSpray(ctx, recording.lastInterventionTick);
    assert.ok(spray?.proposal.action.kind === "spray", "a spray is offered at the sighting");
    assert.equal(spray.target.roomId, "room-u-hall");
    const { standoff } = spray.proposal.action;
    const path = findFlightPath({ prior: belief.mapPrior, openings: belief.openings, hazards: belief.hazards, tick: belief.tick, from: belief.pose.position, goal: standoff, clearanceM: ctx.profile.spanM / 2 + 0.05 });
    assert.ok(path !== null && path.via.includes("door-u-study"), "reached through the study door");
    assert.equal(sprayFireClass(spray.proposal.action, ctx).assessment.summary, "Fire class not confirmed; no cooking, fuel or electrical indicator near it.");

    const proposal = { ...spray.proposal, id: `${belief.runId}/p-regression`, digest: digestOf(spray.proposal) };
    const findings = validateProposal({ phase: "submit", proposal, ctx, state: { runId: belief.runId, missionAborted: false, lastInterventionTick: recording.lastInterventionTick, sprays: [] }, status: "proposed", approval: null });
    assert.deepEqual([...new Set(findings.map(f => f.ruleId))], ["H6"], "from the study only fresh coverage is missing");
    assert.match(findings[0].reason, /coverage/);
  });

  test("from its standoff, after a dwell facing the fire, the spray validates and awaits the commander (staged_spray world)", () => {
    const RUN = "run-main-spray";
    const preset = loadPreset(troyMeta().meta, "staged_spray", "troy-seed-1", RUN);
    const world = createPresetWorld(preset);
    const evidence = new EvidenceStore(defaultEvidenceConfig(RUN, preset.prior));
    const sensing = new SensingPipeline(preset.prior);
    const log = new EventLog(RUN);
    const envelope = preset.envelope(RUN, "commander", 0);
    const reading = interpretReport(preset.defaultReport, preset.prior);
    evidence.addReport({ id: `${RUN}/report/1`, runId: RUN, receivedTick: 0, source: "judge", channel: "typed", originalText: preset.defaultReport, roomHint: reading.roomHint, countText: reading.countText, interpretation: "rules", supersedes: null });
    const hold = (position: Vec3, yawRad: number, ticks: number): HarnessContext => {
      world.drone.position = position;
      world.drone.yawRad = yawRad;
      for (const end = world.tick + ticks; world.tick < end;) {
        world.tick += 1;
        sensing.sense(world);
        sensing.ingest(world.tick, evidence, log, preset.prior);
      }
      const belief = evidence.snapshot({ tick: world.tick, pose: estimatedPose(world), aircraft: aircraftStatus(world), landing: landingSupport(world) });
      return { tick: world.tick, missionStartTick: 0, profile: preset.scenario.profile, policy: DEFAULT_POLICY, envelope, belief };
    };
    // The main run's standoff, south of the fire on the east wing's centre line.
    const standoff = { x: 20.873, y: 0.492, z: 4.107 };
    const aim = { x: 20.873, y: 2.092, z: 3.607 };
    const onStation = hold(standoff, yawBetween(standoff, aim), 150);
    const spray = offeredSpray(onStation, null);
    assert.ok(spray !== undefined, "offered from its standoff");
    const harness = new ActionHarness(RUN, log);
    const result = harness.submit(spray.proposal, onStation);
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result.findings));
    const reason = result.proposalId === null ? "" : harness.record(result.proposalId)?.history.at(-1)?.reason ?? "";
    assert.match(reason, /Extinguishing agent \(H19\): water\. Fire class not confirmed; no cooking, fuel or electrical indicator near it\.$/);
  });
});
