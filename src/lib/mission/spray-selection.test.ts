/**
 * Spray standoff selection on the Troy main scenario's real scene prior (through the truth-free prior builder;
 * no scenario anchors). It lives with the mission because planner code and tests never import simulation
 * modules. Belief fixture: the aircraft has entered through the broken study window and is in the study; a fire
 * was just sighted at the base of the upstairs hall's east wing, where the live run sees it.
 *
 * The hall is L-shaped: a 2.3 m wide east wing and a 1.2 m wide corridor running west from its north end. No
 * point of the corridor keeps an aircraft wallClearanceM + span/2 (0.675 m) from both of its walls, so the only
 * standoffs that need no range assistance are on the wing's centre line, north or south of the fire.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { BeliefSnapshot, OccupantTrack, RouteAssessment } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { horizontalDistance, vec3 } from "../contracts/frames.ts";
import type { Point2 } from "../contracts/geometry.ts";
import { box, pointInPolygon, sphere } from "../contracts/geometry.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import type { GuidedTrack, Incumbent } from "../navigation/planner/candidates.ts";
import { buildCandidateSet, isHomeward, isReturnRefresh, isRouteSweep, isStandClear } from "../navigation/planner/candidates.ts";
import { rankCandidates } from "../navigation/planner/local-planner.ts";
import { assessRoute } from "../navigation/routes/index.ts";
import { EventLog } from "../contracts/events.ts";
import { ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { DecisionBroker } from "../navigation/planner/broker.ts";
import { ENVELOPE as FIXTURE_ENVELOPE, insideBelief, RUN_ID } from "../navigation/planner/test-fixtures.ts";
import { guidedTracks, guideYields, MissionPlanner, onStationM, proposeNearM, UNREACHABLE_PERMANENT_AFTER, UNREACHABLE_RADIUS_M, UNREACHABLE_TICKS, UnreachableMarks } from "./planner-step.ts";
import { observation } from "../navigation/planner/test-fixtures.ts";
import type { CandidateSet, ProposalCandidate } from "../navigation/planner/types.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";

const meta = JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")) as SceneMetaJson;
const prior = floorPlanPriorFromScene(meta);
const hall = prior.rooms.find(room => room.id === "room-u-hall");
const T = 9000;
const FIRE_AT = vec3(20.865, 2.086, 3.6);
/** The reflex corner of the hall where its corridor meets the east wing. */
const CORNER: Point2 = [19.702, 3.157];
/** Where the previous fixed-reach search put the standoff: in the corridor, by the corner. */
const OLD_STANDOFF = vec3(19.35, 3.95, 4.1);
const envelope: MissionEnvelope = deepFreeze({ runId: "run-troy", revision: 1, approvedBy: "commander-1", approvedTick: 0, regions: [box(vec3(-48, -34, -0.15), vec3(62, 58, 8))], maxSpeedMps: 2, ambientCeilingC: 80, endTick: 100_000 });

function hallFireBelief(pose: Vec3, fireRadiusM = 0.25, fireAt: Vec3 = FIRE_AT): BeliefSnapshot {
  const fire = { ...observation("obs-fire", T - 20, { position: pose }), runId: "run-troy" };
  const window = { ...observation("obs-s1", T - 30, { modality: "rgb", detections: [{ kind: "opening_state", openingId: "win-u-study-s1", state: "broken" }] }), runId: "run-troy" };
  return deepFreeze({
    runId: "run-troy",
    tick: T,
    evidenceRevision: 70,
    mapPrior: prior,
    mapRevision: 1,
    mapChanges: [],
    pose: { tick: T, position: pose, yawRad: 0, velocity: vec3(0, 0, 0), sigmaM: 0.1, yawSigmaRad: 0.02, supported: true },
    aircraft: { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 30, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "No landing surface observed." },
    observations: [fire, window],
    reports: [],
    tracks: [],
    crewConfirmations: [],
    coverage: prior.rooms.map(room => ({ roomId: room.id, state: "unobserved" as const, fractionAdequate: 0, fractionAny: 0, lastObservedTick: null, bestModality: null })),
    hazards: [{ observationId: fire.id, tick: T - 20, hazard: "fire" as const, region: sphere(fireAt, fireRadiusM), intensity: 0.6 }],
    openings: [{ openingId: "win-u-study-s1", state: "broken" as const, tick: T - 30, observationId: window.id }],
    routes: [],
    dispatchConfirmed: null,
  });
}

function spray(set: CandidateSet): ProposalCandidate & { proposal: { action: { kind: "spray"; standoff: Vec3; aimPoint: Vec3 } } } {
  const candidate = set.candidates.find(c => c.tool === "request_suppression");
  assert.ok(candidate && candidate.proposal !== null && candidate.proposal.action.kind === "spray", set.notes.join("\n"));
  return candidate as ProposalCandidate & { proposal: { action: { kind: "spray"; standoff: Vec3; aimPoint: Vec3 } } };
}

function boundaryDistance(p: Point2, polygon: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / lengthSq));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay))));
  }
  return best;
}

function segmentPointDistance(a: Vec3, b: Vec3, p: Point2): number {
  const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - a.x) * (b.x - a.x) + (p[1] - a.y) * (b.y - a.y)) / lengthSq));
  return Math.hypot(p[0] - (a.x + t * (b.x - a.x)), p[1] - (a.y + t * (b.y - a.y)));
}

