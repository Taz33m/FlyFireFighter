import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SensorSpec } from "../../contracts/aircraft.ts";
import { SCOUT_S1, TENDER_T1 } from "../../contracts/aircraft.ts";
import { TICK_S } from "../../contracts/clock.ts";
import type { BeliefSnapshot, FloorPlanPrior, HazardEvidence, OccupantTrack } from "../../contracts/evidence.ts";
import { distance, vec3 } from "../../contracts/frames.ts";
import { distanceToRegion, pointInPolygon, sphere } from "../../contracts/geometry.ts";
import { parseProposalInput } from "../../contracts/schema.ts";
import { affectedRegion } from "../../harness/effects.ts";
import { DEFAULT_POLICY, riskClassOf } from "../../harness/policy.ts";
import type { CandidateFactoryInput } from "./candidates.ts";
import { breachAccessScore, unconfirmedAccessScore } from "./access-score.ts";
import { breachAccessOf, buildCandidateSet, isWindowLook, nextSweepStep } from "./candidates.ts";
import {
  afterSuppressionBelief,
  closedWindowBelief,
  coverageWith,
  ENVELOPE,
  FIRE,
  HOUSE,
  insideBelief,
  observation,
  openingSeen,
  outsideBelief,
  REPORT,
  RETURN_ROUTE,
  T_OUTSIDE,
  TRACK,
} from "./test-fixtures.ts";
import type { BreachAccess, CandidateSet, MissionTool, ProposalCandidate } from "./types.ts";
import { CANDIDATE_ID_PATTERN, MAX_CANDIDATE_ID_LENGTH, MAX_DESCRIPTION_LENGTH } from "./types.ts";

function build(belief: BeliefSnapshot, extra: Partial<CandidateFactoryInput> = {}): CandidateSet {
  return buildCandidateSet({ belief, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY, ...extra });
}

function proposals(set: CandidateSet, tool?: MissionTool): ProposalCandidate[] {
  return set.candidates.filter((c): c is ProposalCandidate => c.proposal !== null && (tool === undefined || c.tool === tool));
}

const SCENARIOS: readonly [string, () => CandidateSet][] = [
  ["outside at the start", () => build(outsideBelief())],
  ["outside with the window observed closed", () => build(closedWindowBelief())],
  ["inside with a lead and a fire", () => build(insideBelief())],
  ["inside after suppression and reassessment", () => build(afterSuppressionBelief(), { lastInterventionTick: 2100 })],
];

describe("candidate factory: every candidate is a complete, current proposal", () => {
  for (const [name, make] of SCENARIOS) {
    test(name, () => {
      const set = make();
      assert.ok(proposals(set).length > 0, "scenario produces proposals");
      for (const candidate of proposals(set)) {
        const parsed = parseProposalInput(candidate.proposal);
        assert.ok(parsed.ok, `${candidate.id}: ${parsed.ok ? "" : parsed.errors.join("; ")}`);
        assert.deepEqual(candidate.proposal.basis, set.basis, candidate.id);
        assert.equal(candidate.proposal.createdTick, set.tick);
        assert.ok(candidate.proposal.expiresTick > set.tick && candidate.proposal.expiresTick - set.tick <= DEFAULT_POLICY.maxProposalLifetimeTicks);
        assert.equal(candidate.proposal.aircraftId, TENDER_T1.id);
        if (riskClassOf(candidate.proposal.action.kind) === "consequential") assert.ok(candidate.proposal.citedEvidence.length > 0, `${candidate.id} cites evidence`);
        assert.ok(CANDIDATE_ID_PATTERN.test(candidate.id) && candidate.id.length <= MAX_CANDIDATE_ID_LENGTH, candidate.id);
        assert.ok(candidate.description.length > 0 && candidate.description.length <= MAX_DESCRIPTION_LENGTH, candidate.id);
      }
      const ids = set.candidates.map(c => c.id);
      assert.equal(new Set(ids).size, ids.length, "ids are unique");
      assert.deepEqual(ids.slice(-2), ["defer", "request_human_review"]);
    });
  }

  test("basis carries the current evidence, map, profile, envelope and policy revisions", () => {
    const belief = closedWindowBelief({ evidenceRevision: 31, mapRevision: 2 });
    const set = buildCandidateSet({ belief, profile: { ...TENDER_T1, revision: 4 }, envelope: { ...ENVELOPE, revision: 3 }, policy: { ...DEFAULT_POLICY, revision: 9 } });
    for (const candidate of proposals(set)) {
      assert.deepEqual(candidate.proposal.basis, { evidenceRevision: 31, mapRevision: 2, profileRevision: 4, envelopeRevision: 3, policyRevision: 9 });
    }
  });

  test("cited evidence is always present, unsuperseded and recent in the snapshot", () => {
    const set = build(insideBelief());
    const ids = new Set(insideBelief().observations.map(o => o.id));
    for (const candidate of proposals(set)) for (const id of candidate.proposal.citedEvidence) assert.ok(ids.has(id), `${candidate.id} cites ${id}`);
  });

  test("candidate ids are stable across evidence revisions and input order", () => {
    const a = build(closedWindowBelief());
    const b = build(closedWindowBelief({ evidenceRevision: 13, coverage: closedWindowBelief().coverage.slice().reverse() }));
    assert.deepEqual(b.candidates.map(c => c.id), a.candidates.map(c => c.id));
    assert.notDeepEqual(proposals(b)[0].proposal.basis, proposals(a)[0].proposal.basis);
  });

  test("building does not modify the frozen belief and the result is frozen", () => {
    const belief = insideBelief();
    const set = build(belief);
    assert.ok(Object.isFrozen(set) && Object.isFrozen(set.candidates[0]));
    assert.deepEqual(belief, insideBelief());
  });
});

