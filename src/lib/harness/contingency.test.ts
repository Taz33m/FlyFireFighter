/**
 * Contingency selection, its proposal input and the reserve status. Scope: contingency.ts against
 * truth-free fixture beliefs (motion-fixtures.ts): Tender T1 (120 s return reserve, 80 °C), envelope
 * ambient ceiling 70 °C, default policy (σ ≤ 0.75 m to advance, return routes fresh for 3000 ticks, holds
 * of at most 3000 ticks). Includes the harness-review acceptance case for an infeasible return.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Contingency } from "../contracts/actions.ts";
import type { LandingSupport, RouteAssessment } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import { sphere } from "../contracts/geometry.ts";
import { parseProposalInput } from "../contracts/schema.ts";
import type { ContingencyTrigger } from "./contingency.ts";
import { contingencyProposalInput, reserveStatus, selectContingency } from "./contingency.ts";
import type { ContextOptions } from "./motion-fixtures.ts";
import { context, DEFAULT_POLICY, ENVELOPE, EVIDENCE_REVISION, landingAt, MAP_REVISION, NO_LANDING, NOW, route, RUN_ID, START, TENDER_T1 } from "./motion-fixtures.ts";
import type { HarnessContext } from "./policy.ts";

const RESERVE_S = TENDER_T1.hardLimits.returnReserveS;
const FRESH = DEFAULT_POLICY.returnRouteFreshTicks;
const TRIGGERS: readonly ContingencyTrigger[] = ["commander_abort", "reserve", "localization_lost", "route_blocked", "envelope_expired", "ambient_limit"];

const HOME = route("route-home", "return");
const HOME_BLOCKED = route("route-home", "return", { status: "unsupported" });
const BACK_STAIRS = route("route-back-stairs", "alternate_return", { durationS: 140 });
const LANDING = landingAt(vec3(10, 5, 0), ["obs-us-down-1", "obs-us-down-2"]);

const DEGRADED: readonly [string, ContextOptions["pose"]][] = [
  ["σ above the advance limit", { sigmaM: 1.2 }],
  ["estimator unsupported", { supported: false }],
];

function select(options: ContextOptions, trigger: ContingencyTrigger = "commander_abort"): Contingency {
  return selectContingency(context(options), trigger);
}

function assertParses(contingency: Contingency, ctx: HarnessContext): void {
  const input = contingencyProposalInput(contingency, ctx);
  assert.ok(input !== null, `${contingency.kind} must produce a proposal`);
  const parsed = parseProposalInput(input);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
}

describe("after a bounded hold that found no usable return", () => {
  test("a supported landing is chosen instead of hovering on; without landing support, another hold", () => {
    const first = selectContingency(context({ routes: [HOME_BLOCKED], landing: LANDING }), "commander_abort", 0);
    assert.equal(first.kind, "hold", "the first selection waits for a route reassessment");
    const after = selectContingency(context({ routes: [HOME_BLOCKED], landing: LANDING }), "commander_abort", 1);
    assert.equal(after.kind, "land");
    assert.match(after.reason, /after 1 bounded hold waiting for one/);
    assert.equal(selectContingency(context({ routes: [HOME_BLOCKED], landing: NO_LANDING }), "commander_abort", 1).kind, "hold", "no landing support: hold again");
  });
});

describe("a contingency never lands beside a fire", () => {
  test("a supported landing site within the fire clearance is refused, and the failure says why", () => {
    const fire = { observationId: "obs-fire-near", tick: NOW - 10, hazard: "fire" as const, region: sphere(vec3(10.8, 5, 0.2), 0.3), intensity: 0.5 };
    // Too hot to hold (so a hold is not supported), no usable return route: only landing remains.
    const hot = { ambientC: 85 };
    const near = selectContingency(context({ routes: [HOME_BLOCKED], landing: LANDING, hazards: [fire], aircraft: hot }), "ambient_limit");
    assert.notEqual(near.kind, "land");
    assert.match(near.reason, /landing is not safe: the landing site is .* from the fire seen in observation obs-fire-near/);
    // The same fire 3 m away, or an old sighting, does not block the landing.
    const far = selectContingency(context({ routes: [HOME_BLOCKED], landing: LANDING, hazards: [{ ...fire, region: sphere(vec3(13.5, 5, 0.2), 0.3) }], aircraft: hot }), "ambient_limit");
    assert.equal(far.kind, "land");
    const stale = selectContingency(context({ routes: [HOME_BLOCKED], landing: LANDING, hazards: [{ ...fire, tick: NOW - DEFAULT_POLICY.citedEvidenceMaxAgeTicks - 1 }], aircraft: hot }), "ambient_limit");
    assert.equal(stale.kind, "land");
  });
});

describe("review acceptance case: the sole return route is blocked while localization is degraded", () => {
  for (const [label, pose] of DEGRADED) {
    test(`${label}: lands on supported evidence and names the evidence and termination`, () => {
      const ctx = context({ pose, routes: [HOME_BLOCKED], landing: LANDING });
      const chosen = selectContingency(ctx, "route_blocked");
      assert.equal(chosen.kind, "land");
      assert.ok(chosen.kind === "land");
      assert.deepEqual(chosen.site, LANDING.site);
      assert.deepEqual(chosen.evidenceIds, LANDING.evidenceIds);
      assert.match(chosen.reason, /route_blocked/);
      assert.match(chosen.reason, /landing in place/);
      assert.match(chosen.termination, /touchdown/);
      const input = contingencyProposalInput(chosen, ctx);
      assert.deepEqual(input?.action, { kind: "land", site: LANDING.site }, "the obsolete route is never flown");
    });

    test(`${label}: without landing support records an explicit failure, never a safe label`, () => {
      const ctx = context({ pose, routes: [HOME_BLOCKED], landing: NO_LANDING });
      const chosen = selectContingency(ctx, "route_blocked");
      assert.equal(chosen.kind, "failure");
      assert.ok(chosen.kind === "failure");
      assert.equal(chosen.terminalBehavior, "brake_and_descend");
      assert.match(chosen.reason, /No supported maneuver remains/);
      assert.match(chosen.termination, /not a safe landing/);
      // "safe" may appear only negated.
      for (const text of [chosen.reason, chosen.termination]) assert.doesNotMatch(text, /(?<!not a )\bsafe/i);
      assert.deepEqual(chosen.evidenceIds, NO_LANDING.evidenceIds, "cites why landing is unsupported");
      assert.equal(contingencyProposalInput(chosen, ctx), null);
    });
  }

  test("degraded localization never returns or holds, even with a fresh supported route and spare endurance", () => {
    for (const [label, pose] of DEGRADED) {
      for (const landing of [LANDING, NO_LANDING]) {
        const chosen = select({ pose, routes: [HOME, BACK_STAIRS], landing }, "localization_lost");
        assert.ok(chosen.kind === "land" || chosen.kind === "failure", `${label}: got ${chosen.kind}`);
        assert.match(chosen.reason, /no return, route or perfect hover is assumed/);
      }
    }
  });

  test("a landing reported supported without a site cannot be flown and ends in failure", () => {
    const siteless: LandingSupport = { ...LANDING, site: null };
    const chosen = select({ pose: { supported: false }, landing: siteless });
    assert.equal(chosen.kind, "failure");
    assert.match(chosen.reason, /names no site/);
  });
});

describe("route selection with supported localization", () => {
  test("a fresh supported primary route is selected with its evidence", () => {
    const chosen = select({ routes: [HOME, BACK_STAIRS], landing: LANDING }, "reserve");
    assert.equal(chosen.kind, "return");
    assert.ok(chosen.kind === "return");
    assert.equal(chosen.routeId, HOME.id);
    assert.deepEqual(chosen.evidenceIds, HOME.evidenceIds);
    assert.match(chosen.reason, /reserve/);
    assert.match(chosen.termination, /route-home/);
  });

  test("the alternate route is selected when the primary is unsupported or unknown", () => {
    for (const status of ["unsupported", "unknown"] as const) {
      const chosen = select({ routes: [route("route-home", "return", { status }), BACK_STAIRS] });
      assert.equal(chosen.kind, "alternate_route", status);
      assert.ok(chosen.kind === "alternate_route");
      assert.equal(chosen.routeId, BACK_STAIRS.id);
      assert.match(chosen.reason, new RegExp(`route-home is ${status}`));
    }
  });

  test("only the latest assessment of a route counts", () => {
    const blockedLater = [route("route-home", "return", { assessedTick: NOW - 500 }), route("route-home", "return", { status: "unsupported", assessedTick: NOW - 50 })];
    assert.notEqual(select({ routes: blockedLater }).kind, "return");
    const clearedLater = [route("route-home", "return", { status: "unsupported", assessedTick: NOW - 500 }), route("route-home", "return", { assessedTick: NOW - 50 })];
    assert.equal(select({ routes: clearedLater }).kind, "return");
  });

  test(`a route assessed more than ${FRESH} ticks ago is unusable; exactly ${FRESH} ticks is still fresh`, () => {
    const stale = select({ routes: [route("route-home", "return", { assessedTick: NOW - FRESH - 1 })] });
    assert.notEqual(stale.kind, "return");
    assert.match(stale.reason, /beyond the 3000-tick limit/);
    assert.equal(select({ routes: [route("route-home", "return", { assessedTick: NOW - FRESH })] }).kind, "return");
    const staleAlternate = select({ routes: [HOME_BLOCKED, route("route-back-stairs", "alternate_return", { assessedTick: NOW - FRESH - 1 })] });
    assert.notEqual(staleAlternate.kind, "alternate_route");
  });

  test("a route longer than the remaining endurance is unusable", () => {
    const tooLong = select({ routes: [route("route-home", "return", { durationS: 601 })], aircraft: { enduranceRemainingS: 600 } });
    assert.notEqual(tooLong.kind, "return");
    assert.match(tooLong.reason, /needs an estimated 601 s but only 600 s/);
    assert.equal(select({ routes: [route("route-home", "return", { durationS: 600 })], aircraft: { enduranceRemainingS: 600 } }).kind, "return");
  });

  test("evacuation routes, routes without waypoints and invalid durations never carry a return", () => {
    const routes: RouteAssessment[] = [
      route("route-evac", "evacuation"),
      route("route-empty", "return", { waypoints: [] }),
      route("route-nan", "return", { durationS: NaN }),
      route("route-negative", "return", { durationS: -5 }),
    ];
    assert.equal(select({ routes }).kind, "hold");
  });

  test("among usable routes the shortest is chosen, independent of input order", () => {
    const long = route("route-long", "return", { durationS: 200 });
    const short = route("route-short", "return", { durationS: 80 });
    for (const routes of [[long, short], [short, long]]) {
      const chosen = select({ routes });
      assert.ok(chosen.kind === "return");
      assert.equal(chosen.routeId, "route-short");
    }
  });
});

describe("bounded hold", () => {
  test("with no usable route the hold is capped by the policy and cites the route evidence", () => {
    const chosen = select({ routes: [HOME_BLOCKED], landing: LANDING });
    assert.equal(chosen.kind, "hold");
    assert.ok(chosen.kind === "hold");
    assert.equal(chosen.maxTicks, DEFAULT_POLICY.maxHoldTicks);
    assert.deepEqual(chosen.evidenceIds, HOME_BLOCKED.evidenceIds);
    assert.match(chosen.termination, /until a route is reassessed as supported, the reserve limit or the ambient limit/);
  });

  test("the hold never reaches into the return reserve", () => {
    const tenSecondsSpare = select({ aircraft: { enduranceRemainingS: RESERVE_S + 10 } });
    assert.ok(tenSecondsSpare.kind === "hold");
    assert.equal(tenSecondsSpare.maxTicks, 1000);
    const fractionOfATick = select({ aircraft: { enduranceRemainingS: RESERVE_S + 0.004 }, landing: LANDING });
    assert.equal(fractionOfATick.kind, "land");
    const atReserve = select({ aircraft: { enduranceRemainingS: RESERVE_S } });
    assert.equal(atReserve.kind, "failure");
    assert.match(atReserve.reason, /leaves nothing above the 120 s reserve/);
  });

  test("a smaller policy bound wins over the endurance bound", () => {
    const chosen = select({ policy: { maxHoldTicks: 500 } });
    assert.ok(chosen.kind === "hold");
    assert.equal(chosen.maxTicks, 500);
  });

  test("a misconfigured policy bound still yields a whole-tick hold the proposal schema accepts", () => {
    for (const [maxHoldTicks, expected] of [[70_000, 60_000], [2500.5, 2500]] as const) {
      const ctx = context({ policy: { maxHoldTicks }, aircraft: { enduranceRemainingS: 2000 } });
      const chosen = selectContingency(ctx, "route_blocked");
      assert.ok(chosen.kind === "hold");
      assert.equal(chosen.maxTicks, expected);
      assertParses(chosen, ctx);
    }
  });

  test("the hold needs a known ambient within both the aircraft limit and the envelope ceiling", () => {
    const atCeiling = select({ aircraft: { ambientC: ENVELOPE.ambientCeilingC } });
    assert.equal(atCeiling.kind, "hold");
    for (const options of [{ aircraft: { ambientC: 70.5 } }, { aircraft: { ambientC: null } }, { aircraft: { ambientC: 65 }, envelope: { ambientCeilingC: 60 } }] satisfies ContextOptions[]) {
      assert.equal(select({ ...options, landing: LANDING }, "ambient_limit").kind, "land", JSON.stringify(options));
      assert.equal(select(options, "ambient_limit").kind, "failure", JSON.stringify(options));
    }
  });
});

describe("landing and failure with supported localization", () => {
  test("lands when no route or hold is supported but landing is", () => {
    const chosen = select({ routes: [HOME_BLOCKED], aircraft: { ambientC: 75 }, landing: LANDING }, "ambient_limit");
    assert.equal(chosen.kind, "land");
    assert.match(chosen.reason, /ambient_limit/);
    assert.doesNotMatch(chosen.reason, /in place/);
  });

  test("records failure with route and landing evidence when nothing is supported", () => {
    const chosen = select({ routes: [HOME_BLOCKED], aircraft: { ambientC: 75 } }, "ambient_limit");
    assert.equal(chosen.kind, "failure");
    assert.deepEqual([...chosen.evidenceIds].sort(), [...HOME_BLOCKED.evidenceIds, ...NO_LANDING.evidenceIds].sort());
  });
});

describe("contingency proposal input", () => {
  const revisions = {
    profile: { ...TENDER_T1, revision: 2 },
    policy: { revision: 5 },
    envelope: { revision: 4 },
  };

  test("every supported contingency becomes a valid contingency proposal bound to the current revisions", () => {
    const cases: readonly [Contingency["kind"], ContextOptions][] = [
      ["return", { routes: [HOME] }],
      ["alternate_route", { routes: [HOME_BLOCKED, BACK_STAIRS] }],
      ["hold", { routes: [HOME_BLOCKED] }],
      ["land", { pose: { supported: false }, landing: LANDING }],
    ];
    for (const [kind, options] of cases) {
      const ctx = context({ ...options, ...revisions });
      const chosen = selectContingency(ctx, "commander_abort");
      assert.equal(chosen.kind, kind);
      const input = contingencyProposalInput(chosen, ctx);
      assert.ok(input !== null);
      assertParses(chosen, ctx);
      assert.equal(input.proposer, "contingency");
      assert.equal(input.runId, RUN_ID);
      assert.equal(input.aircraftId, TENDER_T1.id);
      assert.deepEqual(input.basis, { evidenceRevision: EVIDENCE_REVISION, mapRevision: MAP_REVISION, profileRevision: 2, envelopeRevision: 4, policyRevision: 5 });
      assert.equal(input.createdTick, NOW);
      assert.equal(input.expiresTick, NOW + DEFAULT_POLICY.maxProposalLifetimeTicks);
      assert.deepEqual(input.citedEvidence, chosen.evidenceIds);
      assert.equal(input.rationale, chosen.reason);
    }
  });

  test("actions map to return by route id, a hold of maxTicks and a landing at the supported site", () => {
    const ctx = context();
    const stub = { reason: "fixture", evidenceIds: [], termination: "fixture" };
    assert.deepEqual(contingencyProposalInput({ kind: "return", routeId: "r1", ...stub }, ctx)?.action, { kind: "return", routeId: "r1" });
    assert.deepEqual(contingencyProposalInput({ kind: "alternate_route", routeId: "r2", ...stub }, ctx)?.action, { kind: "return", routeId: "r2" });
    assert.deepEqual(contingencyProposalInput({ kind: "hold", maxTicks: 750, ...stub }, ctx)?.action, { kind: "hold", durationTicks: 750 });
    assert.deepEqual(contingencyProposalInput({ kind: "land", site: vec3(1, 2, 0), ...stub }, ctx)?.action, { kind: "land", site: vec3(1, 2, 0) });
    assert.equal(contingencyProposalInput({ kind: "failure", terminalBehavior: "brake_and_descend", ...stub }, ctx), null);
  });

  test("evidence and rationale are bounded so the proposal still parses", () => {
    const manyIds = Array.from({ length: 40 }, (_, i) => `obs-${i}`);
    const ctx = context({ routes: [route("route-home", "return", { evidenceIds: [...manyIds, "obs-0", "x".repeat(65)] })] });
    const chosen = selectContingency(ctx, "reserve");
    assert.equal(chosen.evidenceIds.length, 32);
    assert.ok(!chosen.evidenceIds.includes("x".repeat(65)));
    assertParses(chosen, ctx);
    const verbose: Contingency = { kind: "hold", maxTicks: 100, reason: "r".repeat(900), evidenceIds: manyIds, termination: "fixture" };
    const input = contingencyProposalInput(verbose, ctx);
    assert.equal(input?.rationale.length, 600);
    assert.equal(input?.citedEvidence.length, 32);
    assertParses(verbose, ctx);
  });
});

describe("reserve status", () => {
  test("margin is endurance minus the shortest usable route minus the reserve", () => {
    const status = reserveStatus(context({ routes: [HOME], aircraft: { enduranceRemainingS: 600 } }));
    assert.deepEqual({ mustReturn: status.mustReturn, marginS: status.marginS }, { mustReturn: false, marginS: 600 - 90 - RESERVE_S });
    assert.match(status.reason, /before return is required/);
  });

  test("return is required at and below the threshold", () => {
    const threshold = HOME.estimatedDurationS + RESERVE_S;
    const at = reserveStatus(context({ routes: [HOME], aircraft: { enduranceRemainingS: threshold } }));
    assert.equal(at.mustReturn, true);
    assert.equal(at.marginS, 0);
    assert.match(at.reason, /Return required/);
    const above = reserveStatus(context({ routes: [HOME], aircraft: { enduranceRemainingS: threshold + 0.5 } }));
    assert.equal(above.mustReturn, false);
    assert.equal(above.marginS, 0.5);
  });

  test("the shortest usable route of either purpose sets the margin", () => {
    const status = reserveStatus(context({ routes: [route("route-home", "return", { durationS: 200 }), route("route-back-stairs", "alternate_return", { durationS: 90 })] }));
    assert.equal(status.marginS, 600 - 90 - RESERVE_S);
  });

  test("without a usable route the margin is unknown and a contingency is required", () => {
    for (const routes of [[], [HOME_BLOCKED], [route("route-home", "return", { durationS: 700 })], [route("route-home", "return", { assessedTick: NOW - FRESH - 1 })]]) {
      const status = reserveStatus(context({ routes }));
      assert.equal(status.marginS, null);
      assert.equal(status.mustReturn, true);
      assert.match(status.reason, /No usable return route/);
    }
  });
});

interface GridCase {
  readonly primary: RouteAssessment["status"];
  readonly alternate: RouteAssessment["status"];
  readonly ageTicks: number;
  readonly durationS: number;
  readonly pose: ContextOptions["pose"];
  readonly enduranceRemainingS: number;
  readonly ambientC: number | null;
  readonly landing: LandingSupport;
}

function gridCases(): GridCase[] {
  const statuses: RouteAssessment["status"][] = ["supported", "unsupported", "unknown"];
  const ages = [0, FRESH, FRESH + 1];
  const durations = [60, 599, 700];
  const poses: ContextOptions["pose"][] = [{}, { sigmaM: 0.76 }, { supported: false }];
  const endurances = [600, RESERVE_S + 5, RESERVE_S];
  const ambients = [40, 75, null];
  const cases: GridCase[] = [];
  for (const primary of statuses) for (const alternate of statuses) for (const ageTicks of ages) for (const durationS of durations)
    for (const pose of poses) for (const enduranceRemainingS of endurances) for (const ambientC of ambients) for (const landing of [LANDING, NO_LANDING]) {
      cases.push({ primary, alternate, ageTicks, durationS, pose, enduranceRemainingS, ambientC, landing });
    }
  return cases;
}

function gridContext(c: GridCase): HarnessContext {
  const routes = [
    route("route-home", "return", { status: c.primary, assessedTick: NOW - c.ageTicks, durationS: c.durationS }),
    // The alternate is always fresh and short, so primary freshness and length decide between them.
    route("route-alt", "alternate_return", { status: c.alternate, assessedTick: NOW - 10, durationS: 100 }),
  ];
  return context({ pose: c.pose, routes, aircraft: { enduranceRemainingS: c.enduranceRemainingS, ambientC: c.ambientC }, landing: c.landing });
}

function assertRouteSupported(kind: "return" | "alternate_route", routeId: string, ctx: HarnessContext, where: string): void {
  const used = ctx.belief.routes.find(r => r.id === routeId);
  assert.ok(used, where);
  assert.equal(used.purpose, kind === "return" ? "return" : "alternate_return", where);
  assert.equal(used.status, "supported", where);
  assert.ok(NOW - used.assessedTick <= FRESH, where);
  assert.ok(used.estimatedDurationS <= ctx.belief.aircraft.enduranceRemainingS, where);
}

function assertHoldBounded(maxTicks: number, localized: boolean, c: GridCase, where: string): void {
  assert.ok(localized && c.ambientC !== null && c.ambientC <= ENVELOPE.ambientCeilingC, where);
  assert.ok(maxTicks >= 1 && maxTicks <= Math.min(DEFAULT_POLICY.maxHoldTicks, Math.floor((c.enduranceRemainingS - RESERVE_S) * 100)), where);
}

function assertGridInvariants(chosen: Contingency, ctx: HarnessContext, c: GridCase, where: string): void {
  const localized = ctx.belief.pose.supported && ctx.belief.pose.sigmaM <= DEFAULT_POLICY.maxSigmaForAdvanceM;
  if (!localized) assert.ok(chosen.kind === "land" || chosen.kind === "failure", where);
  if (chosen.kind === "return" || chosen.kind === "alternate_route") assertRouteSupported(chosen.kind, chosen.routeId, ctx, where);
  if (chosen.kind === "hold") assertHoldBounded(chosen.maxTicks, localized, c, where);
  if (chosen.kind === "land") assert.deepEqual(chosen.site, LANDING.site, where);
  if (chosen.kind === "failure") assert.equal(chosen.terminalBehavior, "brake_and_descend", where);
}

describe("selection invariants over a deterministic grid", () => {
  test("never claims a return without support or a hover without localization", () => {
    const cases = gridCases();
    const seen = new Set<Contingency["kind"]>();
    cases.forEach((c, index) => {
      const ctx = gridContext(c);
      const trigger = TRIGGERS[index % TRIGGERS.length];
      const chosen = selectContingency(ctx, trigger);
      const where = JSON.stringify({ ...c, landing: c.landing.supported, chosen: chosen.kind });
      assertGridInvariants(chosen, ctx, c, where);
      assert.ok(chosen.reason.includes(`trigger: ${trigger}`), where);
      assert.ok(chosen.termination.length > 0 && chosen.evidenceIds.length <= 32, where);
      if (chosen.kind !== "failure") assertParses(chosen, ctx);
      seen.add(chosen.kind);
    });
    assert.equal(cases.length, 3 ** 7 * 2);
    // The invariants are not vacuous: the grid reaches every outcome.
    assert.deepEqual([...seen].sort(), ["alternate_route", "failure", "hold", "land", "return"]);
  });

  test("every trigger is named in the reason and selection is deterministic", () => {
    for (const trigger of TRIGGERS) {
      const ctx = context({ routes: [HOME] });
      const first = selectContingency(ctx, trigger);
      assert.match(first.reason, new RegExp(`\\(trigger: ${trigger}\\)`));
      assert.deepEqual(selectContingency(ctx, trigger), first);
    }
  });
});

describe("review F3a: landing in place without localization needs the supported site under the aircraft", () => {
  const LOST = { supported: false } as const;

  test("a supported site 8 m from the estimated position is not 'landing in place': the result is an explicit failure", () => {
    const chosen = select({ pose: LOST, landing: landingAt(vec3(2, 5, 0)) }, "localization_lost");
    assert.equal(chosen.kind, "failure");
    assert.match(chosen.reason, /landing in place is not possible/);
    assert.match(chosen.reason, /8 m horizontally from the estimated position, beyond the 0.2 m pose uncertainty/);
    assert.match(chosen.termination, /not a safe landing/);
  });

  test("a site within the pose uncertainty horizontally is landed on; a NaN σ supports no landing in place", () => {
    const near = select({ pose: { supported: false, sigmaM: 0.2 }, landing: landingAt(vec3(10.15, 5.1, 0)) }, "localization_lost");
    assert.equal(near.kind, "land");
    assert.equal(select({ pose: { supported: false, sigmaM: Number.NaN }, landing: landingAt(vec3(10, 5, 0)) }, "localization_lost").kind, "failure");
  });

  test("with supported localization a landing elsewhere is still a supported maneuver (the aircraft can fly to it)", () => {
    assert.equal(select({ landing: landingAt(vec3(2, 5, 0)), aircraft: { ambientC: 95 } }, "ambient_limit").kind, "land");
  });
});

describe("review F11a: a return route that leaves the envelope cannot carry a contingency", () => {
  test("the selector skips a route with a waypoint outside the envelope and falls back to the next supported maneuver", () => {
    const leaving = route("route-home", "return", { waypoints: [START, vec3(2, 5, 3), vec3(-30, 5, 1)] });
    const chosen = select({ routes: [leaving], landing: LANDING });
    assert.equal(chosen.kind, "hold");
    assert.match(chosen.reason, /waypoint 2 lies outside envelope revision/);
  });
});