describe("spray standoff on the Troy hall fire", () => {
  assert.ok(hall);
  const wallClearance = DEFAULT_POLICY.wallClearanceM + TENDER_T1.spanM / 2;
  const coneRadiusAt = (m: number) => m * Math.tan(((TENDER_T1.modules.water?.coneHalfAngleDeg ?? 0) * Math.PI) / 180);

  test("from the study, the standoff is on the east wing's centre line 1.4-1.7 m from the fire, clear of the walls and the corner", () => {
    const set = buildCandidateSet({ belief: hallFireBelief(vec3(17.5, 1, 4.6)), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY });
    const { standoff, aimPoint } = spray(set).proposal.action;
    assert.ok(pointInPolygon(standoff.x, standoff.y, hall.polygon), "in the fire's room");
    assert.ok(boundaryDistance([standoff.x, standoff.y], hall.polygon) >= wallClearance, `${boundaryDistance([standoff.x, standoff.y], hall.polygon)} m from the nearest wall`);
    const reachM = horizontalDistance(standoff, aimPoint);
    assert.ok(reachM >= 1.4 && reachM <= 1.7, `${reachM} m from the fire`);
    assert.ok(Math.abs(standoff.x - FIRE_AT.x) < 0.05, "on the wing's centre line, straight north or south of the fire");
    assert.ok(segmentPointDistance(standoff, aimPoint, CORNER) > coneRadiusAt(reachM) + 0.2, "the jet does not graze the corridor corner");
    assert.ok(horizontalDistance(standoff, OLD_STANDOFF) > 1.5, "not the old corridor standoff by the corner");
    assert.match(spray(set).proposal.rationale, /at least 0.68 m from every wall, so holding it needs no range assistance/);
  });

  test("from anywhere in the study it is the 1.4 m centre-line standoff on one side of the fire, the nearer side", () => {
    for (const pose of [vec3(17.5, 1, 4.6), vec3(15, 2.5, 4.6), vec3(18.8, -2, 4.6)]) {
      const { standoff, aimPoint } = spray(buildCandidateSet({ belief: hallFireBelief(pose), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY })).proposal.action;
      assert.ok(Math.abs(standoff.x - FIRE_AT.x) < 0.05 && Math.abs(horizontalDistance(standoff, aimPoint) - 1.4) < 0.02, JSON.stringify(standoff));
      const other = vec3(standoff.x, 2 * aimPoint.y - standoff.y, standoff.z);
      assert.ok(horizontalDistance(pose, standoff) <= horizontalDistance(pose, other) + 1e-9, "the side nearer the aircraft");
    }
  });

  test("a larger fire region rules out the nearer standoffs, and with none left the set says why instead of offering one by the corner", () => {
    const big = spray(buildCandidateSet({ belief: hallFireBelief(vec3(17.5, 1, 4.6), 0.45), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY })).proposal.action;
    assert.ok(horizontalDistance(big.standoff, big.aimPoint) >= 1.55, "1.1 m beyond the region's surface");
    const huge = buildCandidateSet({ belief: hallFireBelief(vec3(17.5, 1, 4.6), 0.9), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY });
    assert.ok(!huge.candidates.some(c => c.tool === "request_suppression"));
    assert.ok(huge.notes.some(note => /^No spray standoff for the fire in Upstairs hall/.test(note)), huge.notes.join("\n"));
  });
});

describe("spray standoff stability and stalled stations", () => {
  const study = vec3(17.5, 1, 4.6);
  const choose = (fireAt: Vec3, incumbent: Incumbent | null = null, radiusM = 0.25) => spray(buildCandidateSet({ belief: hallFireBelief(study, radiusM, fireAt), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, incumbent })).proposal.action.standoff;
  const id = "request_suppression:room-u-hall";

  test("a centimetre of sighting jitter does not move the standoff", () => {
    const first = choose(FIRE_AT);
    // The standoff follows the aim by the jitter itself, but stays the same option (same bearing and reach).
    assert.ok(horizontalDistance(choose(vec3(FIRE_AT.x + 0.005, FIRE_AT.y - 0.016, FIRE_AT.z)), first) < 0.03);
  });

  test("a nearer standoff that appears without being materially better does not pull the aircraft off the incumbent", () => {
    const first = choose(FIRE_AT);
    assert.ok(Math.abs(horizontalDistance(first, FIRE_AT) - 1.4) < 0.02, "1.4 m: the shortest reach outside a 0.25 m fire's 1.1 m clearance");
    // Seen from closer the fire region shrinks to 0.08 m and the 1.2 m standoffs clear it too.
    const nearer = choose(FIRE_AT, null, 0.08);
    assert.ok(Math.abs(horizontalDistance(nearer, FIRE_AT) - 1.2) < 0.02, "without an incumbent the nearer one is chosen");
    assert.deepEqual(choose(FIRE_AT, { candidateId: id, station: first }, 0.08), first);
  });

  test("an incumbent that the moved fire's clearance rules out is replaced", () => {
    const first = choose(FIRE_AT);
    const moved = vec3(FIRE_AT.x, FIRE_AT.y - 0.8, FIRE_AT.z);
    assert.ok(horizontalDistance(choose(moved, { candidateId: id, station: first }), first) > 0.1);
  });

  test("a stalled station is left out nearby for a while, not everywhere nearby for the run", () => {
    const marks = new UnreachableMarks();
    // The 1.6 m south standoff stalled; the 1.2 m one, 0.4 m further north, was ruled out too under the old 1 m radius.
    const stalled = vec3(20.865, 0.486, 4.1);
    const first = marks.mark(stalled, 12_400);
    assert.deepEqual(first, { until: 12_400 + UNREACHABLE_TICKS, stalls: 1 });
    assert.ok(marks.has(vec3(20.865, 0.486 + UNREACHABLE_RADIUS_M - 0.01, 4.1), 12_401), "within the radius");
    assert.ok(!marks.has(vec3(20.865, 0.886, 4.1), 12_401), "the 1.2 m south standoff is still offered");
    assert.ok(!marks.has(stalled, 12_400 + UNREACHABLE_TICKS), "the mark expires");
  });

  test("repeated stalls at the same point last longer, and the third lasts for the run", () => {
    const marks = new UnreachableMarks();
    const p = vec3(20.84, 0.71, 4.1);
    marks.mark(p, 0);
    const second = marks.mark(vec3(p.x + 0.1, p.y, p.z), UNREACHABLE_TICKS + 10);
    assert.deepEqual(second, { until: UNREACHABLE_TICKS + 10 + 2 * UNREACHABLE_TICKS, stalls: 2 });
    let last = second;
    for (let n = 3; n <= UNREACHABLE_PERMANENT_AFTER; n++) last = marks.mark(p, 10 * UNREACHABLE_TICKS * n);
    assert.equal(last.until, Infinity);
    assert.ok(marks.has(p, 1e9));
  });
});