describe("inspect_room", () => {
  test("a room 'observed' through a corner glimpse is still offered: the fraction decides, not the sticky state", () => {
    const glimpsed = { roomId: "bedroom-rear", state: "observed" as const, fractionAdequate: 0.003, fractionAny: 0.003, lastObservedTick: 1990, bestModality: "thermal" as const };
    for (const entry of [{ ...glimpsed, fractionSearched: 0.003, searchedSince: [{ sinceTick: 1990, fraction: 0.003 }] }, glimpsed]) {
      const set = build(insideBelief({ coverage: coverageWith([entry]) }));
      const rear = proposals(set, "inspect_room").find(c => c.target.roomId === "bedroom-rear");
      assert.ok(rear, `offered for ${JSON.stringify(entry)}`);
      assert.match(rear.description, /\(observed, 0% person-searched\)/);
    }
    // Adequately seen by lidar but never person-searched: still offered.
    const unsearched = { ...glimpsed, fractionAdequate: 0.97, fractionAny: 1, fractionSearched: 0, searchedSince: [] };
    assert.ok(proposals(build(insideBelief({ coverage: coverageWith([unsearched]) })), "inspect_room").some(c => c.target.roomId === "bedroom-rear"));
  });

  test("rooms on an unknown evacuation route without a fresh post-intervention search are offered", () => {
    const searchedBefore = { roomId: "bedroom-rear", state: "observed" as const, fractionAdequate: 0.97, fractionAny: 1, lastObservedTick: 1990, bestModality: "thermal" as const, fractionSearched: 0.97, searchedSince: [{ sinceTick: 1990, fraction: 0.97 }] };
    const searchedAfter = { ...searchedBefore, roomId: "hall-up", lastObservedTick: 2180, searchedSince: [{ sinceTick: 2180, fraction: 0.6 }, { sinceTick: 1990, fraction: 0.97 }] };
    const belief = afterSuppressionBelief({ status: "unknown", reason: "Not yet supported." }, { coverage: coverageWith([searchedBefore, searchedAfter]) });
    const inspected = (b: BeliefSnapshot, lastInterventionTick: number | null) => proposals(build(b, { lastInterventionTick }), "inspect_room");
    const rear = inspected(belief, 2100).find(c => c.target.roomId === "bedroom-rear");
    assert.ok(rear, "searched before the intervention only");
    assert.match(rear.description, /evacuation route through it needs a fresh search/);
    assert.ok(!inspected(belief, 2100).some(c => c.target.roomId === "hall-up"), "60% searched after the intervention is enough for the route");
    const supported = afterSuppressionBelief({}, { coverage: coverageWith([searchedBefore, searchedAfter]) });
    assert.ok(!inspected(supported, 2100).some(c => c.target.roomId === "bedroom-rear"), "a supported route asks for no inspection");
  });

  test("covers unobserved and degraded rooms, never observed ones, and only moves or scans", () => {
    const set = build(insideBelief());
    const rooms = proposals(set, "inspect_room").map(c => c.target.roomId);
    assert.ok(!rooms.includes("bedroom-rear"), "the observed bedroom is not re-inspected");
    assert.ok(rooms.includes("hall-up") && rooms.includes("bedroom-front"));
    for (const candidate of proposals(set, "inspect_room")) {
      assert.ok(["move", "scan"].includes(candidate.proposal.action.kind));
      assert.match(candidate.description, /does not mark the room empty/);
    }
  });

  test("from outside without an observed entry, it looks in from an exterior opening", () => {
    const set = build(outsideBelief());
    const rear = proposals(set, "inspect_room").find(c => c.target.roomId === "bedroom-rear");
    assert.ok(rear && rear.proposal.action.kind === "move");
    assert.deepEqual(rear.proposal.action.kind === "move" ? rear.proposal.action.goal : null, vec3(2.5, -2.05, 4.4), "2 m in front of the window");
    assert.ok(!proposals(set, "inspect_room").some(c => c.target.roomId === "hall-up"), "a room with no exterior opening cannot be seen from outside");
  });

  test("at the viewpoint it scans instead of moving", () => {
    const belief = outsideBelief({ pose: { ...outsideBelief().pose, position: vec3(2.5, -2.05, 4.4) } });
    const rear = proposals(build(belief), "inspect_room").find(c => c.target.roomId === "bedroom-rear");
    assert.equal(rear?.proposal.action.kind, "scan");
  });

  test("with an observed open entry, it goes inside", () => {
    const open = openingSeen("door-front", "open", T_OUTSIDE - 20);
    const set = build(outsideBelief({ observations: [open.observation], openings: [open.evidence] }));
    const rear = proposals(set, "inspect_room").find(c => c.target.roomId === "bedroom-rear");
    assert.ok(rear && rear.proposal.action.kind === "move");
    const goal = rear.proposal.action.kind === "move" ? rear.proposal.action.goal : vec3(0, 0, 0);
    assert.ok(pointInPolygon(goal.x, goal.y, HOUSE.rooms[2].polygon) && goal.z > 3, "goal is inside the rear bedroom");
    assert.match(rear.description, /door door-front \(observed open\)/);
  });
});

describe("request_breach", () => {
  const breach = (set: CandidateSet) => proposals(set, "request_breach");

  test("offers breaking a window last observed closed with fresh evidence, within reach", () => {
    const [candidate] = breach(build(closedWindowBelief()));
    assert.ok(candidate, "breach candidate exists");
    const action = candidate.proposal.action;
    assert.ok(action.kind === "breach_opening");
    assert.equal(action.openingId, "window-rear");
    assert.ok(distance(action.standoff, action.strikePoint) <= (TENDER_T1.modules.glassBreaker?.reachM ?? 0));
    assert.deepEqual(candidate.proposal.citedEvidence, ["obs-window-rear"]);
    assert.match(candidate.description, /commander approval/);
  });

  // Open and broken windows are observed entries; a blocked one would not create access when broken.
  for (const state of ["open", "broken", "blocked"] as const) {
    test(`no breach when the window's latest observed state is ${state}`, () => {
      const closed = openingSeen("window-rear", "closed", T_OUTSIDE - 50, "obs-closed");
      const later = openingSeen("window-rear", state, T_OUTSIDE - 10, "obs-later");
      const set = build(outsideBelief({ observations: [closed.observation, later.observation], openings: [closed.evidence, later.evidence] }));
      assert.deepEqual(breach(set), []);
    });
  }

  test("no breach on stale, missing or uncitable closed-window evidence", () => {
    const stale = openingSeen("window-rear", "closed", T_OUTSIDE - DEFAULT_POLICY.citedEvidenceMaxAgeTicks - 1, "obs-stale");
    assert.deepEqual(breach(build(outsideBelief({ observations: [stale.observation], openings: [stale.evidence] }))), []);
    assert.deepEqual(breach(build(outsideBelief())), [], "the prior's 'closed' is not an observation");
    const fresh = openingSeen("window-rear", "closed", T_OUTSIDE - 10, "obs-gone");
    assert.deepEqual(breach(build(outsideBelief({ observations: [], openings: [fresh.evidence] }))), [], "evidence outside the snapshot window cannot be cited");
  });

  test("prefers an observed opening: no breach into a room that already has an observed open entry", () => {
    const side = { ...HOUSE.openings[1], id: "window-rear-side", center: vec3(-0.05, 2, 4.4), outwardNormal: vec3(-1, 0, 0) };
    const prior = { ...HOUSE, openings: [...HOUSE.openings, side] };
    const closedRear = openingSeen("window-rear", "closed", T_OUTSIDE - 10, "obs-rear");
    const openSide = observation("obs-side", T_OUTSIDE - 10, { modality: "rgb", detections: [{ kind: "opening_state", openingId: side.id, state: "open" }] });
    const sideEvidence = { openingId: side.id, state: "open" as const, tick: T_OUTSIDE - 10, observationId: "obs-side" };
    const set = build(outsideBelief({ mapPrior: prior, observations: [closedRear.observation, openSide], openings: [closedRear.evidence, sideEvidence] }));
    assert.deepEqual(breach(set), []);
    const rear = proposals(set, "inspect_room").find(c => c.target.roomId === "bedroom-rear");
    assert.match(rear?.description ?? "", /window window-rear-side \(observed open\)/);
  });

  test("no breach without a glass breaker, from inside, or with a possible occupant in the debris region", () => {
    assert.deepEqual(breach(buildCandidateSet({ belief: closedWindowBelief(), profile: SCOUT_S1, envelope: ENVELOPE, policy: DEFAULT_POLICY })), []);
    const inside = closedWindowBelief({ pose: { ...closedWindowBelief().pose, position: vec3(2.5, 2, 4.3) } });
    assert.deepEqual(breach(build(inside)), []);
    const nearWindow = { ...TRACK, position: vec3(2.5, 0.8, 3.6), observationIds: [] };
    const set = build(closedWindowBelief({ tracks: [nearWindow] }));
    assert.deepEqual(breach(set), []);
    assert.ok(set.notes.some(note => /No breach of window window-rear .*track-1 \(±0\.4 m\).*inside its uncertainty plus the 1 m person margin/.test(note)), set.notes.join("\n"));
  });

  // The pre-check uses the harness's own debris region (inward cone, fall volume, exterior strip), not a sphere.
  const breachAction = (set: CandidateSet) => {
    const action = breach(set)[0]?.proposal.action;
    assert.ok(action?.kind === "breach_opening", "a breach is offered");
    return action;
  };

  test("a possible occupant on the ground under the window blocks the breach: glass falls on them", () => {
    const below: OccupantTrack = { ...TRACK, position: vec3(2.5, -0.5, 1), roomId: null, observationIds: [] };
    // Far from a 1.5 m debris sphere around the strike point, but inside the fall strip along the facade.
    assert.ok(distance(below.position, HOUSE.openings[1].center) - 1.5 > below.uncertaintyM + DEFAULT_POLICY.personMarginM);
    const set = build(closedWindowBelief({ tracks: [below] }));
    assert.deepEqual(breach(set), []);
    assert.ok(set.notes.some(note => /window-rear/.test(note) && /refuses glass into an occupied space/.test(note)));
  });

  test("a possible occupant beside the window, clear of the harness debris region, does not block it but marks the room occupied", () => {
    const beside: OccupantTrack = { ...TRACK, position: vec3(0.3, 0.5, 3.5), uncertaintyM: 0.1, observationIds: [] };
    const set = build(closedWindowBelief({ tracks: [beside] }));
    const action = breachAction(set);
    const region = affectedRegion(action, TENDER_T1, HOUSE);
    assert.ok(region && distanceToRegion(region, beside.position) > beside.uncertaintyM + DEFAULT_POLICY.personMarginM, "the harness would not block it either");
    assert.ok(distance(beside.position, action.strikePoint) - 1.5 < beside.uncertaintyM + DEFAULT_POLICY.personMarginM, "a debris sphere would have");
    assert.equal(access(breach(set)[0]).occupiedBy, "track-1");
    assert.match(breach(set)[0].description, /possible occupant track-1 inside/);
  });

  test("a rejected breach can be omitted so another option surfaces", () => {
    const full = build(closedWindowBelief());
    const id = breach(full)[0].id;
    const without = build(closedWindowBelief(), { omitCandidateIds: [id] });
    assert.ok(!without.candidates.some(c => c.id === id));
    assert.ok(proposals(without).length > 0, "other supported options remain");
  });
});

