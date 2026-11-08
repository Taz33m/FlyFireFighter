/**
 * Per-tick execution of an action that monitoring has already cleared for this tick.
 *
 * Pure: from the proposal, the effects so far, the route cursor and the context, it returns this tick's
 * actuator commands, the new effects and whether the action completed. Only the harness calls it, after
 * monitoring, and only the harness issues the resulting batch. Discharge is computed from whole ticks, so
 * a spray stopped after k ticks has discharged exactly k ticks of flow and never more than its dose.
 */
import type { ActionProposal, ActionSpec, ActuationEffects, ActuatorCommand } from "../contracts/actions.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { BreachSpec, SpraySpec } from "./effects.ts";
import { dischargedAfterTicks } from "./effects.ts";
import { guideLeadIndex } from "./person-clearance.ts";
import type { HarnessContext } from "./policy.ts";
import { findRoute } from "./rules.ts";

type GuideSpec = Extract<ActionSpec, { readonly kind: "guide" }>;

/** Route-following state for return and guide; the goal is what the motion controller steers toward. */
export interface ExecutionCursor {
  readonly waypointIndex: number;
  /** Translation goal for the motion controller, or null to hold position. */
  readonly goal: Vec3 | null;
}

export interface TickOutcome {
  readonly commands: readonly ActuatorCommand[];
  readonly effects: ActuationEffects;
  readonly cursor: ExecutionCursor;
  readonly complete: boolean;
}

type Progress = Omit<TickOutcome, "cursor">;

export const NO_EFFECTS: ActuationEffects = deepFreeze({ waterDischargedL: 0, strikeDelivered: false, payloadReleased: false, cuesIssued: 0, ticksExecuted: 0 });

const HOLD_POSITION: ExecutionCursor = deepFreeze({ waypointIndex: 0, goal: null });

export function initialCursor(proposal: ActionProposal, ctx: HarnessContext): ExecutionCursor {
  return nextCursor(proposal, ctx, HOLD_POSITION);
}

/** One executed tick. `effects` are the effects before this tick. */
export function executeTick(proposal: ActionProposal, effects: ActuationEffects, cursor: ExecutionCursor, ctx: HarnessContext): TickOutcome {
  const next = nextCursor(proposal, ctx, cursor);
  const progressed: ActuationEffects = { ...effects, ticksExecuted: effects.ticksExecuted + 1 };
  return { ...progress(proposal, progressed, next, ctx), cursor: next };
}

function progress(proposal: ActionProposal, effects: ActuationEffects, cursor: ExecutionCursor, ctx: HarnessContext): Progress {
  const action = proposal.action;
  const id = proposal.id;
  switch (action.kind) {
    case "spray":
      return spray(id, action, effects);
    case "breach_opening":
      return breach(id, action, effects, ctx);
    case "release_payload":
      return { commands: [{ kind: "release", proposalId: id, payloadId: action.payloadId, point: copy(action.releasePoint) }], effects: { ...effects, payloadReleased: true }, complete: true };
    case "speak":
      return { commands: [{ kind: "audio", proposalId: id, templateId: action.templateId }], effects: { ...effects, cuesIssued: effects.cuesIssued + 1 }, complete: true };
    case "guide":
      return guide(id, action, effects, cursor, ctx);
    case "move":
      return { commands: [], effects, complete: arrived(ctx, action.goal) };
    case "land":
      return { commands: [], effects, complete: arrived(ctx, action.site) };
    case "return":
      return { commands: [], effects, complete: routeFinished(ctx, action.routeId, cursor) };
    case "hold":
    case "scan":
      return { commands: [], effects, complete: effects.ticksExecuted >= action.durationTicks };
  }
}

function spray(id: string, action: SpraySpec, effects: ActuationEffects): Progress {
  const totalL = dischargedAfterTicks(action, effects.ticksExecuted);
  const volumeL = Math.max(0, totalL - effects.waterDischargedL);
  const commands: ActuatorCommand[] = volumeL > 0 ? [{ kind: "water", proposalId: id, flowLps: action.flowLps, volumeL, aimPoint: action.aimPoint }] : [];
  return { commands, effects: { ...effects, waterDischargedL: totalL }, complete: effects.ticksExecuted >= action.durationTicks };
}

