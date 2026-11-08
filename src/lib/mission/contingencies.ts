/**
 * Contingency triggers the runtime watches (harness open issues): the envelope time box ending, the return
 * reserve being reached, localization being lost and the ambient temperature at the aircraft nearing its limits
 * (the aircraft's hard limit or the envelope ceiling, or the profile's exposure budget above its warning
 * temperature); plus the maneuver a mission abort starts. Ambient comes from the aircraft's own reading in the
 * belief, never from the simulator.
 *
 * The harness owns contingencies: harness.startContingency(trigger, ctx) selects the maneuver from current
 * evidence, validates it under the same rules and starts it in the same tick (preempting executing motion),
 * or records an explicit failure (terminal; the guard brakes and descends) and starts nothing. A mission
 * abort starts its contingency inside the harness too. This monitor only decides WHEN to ask, keeps the
 * contingency in force for the view, and tags the harness's proposal for the planner and steering.
 */
import type { Contingency } from "../contracts/actions.ts";
import type { ProposalId } from "../contracts/ids.ts";
import type { AbortResult, ContingencyStartResult } from "../harness/harness.ts";
import type { ContingencyTrigger } from "../harness/contingency.ts";
import { reserveStatus } from "../harness/contingency.ts";
import { localizationSupportsAdvance } from "../harness/motion-guard.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { MissionPlanner, PlannerTick } from "./planner-step.ts";

/** A fresh selection is not attempted more often than this while its trigger persists. */
export const RESELECT_TICKS = 500;
/** With no usable return route, the reserve trigger fires once endurance above the reserve falls below this. */
export const RESERVE_WITHOUT_ROUTE_S = 60;
/** Withdraw once ambient is within this of the aircraft's hard limit or the envelope ceiling, whichever is lower. */
export const AMBIENT_MARGIN_C = 5;
/** Withdraw once this fraction of the profile's exposure budget above its warning temperature is spent. */
export const EXPOSURE_WITHDRAW_FRACTION = 0.75;

export class ContingencyMonitor {
  current: Contingency | null = null;
  private wasLocalized = true;
  private lastSelectionTick = -Infinity;
  /** A landing contingency in progress; once it completes the aircraft is down and nothing is reselected. */
  private landingId: ProposalId | null = null;
  /** Seconds the aircraft's ambient reading has been above the profile's warning temperature this run. */
  secondsAboveWarn = 0;

  /** Check the triggers once per tick, after the belief is current and before planning. */
  check(t: PlannerTick, planner: MissionPlanner): void {
    const ambientC = t.ctx.belief.aircraft.ambientC;
    if (ambientC !== null && ambientC > t.ctx.profile.hardLimits.warnAmbientC) this.secondsAboveWarn += TICK_S;
    const localized = localizationSupportsAdvance(t.ctx);
    const lost = this.wasLocalized && !localized;
    this.wasLocalized = localized;
    const landed = this.landingId !== null && t.harness.record(this.landingId)?.status === "completed";
    if (t.harness.terminalFailure || landed || contingencyExecuting(t)) return;
    const trigger = lost ? "localization_lost" : this.persistentTrigger(t);
    if (trigger === null) return;
    this.lastSelectionTick = t.ctx.tick;
    this.adopt(t.harness.startContingency(trigger, t.ctx), planner);
  }

  /** A mission abort (commander or runtime): the harness started its contingency in the same tick. */
  afterAbort(result: AbortResult, t: PlannerTick, planner: MissionPlanner): void {
    if (result.contingency === null) return;
    this.lastSelectionTick = t.ctx.tick;
    this.current = result.contingency;
    this.tag(result.contingencyRecord, result.contingency, planner);
  }

  private adopt(result: ContingencyStartResult, planner: MissionPlanner): void {
    this.current = result.contingency;
    this.tag(result.record, result.contingency, planner);
  }

  private tag(record: AbortResult["contingencyRecord"], contingency: Contingency, planner: MissionPlanner): void {
    if (record === null || record.status !== "executing") return;
    planner.meta.set(record.proposal.id, { candidateId: null, focus: null, station: null, role: "contingency" });
    if (contingency.kind === "land") this.landingId = record.proposal.id;
  }

  private persistentTrigger(t: PlannerTick): ContingencyTrigger | null {
    if (t.ctx.tick - this.lastSelectionTick < RESELECT_TICKS) return null;
    if (t.harness.missionAborted) return "commander_abort";
    if (t.ctx.tick > t.ctx.envelope.endTick) return "envelope_expired";
    const reserve = reserveStatus(t.ctx);
    const spareS = t.ctx.belief.aircraft.enduranceRemainingS - t.ctx.profile.hardLimits.returnReserveS;
    if (reserve.marginS !== null ? reserve.marginS <= 0 : spareS < RESERVE_WITHOUT_ROUTE_S) return "reserve";
    if (ambientWithdrawal(t, this.secondsAboveWarn)) return "ambient_limit";
    return null;
  }
}

/**
 * Whether heat calls for withdrawing: the aircraft's ambient reading within AMBIENT_MARGIN_C of the lower of its
 * hard limit and the envelope ceiling, or EXPOSURE_WITHDRAW_FRACTION of its exposure budget above the warning
 * temperature already spent. The harness then selects the maneuver (return, hold or land) from current evidence.
 */
export function ambientWithdrawal(t: PlannerTick, secondsAboveWarn: number): boolean {
  const limits = t.ctx.profile.hardLimits;
  const ambientC = t.ctx.belief.aircraft.ambientC;
  const limitC = Math.min(limits.maxAmbientC, t.ctx.envelope.ambientCeilingC);
  if (ambientC !== null && ambientC >= limitC - AMBIENT_MARGIN_C) return true;
  return secondsAboveWarn >= EXPOSURE_WITHDRAW_FRACTION * limits.maxExposureAboveWarnS;
}

function contingencyExecuting(t: PlannerTick): boolean {
  return t.harness.records().some(r => r.status === "executing" && r.proposal.proposer === "contingency");
}