/* Breach access: where entering through a window leads, how it is approached and what can be seen. */

function access(candidate: ProposalCandidate | undefined): BreachAccess {
  const found = candidate === undefined ? null : breachAccessOf(candidate);
  assert.ok(found, `${candidate?.id ?? "missing candidate"} carries a breach access assessment`);
  return found;
}

function withOpening(prior: FloorPlanPrior, id: string, fields: Partial<FloorPlanPrior["openings"][number]>): FloorPlanPrior {
  return { ...prior, openings: prior.openings.map(o => (o.id === id ? { ...o, ...fields } : o)) };
}

/** Both upstairs bedroom windows observed closed, no report, aircraft north of the house near the front bedroom. */
function bothWindowsClosed(prior: FloorPlanPrior, extra: Partial<BeliefSnapshot> = {}): BeliefSnapshot {
  const rear = openingSeen("window-rear", "closed", T_OUTSIDE - 10, "obs-rear");
  const front = openingSeen("window-front", "closed", T_OUTSIDE - 10, "obs-front");
  return outsideBelief({
    mapPrior: prior,
    reports: [],
    pose: { ...outsideBelief().pose, position: vec3(2.5, 12, 4.4) },
    observations: [rear.observation, front.observation, ...(extra.observations ?? [])],
    openings: [rear.evidence, front.evidence, ...(extra.openings ?? [])],
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "observations" && key !== "openings")),
  });
}

describe("request_breach access", () => {
  const breach = (set: CandidateSet) => proposals(set, "request_breach");
  const byOpening =(set: CandidateSet, openingId: string) => proposals(set, "request_breach").find(c => c.target.openingId === openingId);
  const doorClosed = withOpening(HOUSE, "door-front-hall", { priorState: "closed" });

  test("a room whose only interior door the plan draws closed is closed in, and the set says the aircraft would be stranded", () => {
    const set = build(bothWindowsClosed(doorClosed));
    const front = access(byOpening(set, "window-front"));
    assert.equal(front.closedIn, true);
    assert.deepEqual(front.closedOpeningIds, ["door-front-hall"]);
    assert.equal(front.hopsToTarget, null);
    assert.match(byOpening(set, "window-front")?.description ?? "", /only closed doors lead on/);
    assert.ok(set.notes.some(note => /Window window-front .*ranks low: .*door-front-hall.*cannot open doors.*strand/.test(note)), set.notes.join("\n"));
    const rear = access(byOpening(set, "window-rear"));
    assert.equal(rear.closedIn, false);
    assert.equal(rear.hopsToTarget, 1, "with nothing reported, the rest of the house is one open door away");
    assert.deepEqual(rear.via, ["door-rear-hall"]);
  });

  test("observed door states override the plan's", () => {
    const seen = (state: "open" | "closed") => ({
      observations: [observation(`obs-door-${state}`, T_OUTSIDE - 5, { modality: "rgb", detections: [{ kind: "opening_state", openingId: "door-front-hall", state }] })],
      openings: [{ openingId: "door-front-hall", state, tick: T_OUTSIDE - 5, observationId: `obs-door-${state}` }],
    });
    assert.equal(access(byOpening(build(bothWindowsClosed(doorClosed, seen("open"))), "window-front")).closedIn, false, "drawn closed, observed open");
    assert.equal(access(byOpening(build(bothWindowsClosed(HOUSE, seen("closed"))), "window-front")).closedIn, true, "drawn open, observed closed");
  });

  test("the way toward the rescue leads to a reported room, the fire's room or a possible occupant's, cheapest first", () => {
    const reported = build(bothWindowsClosed(HOUSE, { reports: [REPORT] }));
    assert.deepEqual([access(byOpening(reported, "window-rear")).hopsToTarget, access(byOpening(reported, "window-front")).hopsToTarget], [0, 2]);
    assert.equal(access(byOpening(reported, "window-front")).targetRoomId, "bedroom-rear");
    assert.deepEqual(access(byOpening(reported, "window-front")).via, ["door-front-hall", "door-rear-hall"]);
    const fire = observation("obs-fire-out", T_OUTSIDE - 5, { detections: [{ kind: "hazard", hazard: "fire", region: FIRE.region, intensity: 0.8 }] });
    const burning = build(bothWindowsClosed(HOUSE, { reports: [REPORT], observations: [fire], hazards: [{ ...FIRE, observationId: fire.id, tick: T_OUTSIDE - 5 }] }));
    const front = access(byOpening(burning, "window-front"));
    assert.deepEqual([front.hopsToTarget, front.targetRoomId, front.targetReason], [1, "hall-up", "fire"]);
  });

  test("a window whose approach point lies inside another structure has no exterior approach and the set says so", () => {
    const shed = { id: "shed", name: "Shed", floor: 0, polygon: [[7, -1.6], [9, -1.6], [9, -0.7], [7, -0.7]] as [number, number][], zMin: 0, zMax: 2.4 };
    const east = { id: "window-kitchen-east", kind: "window" as const, rooms: ["kitchen", "exterior"] as [string, string], center: vec3(10, 4, 1.4), widthM: 1.2, heightM: 1.2, outwardNormal: vec3(1, 0, 0), priorState: "closed" as const };
    const prior: FloorPlanPrior = { ...HOUSE, rooms: [...HOUSE.rooms, shed], openings: [...HOUSE.openings, east] };
    const seen = (id: string) => ({ obs: observation(`obs-${id}`, T_OUTSIDE - 10, { modality: "rgb", detections: [{ kind: "opening_state", openingId: id, state: "closed" }] }), evidence: { openingId: id, state: "closed" as const, tick: T_OUTSIDE - 10, observationId: `obs-${id}` } });
    const south = seen("window-kitchen");
    const eastSeen = seen(east.id);
    const set = build(outsideBelief({ mapPrior: prior, observations: [south.obs, eastSeen.obs], openings: [south.evidence, eastSeen.evidence] }));
    assert.equal(access(byOpening(set, "window-kitchen")).approach, false);
    assert.equal(access(byOpening(set, east.id)).approach, true);
    assert.match(byOpening(set, "window-kitchen")?.description ?? "", /no exterior approach/);
    assert.ok(set.notes.some(note => /Window window-kitchen into Kitchen ranks low: no exterior approach/.test(note)));
  });

  test("docked at a pane inside the wall band, exterior approaches are still routed from just outside it", () => {
    const kitchen = openingSeen("window-kitchen", "closed", T_OUTSIDE - 10, "obs-kitchen");
    const rear = openingSeen("window-rear", "closed", T_OUTSIDE - 10, "obs-rear");
    const docked = outsideBelief({ pose: { ...outsideBelief().pose, position: vec3(2.5, -0.2, 4.4) }, observations: [kitchen.observation, rear.observation], openings: [kitchen.evidence, rear.evidence] });
    assert.equal(access(byOpening(build(docked), "window-kitchen")).approach, true);
  });

  test("from the standoff RGB sees the debris region through intact glass, thermal does not, and the downward camera adds the fall strip", () => {
    const rgbFront = TENDER_T1.sensors.find(s => s.id === "rgb-front") as SensorSpec;
    const rgbDown = TENDER_T1.sensors.find(s => s.id === "rgb-down") as SensorSpec;
    const seenWith = (sensors: readonly SensorSpec[]) => access(breach(build(closedWindowBelief(), { profile: { ...TENDER_T1, sensors } }))[0]).visibleFraction;
    const rgb = seenWith([rgbFront]);
    const thermal = seenWith([{ ...rgbFront, id: "thermal-wide", modality: "thermal" }]);
    assert.ok(rgb > 0.3 && thermal < rgb / 3, `rgb ${rgb}, thermal ${thermal}`);
    assert.ok(seenWith([rgbFront, rgbDown]) > rgb + 0.1, "the strip under an upper-floor window is below the forward camera's view");
    assert.equal(seenWith([]), 0, "no camera sees anything");
  });

  test("windows whose expected view falls short of the harness's breach coverage floor are named, and rank lower", () => {
    const view = access(breach(build(closedWindowBelief()))[0]).visibleFraction;
    assert.ok(view > 0.3 && view < 0.95, `view ${view}`);
    const strict = build(closedWindowBelief(), { policy: { ...DEFAULT_POLICY, breachMinCoverageFraction: 0.95 } });
    assert.equal(access(breach(strict)[0]).clearsCoverage, false);
    assert.ok(strict.notes.some(note => new RegExp(`No offered window is expected to show the 95% .*window-rear \\(about ${Math.round(view * 100)}%\\)`).test(note)), strict.notes.join("\n"));
    const lenient = build(closedWindowBelief(), { policy: { ...DEFAULT_POLICY, breachMinCoverageFraction: 0.3 } });
    assert.equal(access(breach(lenient)[0]).clearsCoverage, true);
    assert.ok(!lenient.notes.some(note => /expected to show/.test(note)), "no shortfall, no note");
    assert.ok(breachAccessScore(access(breach(strict)[0])) < breachAccessScore(access(breach(lenient)[0])));
  });
});

