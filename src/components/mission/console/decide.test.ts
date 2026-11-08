/**
 * Console gestures → commands. Scope: an approval from the console is exactly the action card's approve
 * command (same builder, proposal id and digest, view tick) with the source in the commander id; it is refused
 * for a stale or changed proposal, before the review delay on either screen, before the device display
 * confirmed the digest, under a dialog, after the run ended, and a second time for the same digest. Abort needs
 * only a live run.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalRecord } from "../../../lib/contracts/actions.ts";
import type { MissionView } from "../../../lib/mission/protocol.ts";
import { APPROVAL_ARMING_MS, approveCommand, noteDisplayed, rejectCommand } from "../approval.ts";
import type { ConsoleDecisionContext } from "./decide.ts";
import { CONSOLE_DOUBLE_PRESS_ABORT_REASON, CONSOLE_HOLD_ABORT_REASON, CONSOLE_REJECT_REASON, consoleCommanderId, decideGesture } from "./decide.ts";

const RUN = "run-7";
const COMMANDER = "commander-9";
const DIGEST = "d".repeat(64);
const ARMED = APPROVAL_ARMING_MS;

function pending(id = "p-breach", digest = DIGEST): ProposalRecord {
  return { proposal: { id, digest, action: { kind: "breach_opening" } }, risk: "consequential", status: "awaiting_approval", approval: null, execution: null, findings: [], history: [] } as unknown as ProposalRecord;
}

type View = NonNullable<ConsoleDecisionContext["view"]>;

function view(record: ProposalRecord | null, overrides: Partial<View> = {}): View {
  return { runId: RUN, status: "running", tick: 4321, config: { commanderId: COMMANDER } as MissionView["config"], pendingApproval: record, ...overrides };
}

/** Both screens have shown the pending digest since t = 0. */
function ctx(nowMs: number, record: ProposalRecord | null = pending(), overrides: Partial<ConsoleDecisionContext> = {}): ConsoleDecisionContext {
  const shown = noteDisplayed(null, record?.proposal.digest ?? null, 0);
  return { runId: RUN, view: view(record), commanderId: "fallback", screen: shown, device: shown, decided: new Set(), dialogOpen: false, nowMs, ...overrides };
}

const APPROVE = { kind: "approve" } as const;
const REJECT = { kind: "reject" } as const;

describe("approve from the console", () => {
  test("is the action card's approve command, bound to the digest, with the source in the commander id", () => {
    const record = pending();
    const result = decideGesture(APPROVE, ctx(ARMED, record));
    const card = approveCommand(view(record), record);
    assert.deepEqual(result.command, { ...card, commanderId: "commander-9 (Free-WiLi console)" });
    assert.deepEqual(result.command, { type: "approve", runId: RUN, proposalId: "p-breach", digest: DIGEST, commanderId: consoleCommanderId(COMMANDER), tick: 4321 });
    assert.equal(result.decidedDigest, DIGEST);
  });

  test("waits for the review delay on the action card", () => {
    const result = decideGesture(APPROVE, ctx(ARMED - 1));
    assert.equal(result.command, null);
    assert.match(result.reason, /Review delay/);
  });

  test("waits for the review delay from when the device display confirmed the proposal", () => {
    const result = decideGesture(APPROVE, ctx(ARMED + 50, pending(), { device: noteDisplayed(null, DIGEST, 100) }));
    assert.equal(result.command, null);
    assert.ok(decideGesture(APPROVE, ctx(ARMED + 100, pending(), { device: noteDisplayed(null, DIGEST, 100) })).command !== null);
  });

  test("is refused while the device display has not confirmed this proposal", () => {
    for (const device of [null, noteDisplayed(null, "e".repeat(64), 0)]) {
      const result = decideGesture(APPROVE, ctx(ARMED * 5, pending(), { device }));
      assert.equal(result.command, null);
      assert.match(result.reason, /console display has not confirmed/);
    }
  });

  test("a stale proposal is refused: the pending digest changed after the screens showed the old one", () => {
    const old = noteDisplayed(null, DIGEST, 0);
    const changed = pending("p-breach", "f".repeat(64));
    const result = decideGesture(APPROVE, ctx(ARMED * 5, changed, { screen: old, device: old }));
    assert.equal(result.command, null);
    assert.match(result.reason, /changed/);
  });

  test("repeated presses for the same digest send nothing more", () => {
    const result = decideGesture(APPROVE, ctx(ARMED, pending(), { decided: new Set([DIGEST]) }));
    assert.equal(result.command, null);
    assert.match(result.reason, /Already sent/);
  });

  test("is refused while a dialog covers the action card", () => {
    assert.equal(decideGesture(APPROVE, ctx(ARMED, pending(), { dialogOpen: true })).command, null);
  });

  test("is refused with no decision, for another run's view, or once the run is over", () => {
    assert.equal(decideGesture(APPROVE, ctx(ARMED, null)).command, null);
    assert.equal(decideGesture(APPROVE, ctx(ARMED, pending(), { runId: "run-8" })).command, null);
    for (const status of ["aborted", "ended"] as const) {
      assert.equal(decideGesture(APPROVE, ctx(ARMED, pending(), { view: view(pending(), { status }) })).command, null);
    }
  });
});

describe("reject from the console", () => {
  test("is the card's reject builder with the console reason and attributed commander, no review delay", () => {
    const record = pending();
    const result = decideGesture(REJECT, ctx(0, record));
    const card = rejectCommand(view(record), record, CONSOLE_REJECT_REASON);
    assert.deepEqual(result.command, { ...card, commanderId: consoleCommanderId(COMMANDER) });
  });

  test("still needs both screens to show this digest", () => {
    assert.equal(decideGesture(REJECT, ctx(0, pending(), { device: null })).command, null);
  });
});

describe("abort from the console", () => {
  test("aborts the live run, attributed, with the gesture in the reason", () => {
    const hold = decideGesture({ kind: "abort", via: "hold" }, ctx(0, null));
    assert.deepEqual(hold.command, { type: "abort", runId: RUN, scope: "mission", by: consoleCommanderId(COMMANDER), tick: 4321, reason: CONSOLE_HOLD_ABORT_REASON });
    const double = decideGesture({ kind: "abort", via: "double_press" }, ctx(0, null));
    assert.equal(double.command?.type === "abort" && double.command.reason, CONSOLE_DOUBLE_PRESS_ABORT_REASON);
  });

  test("is available under a dialog and before any view, but not after the run ended", () => {
    assert.ok(decideGesture({ kind: "abort", via: "hold" }, ctx(0, pending(), { dialogOpen: true, device: null })).command !== null);
    const early = decideGesture({ kind: "abort", via: "hold" }, ctx(0, null, { view: null }));
    assert.deepEqual(early.command, { type: "abort", runId: RUN, scope: "mission", by: consoleCommanderId("fallback"), tick: 0, reason: CONSOLE_HOLD_ABORT_REASON });
    assert.equal(decideGesture({ kind: "abort", via: "hold" }, ctx(0, null, { view: view(null, { status: "ended" }) })).command, null);
  });

  test("a primed abort sends nothing", () => {
    assert.equal(decideGesture({ kind: "abort_primed" }, ctx(0)).command, null);
  });
});
