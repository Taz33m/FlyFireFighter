/**
 * Deterministic planner test fixtures. Everything here is an authored, fictional fixture: the house is
 * not a scene export, not the Troy interior and not a real floor plan, and every observation is labelled
 * provenance "fixture" (person search and detections "oracle_fixture"). None of it is simulator output or
 * detector accuracy, and nothing here is hidden truth: these are belief snapshots, what the planner sees.
 *
 * House (world frame, metres, Z up): x 0–10 east, y 0–8 north; the rear wall faces south (y = 0).
 * Floor 0 spans z 0–2.7: living room x 0–6, kitchen x 6–10. Floor 1 spans z 3–5.7: rear bedroom x 0–5,
 * y 0–4; front bedroom x 0–5, y 4–8; upstairs hall x 5–10. The rear bedroom's window is on the south wall at
 * (2.5, 0, 4.4); the front door is on the north wall at (3, 8, 1). Exterior opening centres sit 0.05 m outside
 * the room polygons, in the wall, as in scene exports. A stair rises along x = 5.5 from the living
 * room (y 7) to the upstairs hall (y 3); both bedroom doors open onto the hall.
 */
import type { MissionEnvelope } from "../../contracts/envelope.ts";
import type { BeliefSnapshot, CallerReport, FloorPlanPrior, HazardEvidence, OccupantTrack, OpeningEvidence, RoomCoverage, RouteAssessment } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import { box, sector, sphere } from "../../contracts/geometry.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import type { Detection, Observation, OpeningState, SensorModality } from "../../contracts/observation.ts";

export const RUN_ID = "run-1";
export const T_OUTSIDE = 1000;
export const T_INSIDE = 2000;

export const HOUSE: FloorPlanPrior = deepFreeze({
  revision: 1,
  source: "fixture: authored fictional two-level house for planner tests",
  floors: [{ index: 0, elevationM: 0, ceilingM: 2.7 }, { index: 1, elevationM: 3, ceilingM: 5.7 }],
  rooms: [
    { id: "living", name: "Living room", floor: 0, polygon: [[0, 0], [6, 0], [6, 8], [0, 8]], zMin: 0, zMax: 2.7 },
    { id: "kitchen", name: "Kitchen", floor: 0, polygon: [[6, 0], [10, 0], [10, 8], [6, 8]], zMin: 0, zMax: 2.7 },
    { id: "bedroom-rear", name: "Rear bedroom", floor: 1, polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], zMin: 3, zMax: 5.7 },
    { id: "bedroom-front", name: "Front bedroom", floor: 1, polygon: [[0, 4], [5, 4], [5, 8], [0, 8]], zMin: 3, zMax: 5.7 },
    { id: "hall-up", name: "Upstairs hall", floor: 1, polygon: [[5, 0], [10, 0], [10, 8], [5, 8]], zMin: 3, zMax: 5.7 },
  ],
  openings: [
    { id: "door-front", kind: "door", rooms: ["living", "exterior"], center: vec3(3, 8.05, 1), widthM: 1, heightM: 2.1, outwardNormal: vec3(0, 1, 0), priorState: "closed" },
    { id: "window-rear", kind: "window", rooms: ["bedroom-rear", "exterior"], center: vec3(2.5, -0.05, 4.4), widthM: 1.2, heightM: 1.2, outwardNormal: vec3(0, -1, 0), priorState: "closed" },
    { id: "window-front", kind: "window", rooms: ["bedroom-front", "exterior"], center: vec3(2.5, 8.05, 4.4), widthM: 1.2, heightM: 1.2, outwardNormal: vec3(0, 1, 0), priorState: "closed" },
    { id: "window-kitchen", kind: "window", rooms: ["kitchen", "exterior"], center: vec3(8, -0.05, 1.4), widthM: 1.2, heightM: 1.2, outwardNormal: vec3(0, -1, 0), priorState: "closed" },
    { id: "door-rear-hall", kind: "door", rooms: ["bedroom-rear", "hall-up"], center: vec3(5, 2, 4), widthM: 0.9, heightM: 2, outwardNormal: vec3(1, 0, 0), priorState: "open" },
    { id: "door-front-hall", kind: "door", rooms: ["bedroom-front", "hall-up"], center: vec3(5, 6, 4), widthM: 0.9, heightM: 2, outwardNormal: vec3(1, 0, 0), priorState: "open" },
  ],
  stairs: [{ id: "stair", bottomRoomId: "living", topRoomId: "hall-up", bottom: vec3(5.5, 7, 0), top: vec3(5.5, 3, 3), widthM: 0.9 }],
  exits: [{ id: "exit-front", openingId: "door-front" }],
  assemblyPoint: box(vec3(2, 12, 0), vec3(6, 16, 2)),
});

