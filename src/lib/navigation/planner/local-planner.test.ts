import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { BeliefSnapshot, FloorPlanPrior, OccupantTrack } from "../../contracts/evidence.ts";
import { vec3 } from "../../contracts/frames.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import { buildCandidateSet } from "./candidates.ts";
import type { LocalPlan } from "./local-planner.ts";
import { PLANNER_WEIGHTS, rankCandidates } from "./local-planner.ts";
import { afterSuppressionBelief, closedWindowBelief, ENVELOPE, HOUSE, insideBelief, openingSeen, outsideBelief, REPORT, shuffled, T_OUTSIDE, TRACK } from "./test-fixtures.ts";
import type { CandidateSet, ProposalCandidate } from "./types.ts";

function build(belief: BeliefSnapshot, lastInterventionTick: number | null = null): CandidateSet {
  return buildCandidateSet({ belief, profile: TENDER_T1, envelope: ENVELOPE, policy: DEFAULT_POLICY, lastInterventionTick });
}

function plan(belief: BeliefSnapshot, lastInterventionTick: number | null = null) {
  return rankCandidates(build(belief, lastInterventionTick), belief, DEFAULT_POLICY);
}

/** North of the house: the front bedroom's exterior viewpoint is 2 m away, the rear bedroom's 14 m. */
const northPose = { ...outsideBelief().pose, position: vec3(2.5, 12, 4.4) };

describe("local planner", () => {
  test("prefers the room named in a report over a nearer unreported room", () => {
    const withReport = plan(outsideBelief({ pose: northPose }));
    assert.equal(withReport.choiceId, "inspect_room:bedroom-rear");
    const withoutReport = plan(outsideBelief({ pose: northPose, reports: [] }));
    assert.equal(withoutReport.choiceId, "inspect_room:bedroom-front", "without the report the nearer room wins");
  });

  test("a superseded report no longer directs the search", () => {
    const correction = { ...REPORT, id: "report-2", receivedTick: 950, originalText: "Sorry, the front bedroom.", roomHint: "bedroom-front", supersedes: "report-1" };
    const result = plan(outsideBelief({ reports: [REPORT, correction] }));
    assert.equal(result.choiceId, "inspect_room:bedroom-front");
  });

  test("ranks deterministically regardless of candidate order", () => {
    const belief = insideBelief();
    const set = build(belief);
    const reference = rankCandidates(set, belief).ranked;
    for (const seed of [1, 7, 42, 99]) {
      const reordered: CandidateSet = { ...set, candidates: shuffled(set.candidates, seed) };
      assert.deepEqual(rankCandidates(reordered, belief).ranked, reference, `seed ${seed}`);
    }
  });

  test("equal scores break by canonical tool order, then candidate id", () => {
    const belief = outsideBelief({ reports: [] });
    const set = build(belief);
    const rear = set.candidates.find((c): c is ProposalCandidate => c.id === "inspect_room:bedroom-rear");
    assert.ok(rear);
    const twins: CandidateSet = { ...set, candidates: [{ ...rear, id: "inspect_room:zz-twin" }, ...set.candidates, { ...rear, id: "inspect_room:aa-twin" }] };
    const order = rankCandidates(twins, belief).ranked.map(r => r.id);
    const tie = order.filter(id => id === "inspect_room:aa-twin" || id === "inspect_room:bedroom-rear" || id === "inspect_room:zz-twin");
    assert.deepEqual(tie, ["inspect_room:aa-twin", "inspect_room:bedroom-rear", "inspect_room:zz-twin"]);
  });

  test("a window observed closed ranks breaching above re-inspecting the room through it", () => {
    const result = plan(closedWindowBelief());
    assert.equal(result.choiceId, "request_breach:window-rear");
  });

  test("an observed open entry ranks entering above breaking glass", () => {
    const open = openingSeen("door-front", "open", T_OUTSIDE - 20);
    const closed = closedWindowBelief();
    const result = plan(closedWindowBelief({ observations: [...closed.observations, open.observation], openings: [...closed.openings, open.evidence] }));
    const ids = result.ranked.map(r => r.id);
    assert.equal(result.ranked[0].tool, "inspect_room");
    assert.ok(ids.indexOf("inspect_room:bedroom-rear") < ids.indexOf("request_breach:window-rear"));
  });

  test("a room observed a moment ago is not re-inspected in a loop just because a report names it", () => {
    const justSeen = outsideBelief({
      coverage: closedWindowBelief().coverage,
    });
    const result = plan(justSeen);
    assert.notEqual(result.choiceId, "inspect_room:bedroom-rear");
    const later = outsideBelief({ tick: T_OUTSIDE + 1200, coverage: closedWindowBelief().coverage });
    assert.equal(plan(later).choiceId, "inspect_room:bedroom-rear", "the report regains weight once the view is stale");
  });

  test("suppressing a fire on a blocked evacuation route outranks a second look at the lead", () => {
    const result = plan(insideBelief());
    assert.equal(result.choiceId, "request_suppression:hall-up");
    const spray = result.ranked.find(r => r.id === "request_suppression:hall-up");
    assert.ok(spray?.score && spray.score.adjustment > 0, "rescue relevance is part of the score");
  });

  test("guidance along a fresh supported route ranks first once it exists", () => {
    const result = plan(afterSuppressionBelief(), 2100);
    assert.equal(result.choiceId, "guide_to_exit:track-1:route-evac");
  });

  test("with no supported proposal the planner defers", () => {
    const belief = insideBelief({ pose: { ...insideBelief().pose, supported: false } });
    const result = plan(belief);
    assert.equal(result.choiceId, "defer");
    assert.deepEqual(result.ranked.map(r => r.id), ["defer", "request_human_review"]);
  });

  test("closer candidates of the same kind cost less travel", () => {
    const result = plan(outsideBelief({ reports: [] }));
    const travel = (id: string) => result.ranked.find(r => r.id === id)?.score?.travel ?? NaN;
    assert.ok(travel("inspect_room:bedroom-rear") < travel("inspect_room:bedroom-front"));
  });

  test("refuses to rank a set against another run's belief", () => {
    assert.throws(() => rankCandidates(build(outsideBelief()), outsideBelief({ runId: "run-2" })), RangeError);
  });
});

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Breach candidate ids in ranked order. */
function rankedBreaches(plan: LocalPlan): string[] {
  return plan.ranked.filter(r => r.tool === "request_breach").map(r => r.id);
}

