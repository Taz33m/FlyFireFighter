/**
 * Console screen state machine and the v024 device line. Scope: which screen each mission state produces and in
 * what priority (no run, aborted, review hold, pending, a decision just made, standing by, phase); the pending
 * card's content taken from the harness's own disclosure; attribution of a decision to the console; and that the
 * device line never exceeds the 8 characters the OG v024 overlay displayed. The disclosure string follows the
 * harness template in src/lib/harness/rules.ts.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalRecord } from "../../../lib/contracts/actions.ts";
import type { FloorPlanPrior } from "../../../lib/contracts/evidence.ts";
import type { PhaseRailState } from "../phases.ts";
import type { ScreenSpec, ScreenView } from "./screens.ts";
import { CONFIRM_TICKS, MAX_OVERLAY_CHARS, RING_STEPS, deriveScreen, overlayText, screenDigest } from "./screens.ts";

const DIGEST = "1a2b3c4d" + "0".repeat(56);
const DISCLOSURE = "Validated: this consequential action awaits the commander's individual approval. Debris region coverage: 82% of 120 required samples (occupiable, reachable, up to standing height) searched for people in the last 300 ticks at quality ≥ 0.50. Unseen: inside under the sill (14), inside beside the frame (8).";
const PRIOR = { rooms: [{ id: "bed-2", name: "Rear bedroom" }], openings: [{ id: "win-3", kind: "window", rooms: ["bed-2"] }] } as unknown as FloorPlanPrior;
const RAIL: PhaseRailState = { current: "suppress", steps: ["done", "done", "done", "done", "current", "upcoming", "upcoming", "upcoming"].map((state, i) => ({ id: i as never, state: state as never, gate: "none" })), halt: null, caption: "Waiting to spray the kitchen fire" };

function record(overrides: Record<string, unknown> = {}, action: Record<string, unknown> = { kind: "breach_opening", openingId: "win-3", strikePoint: { x: 4.25, y: -1.5, z: 1.1 } }): ProposalRecord {
  return {
    proposal: { id: "p-12", digest: DIGEST, createdTick: 4000, expiresTick: 6000, action },
    risk: "consequential", status: "awaiting_approval", approval: null, execution: null, findings: [],
    history: [{ tick: 4000, status: "awaiting_approval", reason: DISCLOSURE, ruleIds: [] }],
    ...overrides,
  } as unknown as ProposalRecord;
}

function view(overrides: Partial<ScreenView> = {}): ScreenView {
  return { runId: "run-1", status: "running", tick: 4800, pendingApproval: null, proposals: [], belief: { mapPrior: PRIOR }, ...overrides };
}

describe("priority", () => {
  test("no view is no run; an aborted mission shows aborted even with a decision pending", () => {
    assert.deepEqual(deriveScreen({ view: null, rail: null, armed: false }), { kind: "no_run" });
    assert.equal(deriveScreen({ view: view({ status: "aborted", pendingApproval: record() }), rail: RAIL, armed: true }).kind, "aborted");
  });

  test("before authorization the console stands by; while running it follows the phase rail", () => {
    assert.deepEqual(deriveScreen({ view: view({ status: "awaiting_authorization" }), rail: RAIL, armed: false }), { kind: "standby", caption: "Waiting for mission authorization" });
    const phase = deriveScreen({ view: view(), rail: RAIL, armed: false });
    assert.deepEqual(phase, { kind: "phase", phase: "suppress", index: 5, label: "SUPPRESS FIRE", caption: RAIL.caption, steps: ["done", "done", "done", "done", "current", "upcoming", "upcoming", "upcoming"], halt: null });
  });

  test("a halt on the rail is named in a word", () => {
    const halted = deriveScreen({ view: view(), rail: { ...RAIL, halt: { kind: "contingency", contingency: "alternate_route", reason: "x" } }, armed: false });
    assert.equal(halted.kind === "phase" && halted.halt, "REROUTE");
  });
});

describe("pending decision", () => {
  test("a breach card carries the harness's coverage, the first unseen place, target, countdown and digest", () => {
    const spec = deriveScreen({ view: view({ pendingApproval: record() }), rail: RAIL, armed: true });
    assert.deepEqual(spec, {
      kind: "pending", action: "breach_opening", title: "BREAK GLASS", target: "Rear bedroom window", coverage: 0.82, note: "Unseen: inside under the sill",
      // 1200 of 2000 ticks left: 12 s, ring 0.6 rounded up to the next of 12 steps.
      secondsLeft: 12, ring: Math.ceil(0.6 * RING_STEPS) / RING_STEPS, digestPrefix: "1a2b3c4d", armed: true,
    });
    assert.equal(screenDigest(spec, view({ pendingApproval: record() })), DIGEST);
  });

  test("during the review delay the same card is held", () => {
    const spec = deriveScreen({ view: view({ pendingApproval: record() }), rail: RAIL, armed: false });
    assert.equal(spec.kind === "pending" && spec.armed, false);
  });

  test("a spray shows its dose and aim; without a coverage disclosure the note says the harness rechecks", () => {
    const spray = record({ history: [{ tick: 4000, status: "awaiting_approval", reason: "Validated: this consequential action awaits the commander's individual approval.", ruleIds: [] }] }, { kind: "spray", flowLps: 0.4, durationTicks: 300, aimPoint: { x: 1, y: 2, z: 0.5 } });
    const spec = deriveScreen({ view: view({ pendingApproval: spray }), rail: RAIL, armed: true });
    assert.equal(spec.kind, "pending");
    if (spec.kind !== "pending") return;
    assert.equal(spec.title, "SPRAY WATER");
    assert.equal(spec.target, "1.20 L at (1.0, 2.0, 0.5)");
    assert.equal(spec.coverage, null);
    assert.equal(spec.note, "Harness rechecks before and during execution");
  });

  test("everything seen is reported as such; an expired window shows zero", () => {
    const seen = record({ history: [{ tick: 4000, status: "awaiting_approval", reason: "Validated: this consequential action awaits the commander's individual approval. Debris region coverage: 100% of 40 required samples searched. No required part is unseen.", ruleIds: [] }] });
    const spec = deriveScreen({ view: view({ pendingApproval: seen, tick: 7000 }), rail: RAIL, armed: true });
    assert.equal(spec.kind === "pending" && spec.note, "Nothing required unseen");
    assert.equal(spec.kind === "pending" && spec.secondsLeft, 0);
    assert.equal(spec.kind === "pending" && spec.ring, 0);
  });
});

describe("decisions just made", () => {
  const approved = (by: string, tick: number) => record({ status: "executing", approval: { commanderId: by }, history: [{ tick: 4000, status: "awaiting_approval", reason: DISCLOSURE, ruleIds: [] }, { tick, status: "approved", reason: `Approved by ${by}`, ruleIds: [] }] });

  test("an approval from the console shows APPROVED via console for CONFIRM_TICKS, then the rail again", () => {
    const by = "commander-1 (Free-WiLi console)";
    assert.deepEqual(deriveScreen({ view: view({ proposals: [approved(by, 4700)] }), rail: RAIL, armed: false }), { kind: "approved", action: "breach_opening", title: "BREAK GLASS", by, viaConsole: true });
    assert.equal(deriveScreen({ view: view({ proposals: [approved(by, 4800 - CONFIRM_TICKS - 1)] }), rail: RAIL, armed: false }).kind, "phase");
  });

  test("an approval from the screen is attributed to the screen; a rejection names who rejected", () => {
    const screen = deriveScreen({ view: view({ proposals: [approved("commander-1", 4700)] }), rail: RAIL, armed: false });
    assert.equal(screen.kind === "approved" && screen.viaConsole, false);
    const rejected = record({ status: "rejected", history: [{ tick: 4750, status: "rejected", reason: "Rejected by commander-1 (Free-WiLi console): Commander rejected the proposal (Free-WiLi console, yellow button).", ruleIds: [] }] });
    assert.deepEqual(deriveScreen({ view: view({ proposals: [rejected] }), rail: RAIL, armed: false }), { kind: "rejected", action: "breach_opening", title: "BREAK GLASS", by: "commander-1 (Free-WiLi console)", viaConsole: true });
  });

  test("a waiting decision outranks a confirmation", () => {
    assert.equal(deriveScreen({ view: view({ proposals: [approved("c", 4790)], pendingApproval: record() }), rail: RAIL, armed: true }).kind, "pending");
  });
});

describe("device line (OG v024 overlay)", () => {
  const specs: ScreenSpec[] = [
    { kind: "no_run" }, { kind: "disconnected" }, { kind: "standby", caption: "x" },
    ...(["report", "approach", "access", "search", "suppress", "reassess", "guide", "outside"] as const).map(phase => ({ kind: "phase" as const, phase, index: 1, label: "", caption: "", steps: [], halt: null })),
    { kind: "phase", phase: "search", index: 4, label: "", caption: "", steps: [], halt: "REROUTE" },
    ...(["breach_opening", "spray", "release_payload"] as const).flatMap(action => [true, false].map(armed => ({ kind: "pending" as const, action, title: "", target: "", coverage: 0.5, note: "", secondsLeft: 1234, ring: 1, digestPrefix: "00000000", armed }))),
    { kind: "approved", action: "spray", title: "", by: "", viaConsole: true }, { kind: "rejected", action: "spray", title: "", by: "", viaConsole: false }, { kind: "aborted", caption: "" },
  ];

  test("every screen fits the overlay's 8 printable characters", () => {
    for (const spec of specs) {
      const text = overlayText(spec);
      assert.ok(text.length > 0 && text.length <= MAX_OVERLAY_CHARS, `${spec.kind}: "${text}"`);
      assert.match(text, /^[\x20-\x7e]+$/);
    }
  });

  test("a pending decision shows its kind and seconds left once armed, and a hold mark before", () => {
    const pending = (armed: boolean, secondsLeft: number): ScreenSpec => ({ kind: "pending", action: "breach_opening", title: "", target: "", coverage: null, note: "", secondsLeft, ring: 1, digestPrefix: "", armed });
    assert.equal(overlayText(pending(true, 12)), "GLASS 12");
    assert.equal(overlayText(pending(true, 400)), "GLASS 99");
    assert.equal(overlayText(pending(false, 12)), "GLASS ..");
    assert.equal(overlayText({ kind: "aborted", caption: "" }), "ABORTED");
  });
});
