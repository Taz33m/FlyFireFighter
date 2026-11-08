/**
 * The deterministic action harness: proposal lifecycle, rules, per-action approvals, monitored execution,
 * idempotent execution requests, abort and reset.
 *
 * Every proposer — cloud or local planner, operator — submits through `submit`; the commander path calls
 * `approve`, `reject` and `abort`. Contingencies are the harness's own: `startContingency` (and a mission
 * abort) selects the maneuver from current evidence, validates it under the same rules and starts it in the
 * same tick; submit() refuses the "contingency" proposer from any caller, so the contingency exemptions
 * cannot be claimed by labelling a proposal. `step` runs exactly once per simulation tick and
 * returns the only actuator output: a batch registered by issueBatch. Commands never actuate directly.
 * The harness reads the truth-free belief snapshot, never simulator truth.
 *
 * Reset is a new ActionHarness with a new run id. Commands that carry another run id are refused, except
 * abort, which is always honored and applies to the current run.
 */
import type {
  AbortCommand,
  ActionProposal,
  ActuationEffects,
  ActuatorBatch,
  ActuatorCommand,
  Approval,
  ApproveCommand,
  Contingency,
  ExecuteCommand,
  ExecutionRecord,
  Finding,
  MotionCommand,
  MotionRequest,
  ProposalInput,
  ProposalRecord,
  ProposalStatus,
  RejectCommand,
  RiskClass,
} from "../contracts/actions.ts";
import { TERMINAL_STATUSES } from "../contracts/actions.ts";
import type { JsonValue } from "../contracts/canonical.ts";
import { digestOf } from "../contracts/canonical.ts";
import type { Tick } from "../contracts/clock.ts";
import type { EventLog } from "../contracts/events.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import type { ProposalId, RunId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import { parseProposalInput } from "../contracts/schema.ts";
import type { ContingencyTrigger } from "./contingency.ts";
import { contingencyProposalInput, selectContingency } from "./contingency.ts";
import { affectedRegion } from "./effects.ts";
import type { ExecutionCursor } from "./execution.ts";
import { executeTick, initialCursor, NO_EFFECTS } from "./execution.ts";
import { issueBatch } from "./issued.ts";
import type { MotionGuardState } from "./motion-guard.ts";
import { guardMotion } from "./motion-guard.ts";
import type { HarnessContext } from "./policy.ts";
import { INTERVENTION_KINDS, MOTION_KINDS, riskClassOf } from "./policy.ts";
import { sprayDischarges } from "./respray.ts";
import type { RuleState, ValidationPhase } from "./rules.ts";
import type { BreachCoverageAssessment } from "./rules.ts";
import { breachCoverageAssessment, finding, fireClassDisclosure, isContingencyAction, validateProposal } from "./rules.ts";

export interface SubmitResult {
  /** True when a record was created and passed submission checks. */
  readonly accepted: boolean;
  /** Null when the submission was refused before a record could be created (schema or run mismatch). */
  readonly proposalId: ProposalId | null;
  readonly digest: string | null;
  readonly risk: RiskClass | null;
  readonly status: ProposalStatus;
  readonly findings: readonly Finding[];
  /** Always false: only step() issues actuator commands. */
  readonly actuated: boolean;
}

export interface CommandResult {
  readonly accepted: boolean;
  readonly proposalId: ProposalId;
  /** Status after the command; null when the proposal is unknown to this run. */
  readonly status: ProposalStatus | null;
  readonly findings: readonly Finding[];
  readonly reason: string;
  /** Always false: only step() issues actuator commands. */
  readonly actuated: boolean;
}

export interface ExecutionResult extends CommandResult {
  /** An execution already existed or the record was terminal; the request was recorded and nothing repeated. */
  readonly duplicate: boolean;
}

export interface AbortResult {
  /** Abort is always accepted. */
  readonly accepted: true;
  readonly scope: "mission" | ProposalId;
  readonly runIdMismatch: boolean;
  /** Executing actions stopped; their effects so far stay recorded. */
  readonly stopped: readonly ProposalId[];
  /** Pending proposals withdrawn. */
  readonly cancelled: readonly ProposalId[];
  /**
   * Mission scope only: the contingency in force after the abort — the selected maneuver, which the harness
   * has already validated and started, or an explicit failure (the harness then brakes and descends).
   */
  readonly contingency: Contingency | null;
  /**
   * Mission scope only: the harness-created contingency proposal — executing when started, rejected or
   * invalidated when the harness refused it (contingency is then a failure). Null when no proposal was
   * made (an unsupported selection, or a proposal-scope abort).
   */
  readonly contingencyRecord: ProposalRecord | null;
  readonly findings: readonly Finding[];
  readonly reason: string;
  /** Always false: abort only stops actuation. */
  readonly actuated: boolean;
}

