/**
 * Suppression gating in the candidate factory: no spray at a fire water is unsafe for (the harness's H19
 * evidence), no second spray at a fire before a sighting after the first still shows flame (H14), and the look
 * at the sprayed fire that replaces it. Scope: the authored planner fixtures (test-fixtures.ts: a fictional
 * house, the aircraft inside the rear bedroom, a fire in the upstairs hall), authored reports and spray records;
 * candidate sets only, no harness run.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { BeliefSnapshot, CallerReport, HazardEvidence } from "../../contracts/evidence.ts";
import { vec3 } from "../../contracts/frames.ts";
import { sphere } from "../../contracts/geometry.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import type { SprayDischarge } from "../../harness/respray.ts";
import { sprayFireClass } from "../../harness/rules.ts";
import type { CandidateFactoryInput } from "./candidates.ts";
import { breachAccessOf, buildCandidateSet, isFireRecheck, isRouteSweep } from "./candidates.ts";
import { ENVELOPE, EVACUATION_BLOCKED, FIRE, insideBelief, observation, openingSeen, outsideBelief, REPORT, RUN_ID } from "./test-fixtures.ts";
import type { CandidateSet, ProposalCandidate } from "./types.ts";

const SPRAY_ID = "request_suppression:hall-up";
const RECHECK_ID = "inspect_room:hall-up:fire-recheck";

function build(belief: BeliefSnapshot, extra: Partial<CandidateFactoryInput> = {}): CandidateSet {
  return buildCandidateSet({ belief, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY, ...extra });
}

function find(set: CandidateSet, id: string): ProposalCandidate | undefined {
  return set.candidates.find((c): c is ProposalCandidate => c.id === id && c.proposal !== null);
}

function caller(id: string, originalText: string): CallerReport {
  return { ...REPORT, id, source: "caller", originalText, roomHint: null };
}

/** The spray the factory offers at the hall fire in the base scene, as a completed spray record ending at `endedTick`. */
function sprayedAt(endedTick: number): SprayDischarge {
  const action = find(build(insideBelief()), SPRAY_ID)?.proposal.action;
  assert.ok(action?.kind === "spray");
  return { proposalId: `${RUN_ID}/p7`, action, endedTick };
}

/** The base scene at `tick`, with the aircraft at `position` and these hall-fire sightings. */
function at(tick: number, hazards: readonly HazardEvidence[] = [FIRE], position = insideBelief().pose.position): BeliefSnapshot {
  const base = insideBelief();
  const sightings = hazards.filter(h => h !== FIRE).map(h => observation(h.observationId, h.tick, { position: vec3(4.5, 2, 4.2), detections: [{ kind: "hazard", hazard: "fire", region: h.region, intensity: h.intensity }] }));
  return insideBelief({ tick, pose: { ...base.pose, tick, position }, hazards, observations: [...base.observations, ...sightings] });
}

describe("no spray where water is the wrong agent", () => {
  test("regression: the hall fire with no cooking, fuel or electrical indicator is sprayable, and the harness agrees", () => {
    const spray = find(build(insideBelief()), SPRAY_ID);
    assert.ok(spray?.proposal.action.kind === "spray");
    const harness = { tick: 2000, missionStartTick: 0, profile: TENDER_T1, policy: DEFAULT_POLICY, envelope: ENVELOPE, belief: insideBelief() };
    assert.equal(sprayFireClass(spray.proposal.action, harness).assessment.waterSuitable, true);
  });

  test("a caller's pan of oil withholds the spray with a note naming the class and the report", () => {
    const set = build(insideBelief({ reports: [REPORT, caller("report-2", "The fire started from a pan of oil")] }));
    assert.equal(set.candidates.some(c => c.tool === "request_suppression"), false);
    const note = set.notes.find(n => n.startsWith("Suppression is not available for the fire in Upstairs hall"));
    assert.ok(note, set.notes.join("\n"));
    assert.match(note, /Water is unsafe for a possible cooking-oil or grease fire \(class K\/F\): caller report report-2 mentions "pan", "oil"\. Water is the only agent carried; route assessment and guidance continue without spraying\.$/);
  });

  test("a fire in the prior's kitchen gets no spray even without a report cue", () => {
    const kitchenFire: HazardEvidence = { observationId: "obs-kitchen-fire", tick: 1980, hazard: "fire", region: sphere(vec3(8, 4, 0.4), 0.4), intensity: 0.8 };
    const base = insideBelief();
    const belief = insideBelief({ hazards: [kitchenFire], observations: [...base.observations, observation(kitchenFire.observationId, kitchenFire.tick, { position: vec3(6.5, 4, 1.4), detections: [{ kind: "hazard", hazard: "fire", region: kitchenFire.region, intensity: 0.8 }] })] });
    const set = build(belief);
    assert.equal(set.candidates.some(c => c.tool === "request_suppression"), false);
    assert.ok(set.notes.some(n => /^Suppression is not available for the fire in Kitchen: .*the fire is in the Kitchen \(floor-plan prior: a kitchen\)/.test(n)), set.notes.join("\n"));
  });

  test("breach access heads for a fire it could suppress, not for one water is unsafe for", () => {
    // Outside, the front bedroom window seen closed; the hall fire is one door from that bedroom, the reported rear bedroom two.
    const seen = openingSeen("window-front", "closed", 990, "obs-window-front");
    const fireView = observation("obs-fire-1", 990, { position: vec3(7, 5, 4.4), detections: [{ kind: "hazard", hazard: "fire", region: FIRE.region, intensity: 0.8 }] });
    const access = (reports: readonly CallerReport[]) => {
      const set = build(outsideBelief({ observations: [seen.observation, fireView], openings: [seen.evidence], hazards: [{ ...FIRE, tick: 990 }], reports }));
      const breach = set.candidates.find(c => c.id === "request_breach:window-front");
      assert.ok(breach, set.notes.join("\n"));
      return breachAccessOf(breach);
    };
    assert.deepEqual([access([REPORT])?.targetRoomId, access([REPORT])?.targetReason], ["hall-up", "fire"]);
    const unsafe = access([REPORT, caller("report-2", "Sparks from the wiring")]);
    assert.deepEqual([unsafe?.targetRoomId, unsafe?.targetReason, unsafe?.hopsToTarget], ["bedroom-rear", "reported", 2], "the unsprayable fire's room is no destination");
  });

  test("the route sweep waits for a fire still to be suppressed, not for one water is unsafe for", () => {
    const unknownRoute = { ...EVACUATION_BLOCKED, status: "unknown" as const, assessedTick: 1990, reason: "Rooms on the route not searched since the fire was seen." };
    const sweeps = (belief: BeliefSnapshot) => build(belief).candidates.filter(isRouteSweep).length;
    assert.equal(sweeps(insideBelief({ routes: [unknownRoute] })), 0, "a sprayable fire burns: suppression first");
    assert.ok(sweeps(insideBelief({ routes: [unknownRoute], reports: [REPORT, caller("report-2", "Sparks from the wiring")] })) > 0, "the fire cannot be sprayed: the sweep goes ahead");
  });
});

