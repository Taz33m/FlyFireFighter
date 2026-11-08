/**
 * In-page "UI fixture driver": stands in for the mission worker only when the worker cannot be started,
 * so the command UI and renderer can be exercised. It speaks the same protocol but runs no simulator,
 * evidence store, planner, harness, controller or evaluator. It steps through a few static,
 * hand-authored states; the UI shows the banner "UI fixture — not a simulation run" for as long as it is
 * active, and labels its outcome as a fixture rather than an evaluator result.
 */
import { EventLog } from "@/lib/contracts/events";
import type { FloorPlanPrior } from "@/lib/contracts/evidence";
import type { Vec3 } from "@/lib/contracts/frames";
import type { SceneMetaJson } from "@/lib/contracts/scene";
import type { Experiment, UiCommand, WorkerMessage } from "@/lib/mission/protocol";
import { EMPTY_PRIOR, priorFromSceneMeta } from "./fixture-belief";
import { fixtureView, stepEvents } from "./fixture-view";
import type { FixtureContext, FixtureStep } from "./fixture-world";
import { FIXTURE_IDS, STEP_TICK, fixtureDronePose, fixtureRender } from "./fixture-world";

/** What the hook needs from either the real worker or this driver. */
export interface MissionPort {
  post(command: UiCommand, transfer?: Transferable[]): void;
  terminate(): void;
}

const FRAME_INTERVAL_MS = 250;
const SCENE = { sceneId: "troy-training", revision: 1, baseUrl: "/scenes/troy-training/" };

type Handler = (cmd: UiCommand) => void;

export class FixtureDriver implements MissionPort {
  private readonly deliver: (message: WorkerMessage) => void;
  private readonly priorReady: Promise<FloorPlanPrior>;
  private ctx: FixtureContext | null = null;
  private log: EventLog | null = null;
  private postedEvents = 0;
  private frameSeq = 0;
  private runSeq = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private stepTimers: ReturnType<typeof setTimeout>[] = [];
  private terminated = false;
  private readonly handlers: Partial<Record<UiCommand["type"], Handler>>;

  constructor(deliver: (message: WorkerMessage) => void) {
    this.deliver = deliver;
    this.priorReady = fetch(`${SCENE.baseUrl}scene.meta.json`)
      .then(response => (response.ok ? response.json() as Promise<SceneMetaJson> : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(priorFromSceneMeta)
      .catch(() => EMPTY_PRIOR);
    this.handlers = {
      start_run: cmd => cmd.type === "start_run" && void this.start(cmd.config),
      reset: () => this.stopRun(),
      pause: () => this.setStatus("paused"),
      resume: () => this.setStatus("running"),
      set_speed: cmd => cmd.type === "set_speed" && this.update({ config: { ...this.current().config, speed: cmd.speed } }),
      report: cmd => cmd.type === "report" && this.onReport(cmd.text),
      authorize_mission: () => this.current().step === "reported" && this.enter("breach_pending", { status: "running" }),
      approve: cmd => cmd.type === "approve" && this.onApprove(cmd.proposalId, cmd.digest),
      reject: cmd => cmd.type === "reject" && this.onReject(cmd.proposalId, cmd.reason),
      abort: cmd => cmd.type === "abort" && this.onAbort(cmd.reason),
      experiment: cmd => cmd.type === "experiment" && this.onExperiment(cmd.experiment),
      export_run: () => this.onExport(),
    };
  }

  post(command: UiCommand): void {
    if (this.terminated) return;
    if (command.type === "camera_frame") return; // Received frames are not consumed: no controller runs here.
    if (command.type !== "start_run" && command.type !== "reset" && (this.ctx === null || ("runId" in command && command.runId !== this.ctx.runId))) return;
    this.handlers[command.type]?.(command);
  }

  terminate(): void {
    this.terminated = true;
    this.stopRun();
  }

  private current(): FixtureContext {
    if (this.ctx === null) throw new Error("UI fixture: no run");
    return this.ctx;
  }

  private async start(config: FixtureContext["config"]): Promise<void> {
    this.stopRun();
    const prior = await this.priorReady;
    if (this.terminated) return;
    this.runSeq += 1;
    const runId = `ui-fixture-${this.runSeq}-${Math.random().toString(36).slice(2, 8)}`;
    this.log = new EventLog(runId);
    this.postedEvents = 0;
    this.ctx = { runId, config, prior, step: "idle", status: "awaiting_report", reportText: null, rejected: [], smoke: {}, obstructions: [], extraOccupants: [], sigmaIncreaseM: 0, lastFrameId: null };
    this.deliver({ type: "run_started", runId, config, scene: SCENE });
    this.appendStepEvents("idle");
    this.publish();
    this.frameTimer = setInterval(() => this.requestFrame(), FRAME_INTERVAL_MS);
  }

  private stopRun(): void {
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.stepTimers.forEach(clearTimeout);
    this.stepTimers = [];
    this.ctx = null;
  }

  private update(patch: Partial<FixtureContext>): void {
    this.ctx = { ...this.current(), ...patch };
    this.publish();
  }

  private setStatus(status: FixtureContext["status"]): void {
    const ctx = this.current();
    if (ctx.status === "aborted" || ctx.status === "ended") return;
    if (status === "paused" && ctx.status !== "running") return;
    if (status === "running" && ctx.status !== "paused") return;
    this.update({ status });
  }

  private enter(step: FixtureStep, patch: Partial<FixtureContext> = {}): void {
    this.ctx = { ...this.current(), ...patch, step };
    this.appendStepEvents(step);
    this.publish();
  }

  private appendStepEvents(step: FixtureStep): void {
    for (const event of stepEvents(step)) this.log?.append({ ...event, tick: STEP_TICK[step] });
  }

  private note(source: "commander" | "operator", kind: string, reason: string, subject: string | null = null): void {
    this.log?.append({ tick: STEP_TICK[this.current().step], source, kind, reason, subject });
  }

  private publish(): void {
    const ctx = this.current();
    if (this.log !== null && this.log.length > this.postedEvents) {
      this.deliver({ type: "events", runId: ctx.runId, events: this.log.since(this.postedEvents) });
      this.postedEvents = this.log.length;
    }
    this.deliver({ type: "view", runId: ctx.runId, view: fixtureView(ctx), render: fixtureRender(ctx) });
  }

  private requestFrame(): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.status === "paused") return;
    this.frameSeq += 1;
    this.deliver({ type: "render_request", runId: ctx.runId, tick: STEP_TICK[ctx.step], frameId: `fx-frame-${this.frameSeq}`, calibrationId: "rgb-front/v1", pose: fixtureDronePose(ctx.step), world: fixtureRender(ctx) });
  }

