/**
 * Person clearance: H18 (submit, approve and execute) and the motion guard's per-tick clearance step.
 *
 * Scope: rule cases run validateProposal or the ActionHarness against the fictional two-level house in
 * test-fixtures.ts (aircraft at the hallway standoff (5, 1, 4.2), Tender T1 with a 0.45 m span, default
 * policy: person clearance 1.0 m, guidance clearance 1.2 m). Guard cases run guardMotion against the open
 * envelope in motion-fixtures.ts (aircraft at (10, 5, 3) facing +x, 0.5 s lookahead). Every track and detection
 * is authored fixture evidence; nothing here is simulator truth or detector accuracy.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionProposal, ActionSpec, Finding, GuardedMotion, MotionRequest, ProposalInput } from "../contracts/actions.ts";
import { digestOf } from "../contracts/canonical.ts";
import type { Tick } from "../contracts/clock.ts";
import { TICK_S } from "../contracts/clock.ts";
import { EventLog } from "../contracts/events.ts";
import type { OccupantTrack } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { add, distance, dot, rotateBodyToWorld, scale, sub, vec3 } from "../contracts/frames.ts";
import { box } from "../contracts/geometry.ts";
import type { Detection, Observation } from "../contracts/observation.ts";
import { initialCursor } from "./execution.ts";
import { ActionHarness } from "./harness.ts";
import * as M from "./motion-fixtures.ts";
import type { MotionGuardState } from "./motion-guard.ts";
import { guardMotion, PERSON_CLEARANCE_LIMIT } from "./motion-guard.ts";
import type { HarnessContext } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import type { ValidationPhase } from "./rules.ts";
import { validateProposal } from "./rules.ts";
import * as H from "./test-fixtures.ts";

const HALF_SPAN = H.makeContext(H.makeBelief(H.T0)).profile.spanM / 2;
/** Centre distance a move keeps from an occupant with uncertainty u. */
const moveKeeps = (u: number) => HALF_SPAN + DEFAULT_POLICY.personClearanceM + u;
/** Centre distance a guide keeps. */
const guideKeeps = (u: number) => HALF_SPAN + DEFAULT_POLICY.guidanceClearanceM + u;

function asProposal(input: ProposalInput): ActionProposal {
  return { ...input, id: `${input.runId}/p1`, digest: digestOf(input) };
}

function check(phase: ValidationPhase, input: ProposalInput, ctx: HarnessContext): Finding[] {
  return validateProposal({ phase, proposal: asProposal(input), ctx, state: { runId: H.RUN_ID, missionAborted: false, lastInterventionTick: null, sprays: [] }, status: "proposed", approval: null });
}

function h18(findings: readonly Finding[]): Finding[] {
  return findings.filter(f => f.ruleId === "H18");
}

/** A hallway occupant 3 m east of the aircraft at the standoff. */
const HALL_OCCUPANT = vec3(8, 1, 4.2);

function hallTrack(overrides: Partial<OccupantTrack> = {}): OccupantTrack {
  return H.occupantTrack(H.T0 - 3, { position: HALL_OCCUPANT, roomId: "hallway", ...overrides });
}

