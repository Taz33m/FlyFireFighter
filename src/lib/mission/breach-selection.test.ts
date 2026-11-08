/**
 * Breach selection on the Troy main scenario's real scene prior. This lives with the mission (which may read
 * scene files and the simulator's truth-free prior builder) because planner code and tests never import
 * simulation modules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { BeliefSnapshot, HazardEvidence, OccupantTrack } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import { box, sphere } from "../contracts/geometry.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { roomContaining } from "../evidence/rooms.ts";
import { DEFAULT_POLICY } from "../harness/policy.ts";
import { breachAccessOf, buildCandidateSet } from "../navigation/planner/candidates.ts";
import type { LocalPlan } from "../navigation/planner/local-planner.ts";
import { rankCandidates } from "../navigation/planner/local-planner.ts";
import { observation, REPORT, shuffled } from "../navigation/planner/test-fixtures.ts";
import type { CandidateSet, ProposalCandidate } from "../navigation/planner/types.ts";
import { floorPlanPriorFromScene } from "../simulation/prior.ts";

/** Breach candidate ids in ranked order. */
function rankedBreaches(plan: LocalPlan): string[] {
  return plan.ranked.filter(r => r.tool === "request_breach").map(r => r.id);
}

/*
 * The Troy main scenario on the real scene prior (public/scenes/troy-training/scene.meta.json, through the
 * truth-free prior builder: no scenario anchors). Belief fixture: the default report names the upstairs rear
 * bedroom, a possible-occupant track was seen there, every exterior window was observed closed a moment ago,
 * and the aircraft hovers outside. Doors are as the plan draws them: the front bedroom's is closed.
 */
