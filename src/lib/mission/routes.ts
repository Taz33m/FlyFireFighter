/**
 * Periodic route assessment for the run: the preset's evacuation route from the newest possible-occupant
 * track, and the aircraft's return route from its estimated position. Assessments use the belief and the
 * harness's last-intervention tick only (assessRoute is truth-free); they are stored in the evidence store
 * so planners, the harness's guidance rule (H15) and contingency selection all read the same judgement.
 * A status change of either route is a key timeline event.
 */
import type { Tick } from "../contracts/clock.ts";
import type { EventLog } from "../contracts/events.ts";
import type { BeliefSnapshot, OccupantTrack, RouteAssessment } from "../contracts/evidence.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import type { HarnessPolicy } from "../harness/policy.ts";
import type { RouteRequest } from "../navigation/routes/index.ts";
import { assessRoute } from "../navigation/routes/index.ts";
import type { MissionPreset } from "./scenario.ts";

export interface RouteUpdate {
  readonly preset: MissionPreset;
  readonly evidence: EvidenceStore;
  readonly log: EventLog;
  readonly belief: BeliefSnapshot;
  readonly tick: Tick;
  readonly lastInterventionTick: Tick | null;
  readonly policy: HarnessPolicy;
}

export class RouteMonitor {
  private readonly statuses = new Map<string, RouteAssessment["status"]>();

  /** Assess both routes; true when any assessment was stored (the belief must be taken again). */
  update(u: RouteUpdate): boolean {
    const track = newestPossibleTrack(u.belief.tracks);
    const requests: RouteRequest[] = [u.preset.returnRouteRequest(u.belief.pose.position)];
    if (track !== null) requests.unshift(u.preset.evacuationRouteRequest(track.position));
    let stored = false;
    for (const request of requests) stored = this.assessOne(u, request) || stored;
    return stored;
  }

  private assessOne(u: RouteUpdate, request: RouteRequest): boolean {
    let assessment: RouteAssessment;
    try {
      assessment = assessRoute({ belief: u.belief, tick: u.tick, lastInterventionTick: u.lastInterventionTick, policy: u.policy }, request);
    } catch (error) {
      u.log.append({ tick: u.tick, source: "evidence", kind: "route.assessment_failed", subject: request.id, reason: `Route ${request.id} could not be assessed: ${message(error)}`, data: { routeId: request.id } });
      return false;
    }
    let stored: boolean;
    try {
      stored = u.evidence.setRouteAssessment(assessment);
    } catch (error) {
      u.log.append({ tick: u.tick, source: "evidence", kind: "route.assessment_rejected", subject: request.id, reason: `The evidence store refused route ${request.id}: ${message(error)}`, data: { routeId: request.id } });
      return false;
    }
    const previous = this.statuses.get(assessment.id) ?? null;
    if (stored && previous !== assessment.status) {
      this.statuses.set(assessment.id, assessment.status);
      u.log.append({
        tick: u.tick, source: "evidence", kind: "route.status_changed", subject: assessment.id,
        reason: `${assessment.purpose === "evacuation" ? "Evacuation" : "Return"} route ${assessment.id} is ${assessment.status}${previous === null ? "" : ` (was ${previous})`}: ${assessment.reason}`,
        data: { routeId: assessment.id, purpose: assessment.purpose, status: assessment.status, previous, evidenceIds: assessment.evidenceIds.slice(0, 16), estimatedDurationS: Number.isFinite(assessment.estimatedDurationS) ? assessment.estimatedDurationS : null },
      });
    }
    return stored;
  }
}

/** The possible-occupant track seen most recently (ties: the later id). */
export function newestPossibleTrack(tracks: readonly OccupantTrack[]): OccupantTrack | null {
  let best: OccupantTrack | null = null;
  for (const track of tracks) {
    if (track.status !== "possible") continue;
    if (best === null || track.lastSeenTick > best.lastSeenTick || (track.lastSeenTick === best.lastSeenTick && track.id > best.id)) best = track;
  }
  return best;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
