/**
 * Commander-approved mission envelope, separate from aircraft hard limits.
 *
 * Routine actions (move, scan, hold, return, guide) run autonomously only inside the current envelope.
 * Changing the envelope is an explicit mission revision: it increments the revision, is validated against
 * hard limits, and invalidates proposals bound to the previous revision. An ordinary action approval
 * never changes the envelope.
 */
import type { AircraftProfile } from "./aircraft.ts";
import type { Tick } from "./clock.ts";
import { ticksFromSeconds } from "./clock.ts";
import type { Vec3 } from "./frames.ts";
import { vec3 } from "./frames.ts";
import type { Region } from "./geometry.ts";
import { regionContains } from "./geometry.ts";
import type { CommanderId, RunId } from "./ids.ts";

export interface MissionEnvelope {
  readonly runId: RunId;
  readonly revision: number;
  readonly approvedBy: CommanderId;
  readonly approvedTick: Tick;
  /** Permitted volume: the union of these regions, in the estimated world frame. */
  readonly regions: readonly Region[];
  readonly maxSpeedMps: number;
  readonly ambientCeilingC: number;
  /** Time box: autonomous mission actions end at this tick (contingencies remain available). */
  readonly endTick: Tick;
}

/** True when the point, and the six points offset by marginM along each axis, lie inside the union. */
export function envelopeContains(envelope: MissionEnvelope, p: Vec3, marginM = 0): boolean {
  const probes = marginM > 0
    ? [p, vec3(p.x + marginM, p.y, p.z), vec3(p.x - marginM, p.y, p.z), vec3(p.x, p.y + marginM, p.z), vec3(p.x, p.y - marginM, p.z), vec3(p.x, p.y, p.z + marginM), vec3(p.x, p.y, p.z - marginM)]
    : [p];
  return probes.every(probe => envelope.regions.some(region => regionContains(region, probe)));
}

/** Reasons an envelope would exceed the aircraft's hard limits. Empty when it is within them. */
export function hardLimitViolations(envelope: MissionEnvelope, profile: AircraftProfile, missionStartTick: Tick): string[] {
  const limits = profile.hardLimits;
  const violations: string[] = [];
  if (envelope.regions.length === 0) violations.push("Envelope has no permitted region.");
  if (envelope.maxSpeedMps > limits.maxSpeedMps) violations.push(`Envelope speed ${envelope.maxSpeedMps} m/s exceeds the aircraft limit of ${limits.maxSpeedMps} m/s.`);
  if (envelope.ambientCeilingC > limits.maxAmbientC) violations.push(`Envelope ambient ceiling ${envelope.ambientCeilingC} °C exceeds the aircraft limit of ${limits.maxAmbientC} °C.`);
  const usableTicks = ticksFromSeconds(limits.enduranceS - limits.returnReserveS);
  if (envelope.endTick - missionStartTick > usableTicks) violations.push("Envelope time box exceeds endurance minus the return reserve.");
  return violations;
}

/** Reasons a proposed envelope revision cannot replace the current one. */
export function envelopeRevisionViolations(next: MissionEnvelope, current: MissionEnvelope, profile: AircraftProfile, missionStartTick: Tick): string[] {
  const violations: string[] = [];
  if (next.runId !== current.runId) violations.push("Envelope revision belongs to a different run.");
  if (next.revision !== current.revision + 1) violations.push(`Envelope revision must be ${current.revision + 1}, got ${next.revision}.`);
  return [...violations, ...hardLimitViolations(next, profile, missionStartTick)];
}