export interface ContingencyStartResult {
  readonly trigger: ContingencyTrigger;
  /** The maneuver selected from current evidence, before the harness validated it. */
  readonly selected: Contingency;
  /**
   * The contingency in force: the selected maneuver when it validated and started; otherwise an explicit
   * failure naming why (no supported maneuver, or the harness's own rules refused the selected one).
   */
  readonly contingency: Contingency;
  /** The harness-created contingency proposal (executing when started, rejected or invalidated when refused); null when none was proposed. */
  readonly record: ProposalRecord | null;
  /** Why the selected maneuver was refused; empty when it started. */
  readonly findings: readonly Finding[];
  readonly terminalFailure: boolean;
  /** Always false: only step() issues actuator commands. */
  readonly actuated: boolean;
}

type CommandName = "approve" | "reject" | "execute";
type Lookup = { readonly record: ProposalRecord } | { readonly refusal: CommandResult };
type AbortOutcome = Pick<AbortResult, "scope" | "stopped" | "cancelled" | "contingency" | "contingencyRecord" | "reason">;
type EventData = { readonly [key: string]: JsonValue };

interface TransitionChange {
  readonly findings?: readonly Finding[];
  readonly approval?: Approval;
  readonly execution?: ExecutionRecord | null;
  readonly data?: EventData;
}

const PENDING: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>(["proposed", "validated", "awaiting_approval", "approved"]);
const SPRAY_OR_BREACH: ReadonlySet<string> = new Set(["spray", "breach_opening"]);
const STILL: MotionCommand = deepFreeze({ velocityBody: { x: 0, y: 0, z: 0 }, yawRateRadps: 0 });
const COMMAND_LABELS: Readonly<Record<CommandName, string>> = { approve: "Approval", reject: "Rejection", execute: "Execution request" };

export class ActionHarness {
  readonly runId: RunId;
  private readonly log: EventLog;
  private readonly entries = new Map<ProposalId, ProposalRecord>();
  private readonly regions = new Map<ProposalId, Region | null>();
  private readonly cursors = new Map<ProposalId, ExecutionCursor>();
  private sequence = 0;
  private aborted = false;
  private failure = false;
  private lastInterventionTick: Tick | null = null;
  private lastTick = 0;
  private lastStepTick = -1;
  private previousMotion: MotionCommand = STILL;

  constructor(runId: RunId, log: EventLog) {
    if (log.runId !== runId) throw new RangeError(`The event log belongs to run ${log.runId}, not ${runId}.`);
    this.runId = runId;
    this.log = log;
  }

  get missionAborted(): boolean {
    return this.aborted;
  }

  get terminalFailure(): boolean {
    return this.failure;
  }

  /**
   * Tick of the most recent spray or breach that changed the world; while a spray is executing, the given
   * current tick, because conditions are still changing. Route assessments must postdate it to support
   * guidance (H15), so route assessors and planners read it here.
   */
  lastInterventionAt(tick: Tick): Tick | null {
    const sprayInProgress = this.executing().some(r => r.proposal.action.kind === "spray");
    return sprayInProgress ? tick : this.lastInterventionTick;
  }

  record(id: ProposalId): ProposalRecord | null {
    return this.entries.get(id) ?? null;
  }

  records(): readonly ProposalRecord[] {
    return Object.freeze([...this.entries.values()]);
  }

  /** The executing motion action and the goal the motion controller steers toward (null goal: hold position). */
  activeMotion(): { proposal: ActionProposal; goal: Vec3 | null } | null {
    const record = this.executing().find(r => MOTION_KINDS.has(r.proposal.action.kind));
    if (!record) return null;
    return { proposal: record.proposal, goal: this.cursors.get(record.proposal.id)?.goal ?? null };
  }

  submit(input: unknown, ctx: HarnessContext): SubmitResult {
    const stale = this.staleClock(ctx);
    if (stale) return this.refuseSubmission(this.lastTick, [stale]);
    this.advanceClock(ctx);
    const parsed = parseProposalInput(input);
    if (!parsed.ok) return this.refuseSubmission(ctx.tick, parsed.errors.map(error => finding("schema", error)));
    if (parsed.value.runId !== this.runId) {
      return this.refuseSubmission(ctx.tick, [finding("run", `The proposal belongs to run ${parsed.value.runId}; this harness controls run ${this.runId}.`)]);
    }
    if (parsed.value.proposer === "contingency") {
      return this.refuseSubmission(ctx.tick, [finding("authority", "Only the harness proposes contingencies (startContingency or a mission abort); a submitted proposal cannot claim the contingency proposer.")]);
    }
    const record = this.register(parsed.value, ctx);
    const findings = this.validate("submit", record, ctx);
    const next = findings.length > 0
      ? this.transition(record, "rejected", ctx.tick, describeFindings("Rejected at submission", findings), { findings })
      : this.accept(record, ctx.tick, ctx);
    return { accepted: findings.length === 0, proposalId: next.proposal.id, digest: next.proposal.digest, risk: next.risk, status: next.status, findings, actuated: false };
  }