  private onReport(text: string): void {
    const ctx = this.current();
    if (ctx.step !== "idle") {
      this.note("operator", "report.ignored", "The UI fixture keeps only the first report; a real run would record every report.");
      this.publish();
      return;
    }
    this.enter("reported", { reportText: text, status: "awaiting_authorization" });
  }

  private onApprove(proposalId: string, digest: string): void {
    const pending = fixtureView(this.current()).pendingApproval;
    if (pending === null || pending.proposal.id !== proposalId || pending.proposal.digest !== digest) {
      this.deliver({ type: "error", runId: this.current().runId, message: "UI fixture: the approval does not match the displayed proposal and digest, so it was refused." });
      return;
    }
    this.note("commander", "approval.issued", `Commander approved ${proposalId} for digest ${digest.slice(0, 12)} (UI fixture).`, proposalId);
    if (proposalId === FIXTURE_IDS.breachProposal) this.enter("spray_pending");
    if (proposalId === FIXTURE_IDS.sprayProposal) {
      this.enter("spraying");
      this.stepTimers.push(setTimeout(() => this.ctx?.status === "running" && this.enter("guiding"), 3500));
      this.stepTimers.push(setTimeout(() => this.ctx?.step === "guiding" && this.deliverFixtureOutcome(), 8000));
    }
  }

  private deliverFixtureOutcome(): void {
    const ctx = this.current();
    this.deliver({ type: "outcome", runId: ctx.runId, result: { label: "simulation_evaluator", runId: ctx.runId, seed: ctx.config.seed, endedTick: 16200, budgetTick: 30000, occupants: [{ label: "simulation_evaluator", occupantKey: "fx-occupant-1", outcome: "reached_assembly_point", arrivalTick: 16100 }], violations: [], droneReturn: "not_returned" } });
  }

  private onReject(proposalId: string, reason: string): void {
    const ctx = this.current();
    if (ctx.rejected.includes(proposalId)) return;
    this.note("commander", "approval.rejected", `Commander rejected ${proposalId}: ${reason} No alternative is generated by the UI fixture.`, proposalId);
    this.update({ rejected: [...ctx.rejected, proposalId] });
  }

  private onAbort(reason: string): void {
    this.stepTimers.forEach(clearTimeout);
    this.stepTimers = [];
    this.note("commander", "mission.aborted", `Abort: ${reason} Completed effects stay recorded (UI fixture).`);
    this.update({ status: "aborted" });
  }

  private onExperiment(experiment: Experiment): void {
    const ctx = this.current();
    const reason = `Experiment ${experiment.kind} applied to the fixture's illustrative world; no sensor model observes it (UI fixture).`;
    this.note("operator", "experiment.applied", reason);
    if (experiment.kind === "add_smoke") this.update({ smoke: { ...ctx.smoke, [experiment.roomId]: (ctx.smoke[experiment.roomId] ?? 0) + experiment.extinctionPerM } });
    else if (experiment.kind === "add_obstruction") this.update({ obstructions: [...ctx.obstructions, { id: `fx-obstruction-${ctx.obstructions.length + 1}`, min: experiment.min, max: experiment.max }] });
    else if (experiment.kind === "degrade_localization") this.update({ sigmaIncreaseM: ctx.sigmaIncreaseM + experiment.sigmaIncreaseM });
    else if (experiment.kind === "add_occupant") this.update({ extraOccupants: [...ctx.extraOccupants, experiment.position as Vec3] });
    else this.publish();
  }

  private onExport(): void {
    const ctx = this.current();
    this.deliver({ type: "export", runId: ctx.runId, files: { "README.txt": "UI fixture export. Not a simulation run: no simulator, harness or evaluator produced these events.\n", "events.jsonl": this.log?.toJsonl() ?? "" } });
  }
}
