/**
 * Commander decisions shared by the action card and the keyboard shortcuts: one review delay and one way to
 * build approve, reject and abort commands. Pure and browser-safe.
 *
 * An approval binds to the exact proposal id and digest on screen, at the view tick the commander saw. The
 * worker and harness still check the digest, expiry and current evidence; these builders only make the UI's
 * request exact. Nothing here decides that an action is safe.
 */
import type { AbortCommand, ApproveCommand, ProposalRecord, RejectCommand } from "../../lib/contracts/actions.ts";
import type { MissionView } from "../../lib/mission/protocol.ts";

/** A newly displayed proposal cannot be approved until it has been on screen this long. */
export const APPROVAL_ARMING_MS = 900;
export const DEFAULT_REJECT_REASON = "Commander rejected the proposal.";
export const DEFAULT_ABORT_REASON = "Commander pressed Abort.";

export type DecisionView = Pick<MissionView, "runId" | "tick" | "config">;

/** Approve exactly the proposal shown: its id and digest, by this run's commander, at the view tick. */
export function approveCommand(view: DecisionView, record: ProposalRecord): ApproveCommand {
  return { type: "approve", runId: view.runId, proposalId: record.proposal.id, digest: record.proposal.digest, commanderId: view.config.commanderId, tick: view.tick };
}

/** Reject the proposal shown; a blank reason becomes the default. */
export function rejectCommand(view: DecisionView, record: ProposalRecord, reason?: string): RejectCommand {
  const text = reason?.trim() ?? "";
  return { type: "reject", runId: view.runId, proposalId: record.proposal.id, commanderId: view.config.commanderId, tick: view.tick, reason: text === "" ? DEFAULT_REJECT_REASON : text };
}

/** Abort the whole mission: stop remaining actuation and select a supported contingency. */
export function abortMissionCommand(runId: string, commanderId: string, tick: number, reason: string = DEFAULT_ABORT_REASON): AbortCommand {
  return { type: "abort", runId, scope: "mission", by: commanderId, tick, reason };
}

/** When a proposal digest was first displayed (monotonic wall-clock ms). */
export interface DisplayedDigest {
  readonly digest: string;
  readonly sinceMs: number;
}

/** Keep the first-seen time while the displayed digest is unchanged; a new digest restarts the review delay. */
export function noteDisplayed(previous: DisplayedDigest | null, digest: string | null, nowMs: number): DisplayedDigest | null {
  if (digest === null) return null;
  return previous !== null && previous.digest === digest ? previous : { digest, sinceMs: nowMs };
}

/** Approve is armed only for the digest on screen, once it has been displayed for APPROVAL_ARMING_MS. */
export function approvalArmed(displayed: DisplayedDigest | null, digest: string, nowMs: number): boolean {
  return displayed !== null && displayed.digest === digest && nowMs - displayed.sinceMs >= APPROVAL_ARMING_MS;
}