  approve(cmd: ApproveCommand, ctx: HarnessContext): CommandResult {
    const found = this.lookup(cmd.proposalId, cmd.runId, "approve", ctx);
    if ("refusal" in found) return found.refusal;
    const { record } = found;
    const { proposal } = record;
    if (record.risk === "routine") {
      return this.refuse(ctx.tick, "approve", record, [finding("H5", "Routine actions have no approval path; they run inside the mission envelope.")]);
    }
    if (record.status !== "awaiting_approval") {
      return this.refuse(ctx.tick, "approve", record, [finding("lifecycle", `The proposal is ${record.status}; only a proposal awaiting approval can be approved.`)]);
    }
    if (cmd.digest !== proposal.digest) {
      return this.refuse(ctx.tick, "approve", record, [finding("H5", "The approval digest does not match the stored proposal; the commander approves exactly the proposal shown.")]);
    }
    if (ctx.tick > proposal.expiresTick) return this.expireOnCommand(record, ctx.tick, finding("H17", `The proposal expired at tick ${proposal.expiresTick}.`));
    const findings = this.validate("approve", record, ctx);
    if (findings.length > 0) return this.invalidateOnCommand(record, ctx.tick, describeFindings("Invalidated at approval", findings), findings);
    const approval: Approval = {
      runId: this.runId,
      proposalId: proposal.id,
      digest: proposal.digest,
      commanderId: cmd.commanderId,
      issuedTick: ctx.tick,
      expiresTick: Math.min(ctx.tick + ctx.policy.approvalTtlTicks, proposal.expiresTick),
    };
    const disclosure = this.breachDisclosure(record, ctx);
    const agent = fireClassDisclosure(proposal.action, ctx);
    const reason = `Approved by ${cmd.commanderId}; execution must start by tick ${approval.expiresTick}.${disclosure ? ` ${disclosure.text}` : ""}${agent ? ` ${agent}` : ""}`;
    const next = this.transition(record, "approved", ctx.tick, reason, { approval, data: { approval: json(approval), commandTick: cmd.tick, ...(disclosure ? { coverage: json(disclosure) } : {}) } });
    return commandResult(true, next, [], reason);
  }

  reject(cmd: RejectCommand, ctx: HarnessContext): CommandResult {
    const found = this.lookup(cmd.proposalId, cmd.runId, "reject", ctx);
    if ("refusal" in found) return found.refusal;
    const { record } = found;
    if (isTerminal(record.status)) return this.refuse(ctx.tick, "reject", record, [finding("lifecycle", `The proposal is already ${record.status}.`)]);
    if (record.status === "executing") return this.refuse(ctx.tick, "reject", record, [finding("lifecycle", "An executing action is stopped with abort, not reject.")]);
    const reason = `Rejected by ${cmd.commanderId}: ${cmd.reason}`;
    const next = this.transition(record, "rejected", ctx.tick, reason, { data: { commanderId: cmd.commanderId, commandTick: cmd.tick } });
    return commandResult(true, next, [], reason);
  }

  requestExecution(cmd: ExecuteCommand, ctx: HarnessContext): ExecutionResult {
    const found = this.lookup(cmd.proposalId, cmd.runId, "execute", ctx);
    if ("refusal" in found) return { ...found.refusal, duplicate: false };
    const { record } = found;
    if (record.execution || isTerminal(record.status)) return this.ignoreDuplicate(record, cmd, ctx.tick);
    const blocked = this.executionGate(record, cmd, ctx);
    return { ...(blocked ?? this.startExecution(record, cmd.requestId, ctx)), duplicate: false };
  }

  /** Advance one simulation tick: expiry, monitored execution, guarded motion. Call exactly once per tick. */
  step(ctx: HarnessContext, request: MotionRequest | null): ActuatorBatch {
    if (ctx.tick <= this.lastStepTick || ctx.tick < this.lastTick) {
      throw new RangeError(`step() runs once per tick on a forward clock: got tick ${ctx.tick} after step ${this.lastStepTick} and tick ${this.lastTick}.`);
    }
    this.lastStepTick = ctx.tick;
    this.advanceClock(ctx);
    this.expirePending(ctx.tick);
    const commands: ActuatorCommand[] = [];
    for (const record of this.executionOrder()) commands.push(...this.advance(record.proposal.id, ctx));
    const motion = guardMotion(request, ctx, this.motionState());
    this.previousMotion = motion ? motion.executed : STILL;
    return issueBatch({ runId: this.runId, tick: ctx.tick, motion, commands });
  }

  /**
   * Select the contingency for `trigger` from current evidence, validate it under the harness's rules and
   * start it in this tick, preempting any executing motion action. When nothing supported remains, or the
   * rules refuse the selected maneuver, the harness records an explicit failure, stops every action and
   * brakes and descends; it never leaves the aircraft holding on an unsupported maneuver. After a terminal
   * failure nothing further is started.
   */
  startContingency(trigger: ContingencyTrigger, ctx: HarnessContext): ContingencyStartResult {
    const tick = Math.max(ctx.tick, this.lastTick);
    this.advanceClock(ctx);
    return this.beginContingency(trigger, ctx, tick);
  }