/*
 * The 360° size-up: with a breach on offer but a better-placed window not yet observed, look at that window
 * first. Fixture: the front bedroom's door is drawn closed (its window would strand the aircraft); the report
 * names the rear bedroom.
 */
describe("size-up looks at unobserved windows", () => {
  const doorClosed = withOpening(HOUSE, "door-front-hall", { priorState: "closed" });
  const looks = (set: CandidateSet) => proposals(set, "inspect_room").filter(isWindowLook);
  const seenClosed = (ids: readonly string[], prior: FloorPlanPrior = doorClosed, extra: Partial<BeliefSnapshot> = {}): BeliefSnapshot => {
    const seen = ids.map(id => openingSeen(id, "closed", T_OUTSIDE - 10, `obs-${id}`));
    return outsideBelief({ mapPrior: prior, observations: seen.map(s => s.observation), openings: seen.map(s => s.evidence), ...extra });
  };

  test("a breach of a poorly placed window yields to a look at the better window not yet observed", () => {
    const set = build(seenClosed(["window-front"]));
    assert.equal(proposals(set, "request_breach").length, 1, "the observed front window is still offered");
    const look = looks(set).find(c => c.target.openingId === "window-rear");
    assert.ok(look, looks(set).map(c => c.id).join(", "));
    assert.equal(look.id, "inspect_room:bedroom-rear:window-rear");
    const pane = HOUSE.openings[1].center;
    assert.deepEqual(look.target.focus, pane, "it faces the pane");
    assert.ok(Math.abs(distance(look.target.station ?? pane, pane) - 2) < 1e-6 && look.target.station?.z === pane.z, "2 m in front of it, at its height");
    assert.equal(look.proposal.action.kind, "move");
    assert.match(look.proposal.rationale, /^Look at window-rear before choosing where to break in: it opens into a room connected toward the target/);
    assert.match(look.description, /Observation only/);
    assert.ok(look.target.access && unconfirmedAccessScore(look.target.access) > breachAccessScore(access(proposals(set, "request_breach")[0])));
    assert.ok(set.notes.some(note => /^Size-up: look at window window-rear of Rear bedroom before choosing where to break in/.test(note)), set.notes.join("\n"));
    assert.ok(looks(set).length <= 2 && new Set(looks(set).map(c => c.target.roomId)).size === looks(set).length, "at most two looks, one per room");
  });

  test("once the window is observed closed its breach replaces the look", () => {
    const set = build(seenClosed(["window-front", "window-rear"]));
    assert.ok(!looks(set).some(c => c.target.openingId === "window-rear"));
    assert.ok(proposals(set, "request_breach").some(c => c.target.openingId === "window-rear"));
  });

  test("when no unobserved window beats the observed ones nothing changes", () => {
    const set = build(seenClosed(["window-rear"]));
    assert.deepEqual(looks(set), []);
    assert.ok(!set.notes.some(note => /Size-up/.test(note)));
    assert.deepEqual(looks(build(outsideBelief({ mapPrior: doorClosed }))), [], "without any breach on offer there is no size-up");
  });

  test("a cooled look is not offered, and a cooled breach is no reason to skip one", () => {
    const belief = seenClosed(["window-front"]);
    assert.deepEqual(looks(build(belief, { omitCandidateIds: ["inspect_room:bedroom-rear:window-rear"] })).filter(c => c.target.openingId === "window-rear"), []);
    // The only observed window cooling after a refusal: the size-up still looks for another way in, but only
    // at a window that promises access (the front bedroom with its door open, not the closed-in kitchen).
    const rearSeen = seenClosed(["window-rear"], HOUSE);
    assert.deepEqual(looks(build(rearSeen)), []);
    const cooled = build(rearSeen, { omitCandidateIds: ["request_breach:window-rear"] });
    assert.deepEqual(looks(cooled).map(c => c.id), ["inspect_room:bedroom-front:window-front"], cooled.notes.join("\n"));
    assert.ok(cooled.notes.some(note => /every observed window is cooling after a refusal/.test(note)));
  });
});

