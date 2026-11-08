/**
 * Presenter logic: the pacing badge's wording at its boundaries, and the judge-challenge point. The challenge
 * tests use the harness's own affected-region derivation and the harness test house, so "inside the region"
 * means inside what the harness will check, not a copy of it.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import { TENDER_T1 } from "../../lib/contracts/aircraft.ts";
import type { FloorPlanPrior } from "../../lib/contracts/evidence.ts";
import { vec3 } from "../../lib/contracts/frames.ts";
import type { Region } from "../../lib/contracts/geometry.ts";
import { box, pointInPolygon, regionContains, sphere } from "../../lib/contracts/geometry.ts";
import { affectedRegion } from "../../lib/harness/effects.ts";
import { FLOOR_PLAN, SPRAY_AIM, SPRAY_STANDOFF, sprayAction } from "../../lib/harness/test-fixtures.ts";
import type { MissionView } from "../../lib/mission/protocol.ts";
import { BODY_HEIGHTS_M, WALL_CLEARANCE_M, challengePoint, challengeTarget, decisionSummary, pacingLabel, trackMethodsText } from "./presenter.ts";

describe("pacingLabel", () => {
  const running = { source: "worker" as const, status: "running" as const, setSpeed: 4 };

  test("an accelerated run says so and states that it is not real-world response time", () => {
    const label = pacingLabel({ ...running, ratio: 3.96 });
    assert.equal(label.tone, "accelerated");
    assert.equal(label.text, "Simulated ×4.0");
    assert.match(label.detail, /not real-world response time/);
  });

  test("a run slower than the wall clock says so even when a faster pace was requested", () => {
    const label = pacingLabel({ ...running, ratio: 0.42 });
    assert.equal(label.tone, "slow");
    assert.match(label.text, /slower than real time/);
    assert.match(label.text, /0\.42/);
    assert.match(label.detail, /Requested pace 4×/);
  });

  test("ratios inside the tolerance read as about real time; just outside do not", () => {
    assert.equal(pacingLabel({ ...running, ratio: 1.04 }).tone, "real");
    assert.equal(pacingLabel({ ...running, ratio: 0.96 }).tone, "real");
    assert.equal(pacingLabel({ ...running, ratio: 1.06 }).tone, "accelerated");
    assert.equal(pacingLabel({ ...running, ratio: 0.94 }).tone, "slow");
  });

  test("unmeasured, stalled, paused and finished runs never claim a pace", () => {
    assert.equal(pacingLabel({ ...running, ratio: null }).tone, "unknown");
    assert.equal(pacingLabel({ ...running, ratio: Number.NaN }).tone, "unknown");
    assert.equal(pacingLabel({ ...running, ratio: 0 }).tone, "stopped");
    assert.equal(pacingLabel({ ...running, status: "paused", ratio: 4 }).tone, "stopped");
    assert.equal(pacingLabel({ ...running, status: "ended", ratio: 4 }).tone, "stopped");
  });

  test("an aborted run still reports its measured pace while the contingency flies the drone home", () => {
    // The runtime keeps stepping after an abort until the run is scored (MissionRuntime.advancing), so the badge
    // must not claim the clock has stopped.
    const returning = pacingLabel({ ...running, status: "aborted", ratio: 1.2 });
    assert.equal(returning.tone, "accelerated");
    assert.match(returning.detail, /^Mission aborted: simulated time continues while the contingency returns the drone\./);
    assert.doesNotMatch(returning.text, /stopped/);
    assert.equal(pacingLabel({ ...running, status: "aborted", ratio: 0 }).tone, "stopped", "a stalled clock still reads as not advancing");
  });

  test("the UI fixture is never presented as simulated time", () => {
    const label = pacingLabel({ source: "fixture", status: "running", setSpeed: 1, ratio: 1 });
    assert.match(label.text, /UI fixture/);
    assert.doesNotMatch(label.text, /×/);
  });
});

const HARNESS_SPRAY = affectedRegion(sprayAction(), TENDER_T1, FLOOR_PLAN);

function assertStandingPersonInside(prior: FloorPlanPrior, region: Region, point: NonNullable<ReturnType<typeof challengePoint>>) {
  const floor = prior.floors.find(f => f.elevationM === point.position.z);
  assert.ok(floor, "the person stands on a known floor");
  const room = prior.rooms.find(r => r.id === point.roomId);
  assert.ok(room && room.floor === floor.index, "the room is on that floor");
  for (const [dx, dy] of [[WALL_CLEARANCE_M, 0], [-WALL_CLEARANCE_M, 0], [0, WALL_CLEARANCE_M], [0, -WALL_CLEARANCE_M]]) {
    assert.ok(pointInPolygon(point.position.x + dx, point.position.y + dy, room.polygon), "clear of the room outline");
  }
  assert.ok(point.heightsInRegionM.length > 0);
  for (const h of point.heightsInRegionM) assert.ok(regionContains(region, vec3(point.position.x, point.position.y, point.position.z + h)));
}

describe("challengePoint", () => {
  test("puts a standing person inside the harness's own spray region, in the hallway under the jet", () => {
    assert.ok(HARNESS_SPRAY);
    const point = challengePoint(FLOOR_PLAN, HARNESS_SPRAY, SPRAY_STANDOFF, SPRAY_AIM);
    assert.ok(point);
    assert.equal(point.roomId, "hallway");
    assert.equal(point.position.z, 3);
    assertStandingPersonInside(FLOOR_PLAN, HARNESS_SPRAY, point);
  });

  test("falls back to sampling the region when the spray line itself crosses no room", () => {
    // The line runs outside the house (y = -3); only the region's far end reaches into the kitchen.
    const region = box(vec3(5, -3, 0), vec3(8, 1, 2));
    const point = challengePoint(FLOOR_PLAN, region, vec3(5, -3, 1), vec3(8, -3, 1));
    assert.ok(point);
    assert.equal(point.method, "region_sample");
    assertStandingPersonInside(FLOOR_PLAN, region, point);
  });

  test("returns null when no standing body can overlap the region", () => {
    // Inside the hallway but entirely between 2.0 and 2.2 m above its floor: above a person's head.
    const overhead = box(vec3(5, 0.5, 5.0), vec3(9, 1.5, 5.2));
    assert.equal(challengePoint(FLOOR_PLAN, overhead, vec3(5, 1, 5.1), vec3(9, 1, 5.1)), null);
    // Entirely outside the house.
    const outside = sphere(vec3(20, 10, 1), 1);
    assert.equal(challengePoint(FLOOR_PLAN, outside, vec3(19, 10, 1), vec3(21, 10, 1)), null);
  });

  test("samples body heights up to a standing adult only", () => {
    assert.ok(Math.max(...BODY_HEIGHTS_M) <= 1.8);
    assert.ok(Math.min(...BODY_HEIGHTS_M) > 0);
  });
});

function record(id: string, status: ProposalStatus, kind: "spray" | "breach" = "spray"): ProposalRecord {
  const action = kind === "spray" ? sprayAction() : { kind: "breach_opening" as const, openingId: "window-rear", standoff: vec3(-0.4, 2, 4.2), strikePoint: vec3(-0.05, 2, 4.2) };
  return { proposal: { id, action }, risk: "consequential", status, approval: null, execution: null, findings: [], history: [] } as unknown as ProposalRecord;
}

function view(status: MissionView["status"], records: readonly ProposalRecord[], regions: MissionView["affectedRegions"]) {
  return { status, proposals: records, affectedRegions: regions, belief: { mapPrior: FLOOR_PLAN } } as unknown as Pick<MissionView, "status" | "proposals" | "affectedRegions" | "belief">;
}

describe("challengeTarget", () => {
  const region = HARNESS_SPRAY as Region;

  for (const status of ["awaiting_approval", "approved", "executing"] as const) {
    test(`is available while the spray is ${status}`, () => {
      const target = challengeTarget(view("running", [record("p-spray", status)], [{ proposalId: "p-spray", region }]));
      assert.equal(target.available, true);
      if (target.available) assert.equal(target.proposalStatus, status);
    });
  }

  test("is unavailable for completed, rejected, invalidated or expired sprays and for other interventions", () => {
    for (const status of ["completed", "rejected", "invalidated", "expired", "aborted"] as const) {
      assert.equal(challengeTarget(view("running", [record("p", status)], [{ proposalId: "p", region }])).available, false, status);
    }
    const breach = record("p-breach", "awaiting_approval", "breach");
    assert.equal(challengeTarget(view("running", [breach], [{ proposalId: "p-breach", region: sphere(vec3(0, 2, 4.2), 1.5) }])).available, false);
  });

  test("is unavailable once the run is over, even with an approved spray", () => {
    assert.equal(challengeTarget(view("aborted", [record("p", "approved")], [{ proposalId: "p", region }])).available, false);
    assert.equal(challengeTarget(view("ended", [record("p", "approved")], [{ proposalId: "p", region }])).available, false);
  });

  test("never guesses a region the harness did not report", () => {
    const target = challengeTarget(view("running", [record("p", "awaiting_approval")], []));
    assert.equal(target.available, false);
    if (!target.available) assert.match(target.reason, /no affected region/);
  });

  test("targets the most recent challengeable spray", () => {
    const target = challengeTarget(view("running", [record("p-old", "invalidated"), record("p-new", "awaiting_approval")], [{ proposalId: "p-old", region }, { proposalId: "p-new", region }]));
    assert.equal(target.available && target.proposalId, "p-new");
  });
});

describe("wording", () => {
  test("track methods name each method and an empty list reads as unknown, not absent", () => {
    assert.equal(trackMethodsText({ detectionMethods: ["oracle_fixture", "thermal_blob"], provenances: ["simulated_sensor"] }), "Detected by oracle fixture, thermal blob detector; from simulated sensor frames");
    assert.match(trackMethodsText({ detectionMethods: [], provenances: [] }), /unknown/);
  });

  test("decision summary takes the reason recorded with the current status and the water actually discharged", () => {
    const base = record("p", "invalidated");
    const decided = {
      ...base,
      history: [
        { tick: 1, status: "approved", reason: "Commander approved.", ruleIds: [] },
        { tick: 2, status: "invalidated", reason: "Possible person inside the affected region.", ruleIds: ["H5"] },
      ],
      execution: { proposalId: "p", startedTick: 2, endedTick: 3, requestIds: [], effects: { waterDischargedL: 0.12, strikeDelivered: false, payloadReleased: false }, stopReason: "invalidated" },
    } as unknown as ProposalRecord;
    assert.deepEqual(decisionSummary(decided), { reason: "Possible person inside the affected region.", ruleIds: ["H5"], dischargedL: 0.12 });
    assert.deepEqual(decisionSummary(base), { reason: null, ruleIds: [], dischargedL: null });
  });
});