describe("look before spraying again", () => {
  test("right after a spray: no second spray, a look back at the fire from the standoff, and no other look", () => {
    const sprayed = sprayedAt(1990);
    const set = build(at(2000), { sprays: [sprayed] });
    assert.equal(find(set, SPRAY_ID), undefined);
    assert.ok(set.notes.includes(`Not offering another spray at the fire in Upstairs hall yet: spray proposal ${RUN_ID}/p7, which reached it, ended 0.1 s ago, and no sighting since shows whether it still burns. The aircraft looks at it first.`), set.notes.join("\n"));
    const recheck = find(set, RECHECK_ID);
    assert.ok(recheck && isFireRecheck(recheck));
    assert.deepEqual(recheck.proposal.action, { kind: "move", goal: sprayed.action.standoff, maxSpeedMps: 2 }, "away from the standoff: back to it");
    assert.deepEqual(set.candidates.filter(c => c.tool === "inspect_room" || c.tool === "investigate_signal").map(c => c.id), [RECHECK_ID], "nothing else is looked at meanwhile");
    assert.ok(set.notes.some(n => n.startsWith("Looking at the sprayed fire again before anything else, for up to 15 s after the spray: not offering ")));

    const there = find(build(at(2000, [FIRE], sprayed.action.standoff), { sprays: [sprayed] }), RECHECK_ID);
    assert.deepEqual(there?.proposal.action, { kind: "scan", lookAt: sprayed.action.aimPoint, durationTicks: 200 }, "at the standoff: hold facing the aim");
  });

  test("15 s after the spray other looks return, but the spray stays withheld until a new sighting", () => {
    const set = build(at(3600), { sprays: [sprayedAt(1990)] });
    assert.equal(find(set, SPRAY_ID), undefined);
    assert.ok(find(set, RECHECK_ID));
    assert.ok(set.candidates.some(c => c.tool === "investigate_signal"), "the second look at the lead is offered again");
  });

  test("a sighting after the spray decides: flame offers the spray again, no flame offers neither", () => {
    const sprays = [sprayedAt(1990)];
    const burning = build(at(2010, [FIRE, { ...FIRE, observationId: "obs-fire-2", tick: 1995, intensity: 0.5 }]), { sprays });
    assert.ok(find(burning, SPRAY_ID), burning.notes.join("\n"));
    assert.equal(find(burning, RECHECK_ID), undefined);
    assert.deepEqual(find(burning, SPRAY_ID)?.proposal.citedEvidence, ["obs-fire-2"], "it cites the sighting after the spray");

    const out = build(at(2010, [FIRE, { ...FIRE, observationId: "obs-fire-2", tick: 1995, intensity: 0 }]), { sprays });
    assert.equal(find(out, SPRAY_ID), undefined);
    assert.equal(find(out, RECHECK_ID), undefined);
  });

  test("a sighting captured during the spray is not after it", () => {
    const set = build(at(2010, [FIRE, { ...FIRE, observationId: "obs-fire-2", tick: 1985, intensity: 0.5 }]), { sprays: [sprayedAt(1990)] });
    assert.equal(find(set, SPRAY_ID), undefined);
    assert.ok(find(set, RECHECK_ID));
  });
});