  /**
   * Always accepted. Stops remaining actuation; completed effects (spent water, a delivered strike) stay
   * recorded. A mission-scope abort also starts the selected contingency in the same tick (startContingency
   * with trigger commander_abort) and returns it with its record.
   */
  abort(cmd: AbortCommand, ctx: HarnessContext): AbortResult {
    const tick = Math.max(ctx.tick, this.lastTick);
    this.advanceClock(ctx);
    const mismatch = cmd.runId !== this.runId;
    const findings: Finding[] = [];
    if (mismatch) {
      findings.push(finding("run", `The abort carried run ${cmd.runId}; abort is always honored, so it was applied to the current run ${this.runId}.`));
      this.append(tick, "abort.run_mismatch", findings[0].reason, ["H13"], { carriedRunId: cmd.runId, scope: cmd.scope }, null);
    }
    const reason = `Abort by ${cmd.by}: ${cmd.reason}`;
    const outcome = cmd.scope === "mission" ? this.abortMission(ctx, tick, reason) : { ...this.abortProposal(cmd.scope, tick, reason), contingencyRecord: null };
    return { accepted: true, runIdMismatch: mismatch, findings, actuated: false, ...outcome };
  }

  /* Submission. */

  private register(input: ProposalInput, ctx: HarnessContext): ProposalRecord {
    this.sequence += 1;
    const copy = structuredClone(input);
    const proposal = deepFreeze<ActionProposal>({ ...copy, id: `${this.runId}/p${this.sequence}`, digest: digestOf(copy) });
    this.regions.set(proposal.id, affectedRegion(proposal.action, ctx.profile, ctx.belief.mapPrior));
    const reason = `Proposed by ${proposal.proposer}: ${proposal.action.kind}. Rationale: ${proposal.rationale}`;
    const record = deepFreeze<ProposalRecord>({
      proposal,
      risk: riskClassOf(proposal.action.kind),
      status: "proposed",
      approval: null,
      execution: null,
      findings: [],
      history: [{ tick: ctx.tick, status: "proposed", reason, ruleIds: [] }],
    });
    this.entries.set(proposal.id, record);
    this.append(ctx.tick, "proposal.proposed", reason, [], { ...this.recordData(record), proposal: json(proposal) }, proposal.id);
    return record;
  }

  private accept(record: ProposalRecord, tick: Tick, ctx?: HarnessContext): ProposalRecord {
    if (record.risk === "routine") {
      return this.transition(record, "validated", tick, "Validated: a routine action runs inside the mission envelope without individual approval.");
    }
    const disclosure = ctx ? this.breachDisclosure(record, ctx) : null;
    const agent = ctx ? fireClassDisclosure(record.proposal.action, ctx) : null;
    const reason = `Validated: this consequential action awaits the commander's individual approval.${disclosure ? ` ${disclosure.text}` : ""}${agent ? ` ${agent}` : ""}`;
    return this.transition(record, "awaiting_approval", tick, reason, disclosure ? { data: { coverage: json(disclosure) } } : {});
  }

  /**
   * For a breach, how much of the debris region a fresh person search covered and where the unseen part
   * lies — shown to the commander with the proposal and at approval (the PRD's explicit modeled effects).
   */
  private breachDisclosure(record: ProposalRecord, ctx: HarnessContext): BreachCoverageAssessment | null {
    const action = record.proposal.action;
    const region = this.regions.get(record.proposal.id) ?? null;
    if (action.kind !== "breach_opening" || region === null) return null;
    return breachCoverageAssessment(action, region, ctx);
  }

  private refuseSubmission(tick: Tick, findings: readonly Finding[]): SubmitResult {
    const reason = `Submission refused: ${findings.map(f => f.reason).join(" ")}`;
    this.append(tick, "command.refused", reason, ruleIdsOf(findings), { command: "submit", findings: json(findings) }, null);
    return { accepted: false, proposalId: null, digest: null, risk: null, status: "rejected", findings, actuated: false };
  }

  /* Execution requests. */

  private executionGate(record: ProposalRecord, cmd: ExecuteCommand, ctx: HarnessContext): CommandResult | null {
    if (cmd.digest !== record.proposal.digest) {
      return this.refuse(ctx.tick, "execute", record, [finding("H5", "The execution request's digest does not match the stored proposal.")]);
    }
    const authority = this.authorityGate(record, ctx);
    if (authority) return authority;
    const conflict = this.conflictFor(record);
    if (conflict && !preempts(record.proposal)) {
      const group = MOTION_KINDS.has(conflict.proposal.action.kind) ? "motion" : "intervention";
      return this.refuse(ctx.tick, "execute", record, [finding("concurrency", `${conflict.proposal.id} (${conflict.proposal.action.kind}) is executing; only one ${group} action executes at a time.`)]);
    }
    const findings = this.validate("execute", record, ctx);
    if (findings.length > 0) return this.invalidateOnCommand(record, ctx.tick, describeFindings("Invalidated before execution", findings), findings);
    return null;
  }

  /** Routine actions execute from validated; consequential actions need a live approval of this exact proposal. */
  private authorityGate(record: ProposalRecord, ctx: HarnessContext): CommandResult | null {
    const { proposal, approval } = record;
    if (record.risk === "routine") {
      if (record.status !== "validated") return this.refuse(ctx.tick, "execute", record, [finding("lifecycle", `The proposal is ${record.status}; a routine action executes from validated.`)]);
      return ctx.tick > proposal.expiresTick ? this.expireOnCommand(record, ctx.tick, finding("H17", `The proposal expired at tick ${proposal.expiresTick}.`)) : null;
    }
    if (record.status !== "approved" || !approval) {
      return this.refuse(ctx.tick, "execute", record, [finding("H5", `This consequential action is ${record.status}; it needs the commander's individual approval before it can execute.`)]);
    }
    if (ctx.tick > approval.expiresTick) {
      return this.expireOnCommand(record, ctx.tick, finding("H5", `The approval expired at tick ${approval.expiresTick}; a new proposal and approval are required.`));
    }
    return null;
  }

