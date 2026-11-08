/**
 * Camera director: framing targets come from the harness's own affected regions and the floor-plan prior
 * (the harness test house), never from belief tracks or simulator truth; the state machine holds framings
 * for the dwell time, ignores oscillating inputs, yields to halts and to the presenter's manual choice, and
 * is deterministic.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionSpec, ProposalRecord, ProposalStatus } from "../../lib/contracts/actions.ts";
import { TENDER_T1 } from "../../lib/contracts/aircraft.ts";
import type { FloorPlanPrior } from "../../lib/contracts/evidence.ts";
import type { Vec3 } from "../../lib/contracts/frames.ts";
import { vec3 } from "../../lib/contracts/frames.ts";
import type { Region } from "../../lib/contracts/geometry.ts";
import { box, regionBounds } from "../../lib/contracts/geometry.ts";
import { affectedRegion } from "../../lib/harness/effects.ts";
import { BREACH_STANDOFF, FLOOR_PLAN, STRIKE_POINT, WINDOW_ID, occupantTrack, sprayAction } from "../../lib/harness/test-fixtures.ts";
import type { MissionView } from "../../lib/mission/protocol.ts";
import { focusOffset } from "../../lib/render/view-cameras.ts";
import type { MissionPhaseId, PhaseHalt } from "../mission/phases.ts";
import type { DirectorInput, DirectorState } from "./director.ts";
import { MIN_DWELL_MS, PRIORITY_DWELL_MS, SETTLE_MS, actionFocus, assemblyFocus, chooseManual, desiredShot, directorOutput, enableAuto, initialDirector, stepDirector } from "./director.ts";

const BREACH: ActionSpec = { kind: "breach_opening", openingId: WINDOW_ID, standoff: BREACH_STANDOFF, strikePoint: STRIKE_POINT };
const SPRAY = sprayAction();
const BREACH_REGION = affectedRegion(BREACH, TENDER_T1, FLOOR_PLAN);
const SPRAY_REGION = affectedRegion(SPRAY, TENDER_T1, FLOOR_PLAN);

function record(id: string, action: ActionSpec, status: ProposalStatus, risk: "consequential" | "routine" = "consequential"): ProposalRecord {
  return { proposal: { id, action, digest: `digest-${id}` }, risk, status, approval: null, execution: null, findings: [], history: [] } as unknown as ProposalRecord;
}

type FocusView = Pick<MissionView, "pendingApproval" | "proposals" | "affectedRegions" | "belief">;

function view(records: readonly ProposalRecord[], regions: readonly { proposalId: string; region: Region | null }[] = [], belief: Partial<MissionView["belief"]> = {}): FocusView {
  const pending = records.find(r => r.status === "awaiting_approval") ?? null;
  return {
    pendingApproval: pending,
    proposals: records,
    affectedRegions: regions.filter((r): r is { proposalId: string; region: Region } => r.region !== null),
    belief: { mapPrior: FLOOR_PLAN, ...belief },
  } as unknown as FocusView;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function assertEncloses(focus: { point: Vec3; radiusM: number }, points: readonly Vec3[]) {
  for (const p of points) assert.ok(dist(focus.point, p) <= focus.radiusM + 1e-9, `(${p.x}, ${p.y}, ${p.z}) is inside the framed radius`);
}

describe("actionFocus", () => {
  test("frames a pending window breach from outside, enclosing the strike point, the standoff and the harness debris region", () => {
    assert.ok(BREACH_REGION);
    const focus = actionFocus(view([record("p-breach", BREACH, "awaiting_approval")], [{ proposalId: "p-breach", region: BREACH_REGION }]));
    assert.ok(focus);
    assert.equal(focus.mode, "exterior");
    assert.equal(focus.awaitingApproval, true);
    assert.equal(focus.regionFramed, true);
    const b = regionBounds(BREACH_REGION);
    assertEncloses(focus.focus, [STRIKE_POINT, BREACH_STANDOFF, b.min, b.max]);
    // The window faces -x; the camera must stand on that side, not look through the house at it.
    assert.ok(focus.focus.viewFrom && focus.focus.viewFrom.x < 0, "camera stands outside the window");
  });

  test("frames an indoor spray in cutaway, keeps it while approved and executing, and lets go once it is done", () => {
    assert.ok(SPRAY_REGION);
    const regions = [{ proposalId: "p-spray", region: SPRAY_REGION }];
    const pending = actionFocus(view([record("p-spray", SPRAY, "awaiting_approval")], regions));
    assert.equal(pending?.mode, "cutaway");
    assert.equal(pending?.awaitingApproval, true);
    for (const status of ["approved", "executing"] as const) {
      const active = actionFocus(view([record("p-spray", SPRAY, status)], regions));
      assert.equal(active?.proposalId, "p-spray", status);
      assert.equal(active?.awaitingApproval, false, status);
    }
    for (const status of ["completed", "rejected", "invalidated", "expired", "aborted"] as const) {
      assert.equal(actionFocus(view([record("p-spray", SPRAY, status)], regions)), null, status);
    }
  });

  test("routine actions and belief contents never become a focus", () => {
    // A possible occupant in belief and a routine move toward it: neither is an intervention target.
    const track = occupantTrack(900);
    const records = [record("p-move", { kind: "move", goal: track.position, maxSpeedMps: 1 }, "executing", "routine"), record("p-guide", { kind: "guide", trackId: track.id, routeId: "r", templateIds: ["follow-light"], maxDurationTicks: 600 }, "executing", "routine")];
    assert.equal(actionFocus(view(records, [], { tracks: [track] })), null);
  });

  test("without a harness region it frames only the target and standoff, and the reason says so", () => {
    const focus = actionFocus(view([record("p-breach", BREACH, "awaiting_approval")]));
    assert.ok(focus);
    assert.equal(focus.regionFramed, false);
    assertEncloses(focus.focus, [STRIKE_POINT, BREACH_STANDOFF]);
    assert.match(desiredShot({ ...input(0, "access"), action: focus }).reason, /no affected region/);
  });

  test("a target with non-finite coordinates is not framed", () => {
    const broken = sprayAction({ aimPoint: vec3(Number.NaN, 1, 3) });
    assert.equal(actionFocus(view([record("p", broken, "awaiting_approval")])), null);
  });
});

describe("assemblyFocus", () => {
  test("shows the exit and the assembly area, seen from beyond the assembly area looking back at the house", () => {
    const focus = assemblyFocus(FLOOR_PLAN);
    assert.ok(focus);
    const exit = FLOOR_PLAN.openings.find(o => o.id === "door-front")!.center;
    const b = regionBounds(FLOOR_PLAN.assemblyPoint);
    assertEncloses(focus, [exit, b.min, b.max]);
    assert.ok(focus.viewFrom && focus.viewFrom.x > 0, "the assembly area lies at +x of the front door");
  });

  test("a zero-size placeholder gives no focus, and guidance falls back to a plain exterior view", () => {
    const placeholder: FloorPlanPrior = { ...FLOOR_PLAN, assemblyPoint: box(vec3(0, 0, 0), vec3(0, 0, 0)) };
    assert.equal(assemblyFocus(placeholder), null);
    const shot = desiredShot({ ...input(0, "guide"), assembly: null });
    assert.equal(shot.mode, "exterior");
    assert.equal(shot.focus, null);
  });
});

describe("focusOffset (ViewCameras.setFocus)", () => {
  const focus = { point: vec3(0, 0, 0), radiusM: 3, viewFrom: vec3(-1, 0, 0) };

  test("the exterior camera stands on the viewFrom side, above the target, far enough to fit the radius", () => {
    const offset = focusOffset(focus, "exterior", 42);
    assert.ok(offset.x < 0 && offset.y > 0, "render x follows world -x; render y is up");
    assert.ok(offset.length() * Math.sin((21 * Math.PI) / 180) >= focus.radiusM);
  });

  test("distance grows with the radius but stays within bounds", () => {
    const near = focusOffset({ ...focus, radiusM: 0.1 }, "exterior", 42).length();
    const far = focusOffset({ ...focus, radiusM: 1e6 }, "cutaway", 42).length();
    assert.ok(near >= 6 - 1e-9);
    assert.ok(far <= 120 + 1e-9);
  });
});

/* State machine. */

