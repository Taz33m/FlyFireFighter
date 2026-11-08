/**
 * Which point the motion controller steers toward this tick, from harness state and the belief only:
 * - an executing motion action's goal (move goal, route waypoint, landing site, guidance waypoint);
 * - for a hold or scan (no goal), the estimated position where it began, so station keeping does not drift;
 * - with no motion action but an intervention executing: a spray's or release's standoff (station keeping
 *   against jet recoil while the harness limits speed), or for a docked breach the estimated position where
 *   it began executing (its standoff lies behind the docked aircraft);
 * - otherwise nothing: the harness gates every request without a validated goal.
 * The focus (what the action looks at) shapes the final approach and, while the aircraft holds, the heading it
 * turns to (steering.ts, command.ts). It is a scan's look-at point, the planner's record of the candidate
 * behind a proposal, or an executing intervention's aim or strike point. The planner holds a station with
 * such a scan during its dwell and while an intervention awaits approval or is approved (planner-step.ts).
 */
import type { Vec3 } from "../contracts/frames.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { ProposalId } from "../contracts/ids.ts";
import type { ActionHarness } from "../harness/harness.ts";
import { INTERVENTION_KINDS } from "../harness/policy.ts";
import type { MissionPlanner } from "./planner-step.ts";
import { interventionFocus, stationOf } from "./planner-step.ts";

export interface SteeringGoal {
  readonly goal: Vec3;
  readonly focus: Vec3 | null;
  readonly proposalId: ProposalId;
}

export class GoalSelector {
  private anchor: { readonly id: ProposalId; readonly point: Vec3 } | null = null;

  select(harness: ActionHarness, planner: MissionPlanner, belief: BeliefSnapshot): SteeringGoal | null {
    const active = harness.activeMotion();
    if (active !== null) {
      const id = active.proposal.id;
      const action = active.proposal.action;
      const lookAt = action.kind === "scan" ? action.lookAt : null;
      if (active.goal !== null) return { goal: active.goal, focus: lookAt ?? planner.meta.get(id)?.focus ?? null, proposalId: id };
      return { goal: this.anchorFor(id, belief), focus: lookAt, proposalId: id };
    }
    const intervention = harness.records().find(r => r.status === "executing" && INTERVENTION_KINDS.has(r.proposal.action.kind));
    const station = intervention === undefined ? null : stationOf(intervention.proposal);
    if (intervention === undefined || station === null) return null;
    const id = intervention.proposal.id;
    // A spray or release keeps station on its standoff, so jet recoil is pulled back rather than accumulated
    // from wherever execution began (H11 stops it beyond the 0.4 m tolerance). A docked breach holds where it
    // docked: its standoff lies behind the aircraft, and steering there would back it away from the pane.
    const goal = intervention.proposal.action.kind === "breach_opening" ? this.anchorFor(id, belief) : station;
    return { goal, focus: interventionFocus(intervention.proposal, planner.meta.get(id)), proposalId: id };
  }

  /** The estimated position when the proposal first needed an anchor. */
  private anchorFor(id: ProposalId, belief: BeliefSnapshot): Vec3 {
    if (this.anchor === null || this.anchor.id !== id) this.anchor = { id, point: belief.pose.position };
    return this.anchor.point;
  }
}
