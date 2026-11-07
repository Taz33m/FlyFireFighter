/**
 * Commander keys: a shortcut sends exactly what the on-screen controls send, and only when the commander
 * clearly meant it — never while typing, on a repeat, with a modifier, under the Q&A dialog, before the
 * review delay, for a digest that is not on screen, or after the run is over.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalRecord } from "../../lib/contracts/actions.ts";
import type { MissionView, UiCommand } from "../../lib/mission/protocol.ts";
import { APPROVAL_ARMING_MS, approveCommand, noteDisplayed, rejectCommand } from "./approval.ts";
import type { CommanderKeyContext, EscapeMemory, KeyEventLike } from "./commander-keys.ts";
import { ABORT_DOUBLE_TAP_MS, KEYBOARD_ABORT_REASON, KEYBOARD_REJECT_REASON, NO_ESCAPE, commandForKey, interpretKey } from "./commander-keys.ts";

const RUN = "run-7";
const COMMANDER = "commander-9";

function pending(id = "p-breach", digest = "d".repeat(64)): ProposalRecord {
  return { proposal: { id, digest, action: { kind: "breach_opening" } }, risk: "consequential", status: "awaiting_approval", approval: null, execution: null, findings: [], history: [] } as unknown as ProposalRecord;
}

type KeyView = NonNullable<CommanderKeyContext["view"]>;

function view(record: ProposalRecord | null, overrides: Partial<KeyView> = {}): KeyView {
  return { runId: RUN, status: "running", tick: 4321, config: { commanderId: COMMANDER } as MissionView["config"], pendingApproval: record, ...overrides };
}

const BODY = { tagName: "BODY" };

function key(k: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: BODY, ...extra };
}

/** Context with the pending decision displayed since t = 0 and the clock at `nowMs`. */
function ctx(nowMs: number, record: ProposalRecord | null = pending(), overrides: Partial<CommanderKeyContext> = {}): CommanderKeyContext {
  return {
    runId: RUN,
    view: view(record),
    commanderId: "fallback-commander",
    displayed: noteDisplayed(null, record?.proposal.digest ?? null, 0),
    dialogOpen: false,
    nowMs,
    escape: NO_ESCAPE,
    ...overrides,
  };
}

const ARMED = APPROVAL_ARMING_MS;

describe("approve and reject keys", () => {
  test("A sends the same approve command as the action card, bound to the digest on screen", () => {
    const record = pending();
    const command = commandForKey(key("a"), ctx(ARMED, record));
    assert.deepEqual(command, approveCommand(view(record), record));
    assert.deepEqual(command, { type: "approve", runId: RUN, proposalId: "p-breach", digest: record.proposal.digest, commanderId: COMMANDER, tick: 4321 });
  });

  test("approve during the review delay is ignored", () => {
    assert.equal(commandForKey(key("a"), ctx(ARMED - 1)), null);
    assert.match(interpretKey(key("a"), ctx(ARMED - 1)).reason, /Review delay/);
  });

  test("approve is ignored when the proposal changed after the commander looked (a new digest restarts the delay)", () => {
    const shown = pending("p-old", "a".repeat(64));
    const replaced = pending("p-new", "b".repeat(64));
    // The card showed p-old for 5 s; p-new arrived in this view but has not been recorded as displayed.
    assert.equal(commandForKey(key("a"), ctx(5000, replaced, { displayed: noteDisplayed(null, shown.proposal.digest, 0) })), null);
    // Once displayed, p-new needs its own review delay.
    const displayed = noteDisplayed(noteDisplayed(null, shown.proposal.digest, 0), replaced.proposal.digest, 5000);
    assert.equal(commandForKey(key("a"), ctx(5000 + ARMED - 1, replaced, { displayed })), null);
    assert.equal((commandForKey(key("a"), ctx(5000 + ARMED, replaced, { displayed })) as { digest: string } | null)?.digest, replaced.proposal.digest);
  });

  test("approve and reject with no pending decision are ignored", () => {
    assert.equal(commandForKey(key("a"), ctx(10_000, null)), null);
    assert.equal(commandForKey(key("r"), ctx(10_000, null)), null);
  });

  test("approve is ignored for a view from another run (after a reset) and once the run is over", () => {
    const record = pending();
    assert.equal(commandForKey(key("a"), ctx(10_000, record, { runId: "run-8" })), null);
    for (const status of ["aborted", "ended"] as const) {
      assert.equal(commandForKey(key("a"), ctx(10_000, record, { view: view(record, { status }) })), null, status);
    }
  });

  test("R sends the action card's reject shape immediately, with a keyboard reason", () => {
    const record = pending();
    const command = commandForKey(key("r"), ctx(1, record));
    assert.deepEqual(command, rejectCommand(view(record), record, KEYBOARD_REJECT_REASON));
    assert.deepEqual(command, { type: "reject", runId: RUN, proposalId: "p-breach", commanderId: COMMANDER, tick: 4321, reason: KEYBOARD_REJECT_REASON });
  });

  test("caps-lock A still approves; Shift+A, Ctrl/Cmd+A, Alt+A and Cmd+R do not", () => {
    assert.equal(commandForKey(key("A"), ctx(ARMED))?.type, "approve");
    const mods: readonly Partial<KeyEventLike>[] = [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }];
    for (const mod of mods) {
      assert.equal(commandForKey(key(mod.shiftKey === true ? "A" : "a", mod), ctx(ARMED)), null, JSON.stringify(mod));
      assert.equal(commandForKey(key("r", mod), ctx(ARMED)), null, JSON.stringify(mod));
    }
  });
});

