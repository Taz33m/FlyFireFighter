/**
 * UI fixture: proposals, MissionView assembly and step events. Digests are computed the same way the
 * harness does (sha256 of the canonical ProposalInput) so the approve path carries a real digest, but no
 * harness validated these proposals: findings and history are illustrative.
 */
import type { ActionSpec, Contingency, GuardedMotion, ProposalInput, ProposalRecord, ProposalStatus } from "@/lib/contracts/actions";
import { digestOf } from "@/lib/contracts/canonical";
import type { MissionEventInput } from "@/lib/contracts/events";
import { sub, vec3 } from "@/lib/contracts/frames";
import type { Region } from "@/lib/contracts/geometry";
import { sector, sphere } from "@/lib/contracts/geometry";
import type { MissionView } from "@/lib/mission/protocol";
import { occupancySummary } from "@/lib/evidence/summary";
import { fixtureBelief } from "./fixture-belief";
import type { FixtureContext, FixtureStep } from "./fixture-world";
import { FIXTURE_IDS, FIXTURE_STEPS, SPRAY_AIM, STEP_TICK } from "./fixture-world";

const after = (step: FixtureStep, from: FixtureStep) => FIXTURE_STEPS.indexOf(step) >= FIXTURE_STEPS.indexOf(from);

const BREACH_ACTION: ActionSpec = { kind: "breach_opening", openingId: FIXTURE_IDS.window, standoff: vec3(24.2, -3.35, 5.1), strikePoint: vec3(24.2, -2.96, 5.1) };
const SPRAY_STANDOFF = vec3(22.4, 0.55, 4.4);
const SPRAY_ACTION: ActionSpec = { kind: "spray", standoff: SPRAY_STANDOFF, aimPoint: SPRAY_AIM, flowLps: 0.2, durationTicks: 200 };
const GUIDE_ACTION: ActionSpec = { kind: "guide", trackId: FIXTURE_IDS.track, routeId: FIXTURE_IDS.route, templateIds: ["follow-light", "stay-low"], maxDurationTicks: 6000 };

function input(ctx: FixtureContext, action: ActionSpec, rationale: string, cited: string[], createdTick: number, lifetimeTicks: number): ProposalInput {
  return {
    runId: ctx.runId, aircraftId: ctx.config.aircraftId, proposer: "local_planner", action, rationale, citedEvidence: cited,
    basis: { evidenceRevision: 4, mapRevision: ctx.prior.revision, profileRevision: 1, envelopeRevision: 1, policyRevision: 1 },
    createdTick, expiresTick: createdTick + lifetimeTicks,
  };
}

function record(id: string, proposalInput: ProposalInput, risk: ProposalRecord["risk"], status: ProposalStatus, ctx: FixtureContext): ProposalRecord {
  const proposal = { ...proposalInput, id, digest: digestOf(proposalInput) };
  const approved = status === "executing" || status === "completed";
  return {
    proposal, risk, status, findings: [],
    approval: approved && risk === "consequential" ? { runId: ctx.runId, proposalId: id, digest: proposal.digest, commanderId: ctx.config.commanderId, issuedTick: proposalInput.createdTick + 300, expiresTick: proposalInput.createdTick + 900 } : null,
    execution: null,
    history: [{ tick: proposalInput.createdTick, status: "awaiting_approval", reason: "UI fixture: illustrative history, not a harness decision.", ruleIds: [] }],
  };
}

function statusFor(ctx: FixtureContext, id: string, pendingStep: FixtureStep, executingStep: FixtureStep | null): ProposalStatus {
  if (ctx.rejected.includes(id)) return "rejected";
  if (ctx.step === pendingStep) return "awaiting_approval";
  if (executingStep !== null && ctx.step === executingStep) return "executing";
  return "completed";
}

function proposals(ctx: FixtureContext): ProposalRecord[] {
  const list: ProposalRecord[] = [];
  if (after(ctx.step, "breach_pending")) {
    list.push(record(FIXTURE_IDS.breachProposal, input(ctx, BREACH_ACTION,
      "The report names the upstairs rear bedroom. Its south window is the nearest observed opening; the front door is closed and the stair route is unobserved.",
      ["fx-obs-window"], 4150, 6000), "consequential", statusFor(ctx, FIXTURE_IDS.breachProposal, "breach_pending", null), ctx));
  }
  if (after(ctx.step, "spray_pending")) {
    list.push(record(FIXTURE_IDS.sprayProposal, input(ctx, SPRAY_ACTION,
      "A small fire in the upstairs hall blocks the route from the possible occupant to the stairs. A 0.4 L jet is within the module's flow and range.",
      ["fx-obs-fire", "fx-obs-person"], 7750, 4500), "consequential", statusFor(ctx, FIXTURE_IDS.sprayProposal, "spray_pending", "spraying"), ctx));
  }
  if (ctx.step === "guiding") {
    list.push(record(FIXTURE_IDS.guideProposal, input(ctx, GUIDE_ACTION,
      "The route assessment after suppression supports the stairs; guide with approved light and speech templates.", ["fx-obs-route"], 11750, 6000), "routine", "executing", ctx));
  }
  return list;
}