const RUN = "run-1";

function input(nowMs: number, phase: MissionPhaseId, extra: Partial<DirectorInput> = {}): DirectorInput {
  return { runId: RUN, phase, halt: null, action: null, assembly: assemblyFocus(FLOOR_PLAN), nowMs, ...extra };
}

const breachFocus = () => actionFocus(view([record("p-breach", BREACH, "awaiting_approval")], [{ proposalId: "p-breach", region: BREACH_REGION }]));
const sprayFocus = () => actionFocus(view([record("p-spray", SPRAY, "awaiting_approval")], [{ proposalId: "p-spray", region: SPRAY_REGION }]));

/** Feed inputs in order; returns the final state and the time of every cut. */
function play(start: DirectorState, inputs: readonly DirectorInput[]): { state: DirectorState; cuts: { at: number; key: string }[] } {
  let state = start;
  const cuts: { at: number; key: string }[] = [];
  for (const i of inputs) {
    const next = stepDirector(state, i);
    if (next.shot.key !== state.shot.key) cuts.push({ at: i.nowMs, key: next.shot.key });
    state = next;
  }
  return { state, cuts };
}

/** Steps every `stepMs` from `from` to `to` inclusive. */
function ticks(from: number, to: number, stepMs: number, make: (t: number) => DirectorInput): DirectorInput[] {
  const out: DirectorInput[] = [];
  for (let t = from; t <= to; t += stepMs) out.push(make(t));
  return out;
}

