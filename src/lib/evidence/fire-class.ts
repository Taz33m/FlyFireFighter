/**
 * Fire-class assessment: whether water is a suitable agent for an observed fire, from the evidence the system
 * has — the reports' words, the floor-plan prior's room names and crew statements — never from simulator truth.
 * No observation tells a flame's fuel apart, so the honest default is that the class is not confirmed.
 *
 * Indicators, each naming its source:
 * - report: a fire-class cue (interpret.ts fireClassCues) in a caller's, judge's or crew radio report that no
 *   later report supersedes. A cue whose clause names one room applies to fires in or near that room; a cue
 *   naming no single room applies to every fire.
 * - floor_plan_prior: a room in or near the fire (within NEAR_FIRE_M horizontally of the sighting, on its floor)
 *   whose name shows a kitchen (possible cooking oil), a garage or workshop (possible fuel) or a utility,
 *   electrical or mechanical room (possible live electrical).
 * - crew: a cue in a crew confirmation, placed in the confirmation's room (else its clause's room).
 * Resolution comes only from crew sources (crew confirmations and crew radio reports; a caller never resolves):
 * a de-energized statement resolves electrical indicators, and an ordinary-combustibles statement resolves the
 * prior's room-type indicators (never a cue someone reported). A statement applies to fires in or near its room,
 * or to every fire when it names none.
 *
 * Water is suitable when no unresolved indicator applies. That never confirms the class: with no indicator the
 * summary says "fire class not confirmed; no cooking, fuel or electrical indicator near it". A fire whose place
 * is in no prior room gets every placed cue too: where it burns is unknown.
 */
import type { BeliefSnapshot, CallerReport, CrewConfirmation, FireClass, FireClassAssessment, FireClassIndicator, FloorPlanPrior, WaterUnsafeFireClass } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { distanceToRegion, prism, regionBounds, representativePoint } from "../contracts/geometry.ts";
import type { RoomId } from "../contracts/ids.ts";
import type { FireClassCue, FireStatement } from "./interpret.ts";
import { fireClassCues, fireStatements } from "./interpret.ts";
import type { PriorRoom } from "./rooms.ts";
import { roomContaining } from "./rooms.ts";

/** A room within this horizontal distance of a fire sighting, on its floor, is near it. */
export const NEAR_FIRE_M = 1.0;
/** A fire seen this far below a room's floor still burns in that room (the planner's fireRoom tolerance). */
const FIRE_FLOOR_TOLERANCE_M = 0.3;

export const FIRE_CLASS_LABELS: { readonly [c in WaterUnsafeFireClass]: string } = {
  cooking_oil: "cooking-oil or grease fire (class K/F)",
  flammable_liquid: "flammable-liquid or gas fire (class B)",
  electrical: "live electrical fire (class C)",
};

const ROOM_TYPES: readonly (readonly [RegExp, WaterUnsafeFireClass, string])[] = [
  [/\bkitchen(?:ette)?s?\b/i, "cooking_oil", "a kitchen"],
  [/\b(?:garages?|workshops?)\b/i, "flammable_liquid", "a garage or workshop"],
  [/\b(?:utility|electrical|mechanical)\b/i, "electrical", "a utility, electrical or mechanical room"],
];

const NO_INDICATOR = "fire class not confirmed; no cooking, fuel or electrical indicator near it";

/** The parts of the belief the assessment reads. */
export type FireClassEvidence = Pick<BeliefSnapshot, "mapPrior" | "reports" | "crewConfirmations">;

/** Where a fire burns according to the prior: the rooms containing it and every room near it (those included). */
interface FirePlace {
  readonly containing: ReadonlySet<RoomId>;
  readonly near: ReadonlyMap<RoomId, PriorRoom>;
  /** Some place is in no prior room and near none: where it burns is unknown. */
  readonly unplaced: boolean;
}

/**
 * The fire-class assessment for a fire seen in `regions` (fire sightings' regions, or a small region at an aim
 * point; several places are assessed together, every indicator of any of them counting).
 */
export function assessFireClass(evidence: FireClassEvidence, regions: Region | readonly Region[]): FireClassAssessment {
  const prior = evidence.mapPrior;
  const place = firePlace(prior, Array.isArray(regions) ? regions : [regions as Region]);
  const scope: Scope = { prior, place, applies: roomId => roomId === null || place.unplaced || place.near.has(roomId) };
  const reports = activeReports(evidence.reports);
  const found = new Indicators();
  reportIndicators(scope, reports, found);
  priorIndicators(scope, found);
  crewIndicators(scope, evidence.crewConfirmations, found);

  const statements = crewStatements(evidence, reports, prior).filter(s => scope.applies(s.roomId));
  const deEnergized = statements.find(s => s.kind === "de_energized") ?? null;
  const ordinary = statements.find(s => s.kind === "ordinary") ?? null;
  const resolved = found.items.map((f): Found => {
    if (deEnergized !== null && f.indicator.fireClass === "electrical") return { ...f, indicator: { ...f.indicator, resolvedBy: deEnergized.text } };
    if (ordinary !== null && f.indicator.source === "floor_plan_prior") return { ...f, indicator: { ...f.indicator, resolvedBy: ordinary.text } };
    return f;
  });
  const indicators = resolved.map(f => f.indicator);
  const classes = [...new Set(indicators.filter(i => i.resolvedBy === null).map(i => i.fireClass))];
  return { fireClass: classOf(classes, ordinary !== null), indicators, waterSuitable: classes.length === 0, summary: summaryOf(resolved, classes, ordinary) };
}

