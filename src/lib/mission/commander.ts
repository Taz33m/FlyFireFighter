/**
 * Scripted commander for batch comparisons and tests (PRD §8: a bounded, repeatable commander policy).
 *
 * It sees only what the action card shows (proposal records) and answers each proposal that awaits approval
 * a fixed number of ticks after it started waiting: approve, or reject when its action kind is configured
 * for rejection. It issues ordinary approve/reject commands through the same path as the UI, binds each
 * approval to the digest it was shown, and stops after maxDecisions. In UI mode there is no scripted
 * commander: the runtime waits for the human. Its decision delay is simulated time, not human decision time.
 */
import type { ActionKind, ApproveCommand, ProposalRecord, RejectCommand } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import type { CommanderId, ProposalId, RunId } from "../contracts/ids.ts";

export interface ScriptedCommanderConfig {
  readonly commanderId: CommanderId;
  /** Ticks between a proposal starting to await approval and the commander's answer. */
  readonly answerAfterTicks: number;
  /** Action kinds the commander rejects instead of approving. */
  readonly rejectKinds?: readonly ActionKind[];
  /** Upper bound on decisions in one run. */
  readonly maxDecisions?: number;
}

export const DEFAULT_SCRIPTED_COMMANDER: ScriptedCommanderConfig = Object.freeze({ commanderId: "scripted-commander", answerAfterTicks: 300, maxDecisions: 16 });

export class ScriptedCommander {
  readonly config: ScriptedCommanderConfig;
  private readonly answered = new Set<ProposalId>();

  constructor(config: ScriptedCommanderConfig = DEFAULT_SCRIPTED_COMMANDER) {
    this.config = config;
  }

  get decisions(): number {
    return this.answered.size;
  }

  /** Commands to issue at this tick boundary. */
  decide(runId: RunId, records: readonly ProposalRecord[], tick: Tick): (ApproveCommand | RejectCommand)[] {
    const out: (ApproveCommand | RejectCommand)[] = [];
    const limit = this.config.maxDecisions ?? Infinity;
    for (const record of records) {
      if (this.answered.size >= limit) break;
      if (record.status !== "awaiting_approval" || this.answered.has(record.proposal.id)) continue;
      const since = awaitingSince(record);
      if (since === null || tick - since < this.config.answerAfterTicks) continue;
      this.answered.add(record.proposal.id);
      const proposalId = record.proposal.id;
      if ((this.config.rejectKinds ?? []).includes(record.proposal.action.kind)) {
        out.push({ type: "reject", runId, proposalId, commanderId: this.config.commanderId, tick, reason: `scripted policy rejects ${record.proposal.action.kind}` });
      } else {
        out.push({ type: "approve", runId, proposalId, digest: record.proposal.digest, commanderId: this.config.commanderId, tick });
      }
    }
    return out;
  }
}

function awaitingSince(record: ProposalRecord): Tick | null {
  for (let i = record.history.length - 1; i >= 0; i--) if (record.history[i].status === "awaiting_approval") return record.history[i].tick;
  return null;
}
