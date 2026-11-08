/**
 * Harness plumbing for a course run: the mission envelope, a truth-free belief snapshot built from the
 * simulator's ESTIMATES (estimatedPose, aircraftStatus, landingSupport — the same calls the mission runtime
 * snapshots), and the single routine move proposal to the course goal. Every actuator path of a course run
 * goes through ActionHarness.step with this context; nothing here hands truth to the harness.
 */
import type { ProposalInput } from "../../contracts/actions.ts";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { Tick } from "../../contracts/clock.ts";
import type { MissionEnvelope } from "../../contracts/envelope.ts";
import type { BeliefSnapshot, FloorPlanPrior } from "../../contracts/evidence.ts";
import { vec3 } from "../../contracts/frames.ts";
import { box } from "../../contracts/geometry.ts";
import type { RunId } from "../../contracts/ids.ts";
import { ActionHarness } from "../../harness/harness.ts";
import type { HarnessContext } from "../../harness/policy.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import { EventLog } from "../../contracts/events.ts";
import { aircraftStatus, estimatedPose, landingSupport } from "../../simulation/localization.ts";
import { floorPlanPriorFromScene } from "../../simulation/prior.ts";
import type { WorldState } from "../../simulation/world-state.ts";
import type { CourseSpec } from "./course.ts";

export interface CourseHarness {
  readonly harness: ActionHarness;
  readonly log: EventLog;
  readonly envelope: MissionEnvelope;
  readonly prior: FloorPlanPrior;
  context(world: WorldState): HarnessContext;
}

export function courseHarness(spec: CourseSpec, runId: RunId, budgetTicks: Tick): CourseHarness {
  const log = new EventLog(runId);
  const harness = new ActionHarness(runId, log);
  const { interior, layout } = spec;
  const envelope: MissionEnvelope = {
    runId, revision: 1, approvedBy: "course-runner", approvedTick: 0,
    regions: [box(vec3(interior.minX, interior.minY, 0), vec3(interior.maxX, interior.maxY, layout.heightM))],
    maxSpeedMps: 2, ambientCeilingC: 70, endTick: budgetTicks + 200,
  };
  const prior = floorPlanPriorFromScene(spec.meta);
  const context = (world: WorldState): HarnessContext => ({ tick: world.tick, missionStartTick: 0, profile: TENDER_T1, policy: DEFAULT_POLICY, envelope, belief: belief(world, runId, prior) });
  return { harness, log, envelope, prior, context };
}

function belief(world: WorldState, runId: RunId, prior: FloorPlanPrior): BeliefSnapshot {
  return {
    runId, tick: world.tick, evidenceRevision: 0, mapPrior: prior, mapRevision: prior.revision, mapChanges: [],
    pose: estimatedPose(world), aircraft: aircraftStatus(world), landing: landingSupport(world),
    observations: [], reports: [], tracks: [], crewConfirmations: [], coverage: [], hazards: [], openings: [], routes: [], dispatchConfirmed: null,
  };
}

/** Submit and start the routine move to the course goal; throws if the harness refuses (a course bug). */
export function startMove(h: CourseHarness, spec: CourseSpec, world: WorldState): string {
  const ctx = h.context(world);
  const input: ProposalInput = {
    runId: h.harness.runId, aircraftId: TENDER_T1.id, proposer: "local_planner",
    action: { kind: "move", goal: spec.goal, maxSpeedMps: spec.speedCapMps },
    rationale: `Course ${spec.courseId}: fly to the goal at the end of the corridor.`, citedEvidence: [],
    basis: { evidenceRevision: 0, mapRevision: h.prior.revision, profileRevision: TENDER_T1.revision, envelopeRevision: h.envelope.revision, policyRevision: DEFAULT_POLICY.revision },
    createdTick: world.tick, expiresTick: world.tick + DEFAULT_POLICY.maxProposalLifetimeTicks,
  };
  const submitted = h.harness.submit(input, ctx);
  if (!submitted.accepted || submitted.proposalId === null || submitted.digest === null) throw new Error(`Move refused: ${submitted.findings.map(f => f.reason).join(" ")}`);
  const started = h.harness.requestExecution({ type: "execute", runId: h.harness.runId, proposalId: submitted.proposalId, digest: submitted.digest, requestId: `${h.harness.runId}/move`, tick: world.tick }, ctx);
  if (!started.accepted) throw new Error(`Move did not start: ${started.reason} ${started.findings.map(f => f.reason).join(" ")}`);
  return submitted.proposalId;
}