describe("local planner: Troy main scenario breach selection", () => {
  const meta = JSON.parse(readFileSync(new URL("../../../public/scenes/troy-training/scene.meta.json", import.meta.url), "utf8")) as SceneMetaJson;
  const prior = floorPlanPriorFromScene(meta);
  const T = 5000;
  const envelope: MissionEnvelope = deepFreeze({ runId: "run-troy", revision: 1, approvedBy: "commander-1", approvedTick: 0, regions: [box(vec3(-48, -34, -0.15), vec3(62, 58, 8))], maxSpeedMps: 2, ambientCeilingC: 80, endTick: 100_000 });
  const allWindows = prior.openings.filter(o => o.kind === "window" && o.rooms[1] === "exterior");
  const seen = (id: string, tick: number, detections: Observation["detections"] = []): Observation => ({
    ...observation(id, tick, { modality: "rgb", personSearch: "oracle_fixture", footprint: sphere(vec3(30, 12, 5), 1), position: vec3(30, 12, 5), detections }),
    runId: "run-troy",
  });
  const occupant: OccupantTrack = { id: "track-7", status: "possible", observationIds: [], position: vec3(23.7, 0.2, 4.4), uncertaintyM: 0.6, roomId: "room-u-rear-bedroom", firstSeenTick: T - 400, lastSeenTick: T - 60, confidence: 0.6, mergedInto: null, ambiguousWith: [] };
  const fireObservation = seen("obs-fire", T - 40);
  const hallFire: HazardEvidence = { observationId: fireObservation.id, tick: T - 40, hazard: "fire", region: sphere(vec3(20.85, 2.1, 3.9), 0.4), intensity: 0.7 };

  function troyBelief(options: { readonly tracks?: readonly OccupantTrack[]; readonly fire?: boolean; readonly pose?: { x: number; y: number; z: number }; readonly observed?: readonly string[] } = {}): BeliefSnapshot {
    const pose = options.pose ?? vec3(30, 12, 5);
    const windows = options.observed === undefined ? allWindows : allWindows.filter(o => options.observed?.includes(o.id));
    return deepFreeze({
      runId: "run-troy",
      tick: T,
      evidenceRevision: 40,
      mapPrior: prior,
      mapRevision: 1,
      mapChanges: [],
      pose: { tick: T, position: pose, yawRad: Math.PI, velocity: vec3(0, 0, 0), sigmaM: 0.1, yawSigmaRad: 0.02, supported: true },
      aircraft: { enduranceRemainingS: 700, waterRemainingL: 1, payloadsOnboard: [], ambientC: 22, thrustAvailableN: 60 },
      landing: { supported: false, site: null, evidenceIds: [], reason: "No landing surface observed." },
      observations: [...windows.map((o, i) => seen(`obs-${o.id}`, T - 100 - i, [{ kind: "opening_state", openingId: o.id, state: "closed" }])), ...(options.fire ? [fireObservation] : [])],
      reports: [{ ...REPORT, runId: "run-troy", originalText: "Someone may be in the upstairs rear bedroom.", roomHint: "room-u-rear-bedroom" }],
      tracks: options.tracks ?? [occupant],
      crewConfirmations: [],
      coverage: prior.rooms.map(room => ({ roomId: room.id, state: "unobserved" as const, fractionAdequate: 0, fractionAny: 0, lastObservedTick: null, bestModality: null })),
      hazards: options.fire ? [hallFire] : [],
      openings: windows.map((o, i) => ({ openingId: o.id, state: "closed" as const, tick: T - 100 - i, observationId: `obs-${o.id}` })),
      routes: [],
      dispatchConfirmed: null,
    });
  }
  const troySet = (belief: BeliefSnapshot, omit: readonly string[] = []) => buildCandidateSet({ belief, profile: TENDER_T1, envelope, policy: DEFAULT_POLICY, omitCandidateIds: omit });
  const breachOf = (set: CandidateSet, id: string) => set.candidates.find((c): c is ProposalCandidate => c.id === `request_breach:${id}`);
  const studyWindows = ["request_breach:win-u-study-s1", "request_breach:win-u-study-s2"];

  test("with an occupant track in the rear bedroom, the best breach is a study window off the upstairs hall", () => {
    const belief = troyBelief();
    const set = troySet(belief);
    const order = rankedBreaches(rankCandidates(set, belief, DEFAULT_POLICY));
    assert.ok(studyWindows.includes(order[0]), order.join(", "));
    const study = breachAccessOf(breachOf(set, order[0].split(":")[1]) as ProposalCandidate);
    assert.ok(study);
    assert.equal(study.closedIn, false);
    assert.equal(study.approach, true);
    assert.equal(study.targetRoomId, "room-u-rear-bedroom");
    assert.deepEqual(study.via, ["door-u-study", "door-u-rear-bedroom"], "through the upstairs hall");
    // The occupied room's window clear of the occupant is offered but ranks below both study windows.
    const rear = order.indexOf("request_breach:win-u-rear-bedroom");
    assert.ok(rear > Math.max(...studyWindows.map(id => order.indexOf(id))), order.join(", "));
    // The front bedroom's door is closed (the drone cannot open doors): both its windows rank below the study and the rear bedroom.
    for (const id of ["request_breach:win-u-front-bedroom-e", "request_breach:win-u-front-bedroom-n"]) {
      assert.ok(order.indexOf(id) > rear, `${id} in ${order.join(", ")}`);
      assert.deepEqual(breachAccessOf(breachOf(set, id.split(":")[1]) as ProposalCandidate)?.closedOpeningIds, ["door-u-front-bedroom"]);
    }
    // The window whose debris region reaches the occupant is not offered at all, and the set says why.
    assert.equal(breachOf(set, "win-u-rear-bedroom-east"), undefined);
    assert.ok(set.notes.some(note => /No breach of window win-u-rear-bedroom-east .*track-7/.test(note)), set.notes.join("\n"));
    assert.ok(set.notes.some(note => /win-u-front-bedroom-e .*door-u-front-bedroom.*strand/.test(note)));
  });

  test("when access is needed the local planner picks that study window, with nothing offered inside the house", () => {
    const belief = troyBelief();
    const set = troySet(belief);
    // The factory itself withholds what the runtime's flight-path filter would drop with every entry closed.
    assert.deepEqual(set.candidates.filter(c => c.target?.station != null && roomContaining(prior, c.target.station) !== null).map(c => c.id), []);
    assert.ok(!set.candidates.some(c => c.id === "investigate_signal:track-7"));
    assert.ok(set.notes.some(note => /Not offering a second look at possible-occupant track track-7 in Upstairs rear bedroom: .*no passable way in from outside yet \(impassable: .*door-front closed \(plan; not observed\)/.test(note)), set.notes.join("\n"));
    const result = rankCandidates(set, belief, DEFAULT_POLICY);
    assert.ok(studyWindows.includes(result.choiceId), result.choiceId);
    for (const seed of [3, 11, 29]) assert.equal(rankCandidates({ ...set, candidates: shuffled(set.candidates, seed) }, belief, DEFAULT_POLICY).choiceId, result.choiceId, `seed ${seed}`);
  });

  test("once a window is observed broken, the lead inside is reachable and its second look is offered again", () => {
    const base = troyBelief();
    const broken = seen("obs-broken", T - 10, [{ kind: "opening_state", openingId: "win-u-rear-bedroom", state: "broken" }]);
    const belief = { ...base, observations: [...base.observations, broken], openings: [...base.openings, { openingId: "win-u-rear-bedroom", state: "broken" as const, tick: T - 10, observationId: broken.id }] };
    assert.ok(troySet(belief).candidates.some(c => c.id === "investigate_signal:track-7"));
  });

  test("a study window wins from every side of the house, with or without the hall fire known", () => {
    for (const fire of [false, true]) {
      for (const pose of [vec3(30, 12, 5), vec3(24, -6, 5), vec3(11, 14, 5), vec3(10, -2, 5), vec3(30.5, 28, 5)]) {
        const belief = troyBelief({ fire, pose });
        const order = rankedBreaches(rankCandidates(troySet(belief), belief, DEFAULT_POLICY));
        assert.ok(studyWindows.includes(order[0]), `fire ${fire}, pose (${pose.x}, ${pose.y}): ${order.slice(0, 4).join(", ")}`);
      }
    }
    const study = breachAccessOf(breachOf(troySet(troyBelief({ fire: true })), "win-u-study-s1") as ProposalCandidate);
    assert.deepEqual([study?.hopsToTarget, study?.targetRoomId, study?.targetReason], [1, "room-u-hall", "fire"]);
  });

  test("before any occupant is detected, the reported rear bedroom's windows rank first", () => {
    const belief = troyBelief({ tracks: [] });
    const order = rankedBreaches(rankCandidates(troySet(belief), belief, DEFAULT_POLICY));
    assert.deepEqual(new Set(order.slice(0, 2)), new Set(["request_breach:win-u-rear-bedroom", "request_breach:win-u-rear-bedroom-east"]), order.join(", "));
  });

  /*
   * The live run's first breach decision (t = 46 s, approach from the north-east): kitchen-e/n/s,
   * front-bedroom-e/n and rear-bedroom-east observed closed, the study and every other window not yet seen.
   */
  const LIVE_OBSERVED = ["win-g-kitchen-e", "win-g-kitchen-n", "win-g-kitchen-s", "win-u-front-bedroom-e", "win-u-front-bedroom-n", "win-u-rear-bedroom-east"];
  const studyLooks = ["inspect_room:room-u-study:win-u-study-s1", "inspect_room:room-u-study:win-u-study-s2"];

  test("size-up: with the study windows not yet seen, the choice is a look at one before any glass is broken", () => {
    for (const pose of [vec3(26, 8, 5), vec3(30, 12, 5), vec3(28, 2, 5)]) {
      const belief = troyBelief({ observed: LIVE_OBSERVED, pose });
      const set = troySet(belief);
      const result = rankCandidates(set, belief, DEFAULT_POLICY);
      assert.ok(studyLooks.includes(result.choiceId), `pose (${pose.x}, ${pose.y}): ${result.ranked.slice(0, 4).map(r => r.id).join(", ")}`);
      const look = set.candidates.find(c => c.id === result.choiceId) as ProposalCandidate;
      assert.match(look.proposal.rationale, /^Look at win-u-study-s[12] before choosing where to break in: it opens into a room connected toward the target/);
      assert.equal(look.proposal.action.kind, "move", "observation only");
      const breaches = rankedBreaches(result);
      assert.ok(result.ranked.findIndex(r => r.id === result.choiceId) < result.ranked.findIndex(r => r.id === breaches[0]), "ranked above the best observed breach");
    }
  });

  test("size-up: the 0.7 m bathroom window, once seen, is too tight to pre-empt the look at the study", () => {
    const belief = troyBelief({ observed: [...LIVE_OBSERVED, "win-u-bath-s"], pose: vec3(20.85, -3.6, 5.25) });
    const set = troySet(belief);
    assert.ok(studyLooks.includes(rankCandidates(set, belief, DEFAULT_POLICY).choiceId));
    assert.ok(set.notes.some(note => /Window win-u-bath-s into Upstairs bathroom ranks low: its 0.7 m pane leaves the 0.55 m aircraft less than half its obstacle clearance/.test(note)), set.notes.join("\n"));
  });

  test("size-up: once the study windows are observed closed, the choice is the study breach", () => {
    const belief = troyBelief({ observed: [...LIVE_OBSERVED, "win-u-study-s1", "win-u-study-s2"], pose: vec3(18.2, -5, 5) });
    const set = troySet(belief);
    assert.ok(!set.candidates.some(c => studyLooks.includes(c.id)));
    assert.ok(studyWindows.includes(rankCandidates(set, belief, DEFAULT_POLICY).choiceId));
  });

  test("size-up: a cooled study look lets the other study window be looked at", () => {
    const belief = troyBelief({ observed: LIVE_OBSERVED });
    const first = rankCandidates(troySet(belief), belief, DEFAULT_POLICY).choiceId;
    const second = rankCandidates(troySet(belief, [first]), belief, DEFAULT_POLICY).choiceId;
    assert.ok(studyLooks.includes(second) && second !== first, `${first} then ${second}`);
  });

  test("size-up: with every window observed, no look is offered and the breach choice is as before", () => {
    const set = troySet(troyBelief());
    assert.ok(!set.candidates.some(c => c.id.split(":").length === 3 && c.tool === "inspect_room"));
    assert.ok(!set.notes.some(note => /Size-up/.test(note)));
  });
});
