/**
 * Look before spraying again. After a spray reaches a fire, a flame sighting captured before that spray ended
 * no longer shows that the fire still burns: water has landed on it since. Another spray at that fire needs a
 * new sighting of the place, captured after the spray ended, that still shows flame (the cameras report a fire
 * that is out as intensity 0, simulation/sensors/hazards.ts). Until then the aircraft looks.
 *
 * Regression (live run): a spray completed at 136.01 s and put the fire out; the planner proposed another at
 * 136.02 s from the flame sighting that predated it, before the first no-flame sighting arrived at 140.4 s, and
 * 0.3 L more was approved and discharged.
 *
 * Shared by the harness (H14, which refuses such a spray) and the planner (which withholds it and holds facing
 * the fire). The record comes from the harness's own execution records, never from simulator truth.
 */
import type { ProposalRecord } from "../contracts/actions.ts";
import type { WaterModuleSpec } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import type { HazardEvidence } from "../contracts/evidence.ts";
import type { Region } from "../contracts/geometry.ts";
import { regionsOverlap } from "../contracts/geometry.ts";
import type { ProposalId } from "../contracts/ids.ts";
import type { SpraySpec } from "./effects.ts";
import { sprayRegion } from "./effects.ts";

/** A spray that put water out: completed or stopped after discharging, or still executing. */
export interface SprayDischarge {
  readonly proposalId: ProposalId;
  readonly action: SpraySpec;
  /** Tick its execution ended; null while it still runs (no sighting can postdate it yet). */
  readonly endedTick: Tick | null;
}

/** Every spray that discharged water (or is discharging), in record order. */
export function sprayDischarges(records: readonly ProposalRecord[]): SprayDischarge[] {
  return records.flatMap(record => {
    const action = record.proposal.action;
    const execution = record.execution;
    if (action.kind !== "spray" || execution === null) return [];
    const running = record.status === "executing";
    if (!running && !(execution.effects.waterDischargedL > 0)) return [];
    return [{ proposalId: record.proposal.id, action, endedTick: running ? null : execution.endedTick }];
  });
}

/**
 * The latest spray whose discharge sector reached the sighting's region and that had not ended before the
 * sighting was captured: the sighting is then out of date for deciding whether the fire still burns. Null when
 * the sighting postdates every spray that reached its place. `exclude` leaves out the proposal being validated.
 */
export function sprayAfterSighting(sprays: readonly SprayDischarge[], sighting: HazardEvidence, water: WaterModuleSpec, exclude: ProposalId | null = null): SprayDischarge | null {
  let latest: SprayDischarge | null = null;
  for (const spray of sprays) {
    if (spray.proposalId === exclude) continue;
    if (spray.endedTick !== null && sighting.tick > spray.endedTick) continue;
    const region = jetRegion(spray.action, water);
    if (region === null || !regionsOverlap(region, sighting.region)) continue;
    if (latest === null || endOrder(spray) > endOrder(latest)) latest = spray;
  }
  return latest;
}

const jetCache = new WeakMap<SpraySpec, { readonly water: WaterModuleSpec; readonly region: Region | null }>();

/** The spray's discharge sector (effects.ts sprayRegion, as H14 derives it), cached per frozen action. */
function jetRegion(action: SpraySpec, water: WaterModuleSpec): Region | null {
  const known = jetCache.get(action);
  if (known !== undefined && known.water === water) return known.region;
  const region = sprayRegion(action, water);
  jetCache.set(action, { water, region });
  return region;
}

function endOrder(spray: SprayDischarge): number {
  return spray.endedTick ?? Infinity;
}