describe("stations the drone cannot reach yet, from outside", () => {
  const stationedInside = (set: CandidateSet) => proposals(set).filter(c => c.target.station !== null && pointInPolygon(c.target.station.x, c.target.station.y, HOUSE.rooms.find(r => r.id === c.target.roomId)?.polygon ?? []) && c.target.station.z > 0);
  const lead: OccupantTrack = { ...TRACK, observationIds: [] };

  test("with every entry closed, a second look at a lead inside is withheld and the set says why", () => {
    const set = build(closedWindowBelief({ tracks: [lead] }));
    assert.deepEqual(proposals(set, "investigate_signal"), []);
    assert.ok(set.notes.some(note => /Not offering a second look at possible-occupant track track-1 in Rear bedroom: .*no passable way in from outside yet \(impassable: .*window-rear closed/.test(note)), set.notes.join("\n"));
    assert.deepEqual(stationedInside(set).map(c => c.id), [], "nothing offered is stationed inside the house");
  });

  test("once the window is observed broken, the way in exists and the second look is offered", () => {
    const broken = openingSeen("window-rear", "broken", T_OUTSIDE - 5, "obs-broken");
    // Away from the window, so the way in keeps the person clearance.
    const belief = closedWindowBelief({ tracks: [{ ...lead, position: vec3(1, 3, 3.5) }] });
    const set = build({ ...belief, observations: [...belief.observations, broken.observation], openings: [...belief.openings, broken.evidence] });
    assert.equal(proposals(set, "investigate_signal").length, 1);
  });

  test("through an observed open door, rooms the drone can reach are inspected inside and the others from outside or not at all", () => {
    const open = openingSeen("door-front", "open", T_OUTSIDE - 20);
    const frontClosedIn = withOpening(HOUSE, "door-front-hall", { priorState: "closed" });
    const set = build(outsideBelief({ mapPrior: frontClosedIn, observations: [open.observation], openings: [open.evidence] }));
    const inspect = (roomId: string) => proposals(set, "inspect_room").find(c => c.target.roomId === roomId);
    // Door, living room, stair, upstairs hall, open bedroom door.
    assert.match(inspect("bedroom-rear")?.description ?? "", /by entering through door door-front/);
    assert.match(inspect("hall-up")?.description ?? "", /by entering through/);
    // The front bedroom's door is drawn closed: look in through its window instead.
    assert.match(inspect("bedroom-front")?.description ?? "", /from outside window window-front/);
    assert.ok(set.notes.some(note => /Inspecting Front bedroom from outside only: .*impassable: .*door-front-hall closed \(plan; not observed\)/.test(note)), set.notes.join("\n"));
    // The kitchen has no interior opening at all: also from outside.
    assert.match(inspect("kitchen")?.description ?? "", /from outside window window-kitchen/);
  });

  test("a room with no exterior opening that the drone cannot reach is not offered, and the set says so", () => {
    const open = openingSeen("door-front", "open", T_OUTSIDE - 20);
    const noStair: FloorPlanPrior = { ...HOUSE, stairs: [] };
    const set = build(outsideBelief({ mapPrior: noStair, observations: [open.observation], openings: [open.evidence] }));
    assert.ok(!proposals(set, "inspect_room").some(c => c.target.roomId === "hall-up"));
    assert.ok(set.notes.some(note => /Not offering to inspect Upstairs hall: the drone has no passable way into it from outside yet/.test(note)), set.notes.join("\n"));
    assert.match(proposals(set, "inspect_room").find(c => c.target.roomId === "living")?.description ?? "", /by entering through door door-front/, "the room behind the open door is still entered");
  });
});

describe("finishing the spray comes before a second look", () => {
  const sprayId = "request_suppression:hall-up";

  test("while the spray cools after a coverage refusal, no second look farther than 2 m from its standoff is offered, and none inside the occupant's room", () => {
    const spray = proposals(build(insideBelief()), "request_suppression")[0]?.target.station;
    assert.ok(spray);
    const set = build(insideBelief(), { omitCandidateIds: [sprayId], retrying: [sprayId] });
    for (const look of proposals(set, "investigate_signal")) {
      const station = look.target.station;
      assert.ok(station && distance(station, spray) <= 2 + 1e-9 && !pointInPolygon(station.x, station.y, HOUSE.rooms[2].polygon), JSON.stringify(station));
    }
    // From the far end of the hall the doorway views are all more than 2 m from the standoff: held back, and said so.
    const far = build(insideBelief({ pose: { ...insideBelief().pose, position: vec3(9.2, 7, 4.35) } }), { omitCandidateIds: [sprayId], retrying: [sprayId] });
    const farSpray = proposals(build(insideBelief({ pose: { ...insideBelief().pose, position: vec3(9.2, 7, 4.35) } })), "request_suppression")[0]?.target.station;
    assert.ok(farSpray);
    assert.ok(proposals(far, "investigate_signal").every(c => c.target.station !== null && distance(c.target.station, farSpray) <= 2 + 1e-9));
  });

  test("a spray left out for another reason (a commander's rejection) holds nothing back", () => {
    assert.equal(proposals(build(insideBelief(), { omitCandidateIds: [sprayId] }), "investigate_signal").length, 1);
    assert.equal(proposals(build(insideBelief()), "investigate_signal").length, 1, "with the spray on offer it simply outranks the second look");
  });

  test("an avoided spray standoff makes the factory choose another one instead of dropping the spray", () => {
    const first = proposals(build(insideBelief({ tracks: [] })), "request_suppression")[0]?.target.station;
    assert.ok(first);
    const other = proposals(build(insideBelief({ tracks: [] }), { avoid: [{ point: first, radiusM: 0.3 }] }), "request_suppression")[0]?.target.station;
    assert.ok(other && distance(other, first) > 0.3, JSON.stringify(other));
  });
});

describe("incumbent stations survive re-plans", () => {
  test("an exterior inspect viewpoint the aircraft is flying to is kept although another window is now nearer", () => {
    const side = { ...HOUSE.openings[1], id: "window-rear-side", center: vec3(-0.05, 2, 4.4), outwardNormal: vec3(-1, 0, 0) };
    const prior: FloorPlanPrior = { ...HOUSE, openings: [...HOUSE.openings, side] };
    const belief = outsideBelief({ mapPrior: prior, pose: { ...outsideBelief().pose, position: vec3(-1.6, 1.2, 4.4) } });
    const station = (set: CandidateSet) => proposals(set, "inspect_room").find(c => c.target.roomId === "bedroom-rear")?.target.station;
    assert.deepEqual(station(build(belief)), vec3(-2.05, 2, 4.4), "nearest window first");
    const kept = vec3(2.5, -2.05, 4.4);
    assert.deepEqual(station(build(belief, { incumbent: { candidateId: "inspect_room:bedroom-rear", station: kept } })), kept);
    assert.deepEqual(station(build(belief, { incumbent: { candidateId: "inspect_room:bedroom-front", station: kept } })), vec3(-2.05, 2, 4.4), "another candidate's incumbent changes nothing");
  });

  test("a second viewpoint the aircraft is flying to is kept until it arrives; there the look is taken in place", () => {
    const first = proposals(build(insideBelief()), "investigate_signal")[0]?.target.station;
    assert.ok(first);
    const incumbent = { candidateId: "investigate_signal:track-1", station: first };
    // Half-way there, from a pose that sees nothing through the door, the incumbent is kept.
    const halfway = insideBelief({ pose: { ...insideBelief().pose, position: vec3(first.x + 1.5, first.y + 2, first.z) } });
    assert.deepEqual(proposals(build(halfway, { incumbent }), "investigate_signal")[0]?.target.station, first);
    // At the viewpoint the second look is a scan in place, never a move to where the aircraft already is.
    const there = insideBelief({ pose: { ...insideBelief().pose, position: first } });
    const look = proposals(build(there, { incumbent }), "investigate_signal")[0];
    assert.ok(look);
    assert.equal(look.proposal.action.kind, "scan");
  });

  test("a spray standoff is kept while valid and nothing is materially better; replaced otherwise", () => {
    const id = "request_suppression:hall-up";
    const standoff = (incumbent: { x: number; y: number; z: number } | null, profile = TENDER_T1) => {
      const action = proposals(build(insideBelief({ tracks: [] }), { profile, incumbent: incumbent === null ? null : { candidateId: id, station: incumbent } }), "request_suppression")[0]?.proposal.action;
      assert.ok(action?.kind === "spray");
      return action.standoff;
    };
    const best = standoff(null);
    const valid = vec3(9.2, 3.5, best.z);
    // With the aircraft's cameras every standoff in the open hall shows nearly all of the jet's search region: kept.
    assert.deepEqual(standoff(valid), valid);
    // With a narrow camera the same (still valid) standoff shows clearly less than the best one: replaced.
    const front = TENDER_T1.sensors.find(s => s.id === "rgb-front") as SensorSpec;
    const narrow = { ...TENDER_T1, sensors: [{ ...front, horizontalFovDeg: 24, verticalFovDeg: 16 }] };
    assert.deepEqual(standoff(valid, narrow), standoff(null, narrow));
    // An incumbent inside the fire's clearance (1.3 m from the centre of a 0.5 m fire) is never kept.
    assert.deepEqual(standoff(vec3(7, 0.7, best.z)), best);
  });
});

describe("request_suppression", () => {
  const spray = (set: CandidateSet) => proposals(set, "request_suppression");

  test("sprays toward the observed fire from a standoff within range, flow, dose and room", () => {
    const [candidate] = spray(build(insideBelief()));
    assert.ok(candidate, "spray candidate exists");
    const action = candidate.proposal.action;
    assert.ok(action.kind === "spray");
    const water = TENDER_T1.modules.water;
    assert.ok(water);
    assert.ok(action.flowLps > 0 && action.flowLps <= water.maxFlowLps);
    assert.ok(distance(action.standoff, action.aimPoint) <= water.rangeM);
    assert.ok(action.flowLps * action.durationTicks * TICK_S <= 1);
    assert.ok(pointInPolygon(action.standoff.x, action.standoff.y, HOUSE.rooms[4].polygon), "standoff is in the fire's room");
    assert.deepEqual(candidate.proposal.citedEvidence, [FIRE.observationId]);
    assert.equal(candidate.target.roomId, "hall-up");
  });

  test("a fire sighted at its base, just below the floor plane, is still in its room and sprayed from inside it", () => {
    const floorZ = HOUSE.rooms[4].zMin;
    const atFloor: HazardEvidence = { ...FIRE, region: sphere(vec3(7, 2, floorZ - 0.002), 0.5) };
    const [candidate] = spray(build(insideBelief({ hazards: [atFloor] })));
    assert.ok(candidate, "spray candidate exists");
    assert.equal(candidate.id, "request_suppression:hall-up");
    assert.equal(candidate.target.roomId, "hall-up");
    const action = candidate.proposal.action;
    assert.ok(action.kind === "spray" && pointInPolygon(action.standoff.x, action.standoff.y, HOUSE.rooms[4].polygon), "standoff is in the fire's room");
  });

  test("no spray without fire evidence, with stale or extinguished fire evidence", () => {
    assert.deepEqual(spray(build(insideBelief({ hazards: [] }))), []);
    assert.deepEqual(spray(build(insideBelief({ hazards: [{ ...FIRE, tick: 2000 - DEFAULT_POLICY.citedEvidenceMaxAgeTicks - 1 }] }))), []);
    assert.deepEqual(spray(build(insideBelief({ hazards: [FIRE, { ...FIRE, tick: 1980, intensity: 0 }] }))), [], "the latest observation shows no fire");
    assert.deepEqual(spray(build(insideBelief({ hazards: [{ ...FIRE, hazard: "smoke" }] }))), []);
  });

  test("no spray beyond the aircraft's module limits", () => {
    assert.deepEqual(spray(buildCandidateSet({ belief: insideBelief(), profile: SCOUT_S1, envelope: ENVELOPE, policy: DEFAULT_POLICY })), [], "no water module");
    const aircraft = insideBelief().aircraft;
    assert.deepEqual(spray(build(insideBelief({ aircraft: { ...aircraft, waterRemainingL: 0.01 } }))), [], "tank nearly empty");
    assert.deepEqual(spray(build(insideBelief({ aircraft: { ...aircraft, waterRemainingL: null } }))), [], "remaining water unknown");
    assert.deepEqual(spray(build(insideBelief({ aircraft: { ...aircraft, thrustAvailableN: TENDER_T1.hardLimits.hoverThrustN } }))), [], "no thrust margin for the jet reaction");
    const shortRange = { ...TENDER_T1, modules: { ...TENDER_T1.modules, water: { tankL: 1, maxFlowLps: 0.05, nozzleDiameterMm: 4, coneHalfAngleDeg: 8, rangeM: 2 } } };
    for (const candidate of spray(buildCandidateSet({ belief: insideBelief(), profile: shortRange, envelope: ENVELOPE, policy: DEFAULT_POLICY }))) {
      const action = candidate.proposal.action;
      assert.ok(action.kind === "spray" && action.flowLps <= 0.05 && distance(action.standoff, action.aimPoint) <= 2);
    }
  });

  test("the planned dose never exceeds the water remaining", () => {
    const aircraft = { ...insideBelief().aircraft, waterRemainingL: 0.3 };
    const [candidate] = spray(build(insideBelief({ aircraft })));
    const action = candidate.proposal.action;
    assert.ok(action.kind === "spray" && action.flowLps * action.durationTicks * TICK_S <= 0.3);
  });

  test("no spray toward a possible occupant at the fire", () => {
    const atFire = { ...TRACK, id: "track-2", position: vec3(7.2, 2, 3.4), roomId: "hall-up", observationIds: [] };
    assert.deepEqual(spray(build(insideBelief({ tracks: [TRACK, atFire] }))), []);
  });
});

/*
 * Spray standoff constraints: in the fire's room, at least wallClearanceM + span/2 from every wall (holding it
 * needs no range assistance), the jet line clear of walls and corners by the cone's radius plus 0.2 m, and
 * 1 m beyond the fire region. Fixture: the upstairs hall reshaped per test; the aircraft in the rear bedroom.
 */
describe("request_suppression standoff", () => {
  const wallClearance = DEFAULT_POLICY.wallClearanceM + TENDER_T1.spanM / 2;
  const tanHalf = Math.tan(((TENDER_T1.modules.water?.coneHalfAngleDeg ?? 0) * Math.PI) / 180);
  const withHall = (polygon: [number, number][]): FloorPlanPrior => ({ ...HOUSE, rooms: HOUSE.rooms.map(r => (r.id === "hall-up" ? { ...r, polygon } : r)) });
  const fireAt = (prior: FloorPlanPrior, center: { x: number; y: number; z: number }, radiusM: number, pose = insideBelief().pose.position): BeliefSnapshot =>
    insideBelief({ mapPrior: prior, hazards: [{ ...FIRE, region: sphere(center, radiusM) }], pose: { ...insideBelief().pose, position: pose }, tracks: [] });
  const sprayAction = (set: CandidateSet) => {
    const action = proposals(set, "request_suppression")[0]?.proposal.action;
    assert.ok(action?.kind === "spray", set.notes.join("\n"));
    return action;
  };
  const edgeDistance = (p: { x: number; y: number }, polygon: readonly (readonly [number, number])[]): number => {
    let best = Infinity;
    polygon.forEach(([ax, ay], i) => {
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / lengthSq));
      best = Math.min(best, Math.hypot(p.x - (ax + t * (bx - ax)), p.y - (ay + t * (by - ay))));
    });
    return best;
  };
  const assertConstraints = (action: { standoff: { x: number; y: number; z: number }; aimPoint: { x: number; y: number; z: number } }, polygon: readonly (readonly [number, number])[], fire: { center: { x: number; y: number; z: number }; radiusM: number }) => {
    const { standoff, aimPoint } = action;
    assert.ok(pointInPolygon(standoff.x, standoff.y, polygon), "in the fire's room");
    assert.ok(edgeDistance(standoff, polygon) >= wallClearance - 1e-9, `${edgeDistance(standoff, polygon)} m from a wall`);
    assert.ok(distance(standoff, fire.center) - fire.radiusM >= 1 - 1e-9, "1 m beyond the fire region");
    const lengthM = Math.hypot(aimPoint.x - standoff.x, aimPoint.y - standoff.y);
    for (let sM = 0; sM <= lengthM - 0.5; sM += 0.05) {
      const p = { x: standoff.x + ((aimPoint.x - standoff.x) * sM) / lengthM, y: standoff.y + ((aimPoint.y - standoff.y) * sM) / lengthM };
      assert.ok(edgeDistance(p, polygon) >= sM * tanHalf + 0.2 - 1e-6, `the jet grazes a wall ${sM.toFixed(2)} m out`);
    }
  };

  test("in the plain hall the standoff meets every constraint", () => {
    const hall = HOUSE.rooms.find(r => r.id === "hall-up")?.polygon ?? [];
    assertConstraints(sprayAction(build(insideBelief({ tracks: [] }))), hall, { center: vec3(7, 2, 3.3), radiusM: 0.5 });
  });

  test("in an L-shaped hall the jet never grazes the inner corner", () => {
    const polygon: [number, number][] = [[5, 0], [10, 0], [10, 3], [7, 3], [7, 8], [5, 8]];
    for (const pose of [vec3(6, 6, 4), vec3(9.5, 1.5, 4), vec3(2.5, 2.5, 4.3)]) {
      const action = sprayAction(build(fireAt(withHall(polygon), vec3(8.6, 1.5, 3.3), 0.3, pose)));
      assertConstraints(action, polygon, { center: vec3(8.6, 1.5, 3.3), radiusM: 0.3 });
    }
  });

  test("in a corridor too narrow to hold clear of both walls no spray is offered, and the set says why", () => {
    const set = build(fireAt(withHall([[5, 0], [10, 0], [10, 1.2], [5, 1.2]]), vec3(7.5, 0.6, 3.3), 0.3));
    assert.deepEqual(proposals(set, "request_suppression"), []);
    assert.ok(set.notes.some(note => /^No spray standoff for the fire in Upstairs hall: no point 2.4, 2.2, 2, 1.8, 1.6, 1.4, 1.2 m from it in its room keeps the aircraft 0.68 m from every wall/.test(note)), set.notes.join("\n"));
  });

  test("among standoffs with near-equal expected views the shortest reach wins, then the one nearest the aircraft", () => {
    // Every wall-clear standoff in the open hall shows nearly all of the jet region; the fire is 0.5 m in radius.
    const chosen = (pose: { x: number; y: number; z: number }) => sprayAction(build(insideBelief({ tracks: [], pose: { ...insideBelief().pose, position: pose } }))).standoff;
    const reach = (p: { x: number; y: number }) => Math.hypot(p.x - 7, p.y - 2);
    const east = chosen(vec3(9.5, 1.5, 4));
    const northWest = chosen(vec3(5.6, 6, 4));
    assert.ok(Math.abs(reach(east) - reach(northWest)) < 0.01, "the same, shortest feasible reach from either side");
    assert.ok(reach(east) - 0.5 >= 1.1 - 1e-6 && reach(east) <= 1.8 + 0.01, `reach ${reach(east)}`);
    assert.ok(Math.hypot(east.x - 9.5, east.y - 1.5) < Math.hypot(northWest.x - 9.5, northWest.y - 1.5), "east of the fire for the aircraft to the east");
    assert.ok(Math.hypot(northWest.x - 5.6, northWest.y - 6) < Math.hypot(east.x - 5.6, east.y - 6), "north-west of the fire for the aircraft to the north-west");
  });
});