  private conflictFor(record: ProposalRecord): ProposalRecord | null {
    const kind = record.proposal.action.kind;
    const group = MOTION_KINDS.has(kind) ? MOTION_KINDS : INTERVENTION_KINDS.has(kind) ? INTERVENTION_KINDS : null;
    if (!group) return null;
    return this.executing().find(r => group.has(r.proposal.action.kind)) ?? null;
  }

  private startExecution(record: ProposalRecord, requestId: string, ctx: HarnessContext): CommandResult {
    const conflict = this.conflictFor(record);
    if (conflict) {
      const preemption = `Preempted by contingency ${record.proposal.id} (${record.proposal.action.kind}).`;
      this.finishExecution(conflict, "aborted", ctx.tick, preemption, [finding("contingency", preemption)]);
    }
    const execution: ExecutionRecord = { proposalId: record.proposal.id, startedTick: ctx.tick, endedTick: null, requestIds: [requestId], effects: NO_EFFECTS, stopReason: null };
    this.cursors.set(record.proposal.id, initialCursor(record.proposal, ctx));
    const reason = `Execution started for request ${requestId}; monitored every tick.`;
    const next = this.transition(record, "executing", ctx.tick, reason, { execution, data: { requestId } });
    return commandResult(true, next, [], reason);
  }

  private ignoreDuplicate(record: ProposalRecord, cmd: ExecuteCommand, tick: Tick): ExecutionResult {
    const execution = record.execution;
    const current = execution ? this.replaceExecution(record, { ...execution, requestIds: [...execution.requestIds, cmd.requestId] }) : record;
    const state = execution ? `its execution already ${record.status === "executing" ? "is running" : "ended"}` : `the proposal is ${record.status}`;
    const reason = `Duplicate execution request ignored (${cmd.requestId}): ${state}; effects are never repeated.`;
    this.append(tick, "execution.duplicate_ignored", reason, ["idempotency"], { proposalId: record.proposal.id, requestId: cmd.requestId, status: record.status }, record.proposal.id);
    return { ...commandResult(false, current, [], reason), duplicate: true };
  }

  /* Monitored execution. */

  private advance(id: ProposalId, ctx: HarnessContext): readonly ActuatorCommand[] {
    const record = this.entries.get(id);
    if (!record || record.status !== "executing" || !record.execution) return [];
    const findings = this.validate("monitor", record, ctx);
    if (findings.length > 0) {
      this.finishExecution(record, "invalidated", ctx.tick, describeFindings("Stopped during execution", findings), findings);
      return [];
    }
    const outcome = executeTick(record.proposal, record.execution.effects, this.cursors.get(id) ?? initialCursor(record.proposal, ctx), ctx);
    this.cursors.set(id, outcome.cursor);
    if (outcome.complete) this.finishExecution(record, "completed", ctx.tick, completionReason(record.proposal, outcome.effects), [], outcome.effects);
    else this.replaceExecution(record, { ...record.execution, effects: outcome.effects });
    return outcome.commands;
  }

  private finishExecution(record: ProposalRecord, status: "completed" | "invalidated" | "aborted", tick: Tick, reason: string, findings: readonly Finding[], effects?: ActuationEffects): ProposalRecord {
    const final = effects ?? record.execution?.effects ?? NO_EFFECTS;
    const execution = record.execution ? { ...record.execution, endedTick: tick, effects: final, stopReason: status === "completed" ? null : reason } : null;
    if (SPRAY_OR_BREACH.has(record.proposal.action.kind) && (final.waterDischargedL > 0 || final.strikeDelivered)) this.lastInterventionTick = tick;
    this.cursors.delete(record.proposal.id);
    return this.transition(record, status, tick, reason, { findings, execution, data: { effects: json(final) } });
  }

  private expirePending(tick: Tick): void {
    for (const record of [...this.entries.values()]) {
      if (!PENDING.has(record.status)) continue;
      const lapse = expiryFinding(record, tick);
      if (lapse) this.transition(record, "expired", tick, lapse.reason, { findings: [lapse] });
    }
  }

  private executing(): ProposalRecord[] {
    return [...this.entries.values()].filter(r => r.status === "executing");
  }

  /** Interventions and speech first, so motion actions monitored in the same tick see this tick's effects. */
  private executionOrder(): ProposalRecord[] {
    const executing = this.executing();
    const isMotion = (r: ProposalRecord): boolean => MOTION_KINDS.has(r.proposal.action.kind);
    return [...executing.filter(r => !isMotion(r)), ...executing.filter(isMotion)];
  }

