/**
 * Independent mission evaluator: scores a run from hidden simulation truth. Its output is labelled
 * simulation evidence and never flows back into planning, motion control, the evidence store or the harness
 * (none of which may import this module).
 *
 * Violations:
 * - collision: every recorded collision with the scene, and every contact episode between the aircraft and
 *   an occupant's body (trace.ts);
 * - hazardous_discharge: water that reached an occupant (one per proposal and occupant), and glass debris or
 *   a released payload that reached an occupant (one per event and occupant; truth footprints in trace.ts);
 * - unauthorized_actuation: a window broken other than the one commanded (localization error can move a strike);
 * - envelope_breach: true-position breaches of the approved regions (per episode), true horizontal speed
 *   above the envelope's speed ceiling, ambient at the aircraft above the envelope's ambient ceiling, and
 *   each episode of motion after the envelope time box that no contingency owned;
 * - hard_limit: true horizontal or vertical speed above the aircraft limit, ambient above the maximum, too
 *   long above the warning temperature, endurance exhausted.
 * Speed ceilings allow SPEED_TOLERANCE_MPS (trace.ts). All of these come from a MissionTrace recorded every
 * tick; late motion is excused only on ticks the run loop marked as contingency-owned (TickContext). Without
 * a trace, only the final state is checked (as a one-tick trace: final position, speed, ambient, contact,
 * and every debris or payload event, both sides of a pane, against the occupants' FINAL positions — a
 * conservative stand-in for where they were); a trace that ends before the final tick is extended by the
 * final state on a copy.
 *
 * An occupant counts as having reached the assembly point only with an arrival tick AND a true final
 * position inside the assembly box. Drone return is reported separately and never affects the rescue outcome.
 */
import type { Tick } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { regionContains } from "../contracts/geometry.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { ConstraintViolation, DroneReturnResult, EvaluatorOccupantResult, MissionResult } from "../contracts/outcomes.ts";
import { droneRadiusM, isTouchedDown } from "../simulation/collisions.ts";
import { locateFeet } from "../simulation/occupant-route.ts";
import type { OccupantTruth, WorldState } from "../simulation/world-state.ts";
import type { MissionTrace } from "./trace.ts";
import { createMissionTrace, OCCUPANT_CONTACT_MARGIN_M, recordTick, SPEED_TOLERANCE_MPS } from "./trace.ts";

export const HARD_LIMIT_SPEED_TOLERANCE_MPS = SPEED_TOLERANCE_MPS;

export interface EvaluationOptions {
  /** Per-tick truth trace; without it only the final state is checked. */
  readonly trace?: MissionTrace;
  /** The run's event log recorded a contingency failure (no supported maneuver remained). */
  readonly failureRecorded?: boolean;
}

export function evaluateMission(world: WorldState, envelope: MissionEnvelope, budgetTick: Tick, launchZone: Region, options: EvaluationOptions = {}): MissionResult {
  if (options.trace && options.trace.runId !== world.runId) throw new Error("Trace belongs to a different run.");
  const trace = traceThroughFinalTick(world, envelope, options.trace);
  const violations = [
    ...eventViolations(world),
    ...occupantViolations(world, trace),
    ...envelopeViolations(trace),
    ...hardLimitViolations(world, trace),
  ].sort((a, b) => a.tick - b.tick);
  return deepFreeze({
    label: "simulation_evaluator",
    runId: world.runId,
    seed: world.seed,
    endedTick: world.tick,
    budgetTick,
    occupants: world.occupants.map(o => occupantResult(world, o)),
    violations,
    droneReturn: droneReturn(world, launchZone, trace, options.failureRecorded === true),
  });
}

/** The caller's trace when it covers the final tick; otherwise a copy extended by the final state (the caller's trace is never changed). */
function traceThroughFinalTick(world: WorldState, envelope: MissionEnvelope, trace: MissionTrace | undefined): MissionTrace {
  if (trace && trace.lastTick !== null && trace.lastTick >= world.tick) return trace;
  const covering = trace ? structuredClone(trace) : createMissionTrace(world);
  recordTick(covering, world, envelope);
  return covering;
}

function eventViolations(world: WorldState): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  const wetted = new Map<string, { tick: Tick; ticks: number; litres: number; occupantKey: string; proposalId: string }>();
  for (const event of world.truthEvents) {
    if (event.kind === "collision") out.push({ tick: event.tick, kind: "collision", detail: event.detail });
    if (event.kind === "glass_broken" && event.data.openingId !== event.data.commandedOpeningId) {
      out.push({ tick: event.tick, kind: "unauthorized_actuation", detail: `Window ${String(event.data.openingId)} broke, but the approved strike targeted ${String(event.data.commandedOpeningId)}.` });
    }
    if (event.kind !== "water_on_occupant") continue;
    const occupantKey = String(event.data.occupantKey);
    const proposalId = String(event.data.proposalId);
    const key = `${proposalId}\u0000${occupantKey}`;
    const entry = wetted.get(key) ?? { tick: event.tick, ticks: 0, litres: 0, occupantKey, proposalId };
    entry.ticks += 1;
    entry.litres += Number(event.data.volumeL) || 0;
    wetted.set(key, entry);
  }
  for (const w of wetted.values()) {
    out.push({ tick: w.tick, kind: "hazardous_discharge", detail: `Water jet of proposal ${w.proposalId} reached occupant ${w.occupantKey} on ${w.ticks} tick(s) (${w.litres.toFixed(3)} L discharged meanwhile).` });
  }
  return out;
}