describe("guide_to_exit and return_to_base", () => {
  const guide = (set: CandidateSet) => proposals(set, "guide_to_exit");

  test("guides only along a fresh, supported evacuation route assessed after the intervention", () => {
    const [candidate] = guide(build(afterSuppressionBelief(), { lastInterventionTick: 2100 }));
    assert.ok(candidate && candidate.proposal.action.kind === "guide");
    assert.equal(candidate.proposal.action.routeId, "route-evac");
    assert.equal(candidate.proposal.action.trackId, TRACK.id);
    assert.deepEqual(candidate.proposal.action.templateIds, ["follow-light", "stay-low"]);
  });

  test("no guidance on an unsupported, unknown, stale or pre-intervention route", () => {
    assert.deepEqual(guide(build(insideBelief())), [], "blocked route");
    assert.deepEqual(guide(build(afterSuppressionBelief({ status: "unknown" }), { lastInterventionTick: 2100 })), []);
    assert.deepEqual(guide(build(afterSuppressionBelief({ assessedTick: 2200 - DEFAULT_POLICY.routeFreshTicks - 1 }))), [], "stale assessment");
    assert.deepEqual(guide(build(afterSuppressionBelief({ assessedTick: 2050 }), { lastInterventionTick: 2100 })), [], "assessed before the suppression");
    assert.deepEqual(guide(build(afterSuppressionBelief({}, { tracks: [] }), { lastInterventionTick: 2100 })), [], "no one to guide");
  });

  test("returns only along a currently supported return route", () => {
    const [candidate] = proposals(build(insideBelief()), "return_to_base");
    assert.ok(candidate && candidate.proposal.action.kind === "return" && candidate.proposal.action.routeId === RETURN_ROUTE.id);
    assert.deepEqual(proposals(build(insideBelief({ routes: [{ ...RETURN_ROUTE, status: "unsupported" }] })), "return_to_base"), []);
    const stale = { ...RETURN_ROUTE, assessedTick: 2000 - DEFAULT_POLICY.returnRouteFreshTicks - 1 };
    assert.deepEqual(proposals(build(insideBelief({ routes: [stale] })), "return_to_base"), []);
  });
});