  private motionState(): MotionGuardState {
    const executing = this.executing();
    const motion = executing.find(r => MOTION_KINDS.has(r.proposal.action.kind));
    return {
      activeMotion: motion ? motion.proposal : null,
      interventionActive: executing.some(r => INTERVENTION_KINDS.has(r.proposal.action.kind)),
      sprayActive: executing.some(r => r.proposal.action.kind === "spray"),
      missionAborted: this.aborted,
      terminalFailure: this.failure,
      previous: this.previousMotion,
    };
  }

  /* Abort. */

  private abortMission(ctx: HarnessContext, tick: Tick, reason: string): AbortOutcome {
    const { stopped, cancelled } = this.stopAll(tick, reason);
    this.aborted = true;
    this.append(tick, "mission.aborted", `${reason} Mission aborted: ${stopped.length} executing action(s) stopped, ${cancelled.length} pending proposal(s) withdrawn.`, ["H13", "H16"], { stopped, cancelled }, null);
    const started = this.beginContingency("commander_abort", ctx, tick);
    const contingency = started.contingency;
    const summary = `${reason} Mission aborted: ${stopped.length} executing action(s) stopped, ${cancelled.length} pending proposal(s) withdrawn. Contingency: ${contingency.kind} — ${contingency.reason}`;
    return { scope: "mission", stopped, cancelled, contingency, contingencyRecord: started.record, reason: summary };
  }

  /** Stop every executing action and withdraw every pending proposal; completed effects stay recorded. */
  private stopAll(tick: Tick, reason: string): { stopped: ProposalId[]; cancelled: ProposalId[] } {
    const stopped: ProposalId[] = [];
    const cancelled: ProposalId[] = [];
    const abortFinding = finding("H13", reason);
    for (const record of [...this.entries.values()]) {
      if (record.status === "executing") {
        this.finishExecution(record, "aborted", tick, reason, [abortFinding]);
        stopped.push(record.proposal.id);
      } else if (PENDING.has(record.status)) {
        this.transition(record, "aborted", tick, reason, { findings: [abortFinding] });
        cancelled.push(record.proposal.id);
      }
    }
    return { stopped, cancelled };
  }

  /** Contingency selection must always complete; a failing selector yields an explicit failure contingency instead of an exception. */
  private selectSafely(ctx: HarnessContext, trigger: ContingencyTrigger): Contingency {
    try {
      return selectContingency(ctx, trigger, this.holdsSpentSinceProgress());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failureContingency(ctx, `Contingency selection failed: ${message}`, []);
    }
  }

  /** Select, validate and start a contingency, or record the explicit failure (see startContingency). */
  /** Contingency holds that have already run to their end, since the latest contingency that was not a hold. */
  private holdsSpentSinceProgress(): number {
    let holds = 0;
    for (const record of [...this.records()].reverse()) {
      if (record.proposal.proposer !== "contingency") continue;
      if (record.proposal.action.kind !== "hold") break;
      if (TERMINAL_STATUSES.includes(record.status)) holds += 1;
    }
    return holds;
  }

  private beginContingency(trigger: ContingencyTrigger, ctx: HarnessContext, tick: Tick): ContingencyStartResult {
    const selected = this.selectSafely(ctx, trigger);
    if (this.failure) {
      const contingency = failureContingency(ctx, `A terminal failure is already recorded; no contingency is started after it (trigger: ${trigger}).`, []);
      return { trigger, selected, contingency, record: null, findings: [], terminalFailure: true, actuated: false };
    }
    let input: ProposalInput | null = null;
    try {
      input = contingencyProposalInput(selected, ctx);
    } catch (error) {
      return this.failContingency(trigger, selected, null, [finding("contingency", `The contingency proposal could not be built: ${error instanceof Error ? error.message : String(error)}`)], ctx, tick);
    }
    if (input === null) return this.failContingency(trigger, selected, null, [], ctx, tick);
    const parsed = parseProposalInput(input);
    if (!parsed.ok) return this.failContingency(trigger, selected, null, parsed.errors.map(error => finding("schema", error)), ctx, tick);
    const record = this.register(parsed.value, ctx);
    const refusedAtSubmit = this.validate("submit", record, ctx);
    if (refusedAtSubmit.length > 0) {
      const rejected = this.transition(record, "rejected", tick, describeFindings("Contingency rejected at submission", refusedAtSubmit), { findings: refusedAtSubmit });
      return this.failContingency(trigger, selected, rejected, refusedAtSubmit, ctx, tick);
    }
    const validated = this.accept(record, tick);
    const refusedAtExecute = this.validate("execute", validated, ctx);
    if (refusedAtExecute.length > 0) {
      const invalidated = this.transition(validated, "invalidated", tick, describeFindings("Contingency invalidated before execution", refusedAtExecute), { findings: refusedAtExecute });
      return this.failContingency(trigger, selected, invalidated, refusedAtExecute, ctx, tick);
    }
    this.startExecution(validated, `${validated.proposal.id}#contingency`, ctx);
    const started = this.entries.get(validated.proposal.id) ?? validated;
    this.logContingency(tick, trigger, selected, selected, started, []);
    return { trigger, selected, contingency: selected, record: started, findings: [], terminalFailure: false, actuated: false };
  }

