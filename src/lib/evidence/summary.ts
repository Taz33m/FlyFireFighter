/**
 * Occupancy accounting for command, derived only from a truth-free belief snapshot.
 *
 * Reported, possibly detected and crew-located evidence stay separate lists with their provenance.
 * Nothing here subtracts detections from a caller's count, totals people, or marks a room or house clear:
 * occupancy is always "unresolved". Evaluator-confirmed exterior arrival is simulation evidence and is not
 * part of the belief, so it never appears here.
 *
 * Each possible track lists how its detections were made (`detectionMethods`) and where the frames came from
 * (`provenances`). "oracle_fixture" marks a raycast against the hidden person (twin frames have provenance
 * "simulated_sensor" but their person detections are still fixtures), so a display must show the method.
 */
import type { Tick } from "../contracts/clock.ts";
import type { BeliefSnapshot, CallerReport, CrewConfirmation, OccupantTrack, RoomCoverage } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { ObservationId, ReportId, RoomId, RunId, TrackId } from "../contracts/ids.ts";
import type { DetectionMethod, Observation, ObservationProvenance } from "../contracts/observation.ts";
import { deepFreeze } from "../contracts/ids.ts";

/** An effective (not superseded) report, in the reporter's own words. */
export interface ReportAccount {
  readonly reportId: ReportId;
  readonly source: CallerReport["source"];
  readonly channel: CallerReport["channel"];
  readonly receivedTick: Tick;
  readonly originalText: string;
  readonly roomHint: RoomId | null;
  readonly countText: string | null;
  /** Earlier reports this one corrects, most recent first. They remain in the belief. */
  readonly revises: readonly ReportId[];
}

/** A possible occupant inferred from detections: not an identity and not a confirmed person. */
export interface PossibleTrackAccount {
  readonly trackId: TrackId;
  readonly roomId: RoomId | null;
  readonly position: Vec3;
  readonly uncertaintyM: number;
  readonly confidence: number;
  readonly firstSeenTick: Tick;
  readonly lastSeenTick: Tick;
  readonly observationIds: readonly ObservationId[];
  /** Other possible tracks that may be the same person; the association is unresolved. */
  readonly ambiguousWith: readonly TrackId[];
  /**
   * Person-detection methods behind the track, from its observations still in the belief's window (sorted).
   * "oracle_fixture" means a labelled raycast fixture, not detector output. Empty when every supporting
   * observation has left the window: the method is then unknown, not absent.
   */
  readonly detectionMethods: readonly DetectionMethod[];
  /** Provenance of those observations (sorted); empty under the same condition. */
  readonly provenances: readonly ObservationProvenance[];
  /** True when any of those detections is an oracle fixture. */
  readonly includesOracleFixture: boolean;
}

export interface OccupancySummary {
  readonly runId: RunId;
  readonly tick: Tick;
  readonly evidenceRevision: number;
  /** Always unresolved: no combination of reports, detections, coverage or confirmations resolves it. */
  readonly occupancy: "unresolved";
  readonly reports: readonly ReportAccount[];
  /** Count language of the most recently received effective report that has any. Text, never a number. */
  readonly latestCountText: { readonly reportId: ReportId; readonly text: string; readonly receivedTick: Tick } | null;
  readonly possibleTracks: readonly PossibleTrackAccount[];
  /** Crew confirmations, with the tracks and reports they link to. */
  readonly crewLocated: readonly CrewConfirmation[];
  /** Observation coverage only. An observed room is not an empty room. */
  readonly roomsByCoverage: { readonly unobserved: readonly RoomId[]; readonly degraded: readonly RoomId[]; readonly observed: readonly RoomId[] };
}

export function occupancySummary(belief: BeliefSnapshot): OccupancySummary {
  const superseded = new Set(belief.reports.flatMap(report => (report.supersedes === null ? [] : [report.supersedes])));
  const reportsById = new Map(belief.reports.map(report => [report.id, report]));
  const effective = belief.reports.filter(report => !superseded.has(report.id));
  const possible = belief.tracks.filter(track => track.status === "possible");
  const possibleIds = new Set(possible.map(track => track.id));
  const observationsById = new Map(belief.observations.map(o => [o.id, o] as const));
  return deepFreeze({
    runId: belief.runId,
    tick: belief.tick,
    evidenceRevision: belief.evidenceRevision,
    occupancy: "unresolved",
    reports: effective.map(report => reportAccount(report, reportsById)),
    latestCountText: latestCountText(effective),
    possibleTracks: possible.map(track => trackAccount(track, possibleIds, observationsById)),
    crewLocated: belief.crewConfirmations.slice(),
    roomsByCoverage: roomsByCoverage(belief.coverage),
  });
}

function reportAccount(report: CallerReport, reportsById: ReadonlyMap<ReportId, CallerReport>): ReportAccount {
  const revises: ReportId[] = [];
  for (let id = report.supersedes; id !== null && !revises.includes(id); id = reportsById.get(id)?.supersedes ?? null) revises.push(id);
  return {
    reportId: report.id,
    source: report.source,
    channel: report.channel,
    receivedTick: report.receivedTick,
    originalText: report.originalText,
    roomHint: report.roomHint,
    countText: report.countText,
    revises,
  };
}

function latestCountText(effective: readonly CallerReport[]): OccupancySummary["latestCountText"] {
  let latest: CallerReport | null = null;
  for (const report of effective) {
    if (report.countText !== null && (latest === null || report.receivedTick >= latest.receivedTick)) latest = report;
  }
  return latest === null || latest.countText === null ? null : { reportId: latest.id, text: latest.countText, receivedTick: latest.receivedTick };
}

function trackAccount(track: OccupantTrack, possibleIds: ReadonlySet<TrackId>, observationsById: ReadonlyMap<ObservationId, Observation>): PossibleTrackAccount {
  const methods = new Set<DetectionMethod>();
  const provenances = new Set<ObservationProvenance>();
  for (const id of track.observationIds) {
    const observation = observationsById.get(id);
    if (observation === undefined) continue;
    provenances.add(observation.provenance);
    for (const d of observation.detections) if (d.kind === "possible_person") methods.add(d.method);
  }
  const detectionMethods = [...methods].sort();
  return {
    trackId: track.id,
    roomId: track.roomId,
    position: track.position,
    uncertaintyM: track.uncertaintyM,
    confidence: track.confidence,
    firstSeenTick: track.firstSeenTick,
    lastSeenTick: track.lastSeenTick,
    observationIds: track.observationIds,
    ambiguousWith: track.ambiguousWith.filter(id => possibleIds.has(id)),
    detectionMethods,
    provenances: [...provenances].sort(),
    includesOracleFixture: methods.has("oracle_fixture"),
  };
}

function roomsByCoverage(coverage: readonly RoomCoverage[]): OccupancySummary["roomsByCoverage"] {
  const pick = (state: RoomCoverage["state"]) => coverage.filter(room => room.state === state).map(room => room.roomId);
  return { unobserved: pick("unobserved"), degraded: pick("degraded"), observed: pick("observed") };
}