describe("keys that never act", () => {
  test("typing a or r in the report box, the reject reason, a select or a contenteditable sends nothing", () => {
    const fields = [{ tagName: "TEXTAREA" }, { tagName: "INPUT" }, { tagName: "input" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }];
    for (const target of fields) {
      for (const k of ["a", "r", "Escape"]) assert.equal(commandForKey(key(k, { target }), ctx(ARMED)), null, `${k} in ${target.tagName}`);
    }
  });

  test("a held key's repeats are ignored", () => {
    assert.equal(commandForKey(key("a", { repeat: true }), ctx(ARMED)), null);
    assert.equal(commandForKey(key("r", { repeat: true }), ctx(ARMED)), null);
  });

  test("nothing acts while the Q&A dialog is open", () => {
    for (const k of ["a", "r"]) assert.equal(commandForKey(key(k), ctx(ARMED, pending(), { dialogOpen: true })), null);
  });

  test("IME composition is ignored", () => {
    assert.equal(commandForKey(key("a", { isComposing: true }), ctx(ARMED)), null);
    assert.equal(commandForKey(key("Process"), ctx(ARMED)), null);
  });
});

/** Press keys in order at the given times, threading the Esc memory; returns the commands sent. */
function press(base: CommanderKeyContext, presses: readonly [number, KeyEventLike, Partial<CommanderKeyContext>?][]) {
  let escape: EscapeMemory = base.escape;
  const sent: UiCommand[] = [];
  for (const [at, event, extra] of presses) {
    const result = interpretKey(event, { ...base, ...extra, nowMs: at, escape });
    escape = result.escape;
    if (result.command !== null) sent.push(result.command);
  }
  return sent;
}

describe("abort (Esc, Esc)", () => {
  test("two taps abort the live run even with no pending decision; the shape matches the Abort button", () => {
    const sent = press(ctx(0, null), [[1000, key("Escape")], [1300, key("Escape")]]);
    assert.deepEqual(sent, [{ type: "abort", runId: RUN, scope: "mission", by: COMMANDER, tick: 4321, reason: KEYBOARD_ABORT_REASON }]);
  });

  test("a single Esc, or two taps too far apart, does not abort", () => {
    assert.deepEqual(press(ctx(0, null), [[1000, key("Escape")]]), []);
    assert.deepEqual(press(ctx(0, null), [[1000, key("Escape")], [1000 + ABORT_DOUBLE_TAP_MS + 1, key("Escape")]]), []);
  });

  test("another key between the taps breaks the double tap", () => {
    assert.deepEqual(press(ctx(0, null), [[1000, key("Escape")], [1100, key("x")], [1200, key("Escape")]]), []);
  });

  test("closing the Q&A dialog with Esc and mashing Esc afterwards never aborts", () => {
    const presses: [number, KeyEventLike, Partial<CommanderKeyContext>?][] = [[1000, key("Escape"), { dialogOpen: true }]];
    for (let t = 1200; t <= 4000; t += 200) presses.push([t, key("Escape")]);
    assert.deepEqual(press(ctx(0, null), presses), []);
    // After a pause the double tap works again.
    assert.equal(press(ctx(0, null), [...presses, [4000 + ABORT_DOUBLE_TAP_MS + 100, key("Escape")], [4000 + ABORT_DOUBLE_TAP_MS + 300, key("Escape")]]).length, 1);
  });

  test("Esc in a field, a held Esc and Shift+Esc never prime or confirm an abort", () => {
    assert.deepEqual(press(ctx(0, null), [[1000, key("Escape", { target: { tagName: "INPUT" } })], [1200, key("Escape", { target: { tagName: "INPUT" } })]]), []);
    assert.deepEqual(press(ctx(0, null), [[1000, key("Escape")], [1400, key("Escape", { repeat: true })], [1500, key("Escape", { repeat: true })]]), []);
    assert.deepEqual(press(ctx(0, null), [[1000, key("Escape", { shiftKey: true })], [1200, key("Escape", { shiftKey: true })]]), []);
  });

  test("abort is unavailable after the run ended or was aborted, and with no run", () => {
    for (const status of ["ended", "aborted"] as const) {
      assert.deepEqual(press(ctx(0, null, { view: view(null, { status }) }), [[1000, key("Escape")], [1200, key("Escape")]]), [], status);
    }
    assert.deepEqual(press(ctx(0, null, { runId: null, view: null }), [[1000, key("Escape")], [1200, key("Escape")]]), []);
  });

  test("a run whose first view has not arrived can still be aborted, by the configured commander at tick 0", () => {
    const sent = press(ctx(0, null, { view: null }), [[1000, key("Escape")], [1200, key("Escape")]]);
    assert.deepEqual(sent, [{ type: "abort", runId: RUN, scope: "mission", by: "fallback-commander", tick: 0, reason: KEYBOARD_ABORT_REASON }]);
  });
});
