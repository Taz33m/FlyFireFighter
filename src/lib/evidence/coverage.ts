/**
 * Room observation coverage.
 *
 * Each room prism (floor polygon x [zMin, zMax]) is sampled on a fixed grid. A sample point keeps the best
 * quality of any observation whose footprint contained it, and the latest capture tick of an adequate-quality
 * frame that ran a person search there. Coverage is accumulated over the whole run. A room is `observed` once
 * any point reached adequate quality, `degraded` if points were only covered below it, and `unobserved`
 * otherwise; that state never decays and says nothing about how much of the room was seen, so decisions use
 * the fractions and the person-search freshness profile (`searchedSince`) instead. Coverage says what was
 * looked at, never who is absent: there is no clear state and full coverage resolves nothing.
 */
import type { Tick } from "../contracts/clock.ts";
import type { CoverageFreshnessStep, FloorPlanPrior, RoomCoverage } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Bounds, Region } from "../contracts/geometry.ts";
import { boundsIntersect, prism, regionBounds, regionContains, samplePoints } from "../contracts/geometry.ts";
import type { RoomId } from "../contracts/ids.ts";
import type { Observation, SensorModality } from "../contracts/observation.ts";

/**
 * Fraction resolution of the freshness profile. The newest and oldest steps are always kept, and others
 * whenever the fraction has grown by at least this much since the last kept step, so a profile has at most
 * 1 / FRESHNESS_RESOLUTION + 2 steps and a lookup under-counts by less than this.
 */
export const FRESHNESS_RESOLUTION = 0.02;

interface BestObservation {
  readonly quality: number;
  readonly tick: Tick;
  readonly id: string;
  readonly modality: SensorModality;
}

interface RoomGrid {
  readonly roomId: RoomId;
  readonly bounds: Bounds;
  readonly points: readonly Vec3[];
  /** Best quality per sample point; -1 until a footprint contains the point. */
  readonly best: Float64Array;
  /** Latest capture tick of an adequate-quality person-search frame per sample point; -1 until one. */
  readonly searched: Float64Array;
  lastObservedTick: Tick | null;
  bestObservation: BestObservation | null;
  /** Summary cache, cleared whenever an observation touches the room. */
  cached: RoomCoverage | null;
}

export class CoverageGrid {
  private readonly rooms: readonly RoomGrid[];
  private readonly adequateQuality: number;

  constructor(prior: FloorPlanPrior, spacingM: number, adequateQuality: number) {
    this.adequateQuality = adequateQuality;
    this.rooms = prior.rooms.map(room => {
      const region = prism(room.polygon, room.zMin, room.zMax);
      const points = samplePoints(region, spacingM);
      return {
        roomId: room.id, bounds: regionBounds(region), points,
        best: new Float64Array(points.length).fill(-1), searched: new Float64Array(points.length).fill(-1),
        lastObservedTick: null, bestObservation: null, cached: null,
      };
    });
  }

  observe(observation: Observation): void {
    const footprint = observation.footprint;
    if (footprint === null) return;
    const footprintBounds = regionBounds(footprint);
    for (const room of this.rooms) {
      if (boundsIntersect(footprintBounds, room.bounds)) observeRoom(room, observation, footprint, this.adequateQuality);
    }
  }

  summary(): RoomCoverage[] {
    return this.rooms.map(room => (room.cached ??= summarize(room, this.adequateQuality)));
  }
}

function summarize(room: RoomGrid, adequateQuality: number): RoomCoverage {
  let adequate = 0;
  let any = 0;
  for (const quality of room.best) {
    if (quality >= 0) any++;
    if (quality >= adequateQuality) adequate++;
  }
  const n = room.points.length;
  const searchedTicks = Array.from(room.searched).filter(tick => tick >= 0);
  const state = adequate > 0 ? "observed" : any > 0 ? "degraded" : "unobserved";
  return {
    roomId: room.roomId,
    state,
    fractionAdequate: adequate / n,
    fractionAny: any / n,
    lastObservedTick: room.lastObservedTick,
    bestModality: room.bestObservation?.modality ?? null,
    fractionSearched: searchedTicks.length / n,
    searchedSince: freshnessProfile(searchedTicks, n),
  };
}

/** Exact (tick, fraction) steps, newest first, thinned to FRESHNESS_RESOLUTION; the first and last are always kept. */
function freshnessProfile(ticks: number[], total: number): CoverageFreshnessStep[] {
  ticks.sort((a, b) => b - a);
  const steps: CoverageFreshnessStep[] = [];
  let kept = 0;
  for (let i = 0; i < ticks.length; i++) {
    if (i + 1 < ticks.length && ticks[i + 1] === ticks[i]) continue;
    const fraction = (i + 1) / total;
    if (steps.length === 0 || fraction - kept >= FRESHNESS_RESOLUTION || i === ticks.length - 1) {
      steps.push({ sinceTick: ticks[i], fraction });
      kept = fraction;
    }
  }
  return steps;
}

/**
 * Fraction of the room adequately person-searched by frames captured at or after `tick`, from the room's
 * freshness profile. Never an over-count; 0 when the coverage carries no profile.
 */
export function searchedFractionSince(coverage: RoomCoverage, tick: Tick): number {
  let fraction = 0;
  for (const step of coverage.searchedSince ?? []) {
    if (step.sinceTick < tick) break;
    fraction = step.fraction;
  }
  return fraction;
}

function observeRoom(room: RoomGrid, observation: Observation, footprint: Region, adequateQuality: number): void {
  const searches = observation.personSearch !== null && observation.quality >= adequateQuality;
  let touched = false;
  for (let i = 0; i < room.points.length; i++) {
    if (!regionContains(footprint, room.points[i])) continue;
    touched = true;
    if (observation.quality > room.best[i]) room.best[i] = observation.quality;
    if (searches && observation.captureTick > room.searched[i]) room.searched[i] = observation.captureTick;
  }
  if (!touched) return;
  room.cached = null;
  room.lastObservedTick = Math.max(room.lastObservedTick ?? observation.captureTick, observation.captureTick);
  const candidate = { quality: observation.quality, tick: observation.captureTick, id: observation.id, modality: observation.modality };
  if (outranks(candidate, room.bestObservation)) room.bestObservation = candidate;
}

/** Higher quality wins, then the later capture, then the smaller id, so arrival order never matters. */
function outranks(a: BestObservation, b: BestObservation | null): boolean {
  if (b === null || a.quality !== b.quality) return b === null || a.quality > b.quality;
  return a.tick !== b.tick ? a.tick > b.tick : a.id < b.id;
}