function occupantViolations(world: WorldState, trace: MissionTrace): ConstraintViolation[] {
  const contacts = trace.occupantContacts.map((c): ConstraintViolation => ({
    tick: c.startTick,
    kind: "collision",
    detail: `Aircraft (radius ${droneRadiusM(world).toFixed(2)} m) contacted occupant ${c.occupantKey}'s body for ${c.endTick - c.startTick + 1} tick(s); closest gap ${c.minGapM.toFixed(2)} m (contact at ≤ ${OCCUPANT_CONTACT_MARGIN_M} m).`,
  }));
  const hazards = trace.hazardContacts.map((h): ConstraintViolation => ({
    tick: h.tick,
    kind: "hazardous_discharge",
    detail: h.kind === "glass_debris"
      ? `Glass debris from window ${h.subject} (proposal ${h.proposalId || "unknown"}, broken at tick ${h.sourceTick}) reached occupant ${h.occupantKey}.`
      : `Payload ${h.subject} (proposal ${h.proposalId || "unknown"}, released at tick ${h.sourceTick}) fell onto occupant ${h.occupantKey}.`,
  }));
  return [...contacts, ...hazards];
}

function envelopeViolations(trace: MissionTrace): ConstraintViolation[] {
  const out: ConstraintViolation[] = trace.envelopeBreaches.map(b => ({
    tick: b.startTick,
    kind: "envelope_breach" as const,
    detail: `True aircraft position left the approved envelope for ${b.endTick - b.startTick + 1} tick(s).`,
  }));
  const speed = trace.envelopeSpeedPeak;
  if (speed && speed.value > speed.ceiling + SPEED_TOLERANCE_MPS) {
    out.push({ tick: speed.tick, kind: "envelope_breach", detail: `True horizontal speed reached ${speed.value.toFixed(2)} m/s; the approved envelope allows ${speed.ceiling} m/s.` });
  }
  const ambient = trace.envelopeAmbientPeak;
  if (ambient && ambient.value > ambient.ceiling) {
    out.push({ tick: ambient.tick, kind: "envelope_breach", detail: `Ambient at the aircraft reached ${ambient.value.toFixed(0)} °C; the approved envelope ceiling is ${ambient.ceiling} °C.` });
  }
  for (const m of trace.lateMotion) {
    out.push({ tick: m.startTick, kind: "envelope_breach", detail: `Aircraft moved (up to ${m.peakSpeedMps.toFixed(2)} m/s) for ${m.endTick - m.startTick + 1} tick(s) after the envelope time box ended at tick ${m.envelopeEndTick}, with no contingency in control.` });
  }
  return out;
}

function hardLimitViolations(world: WorldState, trace: MissionTrace): ConstraintViolation[] {
  const limits = world.profile.hardLimits;
  const out: ConstraintViolation[] = [];
  if (trace.maxHorizontalSpeedTick !== null && trace.maxHorizontalSpeedMps > limits.maxSpeedMps + SPEED_TOLERANCE_MPS) {
    out.push({ tick: trace.maxHorizontalSpeedTick, kind: "hard_limit", detail: `True horizontal speed reached ${trace.maxHorizontalSpeedMps.toFixed(2)} m/s; the limit is ${limits.maxSpeedMps} m/s.` });
  }
  if (trace.maxVerticalSpeedTick !== null && trace.maxVerticalSpeedMps > limits.maxVerticalSpeedMps + SPEED_TOLERANCE_MPS) {
    out.push({ tick: trace.maxVerticalSpeedTick, kind: "hard_limit", detail: `True vertical speed reached ${trace.maxVerticalSpeedMps.toFixed(2)} m/s; the limit is ${limits.maxVerticalSpeedMps} m/s.` });
  }
  if (trace.maxAmbientTick !== null && trace.maxAmbientC > limits.maxAmbientC) {
    out.push({ tick: trace.maxAmbientTick, kind: "hard_limit", detail: `Ambient at the aircraft reached ${trace.maxAmbientC.toFixed(0)} °C; the limit is ${limits.maxAmbientC} °C.` });
  }
  if (trace.warnExposureExceededTick !== null) {
    out.push({ tick: trace.warnExposureExceededTick, kind: "hard_limit", detail: `More than ${limits.maxExposureAboveWarnS} s above ${limits.warnAmbientC} °C.` });
  }
  if (trace.enduranceExhaustedTick !== null) out.push({ tick: trace.enduranceExhaustedTick, kind: "hard_limit", detail: "Endurance exhausted." });
  return out;
}

function occupantResult(world: WorldState, o: OccupantTruth): EvaluatorOccupantResult {
  const inside = regionContains(world.scene.assemblyPoint, vec3(o.position.x, o.position.y, o.position.z + 0.05));
  const reached = o.arrivalTick !== null && inside;
  const outside = locateFeet(world.scene, o.position).kind === "exterior";
  const outcome = reached ? "reached_assembly_point" : o.activity === "incapacitated" ? "incapacitated" : outside ? "outside_not_at_assembly_point" : "inside";
  return { label: "simulation_evaluator", occupantKey: o.key, outcome, arrivalTick: reached ? o.arrivalTick : null };
}

/**
 * Drone return (see DroneReturnResult). Endurance running out in the air and a recorded failure come first:
 * whatever the aircraft did afterwards was not a return or a landing. "returned" needs a recorded departure: some
 * recorded true position outside the launch zone (the path's extreme points decide exactly for a box zone;
 * for other shapes a departure can be missed, never invented).
 */
function droneReturn(world: WorldState, launchZone: Region, trace: MissionTrace, failureRecorded: boolean): DroneReturnResult {
  if (trace.enduranceExhaustedAirborne === true) return "forced_descent";
  if (failureRecorded) return "failed_no_supported_maneuver";
  if (regionContains(launchZone, world.drone.position)) {
    return trace.pathExtremes.some(p => !regionContains(launchZone, p)) ? "returned" : "no_departure_recorded";
  }
  if (isTouchedDown(world)) return "landed_contingency";
  return "not_returned";
}