/** One water-unsafe class when the open indicators agree; ordinary only on a crew statement; otherwise unknown. */
function classOf(openClasses: readonly WaterUnsafeFireClass[], ordinaryConfirmed: boolean): FireClass {
  if (openClasses.length === 1) return openClasses[0];
  return openClasses.length === 0 && ordinaryConfirmed ? "ordinary" : "unknown";
}

interface Scope {
  readonly prior: FloorPlanPrior;
  readonly place: FirePlace;
  /** A source placed in this room (null: no single room) applies to the fire. */
  readonly applies: (roomId: RoomId | null) => boolean;
}

/** Indicators found so far, without repeats (the same cue from the same source). */
class Indicators {
  readonly items: Found[] = [];

  add(indicator: Omit<FireClassIndicator, "resolvedBy" | "text">, prefix: string, where: string): void {
    const same = (i: FireClassIndicator) => i.source === indicator.source && i.sourceId === indicator.sourceId && i.fireClass === indicator.fireClass && i.cue.toLowerCase() === indicator.cue.toLowerCase();
    if (this.items.some(f => same(f.indicator))) return;
    const text = indicator.source === "floor_plan_prior" ? `${prefix}${where}` : `${prefix} mentions "${indicator.cue}"${where}`;
    this.items.push({ indicator: { ...indicator, resolvedBy: null, text }, prefix, where });
  }
}

function inRoom(prior: FloorPlanPrior, roomId: RoomId | null): string {
  if (roomId === null) return "";
  return ` in the ${prior.rooms.find(r => r.id === roomId)?.name ?? roomId}`;
}

function reportIndicators(scope: Scope, reports: readonly CallerReport[], found: Indicators): void {
  for (const report of reports) {
    for (const cue of cachedCues(report, report.originalText, scope.prior)) {
      if (scope.applies(cue.roomId)) found.add({ fireClass: cue.fireClass, source: "report", sourceId: report.id, cue: cue.phrase, roomId: cue.roomId }, `${reportLabel(report)} ${report.id}`, inRoom(scope.prior, cue.roomId));
    }
  }
}

function priorIndicators(scope: Scope, found: Indicators): void {
  for (const room of scope.place.near.values()) {
    for (const [pattern, fireClass, kind] of ROOM_TYPES) {
      if (pattern.test(room.name)) found.add({ fireClass, source: "floor_plan_prior", sourceId: room.id, cue: room.name, roomId: room.id }, `the fire is ${scope.place.containing.has(room.id) ? "in" : "near"} the ${room.name}`, ` (floor-plan prior: ${kind})`);
    }
  }
}

function crewIndicators(scope: Scope, confirmations: readonly CrewConfirmation[], found: Indicators): void {
  for (const confirmation of confirmations) {
    for (const cue of cachedCues(confirmation, confirmation.text, scope.prior)) {
      const roomId = confirmation.roomId ?? cue.roomId;
      if (scope.applies(roomId)) found.add({ fireClass: cue.fireClass, source: "crew", sourceId: confirmation.id, cue: cue.phrase, roomId }, `crew confirmation ${confirmation.id} (${confirmation.crewId})`, inRoom(scope.prior, roomId));
    }
  }
}

/** An indicator with the parts its summary group is written from. */
interface Found {
  readonly indicator: FireClassIndicator;
  readonly prefix: string;
  readonly where: string;
}

/**
 * The commander's summary. Cues from one source and room are told together ("caller report r-1 mentions "pan",
 * "oil" in the Kitchen") so the summary stays short enough for a planner note.
 */
function summaryOf(found: readonly Found[], openClasses: readonly WaterUnsafeFireClass[], ordinary: AttributedStatement | null): string {
  const open = grouped(found.filter(f => f.indicator.resolvedBy === null));
  const closed = found.filter(f => f.indicator.resolvedBy !== null);
  const resolvedText = closed.length === 0 ? "" : ` Resolved: ${[...new Set(closed.map(f => f.indicator.resolvedBy))].map(by => `${grouped(closed.filter(f => f.indicator.resolvedBy === by)).join("; ")} (${by})`).join("; ")}.`;
  if (open.length > 0) return `Water is unsafe for a possible ${openClasses.map(c => FIRE_CLASS_LABELS[c]).join(" or ")}: ${open.join("; ")}.${resolvedText}`;
  if (ordinary !== null) return `Ordinary combustibles per ${ordinary.text}; no unresolved cooking, fuel or electrical indicator near the fire.${resolvedText}`;
  if (closed.length > 0) return `Fire class not confirmed; every cooking, fuel or electrical indicator near it is resolved.${resolvedText}`;
  return `${NO_INDICATOR[0].toUpperCase()}${NO_INDICATOR.slice(1)}.`;
}

