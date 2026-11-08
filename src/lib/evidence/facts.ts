/**
 * Latest-state facts from detections: opening states and hazards.
 *
 * "Latest" is decided by capture tick, never arrival order, so a delayed older observation cannot
 * override a newer one. Equal capture ticks fall back to the larger observation id, which keeps the
 * outcome independent of arrival order.
 *
 * A superseded observation's facts are withdrawn (`withdraw`): its replacement's detections stand for that
 * frame instead. An opening then falls back to its previous observed state (a short history is kept per
 * opening) and a hazard region to its previous sighting still in the window.
 */
import { canonicalJson } from "../contracts/canonical.ts";
import type { Tick } from "../contracts/clock.ts";
import type { HazardEvidence, OpeningEvidence } from "../contracts/evidence.ts";
import type { OpeningId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";

interface Timed {
  readonly tick: Tick;
  readonly observationId: string;
}

interface SequencedHazard {
  readonly seq: number;
  readonly evidence: HazardEvidence;
}

/** Observed states kept per opening, newest first, so withdrawing the latest falls back to an earlier one. */
const OPENING_HISTORY = 8;

export class LatestFacts {
  private readonly openingStates = new Map<OpeningId, OpeningEvidence[]>();
  private readonly latestHazards = new Map<string, SequencedHazard>();
  private recentHazards: SequencedHazard[] = [];
  private hazardSeq = 0;

  record(observation: Observation): void {
    for (const detection of observation.detections) {
      if (detection.kind === "opening_state") {
        const evidence: OpeningEvidence = deepFreeze({ openingId: detection.openingId, state: detection.state, tick: observation.captureTick, observationId: observation.id });
        const history = this.openingStates.get(detection.openingId) ?? [];
        const at = history.findIndex(item => isNewer(evidence, item));
        history.splice(at === -1 ? history.length : at, 0, evidence);
        if (history.length > OPENING_HISTORY) history.length = OPENING_HISTORY;
        this.openingStates.set(detection.openingId, history);
      } else if (detection.kind === "hazard") {
        const evidence: HazardEvidence = deepFreeze({ observationId: observation.id, tick: observation.captureTick, hazard: detection.hazard, region: detection.region, intensity: detection.intensity });
        this.recordHazard({ seq: this.hazardSeq++, evidence });
      }
    }
  }

  /** Latest evidence per opening, ordered by opening id. */
  openings(): OpeningEvidence[] {
    return [...this.openingStates.values()].flatMap(history => history.slice(0, 1)).sort((a, b) => (a.openingId < b.openingId ? -1 : a.openingId > b.openingId ? 1 : 0));
  }

  /**
   * Hazards captured at or after `windowStart`, plus the latest evidence for every (hazard, region) pair even
   * when it is older: no new observation of a fire is not evidence that the fire is out. `windowStart` must
   * not decrease between calls; older hazards that are no longer latest for their region are released.
   */
  hazardsSince(windowStart: Tick): HazardEvidence[] {
    this.recentHazards = this.recentHazards.filter(item => item.evidence.tick >= windowStart);
    const included = new Map<number, SequencedHazard>();
    for (const item of [...this.recentHazards, ...this.latestHazards.values()]) included.set(item.seq, item);
    return [...included.values()]
      .sort((a, b) => a.evidence.tick - b.evidence.tick || a.seq - b.seq)
      .map(item => item.evidence);
  }

  /** Withdraws every fact a superseded observation contributed. */
  withdraw(observationId: string): void {
    for (const [openingId, history] of this.openingStates) {
      const kept = history.filter(item => item.observationId !== observationId);
      if (kept.length === 0) this.openingStates.delete(openingId);
      else if (kept.length !== history.length) this.openingStates.set(openingId, kept);
    }
    this.recentHazards = this.recentHazards.filter(item => item.evidence.observationId !== observationId);
    for (const [key, item] of this.latestHazards) {
      if (item.evidence.observationId !== observationId) continue;
      let fallback: SequencedHazard | undefined;
      for (const other of this.recentHazards) {
        if (hazardKey(other.evidence) === key && (fallback === undefined || isNewer(other.evidence, fallback.evidence))) fallback = other;
      }
      if (fallback === undefined) this.latestHazards.delete(key);
      else this.latestHazards.set(key, fallback);
    }
  }

  private recordHazard(item: SequencedHazard): void {
    this.recentHazards.push(item);
    const key = hazardKey(item.evidence);
    const current = this.latestHazards.get(key);
    if (current === undefined || isNewer(item.evidence, current.evidence)) this.latestHazards.set(key, item);
  }
}

function hazardKey(evidence: HazardEvidence): string {
  return `${evidence.hazard}|${canonicalJson(evidence.region)}`;
}

function isNewer(a: Timed, b: Timed): boolean {
  return a.tick > b.tick || (a.tick === b.tick && a.observationId > b.observationId);
}
