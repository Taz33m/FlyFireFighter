/**
 * Compact evidence summary for a Decisions request.
 *
 * Built only from the truth-free BeliefSnapshot: no simulator truth, hidden positions or evaluator
 * outcomes exist to leak. Every list and string is bounded so the request stays small. Report text is the
 * reporter's own words, sanitized and truncated; it is untrusted data and travels only inside the request's
 * input JSON, never in model instructions. Ages are in mission ticks relative to the snapshot.
 */
import type { BeliefSnapshot, CallerReport, CoverageState, FloorPlanPrior, HazardEvidence, OpeningEvidence, RoomCoverage } from "../../contracts/evidence.ts";
import { representativePoint } from "../../contracts/geometry.ts";
import type { RoomId } from "../../contracts/ids.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import type { Schema } from "../../contracts/schema.ts";
import { arr, int, lit, num, obj, str } from "../../contracts/schema.ts";
import { roomContaining } from "../../evidence/rooms.ts";
import type { HarnessPolicy } from "../../harness/policy.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import { latestOpeningEvidence, latestRoutes, reportedRooms } from "./candidates.ts";
import { compareText, sanitizeText } from "./text.ts";
import type { DecisionEvidence } from "./types.ts";
import { MAX_REPORT_TEXT_LENGTH } from "./types.ts";

export const EVIDENCE_LIMITS = deepFreeze({ reports: 4, rooms: 32, tracks: 8, hazards: 12, openings: 16, routes: 8, idLength: 64, nameLength: 48 });

const L = EVIDENCE_LIMITS;

type PriorRoom = FloorPlanPrior["rooms"][number];

export function summarizeEvidence(belief: BeliefSnapshot, policy: HarnessPolicy = DEFAULT_POLICY): DecisionEvidence {
  const now = belief.tick;
  const age = (tick: number): number => Math.max(0, Math.round(now - tick));
  const roomOf = (room: PriorRoom | null): RoomId | null => (room === null ? null : id(room.id));
  return deepFreeze({
    tick: now,
    reports: effectiveReports(belief).slice(0, L.reports).map(report => ({
      id: id(report.id),
      source: report.source,
      ageTicks: age(report.receivedTick),
      text: sanitizeText(report.originalText, MAX_REPORT_TEXT_LENGTH),
      roomHint: report.roomHint === null ? null : id(report.roomHint),
    })),
    pose: { supported: belief.pose.supported, sigmaM: bounded(belief.pose.sigmaM, 0, 1000, 100), roomId: roomOf(roomContaining(belief.mapPrior, belief.pose.position)) },
    aircraft: {
      enduranceRemainingS: bounded(belief.aircraft.enduranceRemainingS, 0, 1e6, 1),
      waterRemainingL: belief.aircraft.waterRemainingL === null ? null : bounded(belief.aircraft.waterRemainingL, 0, 1000, 100),
      ambientC: belief.aircraft.ambientC === null ? null : bounded(belief.aircraft.ambientC, -100, 2000, 10),
    },
    rooms: roomSummaries(belief).map(({ room, coverage }) => ({
      id: id(room.id),
      name: sanitizeText(room.name, L.nameLength),
      floor: Math.round(bounded(room.floor, -20, 200, 1)),
      coverage: coverage?.state ?? "unobserved",
      lastObservedAgeTicks: coverage === undefined || coverage.lastObservedTick === null ? null : age(coverage.lastObservedTick),
    })),
    tracks: belief.tracks
      .filter(track => track.status === "possible")
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick || compareText(a.id, b.id))
      .slice(0, L.tracks)
      .map(track => ({
        id: id(track.id),
        roomId: track.roomId === null ? null : id(track.roomId),
        confidence: bounded(track.confidence, 0, 1, 100),
        uncertaintyM: bounded(track.uncertaintyM, 0, 1000, 100),
        lastSeenAgeTicks: age(track.lastSeenTick),
        observationCount: track.observationIds.length,
      })),
    hazards: latestHazards(belief, now - policy.citedEvidenceMaxAgeTicks).map(({ hazard, room }) => ({
      kind: hazard.hazard,
      roomId: roomOf(room),
      intensity: bounded(hazard.intensity, 0, 1e6, 100),
      ageTicks: age(hazard.tick),
    })),
    openings: openingSummaries(belief).map(({ evidence, opening }) => ({
      id: id(opening.id),
      kind: opening.kind,
      roomId: id(opening.rooms[0]),
      exterior: opening.rooms[1] === "exterior",
      state: evidence.state,
      ageTicks: age(evidence.tick),
    })),
    routes: latestRoutes(belief.routes)
      .sort((a, b) => b.assessedTick - a.assessedTick || compareText(a.id, b.id))
      .slice(0, L.routes)
      .map(route => ({
        id: id(route.id),
        purpose: route.purpose,
        status: route.status,
        ageTicks: age(route.assessedTick),
        estimatedDurationS: bounded(route.estimatedDurationS, 0, 1e5, 10),
      })),
  });
}