/*
 * Person clearance on Troy: the lead is in the upstairs rear bedroom (x 22.15–26.25, y −2.78–1.45), where the
 * live run's aircraft flew into the occupant while taking a second look. The aircraft is in the hall.
 */
describe("second looks on Troy keep clear of the occupant and the walls", () => {
  const lead = { id: "track-7", status: "possible" as const, observationIds: [], position: vec3(23.7, 0.2, 4.4), uncertaintyM: 0.6, roomId: "room-u-rear-bedroom", firstSeenTick: T - 400, lastSeenTick: T - 60, confidence: 0.9, mergedInto: null, ambiguousWith: [] };
  const rear = prior.rooms.find(room => room.id === "room-u-rear-bedroom");
  const hall = prior.rooms.find(room => room.id === "room-u-hall");
  const withLead = (pose: Vec3) => deepFreeze({ ...hallFireBelief(pose), tracks: [lead] });

  test("the second look is from the hall through the bedroom doorway, at least 1.0 + 0.275 + 0.6 m from the lead and 0.675 m from the hall's walls", () => {
    assert.ok(rear && hall);
    for (const pose of [vec3(20.9, 0.9, 4.6), vec3(21.5, 0.5, 4.6), vec3(19.5, 3.7, 4.6)]) {
      const set = buildCandidateSet({ belief: withLead(pose), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY });
      const look = set.candidates.find(c => c.tool === "investigate_signal");
      assert.ok(look?.target?.station, set.notes.join("\n"));
      const goal = look.target.station;
      assert.ok(pointInPolygon(goal.x, goal.y, hall.polygon) && !pointInPolygon(goal.x, goal.y, rear.polygon), JSON.stringify(goal));
      assert.ok(horizontalDistance(goal, lead.position) >= 1.0 + TENDER_T1.spanM / 2 + lead.uncertaintyM, `${horizontalDistance(goal, lead.position)} m from the lead`);
      assert.ok(boundaryDistance([goal.x, goal.y], hall.polygon) >= DEFAULT_POLICY.wallClearanceM + TENDER_T1.spanM / 2, `${boundaryDistance([goal.x, goal.y], hall.polygon)} m from a wall`);
      // Looking at the lead through door-u-rear-bedroom (x = 22.075, y 0.15-0.95).
      const t = (22.075 - goal.x) / (lead.position.x - goal.x);
      const yAtDoor = goal.y + (lead.position.y - goal.y) * t;
      assert.ok(yAtDoor > 0.15 && yAtDoor < 0.95, `the sight line crosses the wall at y ${yAtDoor}`);
    }
  });

  test("while the hall spray cools after a coverage refusal the aircraft is not sent into the occupant's room", () => {
    const sprayId = "request_suppression:room-u-hall";
    const set = buildCandidateSet({ belief: withLead(vec3(20.87, 0.7, 4.1)), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, omitCandidateIds: [sprayId], retrying: [sprayId] });
    const spray = buildCandidateSet({ belief: withLead(vec3(20.87, 0.7, 4.1)), profile: TENDER_T1, envelope, policy: DEFAULT_POLICY }).candidates.find(c => c.id === sprayId)?.target?.station;
    assert.ok(spray);
    for (const look of set.candidates.filter(c => c.tool === "investigate_signal")) assert.ok(look.target?.station && horizontalDistance(look.target.station, spray) <= 2, "a second look only from beside the spray standoff");
    assert.ok(!set.candidates.some(c => c.proposal !== null && c.target?.station != null && rear && pointInPolygon(c.target.station.x, c.target.station.y, rear.polygon)), "nothing stationed in the rear bedroom");
  });
});

/*
 * Regression (E2E run-e2e-main on fbd5518): a spray accepted 0.32 m from its standoff was never "on station"
 * (0.30 m then), so a station move started every few ticks, each ended at once, and the third aborted the
 * spray at 102.79 s. Fixture house, planner and harness only (no simulator): the test sets the aircraft's
 * estimated position each tick; the harness ends a move when that position is within its arrival tolerance.
 */
