/**
 * Rule-level behaviour of the harness: affected-region derivation and individual rules evaluated through
 * validateProposal, without the lifecycle. Scope: deterministic fixtures from test-fixtures.ts only.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionProposal, Finding, ProposalInput } from "../contracts/actions.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Observation } from "../contracts/observation.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { digestOf } from "../contracts/canonical.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { box, distanceToRegion, regionContains, sector, sphere, union } from "../contracts/geometry.ts";
import { AIRFRAME_BAND_M, coverageOf, occupiable, PERSON_STANDING_HEIGHT_M, requiredSamples } from "./coverage.ts";
import { affectedRegion, jetReactionN, sprayDoseL } from "./effects.ts";
import { localizationSupportsAdvance } from "./motion-guard.ts";
import type { HarnessContext } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import type { RuleState, ValidationPhase } from "./rules.ts";
import { breachCoverageAssessment, validateProposal } from "./rules.ts";
import { ActionHarness } from "./harness.ts";
import { EventLog } from "../contracts/events.ts";
import {
  breachBelief,
  breachInput,
  contingencyHoldInput,
  coverageObservation,
  EVAC_ROUTE_ID,
  evacuationRoute,
  FIRE_OBS_ID,
  fireHazard,
  FLOOR_PLAN,
  guideInput,
  HALLWAY_INTERIOR,
  HALLWAY_VIEW,
  makeBelief,
  makeContext,
  moveInput,
  observation,
  occupantTrack,
  openingEvidence,
  PERSON_IN_SECTOR,
  personDetection,
  personObservation,
  proposalInput,
  RETURN_ROUTE_ID,
  returnRoute,
  routeObservation,
  RUN_ID,
  SPRAY_AIM,
  SPRAY_STANDOFF,
  sprayBelief,
  sprayInput,
  T0,
  WINDOW_VIEW,
} from "./test-fixtures.ts";

function check(phase: ValidationPhase, input: ProposalInput, ctx: HarnessContext, state: Partial<RuleState> = {}): Finding[] {
  const proposal: ActionProposal = { ...input, id: `${input.runId}/p1`, digest: digestOf(input) };
  return validateProposal({ phase, proposal, ctx, state: { runId: RUN_ID, missionAborted: false, lastInterventionTick: null, sprays: [], ...state }, status: "proposed", approval: null });
}

function ruleIds(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map(f => f.ruleId))].sort();
}

describe("modeled intervention effects", () => {
  test("Tender T1's maximum jet matches the profile's documented reaction (about 3.2 N) and dose is flow × time", () => {
    assert.ok(Math.abs(jetReactionN(0.2, 4) - 3.18) < 0.01);
    const spray = sprayInput().action;
    assert.ok(spray.kind === "spray" && Math.abs(sprayDoseL(spray) - 0.6) < 1e-12);
  });

  test("the discharge sector reaches where the jet lands beyond the aim point, not just the aim point", () => {
    const floors = [{ index: 0, elevationM: 0, ceilingM: 2.8 }, { index: 1, elevationM: 3, ceilingM: 5.6 }];
    const region = affectedRegion(sprayInput().action, TENDER_T1, floors);
    assert.ok(region && region.kind === "sector");
    assert.ok(regionContains(region, SPRAY_AIM));
    // Standing on the floor 1.2 m past the fire, in line with the jet: the cone's shallow rays land there,
    // so the person must be inside the checked region (an aim + 0.5 m region would have missed them).
    assert.ok(regionContains(region, vec3(SPRAY_AIM.x + 1.2, SPRAY_AIM.y, 3.05)));
    assert.ok(!regionContains(region, vec3(SPRAY_STANDOFF.x - 0.5, SPRAY_STANDOFF.y, SPRAY_STANDOFF.z)), "nothing behind the nozzle");
  });

  test("a steep spray's region ends where its shallowest ray lands, short of the full jet range", () => {
    const floors = [{ index: 1, elevationM: 3, ceilingM: 5.6 }];
    const steep = sprayInput({}, { aimPoint: vec3(SPRAY_STANDOFF.x + 1, SPRAY_STANDOFF.y, SPRAY_STANDOFF.z - 1) }).action;
    const along = (m: number) => vec3(SPRAY_STANDOFF.x + m / Math.SQRT2, SPRAY_STANDOFF.y, SPRAY_STANDOFF.z - m / Math.SQRT2);
    const bounded = affectedRegion(steep, TENDER_T1, floors);
    const unbounded = affectedRegion(steep, TENDER_T1);
    assert.ok(bounded && unbounded);
    // 45° down from 1.2 m above the floor: the ray 8° shallower lands about 2.0 m out; plus 0.5 m splash.
    assert.ok(regionContains(bounded, along(2.4)) && !regionContains(bounded, along(2.6)));
    // Without a known floor the full 4 m jet range is assumed.
    assert.ok(regionContains(unbounded, along(3.9)) && !regionContains(unbounded, along(4.1)));
  });

  test("an aim point on the nozzle has no derivable region and is refused rather than assumed safe", () => {
    const input = sprayInput({}, { aimPoint: SPRAY_STANDOFF });
    assert.equal(affectedRegion(input.action, TENDER_T1), null);
    const findings = check("submit", input, makeContext(sprayBelief(T0)));
    assert.ok(findings.some(f => f.ruleId === "H6") && findings.some(f => f.ruleId === "H2"));
  });
});

describe("standard fixtures are valid baselines", () => {
  test("the standard spray, breach and move pass every submission rule", () => {
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0))), []);
    assert.deepEqual(check("submit", breachInput(), makeContext(breachBelief(T0))), []);
    assert.deepEqual(check("submit", moveInput(vec3(8, 1, 4.2)), makeContext(sprayBelief(T0))), []);
  });
});

describe("H6 possible persons", () => {
  test("a later adequate look that sees no one there clears an earlier detection; a later poor look does not", () => {
    const detection = personObservation("obs-person-1", T0 - 50);
    const blocked = check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: T0 - 60, extraObservations: [detection, coverageObservation(T0 - 5)] })));
    assert.deepEqual(blocked.filter(f => f.ruleId === "H6"), [], "a later quality-0.9 frame over the position clears it");

    // Below minCoverageQuality (0.3): a frame unusable as a whole clears nothing.
    const poorLater = observation("obs-later-poor", T0 - 5, HALLWAY_VIEW, { quality: 0.2, modality: "thermal" });
    const stillBlocked = check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: T0 - 60, extraObservations: [detection, poorLater] })));
    const h6 = stillBlocked.filter(f => f.ruleId === "H6");
    assert.ok(h6.some(f => f.evidenceIds?.includes("obs-person-1")), JSON.stringify(stillBlocked));
  });

  test("a later frame that again detects a person near the position does not clear it", () => {
    const first = personObservation("obs-person-1", T0 - 50);
    const again = personObservation("obs-person-2", T0 - 5, vec3(PERSON_IN_SECTOR.x + 0.3, PERSON_IN_SECTOR.y, PERSON_IN_SECTOR.z));
    const findings = check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: T0 - 60, extraObservations: [first, again] })));
    const blocking = findings.filter(f => f.ruleId === "H6").flatMap(f => f.evidenceIds ?? []);
    assert.ok(blocking.includes("obs-person-1") && blocking.includes("obs-person-2"));
  });

  test("detections below the confidence threshold do not block; a person just outside the region but within the margin does", () => {
    const faint = personObservation("obs-faint", T0 - 2, PERSON_IN_SECTOR, 0.1);
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { extraObservations: [faint] }))), []);
    // 1.2 m to the side of the sector axis: outside the 8° cone but within uncertainty 0.5 + margin 1.0.
    const beside = personObservation("obs-beside", T0 - 2, vec3(6.5, 2.4, 3.8));
    assert.ok(check("submit", sprayInput(), makeContext(sprayBelief(T0, { extraObservations: [beside] }))).some(f => f.ruleId === "H6"));
    const farAway = personObservation("obs-far", T0 - 2, vec3(2, 2, 3.9));
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { extraObservations: [farAway] }))), []);
  });

  test("a possible-occupant track near the region blocks with its observations; a retracted track does not", () => {
    const near = occupantTrack(T0 - 3, { position: vec3(6.2, 1, 4), observationIds: ["obs-track-a"] });
    const findings = check("submit", sprayInput(), makeContext(sprayBelief(T0, { tracks: [near] })));
    assert.ok(findings.some(f => f.ruleId === "H6" && f.evidenceIds?.includes("obs-track-a")));
    const retracted = { ...near, status: "retracted" as const };
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { tracks: [retracted] }))), []);
  });

  test("a later frame with no person detector (personSearch null) neither clears an earlier detection nor counts as coverage", () => {
    const detection = personObservation("obs-person-1", T0 - 50);
    // 20 ms after the thermal detection, a high-quality RGB frame and a lidar sweep cover the same place with no person detector.
    const unsearched = [
      observation("obs-rgb-unsearched", T0 - 48, HALLWAY_VIEW, { modality: "rgb", quality: 0.95, personSearch: null }),
      observation("obs-lidar", T0 - 48, HALLWAY_VIEW, { modality: "lidar", quality: 0.95, personSearch: null }),
    ];
    const stillBlocked = check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: T0 - 60, extraObservations: [detection, ...unsearched] })));
    assert.ok(stillBlocked.some(f => f.ruleId === "H6" && f.evidenceIds?.includes("obs-person-1")), JSON.stringify(stillBlocked));
    const uncovered = check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: unsearched })));
    assert.deepEqual(ruleIds(uncovered), ["H6"]);

    // Control: the same RGB frame with a person detector applied both covers the region and clears the detection.
    const searched = observation("obs-rgb-searched", T0 - 48, HALLWAY_VIEW, { modality: "rgb", quality: 0.95, personSearch: "image_detector" });
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [searched] }))), []);
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: T0 - 60, extraObservations: [detection, searched] }))), []);
  });

  test("the occupant in the bedroom blocks neither the hallway spray nor the window breach", () => {
    const tracks = [occupantTrack(T0 - 3)];
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { tracks }))), []);
    assert.deepEqual(check("submit", breachInput(), makeContext(breachBelief(T0, { tracks }))), []);
  });
});

describe("H6 coverage of occupiable space", () => {
  const searchOf = (id: string, footprint: Region) => observation(id, T0 - 5, footprint, { modality: "thermal" });
  const regionOf = (input: ProposalInput): Region => {
    const region = affectedRegion(input.action, TENDER_T1);
    if (!region) throw new Error(`no affected region for ${input.action.kind}`);
    return region;
  };

  test("the standard hallway spray reaches the threshold when a person search sees the hallway interior up to its walls", () => {
    const ctx = makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [searchOf("obs-hallway-search", HALLWAY_INTERIOR)] }));
    const coverage = coverageOf(regionOf(sprayInput()), ctx);
    assert.ok(coverage.fraction >= DEFAULT_POLICY.minCoverageFraction, String(coverage.fraction));
    assert.ok(coverage.excludedSamples > 0, "wall, slab and beyond-slab samples were not required");
    assert.deepEqual(coverage.observationIds, ["obs-hallway-search"]);
    assert.deepEqual(check("submit", sprayInput(), ctx), []);
  });

  test("a person search that misses a pocket of occupiable space behind furniture still refuses the spray", () => {
    // The hallway interior minus a low pocket south of the fire (x 6.5–8.5, y 0–0.8, z 3.0–3.8).
    const pocketMissed = union([
      box(vec3(4.06, 0, 3), vec3(6.5, 1.94, 5.6)),
      box(vec3(8.5, 0, 3), vec3(9.94, 1.94, 5.6)),
      box(vec3(6.5, 0.8, 3), vec3(8.5, 1.94, 5.6)),
      box(vec3(6.5, 0, 3.8), vec3(8.5, 0.8, 5.6)),
    ]);
    const ctx = makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [searchOf("obs-partial-search", pocketMissed)] }));
    assert.ok(coverageOf(regionOf(sprayInput()), ctx).fraction < DEFAULT_POLICY.minCoverageFraction);
    const findings = check("submit", sprayInput(), ctx);
    assert.deepEqual(ruleIds(findings), ["H6"]);
    assert.match(findings[0].reason, /occupiable/);
  });

  test("points inside walls, inside the slab, in the roof space or below ground are not occupiable; rooms on another floor are beyond a slab", () => {
    const upperFloor = 4.2;
    const at = (x: number, y: number, z: number, levelZ = upperFloor) => occupiable(vec3(x, y, z), FLOOR_PLAN, DEFAULT_POLICY.wallClearanceM, levelZ);
    assert.equal(at(6, 1, 4), true, "hallway interior");
    assert.equal(at(6, 3, 4), true, "bathroom: same floor, so it still needs coverage although it is behind a wall");
    assert.equal(at(6, 2, 4), false, "wall between hallway and bathroom");
    assert.equal(at(6, -0.2, 4), false, "exterior wall");
    assert.equal(at(6, 1, 2.9), false, "inside the slab");
    assert.equal(at(6, 1, 6), false, "roof space above the hallway ceiling");
    assert.equal(at(5, 1, 2), false, "living room below the slab, for an action on the upper floor");
    assert.equal(at(5, 1, 2, 1.5), true, "the same point for an action on the ground floor");
    assert.equal(at(6, -1, 1), true, "open exterior beyond the wall clearance, where a person can stand");
    assert.equal(at(6, -1, 4), false, "open air above standing height: the prior has nothing outside to stand on");
    assert.equal(at(6, -1, -0.5), false, "below ground");
  });

  test("when no sample is occupiable, coverage cannot be established and the action is refused, never passed", () => {
    const breaker = TENDER_T1.modules.glassBreaker;
    assert.ok(breaker);
    // A pinpoint debris region with no margin, in the exterior wall zone beside the window; the opening is
    // missing from this prior, so the fallback region (a pinpoint sphere and its column) stays in the wall zone.
    const pinpoint = { ...TENDER_T1, modules: { ...TENDER_T1.modules, glassBreaker: { ...breaker, debrisRadiusM: 0.01 } } };
    const prior = { ...FLOOR_PLAN, openings: FLOOR_PLAN.openings.filter(o => o.id !== "window-rear") };
    const ctx = makeContext({ ...breachBelief(T0), mapPrior: prior }, { profile: pinpoint, policy: { ...DEFAULT_POLICY, coverageMarginM: 0 } });
    const region = affectedRegion(breachInput().action, pinpoint, prior);
    assert.ok(region);
    assert.equal(coverageOf(region, ctx, [], true).samples, 0);
    const findings = check("submit", breachInput(), ctx);
    assert.ok(findings.some(f => f.ruleId === "H6" && /cannot be established/.test(f.reason)), JSON.stringify(findings));
  });
});

describe("breach debris: an inward cone, the fall volume under it and a fall strip along the facade", () => {
  const breaker = TENDER_T1.modules.glassBreaker;
  if (!breaker) throw new Error("Tender T1 has a glass breaker");
  const searchOf = (id: string, footprint: Region) => observation(id, T0 - 5, footprint, { modality: "rgb", personSearch: "image_detector" });
  const ctxWith = (...footprints: Region[]) => makeContext(breachBelief(T0, { coverageTick: null, extraObservations: footprints.map((f, i) => searchOf(`obs-breach-search-${i}`, f)) }));
  const breachRegionOf = (): Region => {
    const region = affectedRegion(breachInput().action, TENDER_T1, FLOOR_PLAN);
    if (!region) throw new Error("no breach region");
    return region;
  };
  const camera = vec3(-0.4, 2, 4.2); // the breach standoff, where the forward camera looks in through the pane
  // The forward camera's view through the 1 × 1.2 m pane at x = 0: the frustum |y − 2| ≤ 0.5 + 1.25x,
  // |z − 4.2| ≤ 0.6 + 1.5x, as inscribed 5 cm slabs (it sees no more than the pane allows), plus the
  // approach between the camera and the pane.
  const THROUGH_WINDOW = union([
    sector(camera, vec3(1, 0, 0), Math.atan2(0.5, 0.4), 0.45),
    ...Array.from({ length: 52 }, (_, i) => {
      const x0 = i * 0.05;
      const hy = 0.5 + 1.25 * x0;
      const hz = 0.6 + 1.5 * x0;
      return box(vec3(x0, 2 - hy, 4.2 - hz), vec3(x0 + 0.05, 2 + hy, 4.2 + hz));
    }),
  ]);
  // The downward camera (110° × 90°) hovering at the standoff: the part of its view pyramid outside the wall
  // up to standing height (at 2 m below the camera it already spans x ±2.9 m, y ±2 m).
  const DOWNWARD = box(vec3(-2, 0, -0.5), vec3(-0.3, 4, 2.2));

  test("a possible person inside, 1 m in front of the pane within the debris cone, blocks the breach", () => {
    const inside = observation("obs-person-inside", T0 - 1, null, { modality: "thermal", detections: [personDetection(vec3(0.95, 2, 4.2), 0.7, 0.5)] });
    const findings = check("submit", breachInput(), makeContext(breachBelief(T0, { extraObservations: [inside] })));
    assert.deepEqual(ruleIds(findings), ["H6"]);
    assert.ok(regionContains(breachRegionOf(), vec3(0.95, 2, 4.2)));
  });

  test("the region is directional: the cone points into the room, the fall volume stops at the bedroom floor and the strip at the facade", () => {
    const region = breachRegionOf();
    assert.ok(region.kind === "union" && region.parts[0].kind === "sector");
    assert.deepEqual(region.parts[0].axis, vec3(1, 0, 0), "inward: the reverse of the window's outward normal");
    assert.ok(regionContains(region, vec3(1.2, 2, 3.05)), "inside: down to the bedroom floor under the cone");
    assert.ok(!regionContains(region, vec3(1.2, 2, 1.5)), "inside it does not fall through the slab");
    assert.ok(regionContains(region, vec3(-0.5, 2.7, 0.05)), "outside: the strip reaches the ground, 0.3 m past the frame");
    assert.ok(!regionContains(region, vec3(-0.8, 2, 0.05)), "the strip is 0.6 m deep");
    assert.ok(!regionContains(region, vec3(0.2, 3.2, 4.2)), "the inner wall beside the frame is outside the cone");
  });

  test("the coverage requirement no longer includes the inner wall beside the frame, which the wall hides from the striker's side", () => {
    const action = breachInput().action;
    assert.ok(action.kind === "breach_opening");
    const ctx = ctxWith(THROUGH_WINDOW);
    // Inside the room, beyond the sight lines from the standoff through the pane edges (with 10 cm to spare).
    const besideFrame = (p: Vec3) => p.x > 0 && p.x < 0.5 && Math.abs(p.y - 2) > 0.6 + 1.25 * p.x && p.z > 3 && p.z < 5.6;
    const required = requiredSamples(breachRegionOf(), ctx, [action.openingId], true, action.standoff).points;
    assert.ok(required.length > 0);
    assert.deepEqual(required.filter(besideFrame), []);
    // The former debris sphere, reached from the strike point, did require it.
    const formerSphere = requiredSamples(sphere(action.strikePoint, breaker.debrisRadiusM), ctx, [action.openingId]).points;
    assert.ok(formerSphere.filter(besideFrame).length > 10);
  });

  // The through-window frustum only as far as `depthM` into the room.
  const throughTo = (depthM: number) => union([
    sector(camera, vec3(1, 0, 0), Math.atan2(0.5, 0.4), 0.45),
    ...Array.from({ length: Math.round(depthM / 0.05) }, (_, i) => {
      const x0 = i * 0.05;
      return box(vec3(x0, 2 - (0.5 + 1.25 * x0), 4.2 - (0.6 + 1.5 * x0)), vec3(x0 + 0.05, 2 + 0.5 + 1.25 * x0, 4.2 + 0.6 + 1.5 * x0));
    }),
  ]);
  const DOWNWARD_QUARTER = box(vec3(-2, 0, -0.5), vec3(-0.3, 1.5, 2.2)); // the downward view of one end of the strip only
  const assessmentOf = (ctx: HarnessContext) => {
    const action = breachInput().action;
    assert.ok(action.kind === "breach_opening");
    return breachCoverageAssessment(action, breachRegionOf(), ctx);
  };

  test("a breach with about 80% of its debris region searched is accepted, and the commander is told which parts are unseen", () => {
    const ctx = ctxWith(THROUGH_WINDOW, DOWNWARD_QUARTER);
    const assessment = assessmentOf(ctx);
    assert.ok(assessment.fraction >= DEFAULT_POLICY.breachMinCoverageFraction && assessment.fraction < 0.85, String(assessment.fraction));
    assert.deepEqual(check("submit", breachInput(), ctx), []);
    assert.deepEqual(assessment.unseen.map(g => g.place).sort(), ["inside beside the frame", "inside under the sill", "outside at the wall base"]);
    // The disclosure reaches the commander with the proposal.
    const harness = new ActionHarness(RUN_ID, new EventLog(RUN_ID));
    const submitted = harness.submit(breachInput(), ctx);
    assert.equal(submitted.status, "awaiting_approval");
    const reason = harness.record(submitted.proposalId ?? "")?.history.at(-1)?.reason ?? "";
    assert.match(reason, /Debris region coverage: 7\d(\.\d)?% of \d+ required samples/);
    assert.match(reason, /Unseen: outside at the wall base \(\d+\), inside beside the frame \(\d+\), inside under the sill \(\d+\)\./);
  });

  test("a breach with less of its debris region searched than the policy requires is refused with 'look first' and the unseen parts named", () => {
    // About 65% searched, judged against a stricter 75% floor so the case does not sit on the default's edge.
    const strict = { ...DEFAULT_POLICY, breachMinCoverageFraction: 0.75 };
    const ctx = { ...ctxWith(throughTo(1), DOWNWARD), policy: strict };
    const assessment = assessmentOf(ctx);
    assert.ok(assessment.fraction > 0.55 && assessment.fraction < strict.breachMinCoverageFraction, String(assessment.fraction));
    const findings = check("submit", breachInput(), ctx);
    assert.deepEqual(ruleIds(findings), ["H6"]);
    assert.match(findings[0].reason, /75% is required for a breach: look first/);
    assert.match(findings[0].reason, /Unseen: inside in front of the pane \(\d+\)/);
  });

  test("a through-window view plus a downward view of the strip covers all but the frame pockets", () => {
    const assessment = assessmentOf(ctxWith(THROUGH_WINDOW, DOWNWARD));
    assert.ok(assessment.fraction >= 0.95, String(assessment.fraction));
    assert.deepEqual(assessment.unseen.map(g => g.place).sort(), ["inside beside the frame", "inside under the sill"]);
  });

  test("a possible occupant still blocks a breach whatever the coverage", () => {
    const occupant = observation("obs-person-cone", T0 - 1, null, { modality: "thermal", detections: [personDetection(vec3(1.2, 2.4, 3.9), 0.4, 0.5)] });
    const ctx = makeContext(breachBelief(T0, { coverageTick: null, extraObservations: [observation("obs-full", T0 - 5, WINDOW_VIEW, { modality: "thermal" }), occupant] }));
    assert.equal(assessmentOf(ctx).fraction, 1);
    assert.deepEqual(ruleIds(check("submit", breachInput(), ctx)), ["H6"]);
  });

  test("review: a possible person detected in the unseen part under the sill blocks the breach", () => {
    const underSill = vec3(0.3, 2, 3.2);
    const ctxFor = (extra: Observation[]) => makeContext(breachBelief(T0, {
      coverageTick: null,
      extraObservations: [observation("obs-through", T0 - 5, THROUGH_WINDOW, { modality: "rgb", personSearch: "image_detector" }), observation("obs-down", T0 - 5, DOWNWARD_QUARTER, { modality: "rgb", personSearch: "image_detector" }), ...extra],
    }));
    const baseline = ctxFor([]);
    assert.deepEqual(check("submit", breachInput(), baseline), [], "accepted at about 80% while nobody is seen");
    const action = breachInput().action;
    assert.ok(action.kind === "breach_opening");
    const unseen = coverageOf(breachRegionOf(), baseline, [action.openingId], true, action.standoff).uncovered;
    assert.ok(unseen.some(p => Math.hypot(p.x - underSill.x, p.y - underSill.y, p.z - underSill.z) < 0.3), "the place is in the unseen part");
    const glimpse = observation("obs-glimpse", T0 - 1, null, { modality: "thermal", detections: [personDetection(underSill, 0.5, 0.3)] });
    const findings = check("submit", breachInput(), ctxFor([glimpse]));
    assert.deepEqual(ruleIds(findings), ["H6"]);
    assert.ok(findings.some(f => f.evidenceIds?.includes("obs-glimpse")));
  });

  test("the target opening must have been observed within the coverage freshness window", () => {
    const stale = makeContext(breachBelief(T0, { openings: [openingEvidence(T0 - DEFAULT_POLICY.coverageFreshTicks - 1)] }));
    const findings = check("submit", breachInput(), stale);
    assert.ok(findings.some(f => f.ruleId === "H6" && /look at it again before breaking it/.test(f.reason)), JSON.stringify(findings));
    assert.ok(!check("submit", breachInput(), makeContext(breachBelief(T0))).some(f => /look at it again/.test(f.reason)));
  });
});

describe("H14 purpose", () => {
  test("breaking glass on an opening observed open is refused in favour of the observed opening", () => {
    const findings = check("submit", breachInput(), makeContext(breachBelief(T0, { openings: [openingEvidence(T0 - 10, "open")] })));
    assert.ok(findings.some(f => f.ruleId === "H14" && /use the observed opening instead/.test(f.reason)));
  });

  test("spraying needs a recent fire observation overlapping the sector", () => {
    const findings = check("submit", sprayInput(), makeContext(sprayBelief(T0, { hazards: [] })));
    assert.deepEqual(ruleIds(findings), ["H14"]);
    const elsewhere = [{ observationId: FIRE_OBS_ID, tick: T0 - 10, hazard: "fire" as const, region: sphere(vec3(2, 3, 3.3), 0.3), intensity: 0.5 }];
    assert.deepEqual(ruleIds(check("submit", sprayInput(), makeContext(sprayBelief(T0, { hazards: elsewhere })))), ["H14"]);
  });

  test("a fire seen out after its flame (a later intensity-0 sighting of the place) is not a fire to spray", () => {
    const flame = fireHazard(T0 - 50);
    const out = { ...fireHazard(T0 - 10), observationId: "obs-fire-out", intensity: 0 };
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { hazards: [flame] }))), [], "the flame alone supports the spray");
    const findings = check("submit", sprayInput(), makeContext(sprayBelief(T0, { hazards: [flame, out] })));
    assert.deepEqual(ruleIds(findings), ["H14"]);
    assert.match(findings[0].reason, /show no flame/);
    const relit = { ...fireHazard(T0 - 5), observationId: "obs-fire-again" };
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { hazards: [flame, out, relit] }))), [], "a flame seen after the no-flame sighting counts again");
  });
});

describe("H10 localization and H11 standoff", () => {
  test("pose uncertainty acceptable for movement can still be too large for an intervention", () => {
    const ctx = makeContext(sprayBelief(T0, { sigmaM: 0.5 }));
    assert.deepEqual(check("submit", moveInput(vec3(8, 1, 4.2)), ctx), []);
    assert.deepEqual(ruleIds(check("submit", sprayInput(), ctx)), ["H10"]);
  });

  test("unsupported localization blocks a contingency hold too; lost localization is not a perfect hover", () => {
    const findings = check("submit", contingencyHoldInput(T0), makeContext(sprayBelief(T0, { poseSupported: false })));
    assert.deepEqual(ruleIds(findings), ["H10"]);
  });

  test("the standoff is checked at execution, not at submission", () => {
    const ctx = makeContext(sprayBelief(T0, { position: vec3(4, 1, 4.2) }));
    assert.deepEqual(check("submit", sprayInput(), ctx), []);
    assert.deepEqual(ruleIds(check("execute", sprayInput(), ctx, {})).filter(id => id !== "H5"), ["H11"]);
  });
});

describe("H4 basis and evidence", () => {
  test("superseded cited evidence invalidates at every phase, while cited age matters only before execution", () => {
    const successor = observation("obs-fire-2", T0 - 1, box(vec3(6, 0, 3), vec3(8, 2, 4.5)), { supersedes: FIRE_OBS_ID });
    const superseded = check("monitor", sprayInput(), makeContext(sprayBelief(T0, { extraObservations: [successor] })));
    assert.ok(superseded.some(f => f.ruleId === "H4" && f.evidenceIds?.includes("obs-fire-2")));

    const old = makeContext(sprayBelief(T0 + 3500, { observations: [], extraObservations: [] }));
    assert.ok(check("submit", sprayInput({ createdTick: T0 + 3400, expiresTick: T0 + 5000 }), old).some(f => f.ruleId === "H4" && /ticks old/.test(f.reason)));
    assert.ok(!check("monitor", sprayInput(), old).some(f => f.ruleId === "H4"));
  });

  test("a map change after the basis that overlaps the discharge sector invalidates; one elsewhere does not", () => {
    const overlapping = { revision: 2, tick: T0 - 1, region: box(vec3(6, 0.5, 3), vec3(6.5, 1.5, 4.5)), reason: "debris fell into the hallway", observationIds: ["obs-debris"] };
    const findings = check("submit", sprayInput(), makeContext(sprayBelief(T0, { mapChanges: [overlapping] })));
    assert.ok(findings.some(f => f.ruleId === "H4" && f.evidenceIds?.includes("obs-debris")));
    const elsewhere = { ...overlapping, region: box(vec3(10.5, 3, 3), vec3(11.5, 4, 4)) };
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { mapChanges: [elsewhere] }))), []);
  });

  test("a cited observation that left the belief window blocks a planner proposal but not a contingency; supersession blocks both", () => {
    const routes = [returnRoute(T0 - 10)];
    const cited = { citedEvidence: [`obs-return-${T0 - 10}`] };
    const plannerReturn = proposalInput({ kind: "return", routeId: RETURN_ROUTE_ID }, cited);
    const contingencyReturn = proposalInput({ kind: "return", routeId: RETURN_ROUTE_ID }, { ...cited, proposer: "contingency" });
    const windowOnly = makeContext(sprayBelief(T0, { routes }));
    assert.deepEqual(ruleIds(check("submit", plannerReturn, windowOnly)), ["H4"]);
    assert.deepEqual(check("submit", contingencyReturn, windowOnly), [], "its route support is re-checked by H15 instead");
    const successor = observation("obs-return-reprocessed", T0 - 1, null, { supersedes: `obs-return-${T0 - 10}` });
    const superseded = makeContext(sprayBelief(T0, { routes, extraObservations: [successor] }));
    assert.deepEqual(ruleIds(check("submit", contingencyReturn, superseded)), ["H4"]);
  });

  test("consequential actions must cite evidence", () => {
    const findings = check("submit", sprayInput({ citedEvidence: [] }), makeContext(sprayBelief(T0)));
    assert.ok(findings.some(f => f.ruleId === "H4" && /cite at least one observation/.test(f.reason)));
  });
});

describe("H2 limits and contingency exemptions", () => {
  test("ambient above the envelope ceiling blocks mission actions and a contingency hold, but not the contingency return that leaves", () => {
    const hot = makeContext(sprayBelief(T0, { aircraft: { ambientC: 75 }, routes: [returnRoute(T0 - 10)] }));
    assert.deepEqual(ruleIds(check("submit", moveInput(vec3(8, 1, 4.2)), hot)), ["H2"]);
    const contingencyReturn = proposalInput({ kind: "return", routeId: RETURN_ROUTE_ID }, { proposer: "contingency" });
    assert.deepEqual(check("submit", contingencyReturn, hot), []);
    assert.deepEqual(ruleIds(check("submit", contingencyHoldInput(T0), hot)), ["H2"], "a hold stays in the heat");
  });

  test("a hold beyond the bounded hold and an action that would eat the return reserve are refused", () => {
    const longHold = proposalInput({ kind: "hold", durationTicks: 3001 });
    assert.deepEqual(ruleIds(check("submit", longHold, makeContext(sprayBelief(T0)))), ["H2"]);
    const lowEndurance = makeContext(sprayBelief(T0, { aircraft: { enduranceRemainingS: 122 } }));
    assert.deepEqual(ruleIds(check("submit", sprayInput(), lowEndurance)), ["H2"], "3 s of spray would leave 119 s of a 120 s reserve");
  });
});

describe("review F2: released payloads and glass debris fall to the floor or ground below", () => {
  const RELEASE_POINT = vec3(-3, 2, 4); // aloft outside the west wall, 4 m above the ground
  const RELEASE_VIEW = box(vec3(-6, -1, -0.5), vec3(0, 5, 6.5)); // the release sphere, its fall column and the margin
  const releaseCase = (detections: readonly Vec3[], view: Region = RELEASE_VIEW) => {
    const frame = observation("obs-release-view", T0 - 10, view, { modality: "thermal", detections: detections.map(p => personDetection(p, 0.7, 0.5)) });
    const input = proposalInput({ kind: "release_payload", payloadId: "kit-1", releasePoint: RELEASE_POINT }, { citedEvidence: [frame.id] });
    return check("submit", input, makeContext(makeBelief(T0, { position: RELEASE_POINT, aircraft: { payloadsOnboard: ["kit-1"] }, observations: [frame] })));
  };

  test("a possible person on the ground directly below an aloft release point blocks the release, as one beside it does", () => {
    assert.deepEqual(releaseCase([]), [], "baseline: nobody seen, region covered");
    const below = releaseCase([vec3(-3, 2, 0.9)]);
    assert.deepEqual(ruleIds(below), ["H6"], "3.1 m straight down: in the payload's fall column");
    assert.match(below[0].reason, /Possible person in observation obs-release-view/);
    assert.deepEqual(ruleIds(releaseCase([vec3(-3, 4.3, 4)])), ["H6"], "2.3 m to the side at the same height");
  });

  test("coverage of a release must include the ground under it, not just the air around the release point", () => {
    const airOnly = box(vec3(-6, -1, 2.5), vec3(0, 5, 6.5));
    const findings = releaseCase([], airOnly);
    assert.deepEqual(ruleIds(findings), ["H6"]);
    assert.match(findings[0].reason, /coverage from a person search/);
  });

  test("the fall column stops at the floor of the room the payload is released in; with the floors alone it falls to the ground", () => {
    const upstairs = proposalInput({ kind: "release_payload", payloadId: "kit-1", releasePoint: vec3(2, 2, 4.8) }).action;
    const region = affectedRegion(upstairs, TENDER_T1, FLOOR_PLAN);
    assert.ok(region);
    assert.ok(regionContains(region, vec3(2, 2, 3.05)), "on the bedroom floor below the release point");
    assert.ok(!regionContains(region, vec3(2, 2, 2.5)), "not through the slab into the living room");
    const floorsOnly = affectedRegion(upstairs, TENDER_T1, FLOOR_PLAN.floors);
    assert.ok(floorsOnly && regionContains(floorsOnly, vec3(2, 2, 0.5)), "without rooms the lowest floor is assumed: a longer fall, never a shorter one");
    const outside = affectedRegion(proposalInput({ kind: "release_payload", payloadId: "kit-1", releasePoint: RELEASE_POINT }).action, TENDER_T1, FLOOR_PLAN);
    assert.ok(outside && regionContains(outside, vec3(-3, 2, 0.05)) && regionContains(outside, vec3(-3.9, 2, 0.5)), "outside it falls to the ground");
  });

  test("an upstairs release needs coverage of its own room down to the floor, but not of the room beyond the slab", () => {
    const releasePoint = vec3(2, 2, 4.8);
    const input = proposalInput({ kind: "release_payload", payloadId: "kit-1", releasePoint });
    const region = affectedRegion(input.action, TENDER_T1, FLOOR_PLAN);
    assert.ok(region);
    const bedroomSearch = observation("obs-bedroom-search", T0 - 5, box(vec3(0, 0, 3), vec3(3.94, 4, 5.6)), { modality: "thermal" });
    const upperHalf = observation("obs-bedroom-upper", T0 - 5, box(vec3(0, 0, 4.2), vec3(3.94, 4, 5.6)), { modality: "thermal" });
    const ctxWith = (frame: Observation) => makeContext(makeBelief(T0, { position: releasePoint, observations: [frame] }));
    assert.ok(coverageOf(region, ctxWith(bedroomSearch), [], true).fraction >= DEFAULT_POLICY.minCoverageFraction, "the living room below the slab is not required");
    assert.ok(coverageOf(region, ctxWith(upperHalf), [], true).fraction < DEFAULT_POLICY.minCoverageFraction, "the bedroom floor under the release point is required");
  });

  test("glass from the upper window reaches a possible person on the ground below it outside", () => {
    const person = (at: Vec3) => observation("obs-person", T0 - 1, null, { modality: "thermal", detections: [personDetection(at, 0.7, 0.5)] });
    const below = check("submit", breachInput(), makeContext(breachBelief(T0, { extraObservations: [person(vec3(-1, 2, 0.9))] })));
    assert.deepEqual(ruleIds(below), ["H6"], "3.4 m below the strike point, under the window");
    assert.deepEqual(ruleIds(check("submit", breachInput(), makeContext(breachBelief(T0, { extraObservations: [person(vec3(-1, 2, 4.2))] })))), ["H6"], "at window height");
    const region = affectedRegion(breachInput().action, TENDER_T1, FLOOR_PLAN);
    assert.ok(region);
    assert.ok(regionContains(region, vec3(-0.5, 2, 0.05)), "outside: down to the ground along the facade");
    assert.ok(regionContains(region, vec3(1.2, 2, 3.05)), "inside: down to the bedroom floor");
    assert.ok(!regionContains(region, vec3(1.2, 2, 1.5)), "inside it does not fall through the slab");
  });

  test("breach coverage counts the ground below the window outside, and an unseen wall base is disclosed", () => {
    const aboveGround = box(vec3(-3, -1, 1.5), vec3(3, 5, 7)); // the footprint before falling debris was modeled
    const ctx = makeContext(breachBelief(T0, { coverageTick: null, extraObservations: [observation("obs-window-high", T0 - 5, aboveGround, { modality: "thermal" })] }));
    const action = breachInput().action;
    assert.ok(action.kind === "breach_opening");
    const region = affectedRegion(action, TENDER_T1, FLOOR_PLAN);
    assert.ok(region);
    const assessment = breachCoverageAssessment(action, region, ctx);
    assert.ok(assessment.fraction < 1);
    assert.equal(assessment.unseen[0]?.place, "outside at the wall base");
    assert.match(assessment.text, /Unseen: outside at the wall base \(\d+\)/);
  });
});

describe("review F3a: without localization a landing must be under the aircraft", () => {
  const site = vec3(-4, 2, 0.6);
  const lost = (position: Vec3, sigmaM: number) => makeContext(makeBelief(T0, { position, poseSupported: false, sigmaM, landing: { supported: true, site, evidenceIds: [], reason: "fixture: flat exterior ground observed" } }));
  const land = proposalInput({ kind: "land", site });

  test("H10 refuses a landing on a supported site 9.7 m from the estimated position while localization is lost", () => {
    const findings = check("submit", land, lost(vec3(5, 1, 4.2), 0.5));
    assert.deepEqual(ruleIds(findings), ["H10"]);
    assert.match(findings[0].reason, /descent in place/);
  });

  test("the same landing is accepted when the site is within the pose uncertainty horizontally, and refused for a NaN or negative σ", () => {
    assert.deepEqual(check("submit", land, lost(vec3(-4.3, 2.2, 3), 0.5)), []);
    assert.deepEqual(ruleIds(check("submit", land, lost(vec3(-4, 2, 3), Number.NaN))), ["H10", "H3"]);
    assert.deepEqual(ruleIds(check("submit", land, lost(vec3(-4, 2, 3), -1))), ["H10", "H3"]);
  });
});

describe("review F5: H15 checks an evacuation route's evidence, not only its assessment tick", () => {
  test("under way, guidance stops for a route assessed unsupported but not for evidence that merely aged into unknown", () => {
    const fresh = routeObservation(T0 - 10);
    const withStatus = (status: "supported" | "unknown" | "unsupported") =>
      makeContext(makeBelief(T0, { observations: [fresh], tracks: [occupantTrack(T0 - 5)], routes: [{ ...evacuationRoute(T0 - 10), evidenceIds: [fresh.id], status, reason: `fixture ${status}` }] }));
    const guideInputLocal = guideInput();
    assert.deepEqual(ruleIds(check("monitor", guideInputLocal, withStatus("unknown"), { lastInterventionTick: T0 - 100 })), []);
    assert.deepEqual(ruleIds(check("monitor", guideInputLocal, withStatus("unsupported"), { lastInterventionTick: T0 - 100 })), ["H15"]);
    assert.deepEqual(ruleIds(check("submit", guideInputLocal, withStatus("unknown"), { lastInterventionTick: T0 - 100 })), ["H15"], "starting needs a supported route");
  });

  const INTERVENTION = T0 - 100;
  const guide = guideInput();
  const routeCiting = (evidenceIds: readonly string[], observations: readonly Observation[]) =>
    makeContext(makeBelief(T0, { observations, tracks: [occupantTrack(T0 - 5)], routes: [{ ...evacuationRoute(T0 - 10), evidenceIds }] }));

  test("a route assessed after the spray but citing a pre-spray frame and a missing frame supports no guidance at any phase", () => {
    const ctx = routeCiting(["obs-pre-spray", "obs-does-not-exist"], [observation("obs-pre-spray", T0 - 400, HALLWAY_VIEW, { modality: "thermal" })]);
    for (const phase of ["submit", "execute", "monitor"] as const) {
      const findings = check(phase, guide, ctx, { lastInterventionTick: INTERVENTION });
      assert.deepEqual(ruleIds(findings), ["H15"], phase);
      assert.ok(findings.some(f => /obs-pre-spray captured at tick 600, not after the intervention/.test(f.reason)), phase);
      // Under way (monitor), a cited frame that has left the window is not by itself a reason to stop guidance:
      // evidence aging is checked before execution; an outdated or blocked route still stops it.
      if (phase !== "monitor") assert.ok(findings.some(f => /obs-does-not-exist, which is not in the current evidence/.test(f.reason)), phase);
    }
  });

  test("a route citing a frame captured after the spray supports guidance; one with no evidence, or evidence past the age limit, does not", () => {
    const fresh = routeObservation(T0 - 10);
    assert.deepEqual(check("submit", guide, routeCiting([fresh.id], [fresh]), { lastInterventionTick: INTERVENTION }), []);
    assert.deepEqual(ruleIds(check("submit", guide, routeCiting([], []))), ["H15"]);
    const old = observation("obs-old", T0 - DEFAULT_POLICY.routeEvidenceMaxAgeTicks - 1, HALLWAY_VIEW);
    const stale = check("submit", guide, routeCiting([old.id], [old]));
    assert.ok(stale.some(f => f.ruleId === "H15" && new RegExp(`more than ${DEFAULT_POLICY.routeEvidenceMaxAgeTicks} ticks ago`).test(f.reason)), JSON.stringify(stale));
    // Route evidence may be older than other cited evidence (one aircraft must sweep the whole route), and a
    // guide citing it is held to the route limit, not the 30 s cited-evidence limit.
    assert.ok(DEFAULT_POLICY.routeEvidenceMaxAgeTicks > DEFAULT_POLICY.citedEvidenceMaxAgeTicks);
    const sweptEarlier = routeObservation(T0 - DEFAULT_POLICY.citedEvidenceMaxAgeTicks - 500);
    assert.deepEqual(check("submit", { ...guide, citedEvidence: [sweptEarlier.id] }, routeCiting([sweptEarlier.id], [sweptEarlier]), { lastInterventionTick: T0 - DEFAULT_POLICY.routeEvidenceMaxAgeTicks + 100 }), []);
  });
});

describe("review F7: limits fail closed on non-finite estimates", () => {
  test("a NaN water estimate fails the dose check", () => {
    const findings = check("submit", sprayInput(), makeContext(sprayBelief(T0, { aircraft: { waterRemainingL: Number.NaN } })));
    assert.deepEqual(ruleIds(findings), ["H2"]);
    assert.match(findings[0].reason, /Dose 0.6 L exceeds/);
  });

  test("NaN thrust, ambient and endurance estimates each fail their limit", () => {
    assert.ok(check("monitor", sprayInput(), makeContext(sprayBelief(T0, { aircraft: { thrustAvailableN: Number.NaN } }))).some(f => f.ruleId === "H2" && /reaction/.test(f.reason)));
    const move = moveInput(vec3(8, 1, 4.2));
    assert.ok(check("submit", move, makeContext(sprayBelief(T0, { aircraft: { ambientC: Number.NaN } }))).some(f => f.ruleId === "H2" && /Ambient/.test(f.reason)));
    for (const phase of ["submit", "monitor"] as const) {
      assert.ok(check(phase, move, makeContext(sprayBelief(T0, { aircraft: { enduranceRemainingS: Number.NaN } }))).some(f => f.ruleId === "H2" && /reserve/.test(f.reason)), phase);
    }
  });

  test("a negative or NaN pose σ fails H10 (and H3 for a positioned action), and does not support movement", () => {
    for (const sigmaM of [-1, Number.NaN]) {
      const ctx = makeContext(sprayBelief(T0, { sigmaM }));
      assert.deepEqual(ruleIds(check("submit", moveInput(vec3(8, 1, 4.2)), ctx)), ["H10", "H3"], String(sigmaM));
      assert.ok(check("monitor", sprayInput(), ctx).some(f => f.ruleId === "H10"), String(sigmaM));
      assert.equal(localizationSupportsAdvance(ctx), false, String(sigmaM));
    }
  });
});

describe("review F11a: H3 checks return and guide route waypoints against the envelope", () => {
  test("a contingency return along a route whose last waypoint is 34 m beyond the envelope is refused", () => {
    const outside = { ...returnRoute(T0 - 10), waypoints: [vec3(5, 1, 4.2), vec3(-1, 2, 4.2), vec3(-40, 2, 3)] };
    const input = proposalInput({ kind: "return", routeId: RETURN_ROUTE_ID }, { proposer: "contingency" });
    const findings = check("execute", input, makeContext(makeBelief(T0, { routes: [outside] })), { missionAborted: true });
    assert.deepEqual(ruleIds(findings), ["H3"]);
    assert.match(findings[0].reason, /Route route-return waypoint 2 \(-40, 2, 3\) is outside/);
    assert.deepEqual(check("execute", input, makeContext(makeBelief(T0, { routes: [returnRoute(T0 - 10)] })), { missionAborted: true }), [], "the standard route stays inside");
  });

  test("a guide route that leaves the envelope is refused", () => {
    const route = { ...evacuationRoute(T0 - 10), waypoints: [vec3(3, 2.5, 4), vec3(20, 2, 4)] };
    const ctx = makeContext(makeBelief(T0, { tracks: [occupantTrack(T0 - 5)], routes: [route], observations: [routeObservation(T0 - 10)] }));
    const findings = check("submit", guideInput(), ctx);
    assert.deepEqual(ruleIds(findings), ["H3"]);
    assert.match(findings[0].reason, new RegExp(`Route ${EVAC_ROUTE_ID} waypoint 1`));
  });
});

describe("coverage margin and detection margin are separate", () => {
  const region = (): Region => {
    const r = affectedRegion(sprayInput().action, TENDER_T1, FLOOR_PLAN);
    if (!r) throw new Error("no spray region");
    return r;
  };
  const nearest = (points: readonly Vec3[], to: Vec3): number => Math.min(...points.map(p => Math.hypot(p.x - to.x, p.y - to.y, p.z - to.z)));

  test("a possible person detected 0.9 m from the region still blocks; at 1.1 m it does not (detection margin stays at personMarginM)", () => {
    assert.equal(DEFAULT_POLICY.personMarginM, 1);
    const behindNozzle = (m: number) => vec3(SPRAY_STANDOFF.x - m, SPRAY_STANDOFF.y, SPRAY_STANDOFF.z);
    const at = (m: number) => observation(`obs-person-${m}`, T0 - 2, null, { modality: "thermal", detections: [personDetection(behindNozzle(m), 0.7, 0)] });
    assert.ok(Math.abs(distanceToRegion(region(), behindNozzle(0.9)) - 0.9) < 1e-9);
    const blocked = check("submit", sprayInput(), makeContext(sprayBelief(T0, { extraObservations: [at(0.9)] })));
    assert.deepEqual(ruleIds(blocked), ["H6"]);
    assert.match(blocked[0].reason, /0.9 m from the affected region, inside its uncertainty plus the 1 m margin/);
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { extraObservations: [at(1.1)] }))), []);
    const track = occupantTrack(T0 - 2, { position: behindNozzle(0.9), uncertaintyM: 0, observationIds: ["obs-track-near"] });
    assert.ok(check("submit", sprayInput(), makeContext(sprayBelief(T0, { tracks: [track] }))).some(f => f.ruleId === "H6" && f.evidenceIds?.includes("obs-track-near")));
  });

  test("a sample 0.8 m beside the nozzle no longer needs coverage, while a sample inside the region still does", () => {
    const beside = vec3(SPRAY_STANDOFF.x, SPRAY_STANDOFF.y + 0.8, SPRAY_STANDOFF.z);
    const inside = vec3(6.5, 1, 3.8);
    assert.ok(distanceToRegion(region(), beside) > 0.75 && regionContains(region(), inside));
    const ctx = makeContext(sprayBelief(T0));
    const spacing = DEFAULT_POLICY.coverageSpacingM;
    const required = requiredSamples(region(), ctx).points;
    assert.ok(nearest(required, beside) > 0.4, "nothing near the point beside the nozzle is required");
    assert.ok(nearest(required, inside) <= spacing, "the region itself is required");
    assert.ok(required.every(p => distanceToRegion(region(), p) <= DEFAULT_POLICY.coverageMarginM + 1e-9), "only the region and its 0.3 m edge band");
    // The former behaviour (coverage sampled with the 1 m person margin) required it.
    const formerly = requiredSamples(region(), makeContext(sprayBelief(T0), { policy: { ...DEFAULT_POLICY, coverageMarginM: DEFAULT_POLICY.personMarginM } })).points;
    assert.ok(nearest(formerly, beside) <= spacing);
  });

  test("the jet's edge band does not extend behind the nozzle, while the band ahead of it is still required", () => {
    const jet = region();
    assert.ok(jet.kind === "sector");
    const ctx = makeContext(sprayBelief(T0));
    const { all, points } = requiredSamples(jet, ctx);
    const along = (p: Vec3) => (p.x - jet.apex.x) * jet.axis.x + (p.y - jet.apex.y) * jet.axis.y + (p.z - jet.apex.z) * jet.axis.z;
    assert.ok(all.some(p => along(p) < -0.05), "the sampled edge band reaches behind the nozzle");
    assert.ok(points.every(p => along(p) >= 0 || regionContains(jet, p)), "no required sample lies behind the nozzle's plane");
    const nearNozzleM = TENDER_T1.spanM / 2 + AIRFRAME_BAND_M;
    const fromNozzle = (p: Vec3) => Math.hypot(p.x - jet.apex.x, p.y - jet.apex.y, p.z - jet.apex.z);
    assert.ok(all.some(p => !regionContains(jet, p) && along(p) >= 0 && fromNozzle(p) <= nearNozzleM), "the sampled band reaches beside the airframe");
    assert.ok(points.every(p => regionContains(jet, p) || fromNozzle(p) > nearNozzleM), "no band sample against the airframe is required");
    assert.ok(points.some(p => regionContains(jet, p) && fromNozzle(p) <= 1), "the jet itself near the nozzle is still required");
    assert.ok(points.some(p => !regionContains(jet, p) && along(p) > 0), "the edge band ahead of the nozzle is still required");
    // A breach (falling debris) keeps its whole edge band: the rule is only for a forward water jet.
    const action = breachInput().action;
    assert.ok(action.kind === "breach_opening");
    const debris = affectedRegion(action, TENDER_T1, FLOOR_PLAN);
    assert.ok(debris !== null && debris.kind !== "sector");
  });

  test("a person search that misses the hallway beside and well behind the nozzle now supports the spray", () => {
    // From 0.3 m behind the nozzle onward, only the middle 1.2 m of the hallway's width: nothing 0.6 m or
    // more to either side of the aircraft, nor farther behind it, is seen (both were required with a 1 m margin).
    const ahead = box(vec3(4.7, 0.4, 3), vec3(9.94, 1.6, 5.6));
    const ctx = makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [observation("obs-ahead", T0 - 5, ahead, { modality: "thermal" })] }));
    const coverage = coverageOf(region(), ctx);
    assert.ok(coverage.fraction >= DEFAULT_POLICY.minCoverageFraction, String(coverage.fraction));
    assert.deepEqual(check("submit", sprayInput(), ctx), []);
    const formerly = makeContext(ctx.belief, { policy: { ...DEFAULT_POLICY, coverageMarginM: DEFAULT_POLICY.personMarginM } });
    assert.ok(coverageOf(region(), formerly).fraction < DEFAULT_POLICY.minCoverageFraction, "the 1 m coverage margin refused it");
  });
});

describe("coverage thresholds and the standing band", () => {
  test("under the full rule (95%) a search covering about 90% of the discharge region refuses a spray", () => {
    const partial = box(vec3(6, 0, 3), vec3(9.94, 1.94, 5.6)); // the hallway from 1 m ahead of the nozzle
    const strict = { ...DEFAULT_POLICY, minCoverageFraction: 0.95 };
    const ctx = makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [observation("obs-partial", T0 - 5, partial, { modality: "thermal" })] }), { policy: strict });
    const region = affectedRegion(sprayInput().action, TENDER_T1, FLOOR_PLAN);
    assert.ok(region);
    const fraction = coverageOf(region, ctx).fraction;
    assert.ok(fraction >= DEFAULT_POLICY.breachMinCoverageFraction && fraction < strict.minCoverageFraction, String(fraction));
    const findings = check("submit", sprayInput(), ctx);
    assert.deepEqual(ruleIds(findings), ["H6"]);
    assert.match(findings[0].reason, /95% is required/);
  });

  test("DEMO 80%: the same 90% search allows the spray, but a possible person in the discharge region still refuses it", () => {
    const partial = box(vec3(6, 0, 3), vec3(9.94, 1.94, 5.6));
    const search = observation("obs-partial", T0 - 5, partial, { modality: "thermal" });
    assert.equal(DEFAULT_POLICY.minCoverageFraction, 0.8);
    assert.deepEqual(check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [search] }))), []);
    const person = personObservation("obs-person-sector", T0 - 3);
    const refused = check("submit", sprayInput(), makeContext(sprayBelief(T0, { coverageTick: null, extraObservations: [search, person] })));
    assert.ok(refused.some(f => f.ruleId === "H6" && /Possible person/.test(f.reason)), JSON.stringify(refused));
  });

  test("samples more than standing height above the floor are not required, though they lie in the region", () => {
    const action = breachInput().action;
    assert.ok(action.kind === "breach_opening");
    const region = affectedRegion(action, TENDER_T1, FLOOR_PLAN);
    assert.ok(region);
    const { all, points } = requiredSamples(region, makeContext(breachBelief(T0)), [action.openingId], true, action.standoff);
    const bedroomFloor = 3;
    const high = (p: Vec3) => p.x > 0 && p.z > bedroomFloor + PERSON_STANDING_HEIGHT_M + 1e-9;
    assert.ok(all.filter(high).length > 0, "the debris cone reaches toward the ceiling");
    assert.deepEqual(points.filter(high), []);
    assert.ok(points.some(p => p.x > 0 && p.z > bedroomFloor + PERSON_STANDING_HEIGHT_M - 0.4), "the band up to standing height is required");
    assert.equal(occupiable(vec3(2, 2, 5.15), FLOOR_PLAN, DEFAULT_POLICY.wallClearanceM, 4.2), true);
    assert.equal(occupiable(vec3(2, 2, 5.3), FLOOR_PLAN, DEFAULT_POLICY.wallClearanceM, 4.2), false, "under the ceiling, above head height");
  });

  test("over a stair the band follows the walking surface: nothing on the stair below surface + standing height is dropped", () => {
    // A stair hall spanning both floors (z 0–5.6) with a stair rising from (1, 1, 0) to (4, 1, 3), 1 m wide.
    const prior = {
      ...FLOOR_PLAN,
      rooms: [...FLOOR_PLAN.rooms, { id: "stair-hall", name: "Stair hall", floor: 0, polygon: [[0, -3], [6, -3], [6, -0.1], [0, -0.1]] as [number, number][], zMin: 0, zMax: 5.6 }],
      stairs: [{ id: "stair", bottomRoomId: "stair-hall", topRoomId: "stair-hall", bottom: vec3(1, -1.5, 0), top: vec3(4, -1.5, 3), widthM: 1 }],
    };
    const at = (x: number, y: number, z: number) => occupiable(vec3(x, y, z), prior, DEFAULT_POLICY.wallClearanceM, 1);
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const x = 1 + 3 * t;
      const surface = 3 * t;
      for (const y of [-1.95, -1.5, -1.05]) {
        for (let z = 0.05; z <= surface + PERSON_STANDING_HEIGHT_M; z += 0.25) assert.equal(at(x, y, z), true, `stair t=${t.toFixed(1)} y=${y} z=${z.toFixed(2)}`);
        assert.equal(at(x, y, surface + PERSON_STANDING_HEIGHT_M + 0.1), false, `above the band at t=${t.toFixed(1)}`);
      }
    }
    assert.equal(at(4.5, -2.6, 3), false, "off the stair the floor band applies (floor 0 + 2.2 m)");
    assert.equal(at(4.5, -2.6, 2.1), true);
  });
});