describe("H18: goals and waypoints keep the person clearance (submit, approve, execute)", () => {
  test("a move goal 0.5 m from a possible track is refused at submit, naming the track and the distance", () => {
    const harness = new ActionHarness(H.RUN_ID, new EventLog(H.RUN_ID));
    const result = harness.submit(H.moveInput(vec3(7.5, 1, 4.2)), H.makeContext(H.makeBelief(H.T0, { tracks: [hallTrack()] })));
    assert.equal(result.status, "rejected");
    const findings = h18(result.findings);
    assert.equal(findings.length, 1, JSON.stringify(result.findings));
    assert.match(findings[0].reason, /^Goal \(7\.5, 1, 4\.2\) is 0\.5 m from possible-occupant track track-1 \(confidence 0\.7, ±0\.5 m\), which is 3 m from the aircraft now/);
    assert.deepEqual(findings[0].evidenceIds, ["obs-occupant-1"]);
  });

  test("a move goal 2 m from the same track passes every submission rule", () => {
    assert.ok(2 > moveKeeps(0.5));
    assert.deepEqual(check("submit", H.moveInput(vec3(6, 1, 4.2)), H.makeContext(H.makeBelief(H.T0, { tracks: [hallTrack()] }))), []);
  });

  test("approve and execute re-check current evidence: a person detected beside a validated goal invalidates the move", () => {
    const harness = new ActionHarness(H.RUN_ID, new EventLog(H.RUN_ID));
    const goal = vec3(8, 1, 4.2);
    const submitted = harness.submit(H.moveInput(goal), H.makeContext(H.makeBelief(H.T0)));
    assert.equal(submitted.status, "validated");
    const seen = H.observation("obs-person-new", H.T0, H.HALLWAY_VIEW, { modality: "thermal", detections: [H.personDetection(vec3(8.6, 1, 4.2), 0.6, 0.3)] });
    const execute = H.executeCommand(submitted.proposalId ?? "", submitted.digest ?? "", "req-move", H.T0 + 1);
    const result = harness.requestExecution(execute, H.makeContext(H.makeBelief(H.T0 + 1, { observations: [seen] })));
    assert.equal(result.status, "invalidated");
    assert.ok(h18(result.findings).some(f => /the possible person detected in observation obs-person-new/.test(f.reason) && f.evidenceIds?.includes("obs-person-new")), JSON.stringify(result.findings));
  });

  test("a merged, retracted, low-confidence or later-cleared track does not block; the same track while current does", () => {
    const goal = H.moveInput(vec3(7.5, 1, 4.2));
    const at = (tracks: readonly OccupantTrack[], observations: readonly Observation[] = []) => h18(check("submit", goal, H.makeContext(H.makeBelief(H.T0, { tracks, observations }))));
    assert.equal(at([hallTrack()]).length, 1, "control: the current track blocks");
    assert.deepEqual(at([hallTrack({ status: "merged", mergedInto: "track-2" })]), []);
    assert.deepEqual(at([hallTrack({ status: "retracted" })]), []);
    assert.deepEqual(at([hallTrack({ confidence: DEFAULT_POLICY.personConfidenceThreshold - 0.01 })]), []);
    // Last seen at T0 − 50; an adequate person search over the hallway at T0 − 5 looked there and saw no one.
    assert.deepEqual(at([hallTrack({ lastSeenTick: H.T0 - 50 })], [H.coverageObservation(H.T0 - 5)]), []);
    // A later look from a frame unusable as a whole (quality below minCoverageQuality, 0.3) does not clear it.
    assert.equal(at([hallTrack({ lastSeenTick: H.T0 - 50 })], [H.coverageObservation(H.T0 - 5, H.HALLWAY_VIEW, 0.2)]).length, 1);
  });

  test("uncertainty inflates the clearance: a ±0.6 m track blocks a goal 1.4 m away, a ±0 m track does not", () => {
    const goal = H.moveInput(vec3(6.6, 1, 4.2));
    assert.ok(moveKeeps(0) < 1.4 && 1.4 < moveKeeps(0.6));
    const blocked = h18(check("submit", goal, H.makeContext(H.makeBelief(H.T0, { tracks: [hallTrack({ uncertaintyM: 0.6 })] }))));
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].reason, /is 1\.4 m from possible-occupant track track-1 \(confidence 0\.7, ±0\.6 m\)/);
    assert.deepEqual(h18(check("submit", goal, H.makeContext(H.makeBelief(H.T0, { tracks: [hallTrack({ uncertaintyM: 0 })] })))), []);
  });

  test("a fresh detection blocks like a track; the same detection in a frame a re-processed frame superseded does not", () => {
    const goal = H.moveInput(vec3(7.5, 1, 4.2));
    const frame = H.observation("obs-thermal-1", H.T0 - 2, H.HALLWAY_VIEW, { modality: "thermal", detections: [H.personDetection(HALL_OCCUPANT, 0.6, 0.3)] });
    const blocked = h18(check("submit", goal, H.makeContext(H.makeBelief(H.T0, { observations: [frame] }))));
    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0].evidenceIds, ["obs-thermal-1"]);
    const reprocessed = H.observation("obs-thermal-1b", H.T0 - 2, null, { modality: "thermal", supersedes: "obs-thermal-1" });
    assert.deepEqual(h18(check("submit", goal, H.makeContext(H.makeBelief(H.T0, { observations: [frame, reprocessed] })))), []);
  });

  test("never trapped: inside the clearance a goal farther from the person is accepted, a nearer one is refused, and hold and scan are not refused", () => {
    const inside = (input: ProposalInput) => h18(check("submit", input, H.makeContext(H.makeBelief(H.T0, { position: vec3(7.2, 1, 4.2), tracks: [hallTrack()] }))));
    assert.deepEqual(inside(H.moveInput(vec3(6.9, 1, 4.2))), [], "1.1 m from the person, still inside, but backing away from 0.8 m");
    assert.equal(inside(H.moveInput(vec3(7.6, 1, 4.2))).length, 1);
    assert.deepEqual(inside(H.proposalInput({ kind: "hold", durationTicks: 300 })), []);
    assert.deepEqual(inside(H.proposalInput({ kind: "scan", lookAt: HALL_OCCUPANT, durationTicks: 300 })), []);
  });

  test("route waypoints are checked: a return passing the person is refused at that waypoint, not at the start where the aircraft already is", () => {
    // Return waypoints: (5, 1, 4.2) where the aircraft is, then (4.5, 1, 4.2), 0.6 m from this occupant.
    const occupant = hallTrack({ position: vec3(4.5, 1.6, 4.2) });
    const ctx = H.makeContext(H.makeBelief(H.T0, { tracks: [occupant], routes: [H.returnRoute(H.T0 - 10)] }));
    const findings = h18(check("submit", H.proposalInput({ kind: "return", routeId: H.RETURN_ROUTE_ID }), ctx));
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.match(findings[0].reason, /^Route route-return waypoint 1 \(4\.5, 1, 4\.2\) is 0\.6 m from possible-occupant track track-1/);
  });

  test("a planner landing beside a person is refused; contingencies may be selected near people (the guard keeps them off)", () => {
    const ctx = H.makeContext(H.makeBelief(H.T0, { tracks: [hallTrack({ position: vec3(5.5, 1, 3.2) })] }));
    const site = vec3(5, 1, 3.05);
    assert.equal(h18(check("submit", H.proposalInput({ kind: "land", site }), ctx)).length, 1);
    assert.deepEqual(h18(check("submit", H.proposalInput({ kind: "land", site }, { proposer: "contingency" }), ctx)), []);
    const returnCtx = H.makeContext(H.makeBelief(H.T0, { tracks: [hallTrack({ position: vec3(4.5, 1.6, 4.2) })], routes: [H.returnRoute(H.T0 - 10)] }));
    assert.deepEqual(h18(check("submit", H.proposalInput({ kind: "return", routeId: H.RETURN_ROUTE_ID }, { proposer: "contingency" }), returnCtx)), []);
  });
});