describe("a spray settling just off its standoff stays pending", () => {
  const T0 = 2000;
  const room = vec3(7, 5.5, 3.8);

  function run(phases: readonly { readonly ticks: number; readonly offsetM: (tick: number) => number }[]) {
    const log = new EventLog(RUN_ID);
    const harness = new ActionHarness(RUN_ID, log);
    const planner = new MissionPlanner(new DecisionBroker({ runId: RUN_ID, cloudEnabled: false, policy: DEFAULT_POLICY }));
    const base = insideBelief({ tracks: [], routes: [] });
    const firstSet = buildCandidateSet({ belief: { ...base, pose: { ...base.pose, position: room } }, profile: TENDER_T1, envelope: FIXTURE_ENVELOPE, policy: DEFAULT_POLICY });
    const { standoff, aimPoint } = spray(firstSet).proposal.action;
    // Offsets are taken toward the room's interior, away from the walls.
    const toward = { x: (room.x - standoff.x) / horizontalDistance(room, standoff), y: (room.y - standoff.y) / horizontalDistance(room, standoff) };
    let tick = T0;
    const contexts: HarnessContext[] = [];
    for (const phase of phases) {
      for (let i = 0; i < phase.ticks; i++, tick++) {
        const offset = phase.offsetM(tick);
        const position = vec3(standoff.x + toward.x * offset, standoff.y + toward.y * offset, standoff.z);
        const views = Array.from({ length: 20 }, (_, k) => observation(`cov-${tick - 1 - k * 5}`, tick - 1 - k * 5, { position, footprint: box(vec3(4, -1, 2.5), vec3(11, 9, 6.5)) }));
        // Facing the aim: these tests are about settling distance (the planner waits for the turn otherwise).
        const yawRad = Math.atan2(aimPoint.y - position.y, aimPoint.x - position.x);
        const belief = deepFreeze({ ...base, tick, evidenceRevision: 100 + Math.floor(tick / 50), pose: { ...base.pose, tick, position, yawRad }, observations: [...base.observations, ...views] });
        const ctx: HarnessContext = { tick, missionStartTick: 0, profile: TENDER_T1, policy: DEFAULT_POLICY, envelope: FIXTURE_ENVELOPE, belief };
        const pt = { ctx, harness, log, lastInterventionTick: null, nowMs: tick * 10 };
        planner.noteArrival(pt);
        planner.tick(pt);
        planner.watch(pt, null);
        harness.step(ctx, null);
        contexts.push(ctx);
      }
    }
    return { harness, log, standoff, contexts };
  }
  const sprays = (harness: ActionHarness) => harness.records().filter(r => r.proposal.action.kind === "spray");

  test("the propose distance lies inside the on-station distance, which lies inside the harness's standoff tolerance", () => {
    const ctx = { policy: DEFAULT_POLICY } as HarnessContext;
    const sprayAction = { kind: "spray" as const, standoff: vec3(0, 0, 0), aimPoint: vec3(1, 0, 0), flowLps: 0.1, durationTicks: 10 };
    assert.ok(proposeNearM(sprayAction, ctx) < onStationM(ctx) && onStationM(ctx) < DEFAULT_POLICY.standoffToleranceM);
    assert.ok(proposeNearM(sprayAction, ctx) >= DEFAULT_POLICY.arrivalToleranceM - 1e-9, "a preposition move ends close enough to propose");
  });

  const stationMovesFor = (harness: ActionHarness) => harness.records().filter(r => r.proposal.action.kind === "move" && /Move to the standoff of spray proposal/.test(r.proposal.rationale));

  test("accepted 0.32 m off its standoff, the spray is on station and stays pending while the aircraft settles there", () => {
    const { harness, log } = run([
      { ticks: 400, offsetM: () => 0.32 },
      { ticks: 1000, offsetM: tick => 0.32 + 0.02 * Math.sin(tick / 7) },
    ]);
    const records = sprays(harness);
    assert.equal(records.length, 1, `one spray proposal: ${records.map(r => r.status).join(", ")}`);
    assert.equal(records[0].status, "awaiting_approval", records[0].history.map(h => `${h.status}@${h.tick}: ${h.reason.slice(0, 80)}`).join(" | "));
    assert.ok(!log.entries().some(e => e.kind === "planner.goal_unreachable"), "no station marked unreachable");
    assert.deepEqual(stationMovesFor(harness).map(r => r.history[0].tick), [], "no station move while within the on-station distance");
  });

  test("farther off than the propose distance it prepositions instead, and is proposed once settled", () => {
    const { harness } = run([
      { ticks: 300, offsetM: () => 0.34 },
      { ticks: 400, offsetM: () => 0.25 },
    ]);
    const records = sprays(harness);
    assert.equal(records.length, 1);
    assert.ok(records[0].history[0].tick >= T0 + 300, "not proposed while 0.34 m off");
    assert.equal(records[0].status, "awaiting_approval");
  });

  test("an aircraft pushed well off station gets station moves at most once per retry interval and the spray survives a while", () => {
    const { harness } = run([
      { ticks: 300, offsetM: () => 0.25 },
      { ticks: 300, offsetM: () => 0.25 },
      { ticks: 400, offsetM: () => 0.6 },
    ]);
    const spray = sprays(harness)[0];
    assert.ok(spray, "proposed once settled");
    const stationMoves = stationMovesFor(harness);
    assert.ok(stationMoves.length >= 1 && stationMoves.length <= 2, `${stationMoves.length} station moves in 4 s`);
    assert.equal(spray.status, "awaiting_approval", "a station move that keeps running is not an attempt used up");
  });
});

/*
 * The post-suppression route sweep on Troy: the hall fire is out (no flame sighting), the lead is in the rear
 * bedroom, and the evacuation route (rear bedroom → door-u-rear-bedroom → hall → stair → entry → door-front)
 * is "unknown". The sweep goes in reverse route order and ends by the bedroom doorway, ahead of the occupant.
 */
