/**
 * UI commands, applied by the runtime at a tick boundary in arrival order.
 *
 * - report: kept verbatim with its source, channel and tick; a rules interpretation adds a room hint and
 *   count language as text. A report changes search priority; it never creates a person.
 * - authorize_mission: the commander approves the preset's mission envelope (checked against hard limits).
 * - approve / reject: go to the harness, which binds approvals to the exact digest shown.
 * - abort: always honoured; the harness stops actuation and the runtime starts the selected contingency in
 *   the same tick.
 * - experiment: a documented simulator hook, logged with source "operator".
 * Commands that name another run are refused and logged (the harness does this itself for approve/reject),
 * except abort, which the harness always applies to the current run.
 */
import type { AbortCommand, ApproveCommand, RejectCommand } from "../contracts/actions.ts";
import type { AircraftProfile } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { hardLimitViolations } from "../contracts/envelope.ts";
import type { EventLog } from "../contracts/events.ts";
import type { RunId } from "../contracts/ids.ts";
import { interpretReport } from "../evidence/interpret.ts";
import type { EvidenceStore } from "../evidence/store.ts";
import type { AbortResult, ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { applyExperiment } from "../simulation/experiments.ts";
import type { WorldState } from "../simulation/world-state.ts";
import { describeExperiment, experimentData, toSimulationExperiment } from "./experiments.ts";
import type { UiCommand } from "./protocol.ts";
import type { MissionPreset } from "./scenario.ts";

export const MAX_REPORT_CHARS = 2000;

export interface CommandHost {
  readonly runId: RunId;
  readonly log: EventLog;
  readonly harness: ActionHarness;
  readonly evidence: EvidenceStore;
  readonly world: WorldState;
  readonly preset: MissionPreset;
  readonly profile: AircraftProfile;
  readonly authorized: boolean;
  context(tick: Tick): HarnessContext;
  authorize(envelope: MissionEnvelope, tick: Tick): void;
  setPaused(paused: boolean): void;
  setSpeed(speed: number): void;
  afterAbort(result: AbortResult, tick: Tick): void;
  refuse(tick: Tick, command: string, reason: string): void;
  nextIndex(kind: "report" | "experiment"): number;
}

export function applyCommand(host: CommandHost, cmd: UiCommand, tick: Tick): void {
  switch (cmd.type) {
    case "approve":
    case "reject":
      return decide(host, cmd, tick);
    case "abort":
      return abort(host, cmd, tick);
    case "report":
    case "authorize_mission":
    case "experiment":
    case "pause":
    case "resume":
    case "set_speed":
      if (sameRun(host, cmd.runId, tick, cmd.type)) runCommand(host, cmd, tick);
      return;
    default:
      // start_run, reset, camera_frame and export_run are handled by the worker, not at a tick boundary.
      return;
  }
}

type RunScoped = Extract<UiCommand, { type: "report" | "authorize_mission" | "experiment" | "pause" | "resume" | "set_speed" }>;

function runCommand(host: CommandHost, cmd: RunScoped, tick: Tick): void {
  switch (cmd.type) {
    case "report":
      return report(host, cmd.text, cmd.source, cmd.channel, tick);
    case "authorize_mission":
      return authorize(host, cmd.commanderId, tick);
    case "experiment":
      return experiment(host, cmd.experiment, tick);
    case "pause":
    case "resume":
      return host.setPaused(cmd.type === "pause");
    case "set_speed":
      if (Number.isFinite(cmd.speed) && cmd.speed > 0 && cmd.speed <= 64) return host.setSpeed(cmd.speed);
      return host.refuse(tick, "set_speed", `Speed ${cmd.speed} is not in (0, 64].`);
  }
}

function sameRun(host: CommandHost, runId: RunId, tick: Tick, command: string): boolean {
  if (runId === host.runId) return true;
  host.refuse(tick, command, `The command belongs to run ${runId}; this is run ${host.runId}. Commands and replies from another run cannot act.`);
  return false;
}

function decide(host: CommandHost, cmd: ApproveCommand | RejectCommand, tick: Tick): void {
  if (!host.authorized) return host.refuse(tick, cmd.type, "No mission is authorized, so there is nothing to approve or reject.");
  const ctx = host.context(tick);
  if (cmd.type === "approve") host.harness.approve(cmd, ctx);
  else host.harness.reject(cmd, ctx);
}

function abort(host: CommandHost, cmd: AbortCommand, tick: Tick): void {
  const result = host.harness.abort(cmd, host.context(tick));
  host.afterAbort(result, tick);
}

function report(host: CommandHost, text: string, source: "judge" | "caller", channel: "typed" | "voice", tick: Tick): void {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_REPORT_CHARS) {
    return host.refuse(tick, "report", `A report needs 1 to ${MAX_REPORT_CHARS} characters of text.`);
  }
  const reading = interpretReport(text, host.preset.prior);
  const id = `${host.runId}/report/${host.nextIndex("report")}`;
  host.evidence.addReport({ id, runId: host.runId, receivedTick: tick, source, channel, originalText: text, roomHint: reading.roomHint, countText: reading.countText, interpretation: "rules", supersedes: null });
  const hint = reading.roomHint === null ? "no room matched by the rules" : `room hint ${reading.roomHint}`;
  host.log.append({ tick, source: "intake", kind: "report.received", subject: id, reason: `Report from the ${source} (${channel}), kept verbatim: "${text}". Rules interpretation: ${hint}. A report is a lead, not a confirmed person.`, data: { reportId: id, originalText: text, source, channel, roomHint: reading.roomHint, countText: reading.countText } });
}

function authorize(host: CommandHost, commanderId: string, tick: Tick): void {
  if (host.authorized) return host.refuse(tick, "authorize_mission", "The mission is already authorized; changing the envelope is a separate mission revision.");
  const envelope = host.preset.envelope(host.runId, commanderId, tick);
  const violations = hardLimitViolations(envelope, host.profile, tick);
  if (violations.length > 0) return host.refuse(tick, "authorize_mission", `The preset envelope exceeds hard limits: ${violations.join(" ")}`);
  host.authorize(envelope, tick);
  host.log.append({
    tick, source: "commander", kind: "mission.authorized", subject: null,
    reason: `Mission authorized by ${commanderId}: envelope revision ${envelope.revision}, ${envelope.maxSpeedMps} m/s, ambient ceiling ${envelope.ambientCeilingC} °C, until tick ${envelope.endTick}. Movement and scanning are autonomous inside it; glass, water and payload actions each need their own approval.`,
    data: { commanderId, revision: envelope.revision, endTick: envelope.endTick, maxSpeedMps: envelope.maxSpeedMps },
  });
}

function experiment(host: CommandHost, request: Extract<UiCommand, { type: "experiment" }>["experiment"], tick: Tick): void {
  const index = host.nextIndex("experiment");
  try {
    applyExperiment(host.world, toSimulationExperiment(request, index));
  } catch (error) {
    return host.refuse(tick, "experiment", `Experiment rejected by the simulator: ${error instanceof Error ? error.message : String(error)}`);
  }
  host.log.append({ tick, source: "operator", kind: "experiment.applied", subject: request.kind, reason: describeExperiment(request), data: { index, experiment: experimentData(request) } });
}
