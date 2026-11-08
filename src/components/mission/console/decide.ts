/**
 * Console gesture → the same UiCommand the action card and keyboard send. Pure and browser-safe.
 *
 * The console is only an input device for the human commander. A gesture is turned into a command with the
 * approval.ts builders, bound to the pending proposal's id and digest, and handed to the same `send` the
 * on-screen controls use; the worker and harness revalidate it like any other. On top of the screen's rules
 * (a decision for this live run, the digest the action card shows, the review delay since it appeared) the
 * console adds its own:
 * - the device display must have confirmed it is showing that same digest, and approve also waits the review
 *   delay from that confirmation, so the commander has seen the proposal on whichever screen they read;
 * - one approve or reject per digest from the console: repeated presses send nothing more;
 * - approve and reject are refused while a dialog covers the screen (the action card cannot be clicked then);
 * - abort (the e-stop) needs only a live run.
 * The commander id carries the source, e.g. "commander-1 (Free-WiLi console)", so the event log shows it.
 */
import type { ProposalRecord } from "../../../lib/contracts/actions.ts";
import type { MissionView, UiCommand } from "../../../lib/mission/protocol.ts";
import type { DisplayedDigest } from "../approval.ts";
import { abortMissionCommand, approvalArmed, approveCommand, rejectCommand } from "../approval.ts";
import type { Gesture } from "./buttons.ts";

export const CONSOLE_SOURCE_LABEL = "Free-WiLi console";
export const CONSOLE_REJECT_REASON = "Commander rejected the proposal (Free-WiLi console, yellow button).";
export const CONSOLE_DOUBLE_PRESS_ABORT_REASON = "Commander pressed Abort (Free-WiLi console, red button pressed twice).";
export const CONSOLE_HOLD_ABORT_REASON = "Commander pressed Abort (Free-WiLi console, red button held).";

export function consoleCommanderId(commanderId: string): string {
  return `${commanderId} (${CONSOLE_SOURCE_LABEL})`;
}

export interface ConsoleDecisionContext {
  /** The current run (MissionUiState.runId); null when no run exists. */
  readonly runId: string | null;
  readonly view: Pick<MissionView, "runId" | "status" | "tick" | "config" | "pendingApproval"> | null;
  /** Commander id for abort before the first view arrives. */
  readonly commanderId: string;
  /** The digest the on-screen action card shows and since when (approval.ts noteDisplayed). */
  readonly screen: DisplayedDigest | null;
  /** The digest the device display confirmed it is showing, and since when; null when unconfirmed. */
  readonly device: DisplayedDigest | null;
  /** Digests the console already approved or rejected in this run. */
  readonly decided: ReadonlySet<string>;
  readonly dialogOpen: boolean;
  readonly nowMs: number;
}

export interface ConsoleDecision {
  readonly command: UiCommand | null;
  /** Why the gesture did or did not produce a command (shown on screen and on the device). */
  readonly reason: string;
  /** The digest this command decided, to add to `decided`. */
  readonly decidedDigest: string | null;
}

const none = (reason: string): ConsoleDecision => ({ command: null, reason, decidedDigest: null });

function liveRun(ctx: ConsoleDecisionContext): string | null {
  const view = ctx.view;
  if (ctx.runId === null) return null;
  if (view !== null && view.runId === ctx.runId && (view.status === "aborted" || view.status === "ended")) return null;
  return ctx.runId;
}

type Pending = { readonly view: NonNullable<ConsoleDecisionContext["view"]>; readonly record: ProposalRecord };

/** The decision both screens show, or why there is none to act on. */
function shownPending(ctx: ConsoleDecisionContext, verb: string): Pending | string {
  const view = ctx.view;
  if (view === null || ctx.runId === null || view.runId !== ctx.runId || liveRun(ctx) === null) return `No decision is waiting to ${verb}`;
  const record = view.pendingApproval;
  if (record === null) return `No decision is waiting to ${verb}`;
  if (ctx.dialogOpen) return "A dialog covers the action card; close it first";
  const digest = record.proposal.digest;
  if (ctx.screen?.digest !== digest) return "The decision on screen changed; review the new proposal first";
  if (ctx.device?.digest !== digest) return "The console display has not confirmed this proposal yet";
  if (ctx.decided.has(digest)) return "Already sent from the console for this proposal";
  return { view, record };
}

function attributed(view: Pending["view"]) {
  return { runId: view.runId, tick: view.tick, config: { ...view.config, commanderId: consoleCommanderId(view.config.commanderId) } };
}

function approve(ctx: ConsoleDecisionContext): ConsoleDecision {
  const pending = shownPending(ctx, "approve");
  if (typeof pending === "string") return none(pending);
  const digest = pending.record.proposal.digest;
  if (!approvalArmed(ctx.screen, digest, ctx.nowMs) || !approvalArmed(ctx.device, digest, ctx.nowMs)) {
    return none("Review delay: Approve arms shortly after a decision appears");
  }
  return { command: approveCommand(attributed(pending.view), pending.record), reason: `Approve ${pending.record.proposal.id}`, decidedDigest: digest };
}

function reject(ctx: ConsoleDecisionContext): ConsoleDecision {
  const pending = shownPending(ctx, "reject");
  if (typeof pending === "string") return none(pending);
  return { command: rejectCommand(attributed(pending.view), pending.record, CONSOLE_REJECT_REASON), reason: `Reject ${pending.record.proposal.id}`, decidedDigest: pending.record.proposal.digest };
}

function abort(ctx: ConsoleDecisionContext, via: "double_press" | "hold"): ConsoleDecision {
  const runId = liveRun(ctx);
  if (runId === null) return none("No live run to abort");
  const view = ctx.view !== null && ctx.view.runId === runId ? ctx.view : null;
  const tick = view === null ? 0 : view.tick;
  const commanderId = consoleCommanderId(view === null ? ctx.commanderId : view.config.commanderId);
  const reason = via === "hold" ? CONSOLE_HOLD_ABORT_REASON : CONSOLE_DOUBLE_PRESS_ABORT_REASON;
  return { command: abortMissionCommand(runId, commanderId, tick, reason), reason: "Abort", decidedDigest: null };
}

/** Interpret one console gesture. */
export function decideGesture(gesture: Gesture, ctx: ConsoleDecisionContext): ConsoleDecision {
  switch (gesture.kind) {
    case "approve": return approve(ctx);
    case "reject": return reject(ctx);
    case "abort": return abort(ctx, gesture.via);
    case "abort_primed": return none(liveRun(ctx) === null ? "No live run to abort" : "Press red again (or keep holding) to abort the mission");
  }
}