describe("post-suppression route sweep on Troy", () => {
  const lead = { id: "track-7", status: "possible" as const, observationIds: [], position: vec3(23.7, 0.2, 4.4), uncertaintyM: 0.3, roomId: "room-u-rear-bedroom", firstSeenTick: T - 400, lastSeenTick: T - 60, confidence: 0.9, mergedInto: null, ambiguousWith: [] };
  const entry = prior.rooms.find(room => room.id === "room-g-entry");
  const assembly = vec3(30, 20, 0.5);

  function sweepBelief(fresh: { readonly searched?: readonly string[]; readonly observed?: readonly string[] } = {}): BeliefSnapshot {
    const base = { ...hallFireBelief(vec3(20.5, 1.5, 4.6)), hazards: [], tracks: [lead] };
    const route = assessRoute({ belief: base, tick: T, lastInterventionTick: null, policy: DEFAULT_POLICY }, { id: "route-evacuation", purpose: "evacuation", from: lead.position, destination: { kind: "exit", exitId: "exit-front-door", then: assembly }, traveler: "occupant", speedMps: 0.8 });
    const coverage = prior.rooms.map(room => (fresh.searched ?? []).includes(room.id)
      ? { roomId: room.id, state: "observed" as const, fractionAdequate: 0.6, fractionAny: 0.8, lastObservedTick: T - 5, bestModality: "rgb" as const, fractionSearched: 0.6, searchedSince: [{ sinceTick: T - 5, fraction: 0.6 }] }
      : { roomId: room.id, state: "unobserved" as const, fractionAdequate: 0, fractionAny: 0, lastObservedTick: null, bestModality: null });
    const openings = [...base.openings, ...(fresh.observed ?? []).map(id => ({ openingId: id, state: (id === "door-front" ? "closed" : "open") as "closed" | "open", tick: T - 5, observationId: "obs-s1" }))];
    return deepFreeze({ ...base, coverage, openings, routes: [{ ...route, status: "unknown" as const }] });
  }
  const top = (belief: BeliefSnapshot) => {
    const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY });
    const choice = rankCandidates(set, belief, DEFAULT_POLICY).choiceId;
    return { set, choice: set.candidates.find(c => c.id === choice) };
  };

  test("first the entry, from a station facing the front door", () => {
    const { choice } = top(sweepBelief());
    assert.ok(choice && isRouteSweep(choice), choice?.id);
    assert.equal(choice.target?.roomId, "room-g-entry");
    const station = choice.target?.station;
    assert.ok(station && entry && pointInPolygon(station.x, station.y, entry.polygon));
    assert.deepEqual(choice.target?.focus, vec3(13.707, 6.209, 1.1), "looking at door-front");
  });

  test("then the hall, then a station by the bedroom doorway at the guidance clearance, looking in; then nothing", () => {
    const hallStep = top(sweepBelief({ searched: ["room-g-entry"], observed: ["door-front"] })).choice;
    assert.ok(hallStep && isRouteSweep(hallStep) && hallStep.target?.roomId === "room-u-hall", hallStep?.id);
    const doorStep = top(sweepBelief({ searched: ["room-g-entry", "room-u-hall"], observed: ["door-front"] })).choice;
    assert.ok(doorStep && isRouteSweep(doorStep) && doorStep.target?.roomId === "room-u-rear-bedroom", doorStep?.id);
    const station = doorStep.target?.station;
    assert.ok(station && hall && pointInPolygon(station.x, station.y, hall.polygon), JSON.stringify(station));
    assert.ok(horizontalDistance(station, lead.position) >= 1.2 + TENDER_T1.spanM / 2 + lead.uncertaintyM, `${horizontalDistance(station, lead.position)} m from the lead`);
    assert.ok(horizontalDistance(station, lead.position) <= 6, "within light-cue range, ahead of the occupant on the route");
    assert.deepEqual(doorStep.target?.focus, lead.position, "looking in at the lead");
    const done = top(sweepBelief({ searched: ["room-g-entry", "room-u-hall", "room-u-rear-bedroom"], observed: ["door-front", "door-u-rear-bedroom"] }));
    assert.ok(!done.set.candidates.some(isRouteSweep), "every step's evidence is fresh");
  });

  test("once the entry is done, its evidence ageing past the limit does not send the sweep back before the hall", () => {
    const base = sweepBelief();
    const done = T - 7000;
    const coverage = base.coverage.map(c => (c.roomId === "room-g-entry" ? { ...c, state: "observed" as const, fractionAdequate: 0.6, fractionAny: 0.8, lastObservedTick: done, bestModality: "rgb" as const, fractionSearched: 0.6, searchedSince: [{ sinceTick: done, fraction: 0.6 }] } : c));
    const openings = [...base.openings, { openingId: "door-front", state: "closed" as const, tick: done, observationId: "obs-s1" }];
    const belief = deepFreeze({ ...base, coverage, openings });
    assert.ok(done < T - DEFAULT_POLICY.routeEvidenceMaxAgeTicks, "the entry's evidence has aged out");
    const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, lastInterventionTick: T - 9000 });
    const choice = set.candidates.find(c => c.id === rankCandidates(set, belief, DEFAULT_POLICY).choiceId);
    assert.ok(choice && isRouteSweep(choice) && choice.target?.roomId === "room-u-hall", choice?.id);
  });

  test("no sweep while a flame is still seen", () => {
    const belief = { ...sweepBelief(), hazards: hallFireBelief(vec3(20.5, 1.5, 4.6)).hazards };
    assert.ok(!buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY }).candidates.some(isRouteSweep));
  });
});

/*
 * After guidance on Troy. Guidance ends on its time limit, not on arrival: in the staged post-suppression run the
 * guide completed while the occupant was still walking through the entry hall to the front door, the route went
 * "unknown" as its evidence aged, and the next plan sent the aircraft back into the entry for a route-sweep step,
 * into the occupant's way (contact). Once guidance has run for a track, the aircraft stands clear of that person's
 * remaining route until the track has left or arrived, then returns.
 */