function grouped(found: readonly Found[]): string[] {
  const groups = new Map<string, Found[]>();
  for (const f of found) {
    const key = `${f.indicator.source}|${f.indicator.sourceId}|${f.indicator.roomId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map(group => {
    const first = group[0];
    if (first.indicator.source === "floor_plan_prior") return [...new Set(group.map(f => f.indicator.text))].join("; ");
    return `${first.prefix} mentions ${[...new Set(group.map(f => `"${f.indicator.cue}"`))].join(", ")}${first.where}`;
  });
}

function firePlace(prior: FloorPlanPrior, regions: readonly Region[]): FirePlace {
  const containing = new Set<RoomId>();
  const near = new Map<RoomId, PriorRoom>();
  let unplaced = regions.length === 0;
  for (const region of regions) {
    const point = representativePoint(region);
    const bounds = regionBounds(region);
    const halfWidthM = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y) / 2;
    const center = vec3((bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2, point.z);
    const room = roomContaining(prior, point) ?? roomContaining(prior, vec3(point.x, point.y, point.z + FIRE_FLOOR_TOLERANCE_M));
    const sameFloor = (r: PriorRoom) => (room !== null ? r.floor === room.floor : point.z >= r.zMin - FIRE_FLOOR_TOLERANCE_M && point.z <= r.zMax);
    if (room !== null) containing.add(room.id);
    let placed = room !== null;
    for (const r of prior.rooms) {
      if (r === room || (r.polygon.length >= 3 && sameFloor(r) && horizontalGapM(r, center) - halfWidthM <= NEAR_FIRE_M)) {
        near.set(r.id, r);
        placed = true;
      }
    }
    if (!placed) unplaced = true;
  }
  return { containing, near, unplaced };
}

/** Horizontal distance from `p` to the room's floor polygon; 0 inside it. */
function horizontalGapM(room: PriorRoom, p: { readonly x: number; readonly y: number; readonly z: number }): number {
  const z = Math.min(Math.max(p.z, room.zMin), room.zMax);
  return distanceToRegion(prism(room.polygon, room.zMin, room.zMax), vec3(p.x, p.y, z));
}

/** Reports no later report supersedes: a correction stands for the report it revises. */
function activeReports(reports: readonly CallerReport[]): CallerReport[] {
  const superseded = new Set(reports.map(r => r.supersedes).filter((id): id is string => id !== null));
  return reports.filter(r => !superseded.has(r.id));
}

function reportLabel(report: CallerReport): string {
  return report.source === "crew_radio" ? "crew radio report" : report.source === "judge" ? "report" : "caller report";
}

interface AttributedStatement extends FireStatement {
  /** "crew confirmation c-1 (engine-1): "power is off"" */
  readonly text: string;
}

/** Resolving statements from crew sources only: crew confirmations (in their room, else the clause's) and crew radio reports. */
function crewStatements(evidence: FireClassEvidence, reports: readonly CallerReport[], prior: FloorPlanPrior): AttributedStatement[] {
  const fromConfirmations = evidence.crewConfirmations.flatMap((c: CrewConfirmation) => cachedStatements(c, c.text, prior).map(s => ({ ...s, roomId: c.roomId ?? s.roomId, text: `crew confirmation ${c.id} (${c.crewId}): "${s.phrase}"` })));
  const fromRadio = reports.filter(r => r.source === "crew_radio").flatMap(r => cachedStatements(r, r.originalText, prior).map(s => ({ ...s, text: `crew radio report ${r.id}: "${s.phrase}"` })));
  return [...fromConfirmations, ...fromRadio];
}

/*
 * Text readings are cached per (prior, source object, text): beliefs share the same frozen report and
 * confirmation objects across ticks, and the harness re-assesses every executing tick.
 */

type Cache<T> = WeakMap<FloorPlanPrior, WeakMap<object, { readonly text: string; readonly value: T }>>;

const cueCache: Cache<readonly FireClassCue[]> = new WeakMap();
const statementCache: Cache<readonly FireStatement[]> = new WeakMap();

function cachedCues(source: object, text: string, prior: FloorPlanPrior): readonly FireClassCue[] {
  return cached(cueCache, source, text, prior, () => fireClassCues(text, prior));
}

function cachedStatements(source: object, text: string, prior: FloorPlanPrior): readonly FireStatement[] {
  return cached(statementCache, source, text, prior, () => fireStatements(text, prior));
}

function cached<T>(cache: Cache<T>, source: object, text: string, prior: FloorPlanPrior, read: () => T): T {
  let byPrior = cache.get(prior);
  if (byPrior === undefined) {
    byPrior = new WeakMap();
    cache.set(prior, byPrior);
  }
  const known = byPrior.get(source);
  if (known !== undefined && known.text === text) return known.value;
  const value = read();
  byPrior.set(source, { text, value });
  return value;
}