export const ENVELOPE: MissionEnvelope = deepFreeze({
  runId: RUN_ID,
  revision: 1,
  approvedBy: "commander-1",
  approvedTick: 0,
  regions: [box(vec3(-12, -12, 0), vec3(22, 22, 9))],
  maxSpeedMps: 2,
  ambientCeilingC: 70,
  endTick: 60_000,
});

export const REPORT: CallerReport = deepFreeze({
  id: "report-1",
  runId: RUN_ID,
  receivedTick: 900,
  source: "judge",
  channel: "typed",
  originalText: "Someone may be in the upstairs rear bedroom.",
  roomHint: "bedroom-rear",
  countText: null,
  interpretation: "rules",
  supersedes: null,
});

export function unobservedCoverage(): RoomCoverage[] {
  return HOUSE.rooms.map(room => ({ roomId: room.id, state: "unobserved", fractionAdequate: 0, fractionAny: 0, lastObservedTick: null, bestModality: null }));
}

export function coverageWith(entries: readonly RoomCoverage[]): RoomCoverage[] {
  const byId = new Map(entries.map(entry => [entry.roomId, entry]));
  return unobservedCoverage().map(entry => byId.get(entry.roomId) ?? entry);
}

/** Start of the mission: outside, 5 m south of the rear bedroom window, one typed report. */
export function outsideBelief(overrides: Partial<BeliefSnapshot> = {}): BeliefSnapshot {
  const base: BeliefSnapshot = {
    runId: RUN_ID,
    tick: T_OUTSIDE,
    evidenceRevision: 12,
    mapPrior: HOUSE,
    mapRevision: 1,
    mapChanges: [],
    pose: { tick: T_OUTSIDE, position: vec3(2.5, -5, 4.4), yawRad: Math.PI / 2, velocity: vec3(0, 0, 0), sigmaM: 0.2, yawSigmaRad: 0.05, supported: true },
    aircraft: { enduranceRemainingS: 800, waterRemainingL: 1, payloadsOnboard: [], ambientC: 24, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "No landing surface observed." },
    observations: [],
    reports: [REPORT],
    tracks: [],
    crewConfirmations: [],
    coverage: unobservedCoverage(),
    hazards: [],
    openings: [],
    routes: [],
    dispatchConfirmed: null,
  };
  return deepFreeze({ ...base, ...overrides });
}

export function observation(id: string, captureTick: number, fields: { readonly modality?: SensorModality; readonly footprint?: Region | null; readonly detections?: readonly Detection[]; readonly personSearch?: Observation["personSearch"]; readonly position?: Vec3; readonly supersedes?: string | null } = {}): Observation {
  const modality = fields.modality ?? "thermal";
  return {
    id,
    runId: RUN_ID,
    sensorId: `${modality}-front`,
    modality,
    captureTick,
    arrivalTick: captureTick + 5,
    frameId: `frame-${id}`,
    calibrationId: "fixture-calibration",
    provenance: "fixture",
    sensorPose: { position: fields.position ?? vec3(2.5, -5, 4.4), yawRad: Math.PI / 2, sigmaM: 0.2 },
    quality: 0.8,
    footprint: fields.footprint === undefined ? sphere(fields.position ?? vec3(2.5, -5, 4.4), 4) : fields.footprint,
    personSearch: fields.personSearch === undefined ? (modality === "thermal" ? "oracle_fixture" : null) : fields.personSearch,
    detections: fields.detections ?? [],
    supersedes: fields.supersedes ?? null,
  };
}

/** An RGB frame that saw an opening in the given state, and the matching opening evidence. */
export function openingSeen(openingId: string, state: OpeningState, tick: number, observationId = `obs-${openingId}-${state}-${tick}`): { readonly observation: Observation; readonly evidence: OpeningEvidence } {
  const opening = HOUSE.openings.find(o => o.id === openingId);
  if (!opening) throw new RangeError(`Unknown fixture opening ${openingId}`);
  return {
    observation: observation(observationId, tick, { modality: "rgb", footprint: sector(vec3(2.5, -5, 4.4), vec3(0, 1, 0), 0.8, 8), detections: [{ kind: "opening_state", openingId, state }] }),
    evidence: { openingId, state, tick, observationId },
  };
}

/** Outside, with the rear bedroom window observed closed 10 ticks ago through a degraded view. */
export function closedWindowBelief(overrides: Partial<BeliefSnapshot> = {}): BeliefSnapshot {
  const seen = openingSeen("window-rear", "closed", T_OUTSIDE - 10, "obs-window-rear");
  return outsideBelief({
    observations: [seen.observation],
    openings: [seen.evidence],
    coverage: coverageWith([{ roomId: "bedroom-rear", state: "degraded", fractionAdequate: 0.1, fractionAny: 0.4, lastObservedTick: T_OUTSIDE - 10, bestModality: "rgb" }]),
    ...overrides,
  });
}

