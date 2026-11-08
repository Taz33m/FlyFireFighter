/**
 * The kitchen_grease_fire variant (scenario.ts) through the runtime's own sensor → evidence → planner and
 * harness path, with no simulator truth past the sensors: the cameras see the kitchen fire, the caller's report
 * says a pan of oil caught fire, the planner offers no spray and says why, and the harness refuses a spray
 * proposed anyway (H19), also from the prior's kitchen alone. The main hall fire, seen the same way, stays
 * sprayable with the unconfirmed-class disclosure.
 *
 * Scope: the Troy scene; the aircraft is held (not flown) 1.5 m from each fire, facing it, and the clock is
 * advanced; no full mission (mission.e2e.test.ts flies main). The fire model has no oil chemistry: the kitchen
 * fire is main's fire moved to the counter, labelled as a stand-in.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalInput } from "../contracts/actions.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { EventLog } from "../contracts/events.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import { representativePoint } from "../contracts/geometry.ts";
import { defaultEvidenceConfig } from "../evidence/config.ts";
import { interpretReport } from "../evidence/interpret.ts";
import { EvidenceStore } from "../evidence/store.ts";
import { ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { fireClassDisclosure, sprayFireClass } from "../harness/rules.ts";
import { buildCandidateSet } from "../navigation/planner/candidates.ts";
import { aircraftStatus, estimatedPose, landingSupport } from "../simulation/localization.ts";
import { troyMeta } from "./mission-driver.ts";
import type { PresetVariant } from "./scenario.ts";
import { createPresetWorld, loadPreset } from "./scenario.ts";
import { SensingPipeline } from "./sensing.ts";

const RUN = "run-grease-fire";

/** Holds the aircraft at `position` facing +x or +y (yaw), reports the preset's default report at tick 1, and senses until `end`. */
function observe(variant: PresetVariant, position: Vec3, yawRad: number, end: number, report: boolean) {
  const preset = loadPreset(troyMeta().meta, variant, "troy-seed-1", RUN);
  const world = createPresetWorld(preset);
  world.drone.position = position;
  world.drone.yawRad = yawRad;
  const evidence = new EvidenceStore(defaultEvidenceConfig(RUN, preset.prior));
  const sensing = new SensingPipeline(preset.prior);
  const log = new EventLog(RUN);
  for (let tick = world.tick; tick <= end; tick++) {
    world.tick = tick;
    if (tick === 1 && report) {
      const text = preset.defaultReport;
      const reading = interpretReport(text, preset.prior);
      evidence.addReport({ id: `${RUN}/report/1`, runId: RUN, receivedTick: tick, source: "caller", channel: "typed", originalText: text, roomHint: reading.roomHint, countText: reading.countText, interpretation: "rules", supersedes: null });
    }
    sensing.sense(world);
    sensing.ingest(tick, evidence, log, preset.prior);
  }
  const belief = evidence.snapshot({ tick: end, pose: estimatedPose(world), aircraft: aircraftStatus(world), landing: landingSupport(world) });
  const envelope = preset.envelope(RUN, "commander", 0);
  const ctx: HarnessContext = { tick: end, missionStartTick: 0, profile: preset.scenario.profile, policy: DEFAULT_POLICY, envelope, belief };
  return { preset, belief, ctx, set: buildCandidateSet({ belief, profile: preset.scenario.profile, envelope, policy: DEFAULT_POLICY, lastInterventionTick: null, proposer: "local_planner" }) };
}

function flames(belief: BeliefSnapshot) {
  return belief.hazards.filter(h => h.hazard === "fire" && h.intensity > 0).sort((a, b) => a.tick - b.tick);
}