describe("H18 for guidance: lead from ahead with the guidance clearance", () => {
  const guideScene = (tracks: readonly OccupantTrack[], observations: readonly Observation[] = []) =>
    H.makeContext(H.makeBelief(H.T0, { tracks, routes: [H.evacuationRoute(H.T0 - 10)], observations: [H.routeObservation(H.T0 - 10), ...observations] }));
  const guided = H.occupantTrack(H.T0 - 3);

  test("the guided occupant, beside the route's first waypoint, does not block its own guide", () => {
    assert.ok(distance(H.EVAC_WAYPOINTS[0], H.OCCUPANT_POSITION) < guideKeeps(guided.uncertaintyM));
    assert.deepEqual(h18(check("submit", H.guideInput(), guideScene([guided]))), []);
  });

  test("another possible occupant 1.45 m from a waypoint ahead blocks the guide (guidance clearance) but not a move there (person clearance)", () => {
    const other = H.occupantTrack(H.T0 - 3, { id: "track-2", position: vec3(7, 2.45, 4), uncertaintyM: 0.1, observationIds: ["obs-occupant-2"] });
    assert.ok(moveKeeps(0.1) < 1.45 && 1.45 < guideKeeps(0.1));
    const findings = h18(check("submit", H.guideInput(), guideScene([guided, other])));
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.match(findings[0].reason, /^Route route-evac waypoint 2 \(7, 1, 4\) is 1\.45 m from possible-occupant track track-2 .*guidance keeps 1\.2 m from the aircraft's edge/);
    assert.deepEqual(h18(check("submit", H.moveInput(vec3(7, 1, 4)), guideScene([guided, other]))), []);
  });

  test("tracks that may be the guided person and detections the guided track fused do not block the guide; an unrelated occupant there does", () => {
    // 1.0 m from the lead waypoint (4.5, 1, 4): inside the guidance distance.
    const there = vec3(4.5, 2, 4);
    const twin = H.occupantTrack(H.T0 - 3, { id: "track-2", position: there, ambiguousWith: [H.TRACK_ID], observationIds: ["obs-twin"] });
    const guidedTwin = { ...guided, ambiguousWith: ["track-2"] };
    assert.deepEqual(h18(check("submit", H.guideInput(), guideScene([guidedTwin, twin]))), []);
    const fused = H.observation("obs-occupant-1", H.T0 - 1, box(vec3(4, 1.5, 3), vec3(5, 2.5, 5)), { modality: "thermal", detections: [H.personDetection(there, 0.6, 0.3)] });
    assert.deepEqual(h18(check("submit", H.guideInput(), guideScene([guided], [fused]))), [], "the detection's frame is one the guided track fused");
    const stranger = { ...twin, ambiguousWith: [] };
    assert.equal(h18(check("submit", H.guideInput(), guideScene([guided, stranger]))).length, 1);
  });

  test("the guide's target skips a waypoint within the guidance distance of the occupant and leads to the next one", () => {
    // Waypoint 1 is 1.3 m from the occupant (±0.5 m), inside the 1.925 m guidance distance; waypoint 2 is 2.7 m away.
    const waypoints = [vec3(3, 2.5, 4), vec3(3.5, 2.2, 4), vec3(4.5, 1, 4), vec3(7, 1, 4), vec3(11, 2, 4)];
    const route = { ...H.evacuationRoute(H.T0 - 10), waypoints };
    const ctx = H.makeContext(H.makeBelief(H.T0, { tracks: [guided], routes: [route], observations: [H.routeObservation(H.T0 - 10)] }));
    assert.ok(distance(waypoints[1], guided.position) < guideKeeps(guided.uncertaintyM) && distance(waypoints[2], guided.position) >= guideKeeps(guided.uncertaintyM));
    const cursor = initialCursor(asProposal(H.guideInput()), ctx);
    assert.equal(cursor.waypointIndex, 2);
    assert.deepEqual(cursor.goal, waypoints[2]);
    assert.deepEqual(h18(check("submit", H.guideInput(), ctx)), []);
  });
});

/* Motion guard. */

const AHEAD_INSIDE = vec3(11.1, 5, 3);

function guarded(request: MotionRequest, ctx: HarnessContext, state: MotionGuardState): GuardedMotion {
  const motion = guardMotion(request, ctx, state);
  assert.ok(motion !== null);
  return motion;
}

/** One tick with no acceleration limiting: the previous command equals the request. */
function once(x: number, y: number, z: number, tracks: readonly OccupantTrack[], state: Partial<MotionGuardState> = {}, options: M.ContextOptions = {}): GuardedMotion {
  return guarded(M.motionRequest(x, y, z), M.context({ tracks, ...options }), M.guardState({ previous: M.command(x, y, z), ...state }));
}

/** Fly the guard closed-loop with ideal dynamics (position += executed velocity × dt) toward an occupant. */
function approach(occupant: OccupantTrack, state: Partial<MotionGuardState>, seconds: number): { readonly minM: number; readonly finalM: number } {
  let position = M.START;
  let previous = M.STILL;
  let minM = Infinity;
  for (let i = 0; i < seconds / TICK_S; i++) {
    const ctx = M.context({ pose: { position }, tracks: [occupant] });
    const motion = guarded(M.motionRequest(2, 0, 0, 0, "fly_readout", M.NOW + i), ctx, M.guardState({ previous, ...state }));
    position = add(position, scale(rotateBodyToWorld(0, motion.executed.velocityBody), TICK_S));
    previous = motion.executed;
    minM = Math.min(minM, distance(position, occupant.position));
  }
  return { minM, finalM: distance(position, occupant.position) };
}

function thermalFrame(id: string, captureTick: Tick, detections: readonly Detection[], overrides: Partial<Observation> = {}): Observation {
  return {
    id, runId: M.RUN_ID, sensorId: "thermal-front", modality: "thermal", captureTick, arrivalTick: captureTick, frameId: `frame-${id}`, calibrationId: "calibration-fixture",
    provenance: "fixture", sensorPose: { position: M.START, yawRad: 0, sigmaM: 0.2 }, quality: 0.9, footprint: box(vec3(9, 3, 1), vec3(14, 7, 5)), personSearch: "oracle_fixture",
    detections, supersedes: null, ...overrides,
  };
}

const GUIDE: ActionProposal = M.proposal({ kind: "guide", trackId: "track-near", routeId: "route-evac", templateIds: ["follow-light"], maxDurationTicks: 600 } satisfies ActionSpec);

describe("motion guard: never close in on a possible occupant", () => {
  test("a velocity toward a track 1.1 m ahead no longer closes in; motion away, a slide past and turning in place pass", () => {
    const near = [M.track("track-near", AHEAD_INSIDE)];
    assert.ok(1.1 < moveKeeps(0));
    const toward = once(1, 0, 0, near);
    assert.deepEqual(toward.executed.velocityBody, vec3(0, 0, 0));
    assert.ok(toward.limits.includes(PERSON_CLEARANCE_LIMIT));
    const away = once(-1, 0, 0, near);
    assert.deepEqual(away.executed, M.command(-1, 0, 0));
    assert.deepEqual(away.limits, []);
    // Forward closes, sideways is tangential: the closing component is dropped and the slide kept.
    assert.deepEqual(once(1, 0.5, 0, near).executed.velocityBody, vec3(0, 0.5, 0));
    const turn = guarded(M.motionRequest(0, 0, 0, 0.6), M.context({ tracks: near }), M.guardState());
    assert.deepEqual(turn.executed, M.command(0, 0, 0, 0.6));
  });

  test("inside the clearance no executed command closes in; outside it closing never outruns the slack; opening motion passes unchanged", () => {
    const COMPONENTS = [-1.5, -0.5, 0, 0.5, 1.5];
    const cases: [string, Vec3, number][] = [["inside, ahead-left", vec3(10.9, 5.6, 3), 0], ["outside, ahead-right below", vec3(11.4, 4.2, 2.4), -2.5], ["inside, behind and above", vec3(9.4, 5, 3.6), 1]];
    let checked = 0;
    for (const [label, at, yawRad] of cases) {
      const occupant = M.track("track-near", at);
      const ctx = M.context({ tracks: [occupant], pose: { yawRad } });
      const d = distance(M.START, at);
      const slackM = d - moveKeeps(0);
      const away = scale(sub(M.START, at), 1 / d);
      for (const x of COMPONENTS) for (const y of COMPONENTS) for (const z of COMPONENTS) {
        const motion = guarded(M.motionRequest(x, y, z), ctx, M.guardState({ previous: M.command(x, y, z) }));
        const closing = (v: Vec3) => -dot(rotateBodyToWorld(yawRad, v), away);
        const where = `${label}: (${x}, ${y}, ${z}) → ${JSON.stringify(motion.executed.velocityBody)}`;
        assert.ok(closing(motion.executed.velocityBody) <= Math.max(0, slackM / DEFAULT_POLICY.envelopeLookaheadS) + 1e-9, where);
        if (closing(vec3(x, y, z)) <= 0 && Math.hypot(x, y) <= 2) assert.deepEqual(motion.executed, M.command(x, y, z), where);
        checked++;
      }
    }
    assert.equal(checked, cases.length * COMPONENTS.length ** 3);
  });

  test("approaching from 3 m, a move brakes to the person clearance and a guide stops at the larger guidance clearance", () => {
    const occupant = M.track("track-near", vec3(13, 5, 3), { uncertaintyM: 0.3 });
    const move = approach(occupant, { activeMotion: M.PLANNER_MOVE }, 8);
    assert.ok(move.minM >= moveKeeps(0.3) - 1e-9, `move came within ${move.minM} m`);
    assert.ok(move.finalM <= moveKeeps(0.3) + 0.05, `move stalled at ${move.finalM} m`);
    const guide = approach(occupant, { activeMotion: GUIDE }, 8);
    assert.ok(guide.minM >= guideKeeps(0.3) - 1e-9, `guide came within ${guide.minM} m`);
    assert.ok(guide.finalM <= guideKeeps(0.3) + 0.05, `guide stalled at ${guide.finalM} m`);
  });

  test("uncertainty inflates the clearance: a ±0.6 m track 1.4 m ahead stops the approach, a ±0 m one only slows it", () => {
    assert.deepEqual(once(1, 0, 0, [M.track("track-near", vec3(11.4, 5, 3), { uncertaintyM: 0.6 })]).executed.velocityBody, vec3(0, 0, 0));
    const slowed = once(1, 0, 0, [M.track("track-near", vec3(11.4, 5, 3))]).executed.velocityBody;
    const allowed = (1.4 - moveKeeps(0)) / DEFAULT_POLICY.envelopeLookaheadS;
    assert.ok(Math.abs(slowed.x - allowed) < 1e-9 && slowed.y === 0 && slowed.z === 0, JSON.stringify(slowed));
  });

  test("a merged, retracted, low-confidence or later-cleared track does not limit motion", () => {
    const inert: OccupantTrack[] = [
      M.track("track-merged", AHEAD_INSIDE, { status: "merged", mergedInto: "track-x" }),
      M.track("track-retracted", AHEAD_INSIDE, { status: "retracted" }),
      M.track("track-faint", AHEAD_INSIDE, { confidence: 0.1 }),
      M.track("track-old", AHEAD_INSIDE, { lastSeenTick: M.NOW - 100 }),
    ];
    const lookedAndSawNoOne = thermalFrame("obs-look", M.NOW - 5, []);
    const motion = once(1, 0, 0, inert, {}, { observations: [lookedAndSawNoOne] });
    assert.deepEqual(motion.executed, M.command(1, 0, 0));
    assert.deepEqual(motion.limits, []);
    // Control: the old track without the later look, and a track seen after that look, both stop the approach.
    assert.deepEqual(once(1, 0, 0, inert).executed.velocityBody, vec3(0, 0, 0));
    const seenSince = M.track("track-current", AHEAD_INSIDE, { lastSeenTick: M.NOW - 1 });
    assert.deepEqual(once(1, 0, 0, [...inert, seenSince], {}, { observations: [lookedAndSawNoOne] }).executed.velocityBody, vec3(0, 0, 0));
  });

  test("a detection in the newest person-search frame limits like a track; one in a superseded frame does not", () => {
    const frame = thermalFrame("obs-thermal-1", M.NOW - 1, [{ kind: "possible_person", position: AHEAD_INSIDE, uncertaintyM: 0, confidence: 0.6, method: "oracle_fixture" }]);
    assert.deepEqual(once(1, 0, 0, [], {}, { observations: [frame] }).executed.velocityBody, vec3(0, 0, 0));
    const reprocessed = thermalFrame("obs-thermal-1b", M.NOW - 1, [], { footprint: null, supersedes: "obs-thermal-1" });
    assert.deepEqual(once(1, 0, 0, [], {}, { observations: [frame, reprocessed] }).executed, M.command(1, 0, 0));
  });

  test("contingencies obey the guard: an aborted mission's return cannot drive into a person, nor a contingency landing descend onto one", () => {
    const aborted = { missionAborted: true, activeMotion: M.CONTINGENCY_RETURN };
    assert.deepEqual(once(1, 0, 0, [M.track("track-near", AHEAD_INSIDE)], aborted).executed.velocityBody, vec3(0, 0, 0));
    assert.deepEqual(once(-1, 0, 0, [M.track("track-near", AHEAD_INSIDE)], aborted).executed, M.command(-1, 0, 0));
    const below = [M.track("track-below", vec3(10, 5, 2))];
    const landing = { missionAborted: true, activeMotion: M.CONTINGENCY_LAND };
    assert.deepEqual(once(0, 0, -0.5, below, landing).executed.velocityBody, vec3(0, 0, 0));
    assert.deepEqual(once(0, 0, 0.5, below, landing).executed, M.command(0, 0, 0.5), "climbing away stays allowed");
  });
});