/** Wait strikeDelayTicks (each one monitored), then exactly one strike. */
function breach(id: string, action: BreachSpec, effects: ActuationEffects, ctx: HarnessContext): Progress {
  const delayTicks = ctx.profile.modules.glassBreaker?.strikeDelayTicks ?? 0;
  if (effects.ticksExecuted <= delayTicks) return { commands: [], effects, complete: false };
  return {
    commands: [{ kind: "strike", proposalId: id, openingId: action.openingId, point: copy(action.strikePoint) }],
    effects: { ...effects, strikeDelivered: true },
    complete: true,
  };
}

/** A light cue at the next route waypoint every tick; audio cycling the templates every guidance period. */
function guide(id: string, action: GuideSpec, effects: ActuationEffects, cursor: ExecutionCursor, ctx: HarnessContext): Progress {
  const commands: ActuatorCommand[] = [];
  const modules = ctx.profile.modules;
  if (modules.lightCue && cursor.goal) commands.push({ kind: "light_cue", proposalId: id, target: copy(cursor.goal) });
  const elapsed = effects.ticksExecuted - 1;
  const period = Math.max(1, ctx.policy.guidanceAudioPeriodTicks);
  if (modules.speaker && elapsed % period === 0) {
    commands.push({ kind: "audio", proposalId: id, templateId: action.templateIds[Math.floor(elapsed / period) % action.templateIds.length] });
  }
  return { commands, effects: { ...effects, cuesIssued: effects.cuesIssued + commands.length }, complete: effects.ticksExecuted >= action.maxDurationTicks };
}

function arrived(ctx: HarnessContext, target: Vec3): boolean {
  return distance(ctx.belief.pose.position, target) <= ctx.policy.arrivalToleranceM;
}

function routeFinished(ctx: HarnessContext, routeId: string, cursor: ExecutionCursor): boolean {
  const waypoints = findRoute(ctx, routeId)?.waypoints ?? [];
  const last = waypoints.length - 1;
  return last >= 0 && cursor.waypointIndex >= last && arrived(ctx, waypoints[last]);
}

function nextCursor(proposal: ActionProposal, ctx: HarnessContext, cursor: ExecutionCursor): ExecutionCursor {
  const action = proposal.action;
  switch (action.kind) {
    case "move":
      return { waypointIndex: 0, goal: copy(action.goal) };
    case "land":
      return { waypointIndex: 0, goal: copy(action.site) };
    case "return":
      return returnCursor(ctx, action.routeId, cursor);
    case "guide":
      return guideCursor(ctx, action, cursor);
    default:
      return HOLD_POSITION;
  }
}

/** Advance through each waypoint the aircraft has reached; the route's latest assessment supplies the waypoints. */
function returnCursor(ctx: HarnessContext, routeId: string, cursor: ExecutionCursor): ExecutionCursor {
  const waypoints = findRoute(ctx, routeId)?.waypoints ?? [];
  if (waypoints.length === 0) return cursor;
  const last = waypoints.length - 1;
  let index = Math.min(cursor.waypointIndex, last);
  while (index < last && arrived(ctx, waypoints[index])) index += 1;
  return { waypointIndex: index, goal: copy(waypoints[index]) };
}

/**
 * Lead the occupant from ahead: target the first waypoint past the one nearest the occupant's estimated
 * position that lies beyond the guidance distance from them (guideLeadIndex), so the aircraft is never sent
 * to a goal beside the person it guides. The target never moves backwards, so a noisy track cannot send the
 * light back toward the hazard.
 */
function guideCursor(ctx: HarnessContext, action: GuideSpec, cursor: ExecutionCursor): ExecutionCursor {
  const waypoints = findRoute(ctx, action.routeId)?.waypoints ?? [];
  if (waypoints.length === 0) return cursor;
  const last = waypoints.length - 1;
  const track = ctx.belief.tracks.find(t => t.id === action.trackId);
  const ahead = track ? guideLeadIndex(waypoints, track, ctx) : 0;
  const index = Math.min(Math.max(cursor.waypointIndex, ahead), last);
  return { waypointIndex: index, goal: copy(waypoints[index]) };
}

/** Issued batches are frozen; copy vectors so freezing never reaches caller-owned belief objects. */
function copy(v: Vec3): Vec3 {
  return vec3(v.x, v.y, v.z);
}