  /**
   * No supported maneuver: record the explicit failure, stop every action, mark the mission aborted and fly
   * the harness's unsupported terminal behaviour (brake and descend), never an assumed hover.
   */
  private failContingency(trigger: ContingencyTrigger, selected: Contingency, record: ProposalRecord | null, findings: readonly Finding[], ctx: HarnessContext, tick: Tick): ContingencyStartResult {
    const contingency = selected.kind === "failure" && findings.length === 0
      ? selected
      : failureContingency(ctx, `The selected ${selected.kind} contingency could not run: ${findings.map(f => `${f.ruleId} ${f.reason}`).join(" ") || "no proposal could be built"} (${selected.reason})`, selected.evidenceIds);
    this.failure = true;
    if (!this.aborted) {
      const reason = `Terminal failure after ${trigger}: no supported maneuver remains.`;
      this.stopAll(tick, reason);
      this.aborted = true;
    }
    this.logContingency(tick, trigger, selected, contingency, record, findings);
    return { trigger, selected, contingency, record, findings, terminalFailure: true, actuated: false };
  }

  private logContingency(tick: Tick, trigger: ContingencyTrigger, selected: Contingency, contingency: Contingency, record: ProposalRecord | null, findings: readonly Finding[]): void {
    const started = contingency.kind !== "failure" && record !== null;
    const reason = started
      ? `Contingency ${contingency.kind} started (trigger: ${trigger}): ${contingency.reason}`
      : `Contingency failure (trigger: ${trigger}): ${contingency.reason}`;
    this.append(tick, "contingency.selected", reason, ["H13", ...ruleIdsOf(findings)], {
      trigger,
      kind: contingency.kind,
      selectedKind: selected.kind,
      termination: contingency.termination,
      evidenceIds: [...contingency.evidenceIds],
      proposalId: record?.proposal.id ?? null,
      status: record?.status ?? null,
      findings: json(findings),
      terminalFailure: this.failure,
    }, record?.proposal.id ?? null);
  }

  private abortProposal(scope: ProposalId, tick: Tick, reason: string): Omit<AbortOutcome, "contingencyRecord"> {
    const record = this.entries.get(scope);
    if (!record || isTerminal(record.status)) {
      const note = record ? `${scope} is already ${record.status}; abort never undoes completed effects.` : `No proposal ${scope} exists in run ${this.runId}; nothing to stop.`;
      this.append(tick, "abort.noop", `${reason} ${note}`, ["H13"], { scope }, scope);
      return { scope, stopped: [], cancelled: [], contingency: null, reason: `${reason} ${note}` };
    }
    const abortFinding = finding("H13", reason);
    if (record.status === "executing") {
      this.finishExecution(record, "aborted", tick, reason, [abortFinding]);
      return { scope, stopped: [scope], cancelled: [], contingency: null, reason };
    }
    this.transition(record, "aborted", tick, reason, { findings: [abortFinding] });
    return { scope, stopped: [], cancelled: [scope], contingency: null, reason };
  }

  /* Shared plumbing. */

  private lookup(proposalId: ProposalId, runId: RunId, command: CommandName, ctx: HarnessContext): Lookup {
    const stale = this.staleClock(ctx);
    if (stale) return { refusal: this.refuse(this.lastTick, command, null, [stale], proposalId) };
    this.advanceClock(ctx);
    if (runId !== this.runId) {
      const reason = `The command belongs to run ${runId}; this harness controls run ${this.runId}. Approvals and replies from another run cannot act.`;
      return { refusal: this.refuse(ctx.tick, command, null, [finding("run", reason)], proposalId) };
    }
    const record = this.entries.get(proposalId);
    if (!record) return { refusal: this.refuse(ctx.tick, command, null, [finding("lifecycle", `No proposal ${proposalId} exists in run ${this.runId}.`)], proposalId) };
    return { record };
  }

  private refuse(tick: Tick, command: CommandName, record: ProposalRecord | null, findings: readonly Finding[], proposalId?: ProposalId): CommandResult {
    const id = record ? record.proposal.id : (proposalId ?? "");
    const status = record ? record.status : null;
    const reason = `${COMMAND_LABELS[command]} refused: ${findings.map(f => f.reason).join(" ")}`;
    this.append(tick, "command.refused", reason, ruleIdsOf(findings), { command, proposalId: id, status, findings: json(findings) }, id);
    return { accepted: false, proposalId: id, status, findings, reason, actuated: false };
  }

  private expireOnCommand(record: ProposalRecord, tick: Tick, lapse: Finding): CommandResult {
    const next = this.transition(record, "expired", tick, lapse.reason, { findings: [lapse] });
    return commandResult(false, next, [lapse], lapse.reason);
  }

  private invalidateOnCommand(record: ProposalRecord, tick: Tick, reason: string, findings: readonly Finding[]): CommandResult {
    const next = this.transition(record, "invalidated", tick, reason, { findings });
    return commandResult(false, next, findings, reason);
  }

  private validate(phase: ValidationPhase, record: ProposalRecord, ctx: HarnessContext): Finding[] {
    return validateProposal({ phase, proposal: record.proposal, ctx, state: this.ruleState(ctx), status: record.status, approval: record.approval });
  }