/** A director already showing the chase shot since t = 10 000 ms. */
function chasing(): DirectorState {
  return play(initialDirector(0), [input(0, "report"), ...ticks(MIN_DWELL_MS, 10_000, 100, t => input(t, "approach"))]).state;
}

describe("director", () => {
  test("follows the demo choreography: establish, chase, window, interior, spray, assembly", () => {
    const steps: [number, MissionPhaseId, Partial<DirectorInput>][] = [
      [0, "report", {}],
      [20_000, "approach", {}],
      [40_000, "access", { action: breachFocus() }],
      [60_000, "search", {}],
      [80_000, "suppress", { action: sprayFocus() }],
      [100_000, "guide", {}],
    ];
    let state = initialDirector(0);
    const seen: [string, string][] = [];
    for (const [at, phase, extra] of steps) {
      state = play(state, ticks(at, at + 5_000, 100, t => input(t, phase, extra))).state;
      seen.push([directorOutput(state).mode, state.shot.key]);
    }
    assert.deepEqual(seen, [
      ["exterior", "establish"],
      ["follow", "chase"],
      ["exterior", "action:p-breach"],
      ["cutaway", "interior"],
      ["cutaway", "action:p-spray"],
      ["exterior", "assembly"],
    ]);
  });

  test("inputs that oscillate faster than the settle time never cut", () => {
    const flapping = ticks(10_100, 40_000, SETTLE_MS / 3, t => input(t, Math.floor(t / (SETTLE_MS / 2)) % 2 === 0 ? "approach" : "search"));
    const { state, cuts } = play(chasing(), flapping);
    assert.deepEqual(cuts, []);
    assert.equal(state.shot.key, "chase");
  });

  test("slower oscillation never cuts more often than the minimum dwell", () => {
    const period = SETTLE_MS * 2;
    const { cuts } = play(chasing(), ticks(10_100, 70_000, 50, t => input(t, Math.floor(t / period) % 2 === 0 ? "approach" : "search")));
    assert.ok(cuts.length >= 2, "it does still change shots");
    for (let i = 1; i < cuts.length; i += 1) assert.ok(cuts[i].at - cuts[i - 1].at >= MIN_DWELL_MS, `cut ${i} kept the dwell`);
  });

  test("a waiting approval cuts in after the priority dwell; an ordinary phase change waits the full dwell", () => {
    // Just cut to the chase at t = 0 of this test.
    const fresh = play(initialDirector(0), [input(0, "report"), ...ticks(MIN_DWELL_MS, MIN_DWELL_MS + SETTLE_MS, 50, t => input(t, "approach"))]).state;
    const t0 = fresh.sinceMs;
    const ordinary = play(fresh, ticks(t0 + 50, t0 + MIN_DWELL_MS - 50, 50, t => input(t, "search")));
    assert.deepEqual(ordinary.cuts, [], "no ordinary cut inside the dwell");
    const urgent = play(fresh, ticks(t0 + 50, t0 + MIN_DWELL_MS, 50, t => input(t, "access", { action: breachFocus() })));
    assert.equal(urgent.cuts.length, 1);
    assert.equal(urgent.cuts[0].key, "action:p-breach");
    assert.ok(urgent.cuts[0].at - t0 >= PRIORITY_DWELL_MS && urgent.cuts[0].at - t0 < MIN_DWELL_MS);
  });

  test("a halt holds the framing, and the settle time restarts after it clears", () => {
    const halts: PhaseHalt[] = [{ kind: "paused" }, { kind: "aborted", reason: null }, { kind: "contingency", contingency: "alternate_route", reason: "route blocked" }, { kind: "ended_incomplete", reason: "budget" }];
    for (const halt of halts) {
      const held = play(chasing(), ticks(10_100, 40_000, 100, t => input(t, "suppress", { halt, action: sprayFocus() })));
      assert.deepEqual(held.cuts, [], halt.kind);
      assert.match(directorOutput(held.state).reason, /Holding the framing/, halt.kind);
    }
    const paused = play(chasing(), ticks(10_100, 40_000, 100, t => input(t, "search", { halt: { kind: "paused" } }))).state;
    const resumed = play(paused, ticks(40_100, 40_100 + SETTLE_MS - 100, 100, t => input(t, "search")));
    assert.deepEqual(resumed.cuts, [], "no cut before the new shot settles");
    assert.equal(play(resumed.state, [input(40_100 + SETTLE_MS, "search")]).state.shot.key, "interior");
  });

  test("a manual choice wins until Auto is re-enabled, which cuts straight to the desired shot", () => {
    const manual = chooseManual(chasing(), "cutaway", 10_050);
    const busy = [
      ...ticks(10_100, 30_000, 100, t => input(t, "access", { action: breachFocus() })),
      ...ticks(30_100, 40_000, 100, t => input(t, "report", { runId: "run-2" })),
      ...ticks(40_100, 60_000, 100, t => input(t, "guide")),
    ];
    const { state, cuts } = play(manual, busy);
    assert.deepEqual(cuts, []);
    const out = directorOutput(state);
    assert.deepEqual([out.mode, out.focus, out.auto], ["cutaway", null, false]);
    const auto = enableAuto(state, input(60_050, "guide", { runId: "run-2" }));
    assert.deepEqual([directorOutput(auto).mode, auto.shot.key, auto.auto], ["exterior", "assembly", true]);
  });

  test("re-enabling Auto during a halt keeps the framing until the halt clears", () => {
    const manual = chooseManual(chasing(), "cutaway", 10_050);
    const auto = enableAuto(manual, input(10_100, "search", { halt: { kind: "paused" } }));
    assert.equal(auto.shot.key, "manual:cutaway");
    assert.match(directorOutput(auto).reason, /paused/);
  });

  test("a new run cuts straight to its establishing shot, even inside the dwell", () => {
    const state = chasing();
    const next = stepDirector(state, input(state.sinceMs + 10, "report", { runId: "run-2" }));
    assert.equal(next.shot.key, "establish");
    assert.equal(next.runId, "run-2");
  });

  test("a clock that goes backwards never cuts", () => {
    const { cuts } = play(chasing(), ticks(0, 9_000, 100, t => input(9_000 - t, "search")));
    assert.deepEqual(cuts, []);
  });

  test("is deterministic: the same inputs give the same outputs", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const phases: MissionPhaseId[] = ["report", "approach", "access", "search", "suppress", "reassess", "guide", "outside"];
    const inputs = ticks(0, 120_000, 137, t => input(t, phases[Math.floor(rand() * phases.length)], rand() < 0.1 ? { action: breachFocus() } : rand() < 0.05 ? { halt: { kind: "paused" } } : {}));
    const outputs = (s: DirectorState) => inputs.map(i => directorOutput((s = stepDirector(s, i))));
    assert.deepEqual(outputs(initialDirector(0)), outputs(initialDirector(0)));
  });
});
