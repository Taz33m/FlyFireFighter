/**
 * Commander keyboard shortcuts: pure and browser-safe. A key becomes the same UiCommand the on-screen
 * controls send (approval.ts builds both), so every approval still goes through the worker and harness.
 *
 * Mapping:
 * - A: approve the decision on the action card, only after its review delay, and only the digest on screen.
 * - R: reject the decision on the action card.
 * - Esc, Esc (two taps within ABORT_DOUBLE_TAP_MS): abort the mission. Escape is the key a person reaches
 *   for to stop something and can be hit without looking, so a deliberate double tap is fast. A single
 *   reflexive Esc (closing a menu or the Q&A drawer) does nothing, and an Esc burst that began while a dialog
 *   was open or focus was in a field never counts, so mashing Esc to close the drawer cannot abort. Shifted
 *   Escape was rejected because Chrome on Windows and ChromeOS reserves Shift+Esc for its task manager.
 *   The on-screen Abort button stays the primary control.
 *
 * Ignored: key repeats, modifier combinations (Ctrl/Cmd/Alt/Shift), IME composition, keys typed into
 * input/textarea/select/contenteditable, and every key while a <dialog> is open.
 */
import type { MissionView, UiCommand } from "../../lib/mission/protocol.ts";
import type { DisplayedDigest } from "./approval.ts";
import { abortMissionCommand, approvalArmed, approveCommand, rejectCommand } from "./approval.ts";

export const ABORT_DOUBLE_TAP_MS = 600;
export const KEYBOARD_REJECT_REASON = "Commander rejected the proposal (keyboard shortcut R).";
export const KEYBOARD_ABORT_REASON = "Commander pressed Abort (keyboard shortcut Esc Esc).";

/** The keys, for on-screen hints. */
export const COMMANDER_KEYS = { approve: "A", reject: "R", abort: "Esc Esc" } as const;

export interface KeyTargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

/** The parts of a KeyboardEvent this module reads. */
export interface KeyEventLike {
  readonly key: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly target: KeyTargetLike | null;
}

/** Double-tap memory for the abort key. */
export interface EscapeMemory {
  /** When an eligible first Esc primed abort. */
  readonly primedAtMs: number | null;
  /** When an Esc last arrived that could not count (dialog open, in a field, repeat, modifier, burst). */
  readonly lastBlockedAtMs: number | null;
}

export const NO_ESCAPE: EscapeMemory = { primedAtMs: null, lastBlockedAtMs: null };

export interface CommanderKeyContext {
  /** The current run (MissionUiState.runId); null when no run exists. */
  readonly runId: string | null;
  readonly view: Pick<MissionView, "runId" | "status" | "tick" | "config" | "pendingApproval"> | null;
  /** Commander id for abort when no view has arrived yet (approve and reject use view.config). */
  readonly commanderId: string;
  /** The digest the action card shows and since when; approval.ts noteDisplayed. */
  readonly displayed: DisplayedDigest | null;
  readonly dialogOpen: boolean;
  /** Monotonic wall clock, ms. */
  readonly nowMs: number;
  readonly escape: EscapeMemory;
}

export interface KeyResult {
  readonly command: UiCommand | null;
  readonly escape: EscapeMemory;
  /** Why the key did or did not produce a command (for tests and an optional on-screen hint). */
  readonly reason: string;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);
const EDITABLE_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditableTarget(target: KeyTargetLike | null): boolean {
  if (target === null) return false;
  return EDITABLE_TAGS.has((target.tagName ?? "").toUpperCase()) || target.isContentEditable === true;
}

function blockReason(event: KeyEventLike, ctx: CommanderKeyContext): string | null {
  if (event.isComposing === true || event.key === "Process") return "IME composition in progress";
  if (event.repeat) return "Key repeat ignored";
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return "Modifier combination ignored";
  if (isEditableTarget(event.target)) return "Typing in a field";
  if (ctx.dialogOpen) return "A dialog is open";
  return null;
}

/** The current run while it can still be aborted; a view from another run says nothing about this one. */
function liveRun(ctx: CommanderKeyContext): string | null {
  const view = ctx.view;
  if (ctx.runId === null) return null;
  if (view !== null && view.runId === ctx.runId && (view.status === "aborted" || view.status === "ended")) return null;
  return ctx.runId;
}