export const FIRE_REGION: Region = sphere(vec3(7, 2, 3.3), 0.5);
export const TRACK_POSITION: Vec3 = vec3(1, 1, 3.5);

export const TRACK: OccupantTrack = deepFreeze({
  id: "track-1",
  status: "possible",
  observationIds: ["obs-person-1"],
  position: TRACK_POSITION,
  uncertaintyM: 0.4,
  roomId: "bedroom-rear",
  firstSeenTick: 1950,
  lastSeenTick: 1950,
  confidence: 0.6,
  mergedInto: null,
  ambiguousWith: [],
});

export const FIRE: HazardEvidence = deepFreeze({ observationId: "obs-fire-1", tick: 1960, hazard: "fire", region: FIRE_REGION, intensity: 0.8 });

export const EVACUATION_BLOCKED: RouteAssessment = deepFreeze({
  id: "route-evac",
  purpose: "evacuation",
  waypoints: [vec3(1.5, 1.5, 3.5), vec3(5, 2, 3.5), vec3(7, 2, 3.5), vec3(9, 6, 3.5), vec3(9, 7.5, 0.5)],
  status: "unsupported",
  assessedTick: 1970,
  evidenceIds: ["obs-fire-1"],
  estimatedDurationS: 40,
  reason: "Fire observed in the upstairs hall blocks the route.",
});

export const RETURN_ROUTE: RouteAssessment = deepFreeze({
  id: "route-return",
  purpose: "return",
  waypoints: [vec3(2.5, 1, 4.3), vec3(2.5, -1, 4.4), vec3(2.5, -8, 2)],
  status: "supported",
  assessedTick: 1500,
  evidenceIds: ["obs-window-rear-broken"],
  estimatedDurationS: 25,
  reason: "Entry path observed clear.",
});

/**
 * Inside the rear bedroom after entering through the broken rear window: a possible occupant in the
 * bedroom, a small fire in the upstairs hall on the evacuation route, and a supported return route.
 */
export function insideBelief(overrides: Partial<BeliefSnapshot> = {}): BeliefSnapshot {
  const broken = openingSeen("window-rear", "broken", 1500, "obs-window-rear-broken");
  const person = observation("obs-person-1", 1950, { position: vec3(2.5, 2.5, 4.3), detections: [{ kind: "possible_person", position: TRACK_POSITION, uncertaintyM: 0.4, confidence: 0.6, method: "oracle_fixture" }] });
  const fire = observation("obs-fire-1", 1960, { position: vec3(4.5, 2, 4.2), detections: [{ kind: "hazard", hazard: "fire", region: FIRE_REGION, intensity: 0.8 }] });
  return outsideBelief({
    tick: T_INSIDE,
    evidenceRevision: 40,
    pose: { tick: T_INSIDE, position: vec3(2.5, 2.5, 4.3), yawRad: 0, velocity: vec3(0, 0, 0), sigmaM: 0.2, yawSigmaRad: 0.05, supported: true },
    observations: [broken.observation, person, fire],
    openings: [broken.evidence],
    tracks: [TRACK],
    hazards: [FIRE],
    routes: [EVACUATION_BLOCKED, RETURN_ROUTE],
    coverage: coverageWith([
      { roomId: "bedroom-rear", state: "observed", fractionAdequate: 0.97, fractionAny: 1, lastObservedTick: 1990, bestModality: "thermal" },
      { roomId: "hall-up", state: "degraded", fractionAdequate: 0.4, fractionAny: 0.7, lastObservedTick: 1960, bestModality: "thermal" },
    ]),
    ...overrides,
  });
}

/** After suppression at tick 2100: the evacuation route is reassessed from fresh observations. */
export function afterSuppressionBelief(routeOverrides: Partial<RouteAssessment> = {}, overrides: Partial<BeliefSnapshot> = {}): BeliefSnapshot {
  const reassessed: RouteAssessment = { ...EVACUATION_BLOCKED, status: "supported", assessedTick: 2150, evidenceIds: ["obs-route-1"], reason: "Fresh thermal view shows the hall passable.", ...routeOverrides };
  const routeView = observation("obs-route-1", 2150, { position: vec3(4.5, 2, 4.2) });
  const base = insideBelief();
  return insideBelief({
    tick: 2200,
    evidenceRevision: 55,
    pose: { ...base.pose, tick: 2200 },
    observations: [...base.observations, routeView],
    hazards: [{ ...FIRE, observationId: "obs-route-1", tick: 2150, intensity: 0 }],
    routes: [EVACUATION_BLOCKED, reassessed, { ...RETURN_ROUTE, assessedTick: 2150 }],
    ...overrides,
  });
}

/** Deterministic Fisher–Yates shuffle with a fixed linear congruential generator. */
export function shuffled<T>(items: readonly T[], seed = 7): T[] {
  const out = items.slice();
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