/** Strict schema for DecisionEvidence: unknown members are rejected and every list and string is bounded. */
export const decisionEvidenceSchema: Schema = obj({
  tick: int(),
  reports: arr(obj({ id: str(L.idLength, 0), source: lit("caller", "judge", "crew_radio"), ageTicks: int(), text: str(MAX_REPORT_TEXT_LENGTH, 0), roomHint: nullable(str(L.idLength, 0)) }), L.reports),
  pose: obj({ supported: { type: "boolean" }, sigmaM: num(0, 1000), roomId: nullable(str(L.idLength, 0)) }),
  aircraft: obj({ enduranceRemainingS: num(0, 1e6), waterRemainingL: nullable(num(0, 1000)), ambientC: nullable(num(-100, 2000)) }),
  rooms: arr(obj({ id: str(L.idLength, 0), name: str(L.nameLength, 0), floor: int(-20, 200), coverage: lit("unobserved", "observed", "degraded"), lastObservedAgeTicks: nullable(int()) }), L.rooms),
  tracks: arr(obj({ id: str(L.idLength, 0), roomId: nullable(str(L.idLength, 0)), confidence: num(0, 1), uncertaintyM: num(0, 1000), lastSeenAgeTicks: int(), observationCount: int() }), L.tracks),
  hazards: arr(obj({ kind: lit("fire", "smoke", "heat", "obstruction"), roomId: nullable(str(L.idLength, 0)), intensity: num(0, 1e6), ageTicks: int() }), L.hazards),
  openings: arr(obj({ id: str(L.idLength, 0), kind: lit("door", "window", "opening"), roomId: str(L.idLength, 0), exterior: { type: "boolean" }, state: lit("closed", "open", "broken", "blocked"), ageTicks: int() }), L.openings),
  routes: arr(obj({ id: str(L.idLength, 0), purpose: lit("return", "alternate_return", "evacuation"), status: lit("supported", "unsupported", "unknown"), ageTicks: int(), estimatedDurationS: num(0, 1e5) }), L.routes),
});

function nullable(inner: Schema): Schema {
  return { type: "nullable", inner };
}

/** Effective (not superseded) reports, most recent first. */
function effectiveReports(belief: BeliefSnapshot): CallerReport[] {
  const superseded = new Set(belief.reports.flatMap(report => (report.supersedes === null ? [] : [report.supersedes])));
  return belief.reports.filter(report => !superseded.has(report.id)).sort((a, b) => b.receivedTick - a.receivedTick || compareText(a.id, b.id));
}

/** Rooms named in reports first, then unobserved, degraded and observed rooms. */
function roomSummaries(belief: BeliefSnapshot): { readonly room: PriorRoom; readonly coverage: RoomCoverage | undefined }[] {
  const coverage = new Map(belief.coverage.map(entry => [entry.roomId, entry]));
  const reported = reportedRooms(belief);
  const order: { readonly [state in CoverageState]: number } = { unobserved: 1, degraded: 2, observed: 3 };
  const rank = (room: PriorRoom): number => (reported.has(room.id) ? 0 : order[coverage.get(room.id)?.state ?? "unobserved"]);
  return belief.mapPrior.rooms
    .slice()
    .sort((a, b) => rank(a) - rank(b) || compareText(a.id, b.id))
    .slice(0, L.rooms)
    .map(room => ({ room, coverage: coverage.get(room.id) }));
}

/** The latest fresh observation per hazard kind and room, most recent first. */
function latestHazards(belief: BeliefSnapshot, from: number): { readonly hazard: HazardEvidence; readonly room: PriorRoom | null }[] {
  const latest = new Map<string, { readonly hazard: HazardEvidence; readonly room: PriorRoom | null }>();
  for (const hazard of belief.hazards) {
    if (hazard.tick < from) continue;
    const room = roomContaining(belief.mapPrior, representativePoint(hazard.region));
    const key = `${hazard.hazard}|${room?.id ?? ""}`;
    const current = latest.get(key);
    if (current === undefined || hazard.tick >= current.hazard.tick) latest.set(key, { hazard, room });
  }
  return [...latest.values()].sort((a, b) => b.hazard.tick - a.hazard.tick || compareText(a.hazard.hazard, b.hazard.hazard)).slice(0, L.hazards);
}

function openingSummaries(belief: BeliefSnapshot): { readonly evidence: OpeningEvidence; readonly opening: FloorPlanPrior["openings"][number] }[] {
  const latest = latestOpeningEvidence(belief.openings);
  return belief.mapPrior.openings
    .flatMap(opening => {
      const evidence = latest.get(opening.id);
      return evidence === undefined ? [] : [{ evidence, opening }];
    })
    .sort((a, b) => b.evidence.tick - a.evidence.tick || compareText(a.opening.id, b.opening.id))
    .slice(0, L.openings);
}

/** Identifiers are data here: sanitized and bounded, never interpreted. */
function id(raw: string): string {
  return sanitizeText(raw, L.idLength);
}

/** Clamp into [min, max] and round to 1/factor; non-finite values become the nearest bound. */
function bounded(value: number, min: number, max: number, factor: number): number {
  const finite = Number.isNaN(value) ? min : value;
  const rounded = Math.round(Math.min(max, Math.max(min, finite)) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