describe("investigate_signal", () => {
  // Bedroom-rear is x 0–5, y 0–4; the lead is at (1, 1) ±0.4 m.
  const viewpoint = (set: CandidateSet) => proposals(set, "investigate_signal")[0]?.target.station ?? null;
  const rearWalls = HOUSE.rooms.find(r => r.id === "bedroom-rear")?.polygon ?? [];
  const wallGap = (p: { x: number; y: number }) => Math.min(p.x - 0, 5 - p.x, p.y - 0, 4 - p.y);

  test("prefers a second look from the hall through the lead's doorway", () => {
    const [candidate] = proposals(build(insideBelief()), "investigate_signal");
    assert.ok(candidate && candidate.proposal.action.kind === "move");
    const goal = candidate.proposal.action.goal;
    assert.ok(pointInPolygon(goal.x, goal.y, HOUSE.rooms[4].polygon), `in the upstairs hall: ${JSON.stringify(goal)}`);
    // The sight line to the lead passes door-rear-hall (x = 5, y 1.55-2.45).
    const t = (goal.x - 5) / (goal.x - TRACK.position.x);
    const yAtDoor = goal.y + (TRACK.position.y - goal.y) * t;
    assert.ok(yAtDoor > 1.55 && yAtDoor < 2.45, `crosses the wall at y ${yAtDoor}`);
    assert.ok(distance(goal, insideBelief().pose.position) >= 1, "a new viewpoint, not the current one");
    assert.match(candidate.proposal.rationale, /looking in from beyond the doorway/);
  });

  test("an occupant by the only door: the second look stays in the hall, never past them into the room", () => {
    const closedDoor = withOpening(HOUSE, "door-rear-hall", { priorState: "closed" });
    // The lead stands 0.6 m inside door-rear-hall; any way into the bedroom passes within their clearance.
    const byDoor = { ...TRACK, position: vec3(4.4, 2.6, 3.5), uncertaintyM: 0.2 };
    const goal = viewpoint(build(insideBelief({ tracks: [byDoor], pose: { ...insideBelief().pose, position: vec3(8, 5, 4.35) } })));
    assert.ok(goal, "a doorway view exists");
    assert.ok(pointInPolygon(goal.x, goal.y, HOUSE.rooms[4].polygon), JSON.stringify(goal));
    assert.ok(Math.hypot(goal.x - 4.4, goal.y - 2.6) >= 1.0 + TENDER_T1.spanM / 2 + 0.2 + 0.2 - 1e-6);
    // With the door closed there is neither a doorway view nor clearance-keeping access to one inside.
    const shut = build(insideBelief({ mapPrior: closedDoor, tracks: [byDoor], pose: { ...insideBelief().pose, position: vec3(8, 5, 4.35) } }));
    assert.deepEqual(proposals(shut, "investigate_signal").filter(c => c.target.station !== null && pointInPolygon(c.target.station.x, c.target.station.y, HOUSE.rooms[2].polygon)), []);
  });

  // With the hall door shut the only views are inside the bedroom; the lead at (1, 3) leaves the broken window's way out clear.
  const closedDoor = withOpening(HOUSE, "door-rear-hall", { priorState: "closed" });
  const inRoom = (extra: Partial<BeliefSnapshot> = {}) => insideBelief({ mapPrior: closedDoor, tracks: [{ ...TRACK, position: vec3(1, 3, 3.5) }], pose: { ...insideBelief().pose, position: vec3(3.5, 1, 4.3) }, ...extra });

  test("a fresh detection apart from the fused track is kept clear too", () => {
    const first = viewpoint(build(inRoom()));
    assert.ok(first);
    // The newest person-search frame puts the person 0.3 m from the track, toward that viewpoint.
    const d = Math.hypot(first.x - 1, first.y - 3);
    const at = vec3(1 + (0.3 * (first.x - 1)) / d, 3 + (0.3 * (first.y - 3)) / d, 3.5);
    const frame = observation("obs-person-now", insideBelief().tick - 2, { position: vec3(3.5, 1, 4.3), detections: [{ kind: "possible_person", position: at, uncertaintyM: 0.4, confidence: 0.6, method: "oracle_fixture" }] });
    const base = inRoom();
    const moved = viewpoint(build({ ...base, observations: [...base.observations, frame] }));
    assert.ok(Math.hypot(first.x - at.x, first.y - at.y) < 1.0 + TENDER_T1.spanM / 2 + 0.4 + 0.2, "the first viewpoint is inside the detection's clearance");
    assert.ok(moved && Math.hypot(moved.x - at.x, moved.y - at.y) >= 1.0 + TENDER_T1.spanM / 2 + 0.4 + 0.2 - 1e-6, JSON.stringify(moved));
  });

  test("with the lead beside the only way out, no in-room viewpoint is offered: the aircraft could not leave", () => {
    // The lead at (1, 1) is 1.57 m from the broken window's inside approach: no clearance-keeping way back out.
    const set = build(insideBelief({ mapPrior: closedDoor }));
    assert.deepEqual(proposals(set, "investigate_signal"), []);
    assert.ok(set.notes.some(note => /with clearance-keeping access in and back out to the room's exit/.test(note)), set.notes.join("\n"));
  });

  test("an in-room second viewpoint keeps the person clearance from the lead and the wall clearance from the room's walls", () => {
    const set = build(inRoom());
    const goal = viewpoint(set);
    assert.ok(goal, set.notes.join("\n"));
    assert.ok(pointInPolygon(goal.x, goal.y, rearWalls));
    const required = 1.0 + TENDER_T1.spanM / 2 + TRACK.uncertaintyM;
    assert.ok(Math.hypot(goal.x - 1, goal.y - 3) >= required + 0.2 - 1e-6, `${JSON.stringify(goal)} is ${Math.hypot(goal.x - 1, goal.y - 3)} m from the lead`);
    assert.ok(wallGap(goal) >= DEFAULT_POLICY.wallClearanceM + TENDER_T1.spanM / 2 - 1e-6, `${wallGap(goal)} m from a wall`);
    assert.match(proposals(set, "investigate_signal")[0].proposal.rationale, /at least 1.8[78] m\) and 0.68 m from the walls, with clearance-keeping access to it and back out/);
  });

  test("a larger person clearance in the harness policy is honoured once the policy carries it", () => {
    const policy = { ...DEFAULT_POLICY, personClearanceM: 1.5 } as typeof DEFAULT_POLICY;
    const goal = viewpoint(build(insideBelief(), { policy }));
    assert.ok(goal && Math.hypot(goal.x - 1, goal.y - 1) >= 1.5 + TENDER_T1.spanM / 2 + TRACK.uncertaintyM + 0.2 - 1e-6, JSON.stringify(goal));
  });

  test("when no viewpoint from the doorway or in the room can keep both clearances, no second look is offered and the set says why", () => {
    const vague = { ...TRACK, uncertaintyM: 8 };
    const set = build(insideBelief({ tracks: [vague] }));
    assert.deepEqual(proposals(set, "investigate_signal"), []);
    assert.ok(set.notes.some(note => /^Not offering a second look at possible-occupant track track-1 in Rear bedroom: no viewpoint from the doorway or in the room keeps 9.48 m from the lead/.test(note)), set.notes.join("\n"));
  });

  test("a viewpoint inside an avoided point's radius is not chosen", () => {
    const first = viewpoint(build(insideBelief()));
    assert.ok(first);
    const other = viewpoint(build(insideBelief(), { avoid: [{ point: first, radiusM: 0.3 }] }));
    assert.ok(other && distance(other, first) > 0.3);
  });

  test("retracted or merged tracks are not investigated", () => {
    const set = build(insideBelief({ tracks: [{ ...TRACK, status: "retracted" }] }));
    assert.deepEqual(proposals(set, "investigate_signal"), []);
  });
});

describe("global gates", () => {
  test("unsupported localization, a closed time box or excessive heat leave only defer and review", () => {
    const pose = { ...insideBelief().pose, supported: false };
    const cases: [BeliefSnapshot, RegExp][] = [
      [insideBelief({ pose }), /localization/],
      [insideBelief({ tick: ENVELOPE.endTick + 1 }), /time box/],
      [insideBelief({ aircraft: { ...insideBelief().aircraft, ambientC: 95 } }), /ambient/],
      [insideBelief({ aircraft: { ...insideBelief().aircraft, ambientC: null } }), /ambient temperature is unknown/],
    ];
    for (const [belief, reason] of cases) {
      const set = build(belief);
      assert.deepEqual(set.candidates.map(c => c.id), ["defer", "request_human_review"]);
      assert.match(set.gateReason ?? "", reason);
      assert.match(set.candidates[0].description, reason);
    }
  });
});

/*
 * The post-suppression route sweep keeps going forward: steps are given by when their evidence was last complete
 * (null: never), the evidence age limit by `since`, and the intervention by the last argument.
 */
describe("route sweep order", () => {
  const since = 6100;
  test("starts at the first step", () => {
    assert.equal(nextSweepStep([null, null, null], since, 50), 0);
    assert.equal(nextSweepStep([100, null, null], since, 150), 0, "evidence from before the intervention is not this sweep's");
  });
  test("once the first step is done, an aged first step does not send it back before the remaining steps", () => {
    assert.equal(nextSweepStep([200, null, null], since, 150), 1);
    assert.equal(nextSweepStep([200, 300, null], since, 150), 2);
  });
  test("a step completed out of order counts while it is fresh, and is swept again in turn once it is not", () => {
    assert.equal(nextSweepStep([7000, 6500, null], since, 150), 2, "step 2 was seen before step 1 but is still fresh");
    assert.equal(nextSweepStep([7000, 300, null], since, 150), 1);
  });
  test("aged steps are swept again only after the last step, from the start", () => {
    assert.equal(nextSweepStep([200, 300, 6200], since, 150), 0);
    assert.equal(nextSweepStep([6300, 300, 6200], since, 150), 1, "after the first step again, the pass goes on to the next aged one");
    assert.equal(nextSweepStep([6300, 6400, 6500], since, 150), -1, "every step fresh");
  });
});