/** The decision on the action card for the current run, if any. */
function pendingFor(ctx: CommanderKeyContext) {
  const view = ctx.view;
  if (view === null || ctx.runId === null || view.runId !== ctx.runId || liveRun(ctx) === null) return null;
  const record = view.pendingApproval;
  return record === null ? null : { view, record };
}

type Decision = Pick<KeyResult, "command" | "reason">;

function approveKey(ctx: CommanderKeyContext): Decision {
  const pending = pendingFor(ctx);
  if (pending === null) return { command: null, reason: "No decision is waiting for approval" };
  const digest = pending.record.proposal.digest;
  if (ctx.displayed?.digest !== digest) return { command: null, reason: "The decision on screen changed; review the new proposal first" };
  if (!approvalArmed(ctx.displayed, digest, ctx.nowMs)) return { command: null, reason: "Review delay: Approve arms shortly after a decision appears" };
  return { command: approveCommand(pending.view, pending.record), reason: `Approve ${pending.record.proposal.id}` };
}

function rejectKey(ctx: CommanderKeyContext): Decision {
  const pending = pendingFor(ctx);
  if (pending === null) return { command: null, reason: "No decision is waiting to reject" };
  if (ctx.displayed?.digest !== pending.record.proposal.digest) return { command: null, reason: "The decision on screen changed; review the new proposal first" };
  return { command: rejectCommand(pending.view, pending.record, KEYBOARD_REJECT_REASON), reason: `Reject ${pending.record.proposal.id}` };
}

function escapeKey(ctx: CommanderKeyContext): KeyResult {
  const runId = liveRun(ctx);
  if (runId === null) return { command: null, escape: NO_ESCAPE, reason: "No live run to abort" };
  const { primedAtMs, lastBlockedAtMs } = ctx.escape;
  if (primedAtMs !== null && ctx.nowMs - primedAtMs >= 0 && ctx.nowMs - primedAtMs <= ABORT_DOUBLE_TAP_MS) {
    const tick = ctx.view !== null && ctx.view.runId === runId ? ctx.view.tick : 0;
    const commanderId = ctx.view !== null && ctx.view.runId === runId ? ctx.view.config.commanderId : ctx.commanderId;
    return { command: abortMissionCommand(runId, commanderId, tick, KEYBOARD_ABORT_REASON), escape: NO_ESCAPE, reason: "Abort" };
  }
  if (lastBlockedAtMs !== null && ctx.nowMs - lastBlockedAtMs >= 0 && ctx.nowMs - lastBlockedAtMs < ABORT_DOUBLE_TAP_MS) {
    // Part of a burst that started by closing a dialog or leaving a field: extend the burst, never prime.
    return { command: null, escape: { primedAtMs: null, lastBlockedAtMs: ctx.nowMs }, reason: "Esc burst after closing a dialog or leaving a field; pause, then press Esc twice to abort" };
  }
  return { command: null, escape: { primedAtMs: ctx.nowMs, lastBlockedAtMs: null }, reason: "Press Esc again to abort the mission" };
}

/** Interpret one keydown. Returns the command to send (or null) and the next Esc double-tap memory. */
export function interpretKey(event: KeyEventLike, ctx: CommanderKeyContext): KeyResult {
  if (MODIFIER_KEYS.has(event.key)) return { command: null, escape: ctx.escape, reason: "Modifier key" };
  const isEscape = event.key === "Escape";
  const blocked = blockReason(event, ctx);
  if (blocked !== null) return { command: null, escape: isEscape ? { primedAtMs: null, lastBlockedAtMs: ctx.nowMs } : { ...ctx.escape, primedAtMs: null }, reason: blocked };
  if (isEscape) return escapeKey(ctx);
  // Any other key breaks an Esc double tap.
  const escape: EscapeMemory = { ...ctx.escape, primedAtMs: null };
  const key = event.key.toLowerCase();
  if (key === "a") return { ...approveKey(ctx), escape };
  if (key === "r") return { ...rejectKey(ctx), escape };
  return { command: null, escape, reason: "Not a commander shortcut" };
}

/** `interpretKey(...).command`, for callers that track no Esc memory of their own. */
export function commandForKey(event: KeyEventLike, ctx: CommanderKeyContext): UiCommand | null {
  return interpretKey(event, ctx).command;
}