/** A spray 1.5 m from the latest flame sighting, toward it, as a proposer might submit it anyway. */
function sprayAtLatestFlame(ctx: HarnessContext, from: Vec3): ProposalInput {
  const belief = ctx.belief;
  const latest = flames(belief).at(-1);
  assert.ok(latest !== undefined, "the fire is seen burning");
  const aim = representativePoint(latest.region);
  return {
    runId: RUN,
    aircraftId: ctx.profile.id,
    proposer: "operator",
    action: { kind: "spray", standoff: from, aimPoint: aim, flowLps: 0.1, durationTicks: 300 },
    rationale: "Test: spray the kitchen fire anyway.",
    citedEvidence: [latest.observationId],
    basis: { evidenceRevision: belief.evidenceRevision, mapRevision: belief.mapRevision, profileRevision: ctx.profile.revision, envelopeRevision: ctx.envelope.revision, policyRevision: ctx.policy.revision },
    createdTick: belief.tick,
    expiresTick: belief.tick + 3000,
  };
}

describe("kitchen grease fire variant", () => {
  const KITCHEN_VIEW = vec3(24.4, 1.0, 1.9);

  test("the planner offers no spray at the kitchen fire and its note names the caller's pan of oil and the kitchen", () => {
    const { belief, set } = observe("kitchen_grease_fire", KITCHEN_VIEW, 0, 100, true);
    assert.ok(flames(belief).length > 0, "the cameras see the kitchen fire burning");
    assert.match(belief.reports[0]?.originalText ?? "", /A pan of oil caught fire on the stove in the kitchen\.$/);
    assert.deepEqual(set.candidates.filter(c => c.tool === "request_suppression").map(c => c.id), []);
    const note = set.notes.find(n => n.startsWith("Suppression is not available for the fire in Kitchen and dining room: Water is unsafe for a possible cooking-oil or grease fire (class K/F): caller report"));
    assert.ok(note, set.notes.join("\n"));
    assert.match(note, /mentions "pan", "oil", "stove" in the Kitchen and dining room/);
  });

  test("the harness refuses a spray proposed anyway: H19 from the report, and from the prior's kitchen without it", () => {
    for (const report of [true, false]) {
      const { ctx } = observe("kitchen_grease_fire", KITCHEN_VIEW, 0, 100, report);
      const harness = new ActionHarness(RUN, new EventLog(RUN));
      const result = harness.submit(sprayAtLatestFlame(ctx, vec3(24.4, 1.0, 1.42)), ctx);
      assert.equal(result.accepted, false);
      const agent = result.findings.find(f => f.ruleId === "H19");
      assert.ok(agent, JSON.stringify(result.findings));
      assert.match(agent.reason, /the fire is in the Kitchen and dining room \(floor-plan prior: a kitchen\)/);
      if (report) assert.match(agent.reason, /caller report run-grease-fire\/report\/1 mentions "pan", "oil", "stove"/);
      else assert.doesNotMatch(agent.reason, /caller report/);
    }
  });

  test("regression: main's hall fire, seen the same way, is offered a spray the harness's agent rule allows, with the disclosure", () => {
    // staged_spray: main's hall fire after the skipped entry, the aircraft held 1.5 m south of it facing north (as fire-out.test.ts).
    const { belief, ctx, set } = observe("staged_spray", vec3(20.85, 0.6, 4.6), Math.PI / 2, 100, true);
    assert.equal(belief.reports[0]?.originalText, "Someone may be in the upstairs rear bedroom.");
    const spray = set.candidates.find(c => c.tool === "request_suppression");
    assert.ok(spray?.proposal?.action.kind === "spray", set.notes.join("\n"));
    assert.equal(sprayFireClass(spray.proposal.action, ctx).assessment.waterSuitable, true);
    assert.equal(fireClassDisclosure(spray.proposal.action, ctx), "Extinguishing agent (H19): water. Fire class not confirmed; no cooking, fuel or electrical indicator near it.");
    const result = new ActionHarness(RUN, new EventLog(RUN)).submit(spray.proposal, ctx);
    assert.equal(result.findings.some(f => f.ruleId === "H19"), false, JSON.stringify(result.findings));
  });
});