function affectedRegions(list: readonly ProposalRecord[]): MissionView["affectedRegions"] {
  return list.flatMap(r => {
    const a = r.proposal.action;
    let region: Region | null = null;
    if (a.kind === "breach_opening") region = sphere(a.strikePoint, 1.5);
    if (a.kind === "spray") region = sector(a.standoff, sub(a.aimPoint, a.standoff), (8 * Math.PI) / 180, 4);
    return region === null ? [] : [{ proposalId: r.proposal.id, region }];
  });
}

function motion(ctx: FixtureContext): GuardedMotion | null {
  if (!after(ctx.step, "breach_pending") || ctx.status !== "running") return null;
  const tick = STEP_TICK[ctx.step];
  return {
    requested: { source: "flow_baseline", tick, velocityBody: vec3(1.4, 0.1, 0), yawRateRadps: 0.3 },
    executed: { velocityBody: vec3(0.8, 0.06, 0), yawRateRadps: 0.3 },
    limits: ["speed"],
  };
}

function contingency(ctx: FixtureContext): Contingency | null {
  if (ctx.status !== "aborted") return null;
  return { kind: "hold", maxTicks: 3000, reason: "Abort requested by the commander (UI fixture).", evidenceIds: [], termination: "Hold until the commander resets the run." };
}

export function fixtureView(ctx: FixtureContext): MissionView {
  const belief = fixtureBelief(ctx);
  const list = proposals(ctx);
  const pending = ctx.status === "running" ? list.find(r => r.status === "awaiting_approval") ?? null : null;
  const authorized = after(ctx.step, "breach_pending");
  return {
    runId: ctx.runId, config: ctx.config, status: ctx.status, tick: STEP_TICK[ctx.step], simToWallRatio: null,
    envelope: authorized ? { runId: ctx.runId, revision: 1, approvedBy: ctx.config.commanderId, approvedTick: 650, regions: [{ kind: "box", min: vec3(-10, -20, 0), max: vec3(45, 40, 12) }], maxSpeedMps: 3, ambientCeilingC: 70, endTick: 60650 } : null,
    belief, occupancy: occupancySummary(belief), proposals: list, pendingApproval: pending, affectedRegions: affectedRegions(list),
    motion: motion(ctx),
    controller: { mode: ctx.config.controller, label: "UI fixture — no motion controller is running; motion values are illustrative", source: "flow_baseline", features: {}, neural: null, inputFrameId: ctx.lastFrameId },
    decider: { label: "Local planner", status: "UI fixture — no planner is running", lastChoice: null },
    contingency: contingency(ctx),
    water: { remainingL: belief.aircraft.waterRemainingL, dischargedL: ctx.step === "guiding" ? 0.4 : ctx.step === "spraying" ? 0.38 : 0 },
  };
}

/** Timeline entries for entering a step. Reasons say plainly that no simulator or harness produced them. */
export function stepEvents(step: FixtureStep): Omit<MissionEventInput, "tick">[] {
  const fx = "(UI fixture)";
  switch (step) {
    case "idle": return [{ source: "system", kind: "run.started", reason: `Run opened with the UI fixture driver; no simulator, planner or harness is running ${fx}.` }];
    case "reported": return [{ source: "intake", kind: "report.received", subject: "fx-report-1", reason: `Typed report kept in the reporter's own words; it raises search priority without creating a confirmed person ${fx}.` }];
    case "breach_pending": return [
      { source: "commander", kind: "mission.authorized", reason: `Commander approved the preset mission envelope, revision 1 ${fx}.` },
      { source: "harness", kind: "proposal.proposed", subject: FIXTURE_IDS.breachProposal, ruleIds: ["H1", "H2", "H4", "H6"], reason: `Window access waits for an individual commander approval ${fx}.` },
    ];
    case "spray_pending": return [
      { source: "harness", kind: "execution.completed", subject: FIXTURE_IDS.breachProposal, ruleIds: ["H5", "H11"], reason: `Glass broken at the approved strike point; the opening stays broken after any abort ${fx}.` },
      { source: "evidence", kind: "track.created", subject: FIXTURE_IDS.track, reason: `Possible occupant from a thermal frame labelled oracle fixture, not detector evidence ${fx}.` },
      { source: "harness", kind: "proposal.proposed", subject: FIXTURE_IDS.sprayProposal, ruleIds: ["H2", "H4", "H6"], reason: `Water-jet proposal waits for its own approval; the window approval does not cover it ${fx}.` },
    ];
    case "spraying": return [{ source: "harness", kind: "execution.started", subject: FIXTURE_IDS.sprayProposal, ruleIds: ["H5", "H6", "H11"], reason: `Discharge started after revalidation against current evidence ${fx}.` }];
    case "guiding": return [
      { source: "harness", kind: "execution.completed", subject: FIXTURE_IDS.sprayProposal, reason: `0.40 L discharged; suppression alone does not make the route usable ${fx}.` },
      { source: "evidence", kind: "route.assessed", subject: FIXTURE_IDS.route, reason: `Fresh frames support the stair route after suppression ${fx}.` },
      { source: "harness", kind: "guidance.started", subject: FIXTURE_IDS.guideProposal, ruleIds: ["H8", "H15"], reason: `Light and speech guidance with approved templates while the route stays supported ${fx}.` },
    ];
  }
}