describe("local planner: choosing a window to breach (fixture house)", () => {
  /** Both upstairs bedroom windows observed closed; the aircraft north of the house, nearer the front bedroom. */
  const bothClosed = (prior: FloorPlanPrior, extra: Partial<BeliefSnapshot> = {}): BeliefSnapshot => {
    const rear = openingSeen("window-rear", "closed", T_OUTSIDE - 10, "obs-rear");
    const front = openingSeen("window-front", "closed", T_OUTSIDE - 10, "obs-front");
    return outsideBelief({ mapPrior: prior, reports: [], pose: { ...outsideBelief().pose, position: vec3(2.5, 12, 4.4) }, observations: [rear.observation, front.observation], openings: [rear.evidence, front.evidence], ...extra });
  };
  const doorClosed: FloorPlanPrior = { ...HOUSE, openings: HOUSE.openings.map(o => (o.id === "door-front-hall" ? { ...o, priorState: "closed" as const } : o)) };

  test("a nearer window into a room only closed doors lead out of ranks below a farther one into a connected room", () => {
    assert.equal(rankedBreaches(plan(bothClosed(HOUSE)))[0], "request_breach:window-front", "with both doors open the nearer window wins");
    assert.deepEqual(rankedBreaches(plan(bothClosed(doorClosed))), ["request_breach:window-rear", "request_breach:window-front"]);
  });

  test("a possible occupant in the reported room moves the breach to a connected neighbour; without one the reported room is preferred", () => {
    const report = { reports: [REPORT], pose: outsideBelief().pose };
    assert.equal(rankedBreaches(plan(bothClosed(HOUSE, report)))[0], "request_breach:window-rear");
    // In the rear bedroom but clear of the window's debris region: the window is offered, and ranked down.
    const occupant: OccupantTrack = { ...TRACK, position: vec3(0.3, 0.5, 3.5), uncertaintyM: 0.1, observationIds: [] };
    const result = plan(bothClosed(HOUSE, { ...report, tracks: [occupant] }));
    assert.deepEqual(rankedBreaches(result), ["request_breach:window-front", "request_breach:window-rear"]);
  });

  test("an observed open entry still outranks the best-placed window", () => {
    const open = openingSeen("door-front", "open", T_OUTSIDE - 20);
    const closed = bothClosed(HOUSE, { reports: [REPORT] });
    const result = plan({ ...closed, observations: [...closed.observations, open.observation], openings: [...closed.openings, open.evidence] });
    assert.equal(result.ranked[0].tool, "inspect_room");
  });

  test("size-up: a look at a better-placed unobserved window ranks above the nearer observed breach", () => {
    const front = openingSeen("window-front", "closed", T_OUTSIDE - 10, "obs-front");
    const belief = outsideBelief({ pose: { ...outsideBelief().pose, position: vec3(2.5, 12, 4.4) }, observations: [front.observation], openings: [front.evidence] });
    const result = plan(belief);
    assert.equal(result.choiceId, "inspect_room:bedroom-rear:window-rear");
    const look = result.ranked.find(r => r.id === result.choiceId)?.score;
    const breach = result.ranked.find(r => r.id === "request_breach:window-front")?.score;
    assert.ok(look && breach);
    assert.equal(look.total, round(breach.total + PLANNER_WEIGHTS.sizeUpLead), "lifted just above the breach it might replace");
    assert.equal(look.total, round(look.base + look.report + look.newObservation + look.evidenceAge + look.adjustment - look.travel), "the lift is part of the adjustment");
    // Once the rear window is observed closed, its breach wins and the look is gone.
    const rear = openingSeen("window-rear", "closed", T_OUTSIDE - 5, "obs-rear");
    assert.equal(plan({ ...belief, observations: [...belief.observations, rear.observation], openings: [...belief.openings, rear.evidence] }).choiceId, "request_breach:window-rear");
  });

  test("breach access and notes travel as plain data: a cloned set ranks exactly like the original", () => {
    const belief = bothClosed(doorClosed);
    const set = build(belief);
    assert.ok(set.candidates.every(c => c.target === null || (c.tool === "request_breach") === (c.target.access !== null)), "only breach targets carry access");
    const clone = JSON.parse(JSON.stringify(set)) as CandidateSet;
    assert.deepEqual(clone.notes, set.notes);
    assert.deepEqual(rankCandidates(clone, belief).ranked, rankCandidates(set, belief).ranked);
    // Without the access data the closed-in window would win on distance: the ranking above depends on it.
    const stripped: CandidateSet = { ...clone, candidates: clone.candidates.map(c => (c.target === null ? c : { ...c, target: { ...c.target, access: null } })) as CandidateSet["candidates"] };
    assert.equal(rankedBreaches(rankCandidates(stripped, belief))[0], "request_breach:window-front");
  });
});