  private ruleState(ctx: HarnessContext): RuleState {
    // A spray in progress keeps changing conditions, so no route assessment can postdate it yet.
    const entries = this.entries;
    return {
      runId: this.runId,
      missionAborted: this.aborted,
      lastInterventionTick: this.lastInterventionAt(ctx.tick),
      // Read only by H14 (submit, approval, execution), so not rebuilt on every monitored tick.
      get sprays() {
        return sprayDischarges([...entries.values()]);
      },
    };
  }

  private transition(record: ProposalRecord, status: ProposalStatus, tick: Tick, reason: string, change: TransitionChange = {}): ProposalRecord {
    const findings = change.findings ?? [];
    const ruleIds = ruleIdsOf(findings);
    const next = deepFreeze<ProposalRecord>({
      ...record,
      status,
      approval: change.approval ?? record.approval,
      execution: change.execution === undefined ? record.execution : change.execution,
      findings: [...findings],
      history: [...record.history, { tick, status, reason, ruleIds }],
    });
    this.entries.set(record.proposal.id, next);
    this.append(tick, `proposal.${status}`, reason, ruleIds, { ...this.recordData(next), ...change.data }, record.proposal.id);
    return next;
  }

  private replaceExecution(record: ProposalRecord, execution: ExecutionRecord): ProposalRecord {
    const next = deepFreeze<ProposalRecord>({ ...record, execution });
    this.entries.set(record.proposal.id, next);
    return next;
  }

  private recordData(record: ProposalRecord): EventData {
    const { proposal } = record;
    return {
      proposalId: proposal.id,
      actionKind: proposal.action.kind,
      proposer: proposal.proposer,
      risk: record.risk,
      status: record.status,
      digest: proposal.digest,
      findings: json(record.findings),
      affectedRegion: json(this.regions.get(proposal.id) ?? null),
    };
  }

  /** Harness events never move the shared log's clock backwards. */
  private append(tick: Tick, kind: string, reason: string, ruleIds: readonly string[], data: EventData, subject: string | null): void {
    const last = this.log.since(this.log.length - 1)[0];
    this.log.append({ tick: last ? Math.max(tick, last.tick) : tick, source: "harness", kind, subject, ruleIds, reason, data });
  }

  private staleClock(ctx: HarnessContext): Finding | null {
    if (ctx.tick >= this.lastTick) return null;
    return finding("clock", `The command's context is at tick ${ctx.tick}, before tick ${this.lastTick} already processed; the mission clock does not run backwards.`);
  }

  private advanceClock(ctx: HarnessContext): void {
    this.lastTick = Math.max(this.lastTick, ctx.tick);
  }
}

/** An explicit failure: brake and descend, labelled as unsupported (never safe). */
function failureContingency(ctx: HarnessContext, reason: string, evidenceIds: readonly string[]): Contingency {
  const descent = Math.min(ctx.policy.terminalDescentMps, ctx.profile.hardLimits.maxVerticalSpeedMps);
  return {
    kind: "failure",
    terminalBehavior: "brake_and_descend",
    reason: `${reason} No supported maneuver remains.`,
    evidenceIds: [...evidenceIds],
    termination: `Mission failure recorded. Brake and descend at ${Math.round(descent * 100) / 100} m/s until ground contact; this is an unsupported terminal behaviour, not a safe landing.`,
  };
}

function preempts(proposal: ActionProposal): boolean {
  return MOTION_KINDS.has(proposal.action.kind) && isContingencyAction(proposal);
}

function expiryFinding(record: ProposalRecord, tick: Tick): Finding | null {
  if (record.approval && tick > record.approval.expiresTick) return finding("H5", `The approval expired at tick ${record.approval.expiresTick} before execution started.`);
  if (tick > record.proposal.expiresTick) return finding("H17", `The proposal expired at tick ${record.proposal.expiresTick}.`);
  return null;
}

function commandResult(accepted: boolean, record: ProposalRecord, findings: readonly Finding[], reason: string): CommandResult {
  return { accepted, proposalId: record.proposal.id, status: record.status, findings, reason, actuated: false };
}

function completionReason(proposal: ActionProposal, effects: ActuationEffects): string {
  switch (proposal.action.kind) {
    case "spray":
      return `Completed: discharged ${Math.round(effects.waterDischargedL * 1e6) / 1e6} L over ${effects.ticksExecuted} ticks.`;
    case "breach_opening":
      return "Completed: one glass strike delivered.";
    case "release_payload":
      return "Completed: payload released; release does not establish receipt or use.";
    case "speak":
      return `Completed: template ${proposal.action.templateId} played.`;
    case "guide":
      return `Completed: guidance ran ${effects.ticksExecuted} ticks and issued ${effects.cuesIssued} cues.`;
    default:
      return `Completed after ${effects.ticksExecuted} ticks.`;
  }
}

function isTerminal(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function ruleIdsOf(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map(f => f.ruleId))];
}

function describeFindings(prefix: string, findings: readonly Finding[]): string {
  return `${prefix}: ${findings.map(f => `${f.ruleId} ${f.reason}`).join(" ")}`;
}

/** Plain JSON copy for event data (contract values are plain data). */
function json(value: unknown): JsonValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
}