describe("after guidance on Troy", () => {
  const ASSEMBLY = vec3(19, 25.5, 0);
  const lead: OccupantTrack = { id: "track-7", status: "possible", observationIds: [], position: vec3(12.9, 4.2, 0.9), uncertaintyM: 0.3, roomId: "room-g-entry", firstSeenTick: T - 14_000, lastSeenTick: T - 10, confidence: 0.9, mergedInto: null, ambiguousWith: [] };
  const guided: readonly GuidedTrack[] = [{ trackId: lead.id, routeId: "route-evacuation", sinceTick: T - 12_000 }];
  /** Guidance clearance from the aircraft's centre: policy guidanceClearanceM, half the span, the track's uncertainty. */
  const guidanceM = (u: number) => DEFAULT_POLICY.guidanceClearanceM + TENDER_T1.spanM / 2 + u;
  const returnRoute = (pose: Vec3): RouteAssessment => ({ id: "route-return", purpose: "return", waypoints: [pose, vec3(30.5, 28, 1.5)], status: "supported", assessedTick: T - 10, evidenceIds: [], estimatedDurationS: 40, reason: "Supported for the drone." });

  /** The aircraft ahead of the occupant by the front door (where the guide left it); fire out, nothing searched. */
  function afterGuide(person: OccupantTrack, pose: Vec3, evacuation: RouteAssessment["status"] = "unknown"): BeliefSnapshot {
    const base = hallFireBelief(pose);
    const plain = { ...base, observations: base.observations.filter(o => o.id !== "obs-fire"), hazards: [], tracks: [person] };
    const route = assessRoute({ belief: plain, tick: T, lastInterventionTick: null, policy: DEFAULT_POLICY }, { id: "route-evacuation", purpose: "evacuation", from: person.position, destination: { kind: "exit", exitId: "exit-front-door", then: ASSEMBLY }, traveler: "occupant", speedMps: 0.8 });
    return deepFreeze({ ...plain, routes: [{ ...route, status: evacuation }, returnRoute(pose)] });
  }
  const plan = (belief: BeliefSnapshot, withGuided: readonly GuidedTrack[] = guided) => {
    const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, guided: withGuided });
    const choice = rankCandidates(set, belief, DEFAULT_POLICY).choiceId;
    return { set, choice: set.candidates.find(c => c.id === choice) };
  };
  /** Horizontal distance from p to the occupant's way out (the evacuation route assessed from them), on p's floor. */
  const wayOutDistance = (belief: BeliefSnapshot, p: Vec3) => {
    const route = belief.routes.find(r => r.purpose === "evacuation");
    assert.ok(route && route.waypoints.length > 1);
    let best = Infinity;
    for (let i = 1; i < route.waypoints.length; i++) {
      const a = route.waypoints[i - 1];
      const b = route.waypoints[i];
      if (Math.min(Math.abs(a.z - p.z), Math.abs(b.z - p.z)) > 2.5) continue;
      best = Math.min(best, segmentPointDistance(a, b, [p.x, p.y]));
    }
    return best;
  };
  const DOOR_SIDE = vec3(13.0, 6.3, 1.4);

  /** About to come down the stair (the route then runs hall, stair, entry), and walking through the entry to the door. */
  const upstairs = { ...lead, position: vec3(19.0, 3.76, 4.4), roomId: "room-u-hall" };

  test("without the guide record, the plan sweeps the entry from a station on the occupant's way out", () => {
    const belief = afterGuide(upstairs, DOOR_SIDE);
    const { choice } = plan(belief, []);
    assert.ok(choice && isRouteSweep(choice) && choice.target?.roomId === "room-g-entry" && choice.target.station, choice?.id);
    assert.ok(wayOutDistance(belief, choice.target.station) < guidanceM(lead.uncertaintyM), "the sweep station is on the way out");
  });

  test("once guidance has run, the aircraft stands clear of the way out and faces the occupant; nothing crosses their path and the return waits", () => {
    for (const person of [upstairs, lead]) {
      const belief = afterGuide(person, DOOR_SIDE);
      const { set, choice } = plan(belief);
      const where = JSON.stringify(person.position);
      assert.ok(choice && isStandClear(choice), `${where}: ${choice?.id}\n${set.notes.join("\n")}`);
      assert.equal(choice.target?.trackId, person.id);
      assert.deepEqual(choice.target?.focus, person.position, "facing the occupant");
      const station = choice.target?.station;
      assert.ok(station);
      assert.ok(wayOutDistance(belief, station) >= guidanceM(person.uncertaintyM), `${where}: ${wayOutDistance(belief, station)} m from the way out`);
      assert.ok(horizontalDistance(station, person.position) >= guidanceM(person.uncertaintyM) || Math.abs(station.z - person.position.z) > 2.5);
      const proposals = set.candidates.filter(c => c.proposal !== null);
      for (const c of proposals) {
        assert.ok(c.target?.station == null || wayOutDistance(belief, c.target.station) >= guidanceM(person.uncertaintyM), `${where}: ${c.id} is stationed on the way out`);
      }
      assert.ok(!proposals.some(isRouteSweep), "no route sweep for a guided person");
      assert.ok(!proposals.some(c => c.tool === "investigate_signal" && !isStandClear(c)), "no second look at a guided person");
      assert.ok(!proposals.some(c => c.tool === "return_to_base"), "the return waits while they are on the way out");
    }
  });

  test("seen outside or at the assembly point: no more standing clear or guidance, and the return to base ranks first", () => {
    for (const position of [vec3(16.5, 12, 0.9), vec3(19, 25, 0.9)]) {
      const belief = afterGuide({ ...lead, position, roomId: null }, DOOR_SIDE, "supported");
      const { set, choice } = plan(belief);
      assert.ok(choice && choice.tool === "return_to_base" && isHomeward(choice), `${JSON.stringify(position)}: ${choice?.id}`);
      assert.ok(set.candidates.some(c => c.tool === "inspect_room"), "rooms not yet searched are still on offer, below the return");
      assert.ok(!set.candidates.some(c => c.tool === "guide_to_exit" || isStandClear(c)));
    }
  });

  test("last seen in the entry: gone out only once later looks have found their whole way out to the door empty", () => {
    // Last seen 2.5 m short of the front door; the stand-clear station is in the entry's north-west corner.
    const lastSeen = { ...lead, position: vec3(13.1, 4.4, 0.9), lastSeenTick: T - 300 };
    const pose = vec3(11.0, 8.6, 1.4);
    const unseen = afterGuide(lastSeen, pose);
    const waiting = plan(unseen);
    assert.ok(waiting.choice && isStandClear(waiting.choice), waiting.choice?.id);
    assert.deepEqual(waiting.choice.target?.focus, lastSeen.position, "facing where they were last seen");
    assert.ok(!waiting.set.candidates.some(c => c.tool === "return_to_base"));
    const look = (id: string, at: Vec3) => ({ ...observation(id, T - 50, { position: pose, footprint: sphere(at, 1.2) }), runId: "run-troy" });
    // Where they were seen is empty now, but the way on to the door is not yet searched: still standing clear, facing it.
    const partly = deepFreeze({ ...unseen, observations: [...unseen.observations, look("obs-look-1", lastSeen.position)] });
    const next = plan(partly);
    assert.ok(next.choice && isStandClear(next.choice), next.choice?.id);
    const focus = next.choice.target?.focus;
    assert.ok(focus && horizontalDistance(focus, lastSeen.position) > 1 && horizontalDistance(focus, vec3(13.707, 6.209, 1.1)) < 1.5, `facing ${JSON.stringify(focus)}, on toward the door`);
    assert.ok(!next.set.candidates.some(c => c.tool === "return_to_base"));
    const searched = deepFreeze({ ...partly, observations: [...partly.observations, look("obs-look-2", vec3(13.3, 6.1, 1.0))] });
    const { choice } = plan(searched);
    assert.ok(choice && isHomeward(choice), choice?.id);
  });

  test("a person picked up again as a new track on the way out is still the guided person", () => {
    // The guided track stays where the occupant sheltered; the walk out is tracked as t4, first seen after guidance began.
    const sheltered = { ...lead, id: "track-1", position: vec3(23.7, 0.3, 4.3), roomId: "room-u-rear-bedroom", lastSeenTick: T - 9000 };
    const walking = { ...lead, id: "track-4", position: vec3(13.1, 4.4, 0.9), firstSeenTick: T - 600, lastSeenTick: T - 10 };
    const guidedT1: readonly GuidedTrack[] = [{ trackId: sheltered.id, routeId: "route-evacuation", sinceTick: T - 12_000 }];
    const base = afterGuide(sheltered, DOOR_SIDE);
    const belief = deepFreeze({ ...base, tracks: [sheltered, walking] });
    const { set, choice } = plan(belief, guidedT1);
    assert.ok(choice && isStandClear(choice) && choice.target?.trackId === walking.id, `${choice?.id}\n${set.notes.join("\n")}`);
    assert.ok(!set.candidates.some(c => isRouteSweep(c) || (c.tool === "investigate_signal" && !isStandClear(c))), "no sweep or second look at either track");
    const out = deepFreeze({ ...belief, tracks: [sheltered, { ...walking, position: vec3(16.5, 12, 0.9), roomId: null }] });
    const after = plan(out, guidedT1);
    assert.ok(after.choice && isHomeward(after.choice), after.choice?.id);
  });

  /** Where the main run left the aircraft after guidance: upstairs, over the stairwell. */
  const OVER_STAIRWELL = vec3(17.97, 3.79, 4.81);
  const sheltered: OccupantTrack = { ...lead, id: "track-1", position: vec3(23.7, 0.3, 4.3), roomId: "room-u-rear-bedroom", lastSeenTick: T - 9000 };
  const guidedT1: readonly GuidedTrack[] = [{ trackId: sheltered.id, routeId: "route-evacuation", sinceTick: T - 12_000 }];

  test("with no station that keeps clear by a way that does not cross their path, the aircraft holds where it is facing them", () => {
    // The occupant, picked up again at the stair top, is about to pass beneath the aircraft on the stair.
    const atStairTop = { ...lead, id: "track-3", position: vec3(19.3, 3.9, 3.7), roomId: "room-u-hall", firstSeenTick: T - 100, lastSeenTick: T - 10 };
    const belief = deepFreeze({ ...afterGuide(sheltered, OVER_STAIRWELL), tracks: [sheltered, atStairTop] });
    const { set, choice } = plan(belief, guidedT1);
    assert.ok(choice && isStandClear(choice), `${choice?.id}\n${set.notes.join("\n")}`);
    const action = choice.proposal?.action;
    assert.ok(action?.kind === "scan" || (action?.kind === "move" && wayOutDistance(belief, action.goal) >= guidanceM(atStairTop.uncertaintyM)), JSON.stringify(action));
  });

  test("seen on the way out and gone from there, the occupant is presumed out once the rest of the walk would be over; never if never seen leaving their room", () => {
    const look = (at: Vec3, tick: number) => ({ ...observation(`obs-look-${tick}`, tick, { position: OVER_STAIRWELL, footprint: sphere(at, 1.2) }), runId: "run-troy" });
    const walking = { ...lead, id: "track-4", position: vec3(13.1, 4.4, 0.9), firstSeenTick: T - 4000 };
    const at = (lastSeenTick: number, lookTick: number) => {
      const base = afterGuide(sheltered, OVER_STAIRWELL);
      return deepFreeze({ ...base, tracks: [sheltered, { ...walking, lastSeenTick }], observations: [...base.observations, look(walking.position, lookTick)] });
    };
    // Last seen 2.4 m from the front door: a 0.5 m/s walk and 10 s margin is under 15 s.
    const long = plan(at(T - 3000, T - 2000), guidedT1);
    assert.ok(long.choice && isHomeward(long.choice), long.choice?.id);
    const recent = plan(at(T - 600, T - 300), guidedT1);
    assert.ok(recent.choice && isStandClear(recent.choice), recent.choice?.id);
    assert.ok(!recent.set.candidates.some(c => c.tool === "return_to_base"));
    // Only ever seen in the bedroom it sheltered in: a missed look there is no reason to presume them out.
    const base = afterGuide(sheltered, OVER_STAIRWELL);
    const stayed = deepFreeze({ ...base, observations: [...base.observations, look(sheltered.position, T - 2000)] });
    assert.ok(!plan(stayed, guidedT1).set.candidates.some(c => c.tool === "return_to_base"));
  });

  test("home after arrival: the return route's stale door and old fire place are looked at from beside them, then the return ranks first", () => {
    const intervention = T - 9000;
    const arrived = { ...lead, position: vec3(19, 25, 0.9), roomId: null };
    const base = afterGuide(arrived, OVER_STAIRWELL);
    const flame = { observationId: "obs-flame", tick: T - 9500, hazard: "fire" as const, region: sphere(FIRE_AT, 0.25), intensity: 0.6 };
    const doorSeen = (tick: number) => ({ openingId: "door-u-study", state: "open" as const, tick, observationId: "obs-s1" });
    const stale = { ...base, hazards: [flame], openings: [...base.openings, doorSeen(T - 8000)] };
    const ret = assessRoute({ belief: stale, tick: T, lastInterventionTick: intervention, policy: DEFAULT_POLICY }, { id: "route-return", purpose: "return", from: OVER_STAIRWELL, destination: { kind: "point", point: vec3(30.5, 28, 1.5) }, traveler: "drone", speedMps: 2 });
    assert.equal(ret.status, "unknown", ret.reason);
    const evacuation = base.routes.filter(r => r.purpose === "evacuation");
    const withRoute = (belief: Omit<BeliefSnapshot, "routes">, route: RouteAssessment) => deepFreeze({ ...belief, routes: [...evacuation, route] });
    const choose = (belief: BeliefSnapshot) => {
      const set = buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, guided, lastInterventionTick: intervention });
      return { set, choice: set.candidates.find(c => c.id === rankCandidates(set, belief, DEFAULT_POLICY).choiceId) };
    };
    const door = vec3(19.627, 1.2, 4.65);
    const first = choose(withRoute(stale, ret));
    assert.ok(first.choice && isReturnRefresh(first.choice), `${first.choice?.id}\n${first.set.notes.join("\n")}`);
    assert.ok(!first.set.candidates.some(c => c.tool === "return_to_base"));
    const focus = first.choice.target?.focus;
    const station = first.choice.target?.station;
    assert.ok(focus && station && horizontalDistance(station, focus) <= 3, JSON.stringify({ focus, station }));
    assert.ok(hall && pointInPolygon(station.x, station.y, hall.polygon), `looking from the hall, over its floor: ${JSON.stringify({ focus, station, d: first.choice.description })}`);
    // With the first place seen, the other is next.
    const firstIsDoor = horizontalDistance(focus, door) < 0.05;
    const seenOne = firstIsDoor ? { ...stale, openings: [...stale.openings, doorSeen(T - 10)] } : { ...stale, hazards: [flame, { ...flame, observationId: "obs-out", tick: T - 10, intensity: 0 }] };
    const second = choose(withRoute(seenOne, ret));
    assert.ok(second.choice && isReturnRefresh(second.choice), second.choice?.id);
    assert.equal(horizontalDistance(second.choice.target!.focus!, door) < 0.05, !firstIsDoor, "the other place");
    // Both seen and the route supported: the homeward return.
    const fresh = { ...stale, openings: [...stale.openings, doorSeen(T - 10)], hazards: [flame, { ...flame, observationId: "obs-out", tick: T - 10, intensity: 0 }] };
    const home = choose(withRoute(fresh, { ...ret, status: "supported", assessedTick: T - 5 }));
    assert.ok(home.choice && isHomeward(home.choice), home.choice?.id);
    assert.ok(!home.set.candidates.some(isReturnRefresh));
  });

  test("a guide still running yields once the occupant is out, not while they are on the way", () => {
    // In the main run the planner chose the homeward return 13 s after arrival while the guide ran on to the recall.
    const out = plan(afterGuide({ ...lead, position: vec3(16.5, 12, 0.9), roomId: null }, DOOR_SIDE)).set;
    const walking = plan(afterGuide(lead, DOOR_SIDE)).set;
    assert.ok(guideYields(out));
    assert.ok(!guideYields(walking));
  });

  test("guidance has run once a guide began executing; a guide refused or awaiting execution does not count", () => {
    const record = (id: string, statuses: readonly string[]) => ({
      proposal: { id, action: { kind: "guide", trackId: lead.id, routeId: "route-evacuation", templateIds: ["follow-light"], maxDurationTicks: 100 } },
      status: statuses[statuses.length - 1],
      history: statuses.map((status, i) => ({ status, tick: 100 + i * 10, reason: null })),
    });
    const records = [record("p1", ["submitted", "rejected"]), record("p2", ["submitted", "approved"]), record("p3", ["submitted", "approved", "executing", "completed"])];
    assert.deepEqual(guidedTracks(records as unknown as Parameters<typeof guidedTracks>[0]), [{ trackId: lead.id, routeId: "route-evacuation", sinceTick: 120 }]);
  });
});
