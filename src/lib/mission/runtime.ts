/**
 * MissionRuntime: one run of the continuous mission on the fixed 100 Hz clock.
 *
 * step() advances exactly one tick, in this order: (a) queued commands (and the scripted commander's answers)
 * at the tick boundary; on visual ticks a camera frame of the TRUE pose (awaited; a failed frame pauses the
 * run instead of advancing without it); (b) sensing, and ingestion of everything that has arrived; (c) the
 * truth-free belief; (d) every ROUTE_PERIOD_TICKS, evacuation and return route assessments; contingency
 * triggers; (e) planning; (f) on visual ticks, the controller on the noisy frame (held in between); (g) the
 * harness's single step and the world step; (h) evaluator-side end conditions and, every
 * REPLAY_PERIOD_TICKS, a replay frame. The world does not advance until the commander authorizes the
 * mission, nor while paused. Wall time is used only for metrics and the cloud planner's deadlines.
 *
 * Motion support around the controller (all truth-free): the path follower (steering.ts) with exterior
 * transit height and range-blocked detours; measured motion (gyro + estimated velocity) in the controller's
 * `previous` slot; close-quarters command settings indoors, at openings and at intervention standoffs; and
 * the stale looming-memory re-sense (stall.ts).
 *
 * Public API used by the worker and batch evaluation (keep stable): MissionRuntime.create(RuntimeOptions),
 * command(), step(), view(), render(), outcome(), eventsSince(), timing(), exportRun(), close().
 */
import type { ActuatorBatch, MotionCommand, MotionRequest } from "../contracts/actions.ts";
import type { CameraCalibration } from "../contracts/camera.ts";
import { calibrationFromSensor } from "../contracts/camera.ts";
import type { Tick } from "../contracts/clock.ts";
import { onCadence, secondsFromTicks, VISUAL_PERIOD_TICKS } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { MissionEvent } from "../contracts/events.ts";
import { EventLog } from "../contracts/events.ts";
import { ZERO } from "../contracts/frames.ts";
import { regionBounds } from "../contracts/geometry.ts";
import type { RunId } from "../contracts/ids.ts";
import type { MissionResult } from "../contracts/outcomes.ts";
import type { SceneMetaJson } from "../contracts/scene.ts";
import { createMissionTrace, recordTick } from "../evaluation/trace.ts";
import type { MissionTrace } from "../evaluation/trace.ts";
import { defaultEvidenceConfig } from "../evidence/config.ts";
import { EvidenceRejection } from "../evidence/errors.ts";
import { EvidenceStore } from "../evidence/store.ts";
import { occupancySummary } from "../evidence/summary.ts";
import type { AbortResult } from "../harness/harness.ts";
import { ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { DEFAULT_POLICY, INTERVENTION_KINDS } from "../harness/policy.ts";
import { DecisionBroker } from "../navigation/planner/broker.ts";
import { aircraftStatus, estimatedPose, landingSupport } from "../simulation/localization.ts";
import type { RangeReadings } from "../simulation/sensors/index.ts";
import { stepWorld } from "../simulation/world.ts";
import type { WorldState } from "../simulation/world-state.ts";
import type { CameraSource, CapturedFrame } from "./camera-source.ts";
import { HeadlessCameraSource, withReadNoise } from "./camera-source.ts";
import type { CommandHost } from "./commands.ts";
import { applyCommand } from "./commands.ts";
import type { ScriptedCommanderConfig } from "./commander.ts";
import { ScriptedCommander } from "./commander.ts";
import { ContingencyMonitor } from "./contingencies.ts";
import type { NeuralConnector } from "./controller-slot.ts";
import { ControllerSlot, controllerInput, measuredMotion } from "./controller-slot.ts";
import type { SteeringGoal } from "./goal.ts";
import { GoalSelector } from "./goal.ts";
import { RunWatch, scoreRun } from "./outcome.ts";
import type { PlannerTick } from "./planner-step.ts";
import { MissionPlanner, RUNTIME_ACTOR } from "./planner-step.ts";
import type { MissionStatus, MissionView, RenderRequest, RenderSnapshot, ReplayFrame, RunConfig, UiCommand } from "./protocol.ts";
import { RouteMonitor } from "./routes.ts";
import type { MissionPreset } from "./scenario.ts";
import { createPresetWorld, loadPreset, PRESET_VARIANTS, variantOfScenarioId } from "./scenario.ts";
import { SensingPipeline } from "./sensing.ts";
import { EXTERIOR, spaceOf } from "./steering-graph.ts";
import { LatencyStats } from "./stats.ts";
import type { SteeringOutput } from "./steering.ts";
import { PathFollower } from "./steering.ts";
import { exportRun as exportBundle } from "./export.ts";
import { affectedRegions, cloudDeciderOf, DECIDER_MODE_TEXT, deciderLabel, deciderView, pendingApproval, renderSnapshot, viewBelief, waterDischargedL } from "./view.ts";

export const ROUTE_PERIOD_TICKS = 50;
export const TRANSIT_BELOW_CEILING_M = 1;
export const DOCK_WITHIN_M = 2;
/** Replay frames are recorded every 10 ticks (10 Hz of simulation time) once the mission is authorized. */
export const REPLAY_PERIOD_TICKS = 10;
const STILL: MotionCommand = Object.freeze({ velocityBody: ZERO, yawRateRadps: 0 });

export interface RuntimeOptions {
  readonly runId: RunId;
  readonly config: RunConfig;
  readonly meta: SceneMetaJson;
  /** Camera source for the live world; defaults to the headless collider renderer. */
  readonly camera?: (world: () => WorldState, calibration: CameraCalibration) => CameraSource;
  readonly neural?: NeuralConnector | null;
  /** Batch/test commander; null (the default) waits for the human. */
  readonly commander?: ScriptedCommanderConfig | null;
  /** Scripted commander policy: recall the aircraft (mission abort → contingency) after the evaluator announces arrival. */
  readonly recallOnArrival?: boolean;
  /** Monotonic wall clock (ms) for metrics and cloud deadlines. */
  readonly nowMs?: () => number;
  /**
   * Range assistance for motion (default true). False gives the controller and the steering's detour no
   * range readings (ranges: null): the PRD's "fly-model motion alone" condition. Range observations still
   * reach the evidence store and localization; only motion loses them.
   */
  readonly rangeAssist?: boolean;
  /** Water aboard at launch in litres (default: the profile's full tank); 0 ≤ value ≤ tank. */
  readonly initialWaterL?: number;
}

export interface StepResult {
  readonly advanced: boolean;
  readonly ended: boolean;
  /** Why the run paused itself this step (a camera failure), else null. */
  readonly pausedReason: string | null;
}

/** Scripted recall waits this long after arrival (30 s) so the planner's own return can start first. */
export const RECALL_GRACE_TICKS = 3000;

/** Close-quarters reason while an intervention executes on its standoff; it selects station keeping. */
const HOLDING_INTERVENTION = "holding an intervention standoff";

export class MissionRuntime implements CommandHost {
  readonly runId: RunId;
  readonly config: RunConfig;
  readonly preset: MissionPreset;
  readonly meta: SceneMetaJson;
  readonly world: WorldState;
  readonly log: EventLog;
  readonly harness: ActionHarness;
  readonly evidence: EvidenceStore;
  readonly calibration: CameraCalibration;
  readonly planner: MissionPlanner;
  readonly slot: ControllerSlot;
  readonly stats = { tick: new LatencyStats(), frame: new LatencyStats(), controller: new LatencyStats(), render: new LatencyStats() };
  readonly frameRenderers = new Set<string>();
  /** Experimental conditions of this run (recorded in run.started and results.json). */
  readonly rangeAssist: boolean;
  readonly initialWaterL: number;
  simToWallRatio: number | null = null;
  private readonly camera: CameraSource;
  private readonly sensing: SensingPipeline;
  private readonly contingencies = new ContingencyMonitor();
  private readonly follower = new PathFollower();
  private readonly goals = new GoalSelector();
  private readonly routes = new RouteMonitor();
  private readonly watch = new RunWatch();
  private readonly commander: ScriptedCommander | null;
  private readonly recallOnArrival: boolean;
  private readonly nowMs: () => number;
  private readonly queue: UiCommand[] = [];
  private readonly errors: string[] = [];
  private readonly counters = { report: 0, experiment: 0 };
  private readonly trace: MissionTrace;
  private readonly replay: string[] = [];
  private lastFaultTick: Tick | null = null;
  private envelope: MissionEnvelope | null = null;
  private missionStartTick = 0;
  private paused = false;
  private speed: number;
  private belief: BeliefSnapshot;
  private held: MotionRequest | null = null;
  private previous: MotionCommand = STILL;
  private lastBatch: ActuatorBatch | null = null;
  private steer: SteeringOutput | null = null;
  private result: MissionResult | null = null;
  private recalled = false;
  /** Tick the evaluator first reported an arrival (scripted recall timing only). */
  private arrivedAt: Tick | null = null;
  private readonly startedWallMs: number;

  static async create(options: RuntimeOptions): Promise<MissionRuntime> {
    const variant = variantOfScenarioId(options.config.scenarioId);
    if (variant === null || !options.config.scenarioId.startsWith(`${options.meta.sceneId}/`)) throw new Error(`Unknown scenario "${options.config.scenarioId}"; expected ${options.meta.sceneId}/<${PRESET_VARIANTS.join("|")}>.`);
    const preset = loadPreset(options.meta, variant, options.config.seed, options.runId);
    const profile = preset.scenario.profile;
    if (options.config.aircraftId !== profile.id) throw new Error(`Scenario ${options.config.scenarioId} flies ${profile.id}, not ${options.config.aircraftId}.`);
    const rgb = profile.sensors.find(sensor => sensor.id === "rgb-front");
    if (!rgb) throw new Error(`${profile.id} has no rgb-front camera.`);
    const calibration = calibrationFromSensor(rgb, 1);
    const tankL = profile.modules.water?.tankL ?? 0;
    if (options.initialWaterL !== undefined && !(Number.isFinite(options.initialWaterL) && options.initialWaterL >= 0 && options.initialWaterL <= tankL)) {
      throw new RangeError(`initialWaterL ${options.initialWaterL} is outside 0–${tankL} L (the ${profile.id} tank).`);
    }
    const { slot, startupFallback } = await ControllerSlot.create(options.config.controller, options.runId, calibration, options.neural ?? null);
    return new MissionRuntime(options, preset, calibration, slot, startupFallback);
  }

  private constructor(options: RuntimeOptions, preset: MissionPreset, calibration: CameraCalibration, slot: ControllerSlot, startupFallback: string | null) {
    this.runId = options.runId;
    this.config = options.config;
    this.speed = options.config.speed;
    this.preset = preset;
    this.meta = options.meta;
    this.calibration = calibration;
    this.slot = slot;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.startedWallMs = this.nowMs();
    this.world = createPresetWorld(preset);
    this.rangeAssist = options.rangeAssist ?? true;
    if (options.initialWaterL !== undefined) this.world.drone.waterRemainingL = options.initialWaterL;
    this.initialWaterL = this.world.drone.waterRemainingL;
    this.log = new EventLog(this.runId);
    this.harness = new ActionHarness(this.runId, this.log);
    // The belief's observation window must hold every observation an evacuation route may cite (H15 checks
    // that each cited id is still in the current evidence), so it covers the route evidence age.
    const evidenceConfig = defaultEvidenceConfig(this.runId, preset.prior);
    this.evidence = new EvidenceStore({ ...evidenceConfig, observationWindowTicks: Math.max(evidenceConfig.observationWindowTicks, DEFAULT_POLICY.routeEvidenceMaxAgeTicks) });
    const cloudDecider = cloudDeciderOf(options.config.decider);
    this.planner = new MissionPlanner(new DecisionBroker({ runId: this.runId, cloudEnabled: cloudDecider !== null, cloudDecider: cloudDecider ?? undefined, policy: DEFAULT_POLICY }));
    this.sensing = new SensingPipeline(preset.prior);
    this.camera = (options.camera ?? ((world, cal) => new HeadlessCameraSource(world, cal)))(() => this.world, calibration);
    this.commander = options.commander ? new ScriptedCommander(options.commander) : null;
    this.recallOnArrival = options.recallOnArrival === true;
    this.trace = createMissionTrace(this.world);
    this.belief = this.snapshot(0);
    this.log.append({
      tick: 0, source: "system", kind: "run.started", subject: this.runId,
      reason: `Run ${this.runId} of ${preset.scenario.scenarioId} (seed ${options.config.seed}) with ${slot.label} and the ${DECIDER_MODE_TEXT[options.config.decider]}. Troy training scene — real exterior reference; fictional interior and incident.`,
      data: { rangeAssist: this.rangeAssist, initialWaterL: this.initialWaterL, scenarioId: preset.scenario.scenarioId, seed: options.config.seed, aircraftId: preset.scenario.profile.id, controller: options.config.controller, controllerLabel: slot.label, decider: options.config.decider, calibrationId: calibration.id },
    });
    if (startupFallback !== null) this.logFallback(0, startupFallback);
  }

  get profile() {
    return this.preset.scenario.profile;
  }

  get authorized(): boolean {
    return this.envelope !== null;
  }

  get status(): MissionStatus {
    if (this.result !== null) return "ended";
    if (this.paused) return "paused";
    if (this.harness.missionAborted) return "aborted";
    if (this.envelope !== null) return "running";
    return this.belief.reports.length > 0 ? "awaiting_authorization" : "awaiting_report";
  }

  /** True while step() advances the clock. */
  get advancing(): boolean {
    return this.envelope !== null && !this.paused && this.result === null;
  }

  command(cmd: UiCommand): void {
    this.queue.push(cmd);
  }

  /** Observations ingested so far and the first evidence-store rejections (for tests and diagnostics). */
  sensingStats(): { readonly ingested: number; readonly rejections: readonly string[] } {
    return { ingested: this.sensing.ingested, rejections: [...this.sensing.rejections] };
  }

  /** The current truth-free belief snapshot. */
  get currentBelief(): BeliefSnapshot {
    return this.belief;
  }

  /** Error messages for the UI since the last call. */
  drainErrors(): string[] {
    return this.errors.splice(0);
  }

  async step(): Promise<StepResult> {
    if (this.result !== null) return { advanced: false, ended: true, pausedReason: null };
    const started = this.nowMs();
    const tick = this.world.tick;
    this.applyCommands(tick);
    if (!this.advancing) return { advanced: false, ended: this.result !== null, pausedReason: null };
    let frame: CapturedFrame | null = null;
    if (onCadence(tick, VISUAL_PERIOD_TICKS)) {
      try {
        frame = await this.capture(tick);
      } catch (error) {
        return { advanced: false, ended: false, pausedReason: this.pauseForCamera(tick, error) };
      }
    }
    this.sensing.sense(this.world);
    this.sensing.ingest(tick, this.evidence, this.log, this.preset.prior);
    this.belief = this.snapshot(tick);
    if (onCadence(tick, ROUTE_PERIOD_TICKS)) this.updateRoutes(tick);
    const pt = this.plannerTick(tick);
    this.contingencies.check(pt, this.planner);
    this.planner.noteArrival(this.plannerTick(tick));
    this.planner.tick(this.plannerTick(tick));
    if (frame !== null) this.held = await this.control(tick, frame);
    this.planner.watch(this.plannerTick(tick), this.steer?.remainingM ?? null);
    this.advance(tick);
    this.stats.tick.add(this.nowMs() - started);
    return { advanced: true, ended: this.result !== null, pausedReason: null };
  }

  view(): MissionView {
    const records = this.harness.records();
    const belief = this.belief;
    return {
      runId: this.runId,
      config: { ...this.config, speed: this.speed },
      status: this.status,
      tick: this.world.tick,
      simToWallRatio: this.simToWallRatio,
      envelope: this.envelope,
      belief: viewBelief(belief),
      occupancy: occupancySummary(belief),
      proposals: records,
      pendingApproval: pendingApproval(records),
      affectedRegions: affectedRegions(records, this.world, belief),
      motion: this.lastBatch?.motion ?? null,
      controller: this.slot.view(),
      decider: deciderView(this.planner.lastDecision, this.config.decider, this.planner.broker.cloudActive, this.planner.broker.requestInFlight !== null),
      contingency: this.contingencies.current,
      water: { remainingL: belief.aircraft.waterRemainingL, dischargedL: waterDischargedL(records) },
    };
  }

  render(): RenderSnapshot {
    return renderSnapshot(this.world, { actuators: this.lastBatch?.commands ?? [], motion: this.lastBatch?.motion ?? null });
  }

  eventsSince(seq: number): readonly MissionEvent[] {
    return this.log.since(seq);
  }

  outcome(): MissionResult | null {
    return this.result;
  }

  /** Simulated seconds and wall milliseconds so far, for results.json. */
  timing(): { readonly simulatedS: number; readonly wallMs: number } {
    return { simulatedS: secondsFromTicks(this.world.tick), wallMs: this.nowMs() - this.startedWallMs };
  }

  /** The run bundle (export.ts, protocol RUN_BUNDLE_FILES): events.jsonl, results.json and replay.jsonl. */
  exportRun(metaSha256: string | null = null): { readonly [name: string]: string } {
    const view = this.view();
    const timing = this.timing();
    return exportBundle({
      runId: this.runId,
      config: view.config,
      scenarioId: this.preset.scenario.scenarioId,
      meta: this.meta,
      metaSha256,
      controller: view.controller,
      calibrationId: this.calibration.id,
      renderers: [...this.frameRenderers].sort(),
      decider: { label: view.decider.label, status: view.decider.status },
      conditions: { rangeAssist: this.rangeAssist, initialWaterL: this.initialWaterL },
      eventsJsonl: this.log.toJsonl(),
      replayJsonl: this.replay.join(""),
      result: this.result,
      status: view.status,
      timing: { simulatedS: timing.simulatedS, wallMs: timing.wallMs, simToWallRatio: this.simToWallRatio, latency: { tick: this.stats.tick.summary(), frame: this.stats.frame.summary(), render: this.stats.render.summary(), controller: this.stats.controller.summary() } },
    });
  }

  close(): void {
    this.slot.close();
  }

  /* CommandHost. */

  context(tick: Tick): HarnessContext {
    return { tick, missionStartTick: this.missionStartTick, profile: this.profile, policy: DEFAULT_POLICY, envelope: this.envelope ?? unauthorizedEnvelope(this.runId), belief: this.belief };
  }

  authorize(envelope: MissionEnvelope, tick: Tick): void {
    this.envelope = envelope;
    this.missionStartTick = tick;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  get currentSpeed(): number {
    return this.speed;
  }

  afterAbort(result: AbortResult, tick: Tick): void {
    this.contingencies.afterAbort(result, this.plannerTick(tick), this.planner);
  }

  refuse(tick: Tick, command: string, reason: string): void {
    this.log.append({ tick, source: "system", kind: "command.refused", subject: command, reason, data: { command } });
    this.errors.push(reason);
  }

  nextIndex(kind: "report" | "experiment"): number {
    this.counters[kind] += 1;
    return this.counters[kind];
  }

  /* Tick phases. */

  private applyCommands(tick: Tick): void {
    if (this.commander !== null && this.envelope !== null) for (const cmd of this.commander.decide(this.runId, this.harness.records(), tick)) this.queue.push(cmd);
    this.maybeRecall(tick);
    if (this.queue.length === 0) return;
    this.belief = this.snapshot(tick);
    for (const cmd of this.queue.splice(0)) applyCommand(this, cmd, tick);
    // Commands change evidence (a report) and status (authorization): the view must reflect them even while
    // the clock is not advancing.
    this.belief = this.snapshot(tick);
  }

  /**
   * Scripted policy only: once the evaluator announces arrival, the commander recalls the aircraft, after a
   * grace period in which the planner's own homeward return may start (a return under way is not recalled).
   */
  private maybeRecall(tick: Tick): void {
    if (!this.recallOnArrival || this.recalled || !this.watch.anyArrived || this.harness.missionAborted) return;
    this.arrivedAt ??= tick;
    const returning = this.harness.activeMotion()?.proposal.action.kind === "return";
    if (returning || tick - this.arrivedAt < RECALL_GRACE_TICKS) return;
    this.recalled = true;
    this.queue.push({ type: "abort", runId: this.runId, scope: "mission", by: this.commander?.config.commanderId ?? "scripted-commander", tick, reason: "Recall: the evaluator reports the occupant at the assembly point." });
  }

  private async capture(tick: Tick): Promise<CapturedFrame> {
    const started = this.nowMs();
    const request: RenderRequest = { type: "render_request", runId: this.runId, tick, frameId: `${this.runId}/rgb-front/frame/${tick}`, calibrationId: this.calibration.id, pose: { position: this.world.drone.position, yawRad: this.world.drone.yawRad }, world: this.render() };
    const frame = await this.camera.capture(request);
    this.stats.frame.add(this.nowMs() - started);
    if (frame.renderMs !== null) this.stats.render.add(frame.renderMs);
    if (!this.frameRenderers.has(frame.renderer)) {
      this.frameRenderers.add(frame.renderer);
      this.log.append({ tick, source: "sensor", kind: "camera.renderer", subject: frame.renderer, reason: `Controller frames are rendered by ${frame.renderer} with calibration ${frame.calibrationId}.`, data: { renderer: frame.renderer, calibrationId: frame.calibrationId } });
    }
    return withReadNoise(frame, this.calibration, this.world.seed, tick);
  }

  private pauseForCamera(tick: Tick, error: unknown): string {
    const reason = `Paused at tick ${tick}: no camera frame (${error instanceof Error ? error.message : String(error)}). The run does not advance without the controller's frame.`;
    this.paused = true;
    this.log.append({ tick, source: "system", kind: "run.paused", subject: null, reason, data: { cause: "camera" } });
    this.errors.push(reason);
    return reason;
  }

  private updateRoutes(tick: Tick): void {
    const changed = this.routes.update({ preset: this.preset, evidence: this.evidence, log: this.log, belief: this.belief, tick, lastInterventionTick: this.harness.lastInterventionAt(tick), policy: DEFAULT_POLICY });
    if (changed) this.belief = this.snapshot(tick);
  }

  private async control(tick: Tick, frame: CapturedFrame): Promise<MotionRequest | null> {
    const target = this.goals.select(this.harness, this.planner, this.belief);
    this.steer = target === null ? null : this.follower.steer({ belief: this.belief, goal: target.goal, focus: target.focus, clearanceM: this.profile.spanM / 2 + 0.05, ranges: this.motionRanges(), transitZ: transitHeight(this.envelope) });
    this.updateDocking(tick, target);
    const previous = measuredMotion(this.previous, this.sensing.latestImu?.angularRateRadps.z ?? null, this.belief.pose.velocity, this.belief.pose.yawRad);
    const input = controllerInput({ tick, frame, goal: this.steer?.goal ?? null, previous, frameQuality: this.sensing.latestRgbQuality, poseSigmaM: this.belief.pose.sigmaM, ranges: this.motionRanges() });
    const started = this.nowMs();
    const result = await this.slot.step(input, frame);
    this.stats.controller.add(this.nowMs() - started);
    if (result.fallbackReason !== null) this.logFallback(tick, result.fallbackReason);
    if (result.resense !== null) this.log.append({ tick, source: "motion", kind: "controller.resense", subject: frame.frameId, reason: result.resense, data: { frameId: frame.frameId } });
    if (result.fault !== null) this.log.append({ tick, source: "motion", kind: "controller.fault", subject: frame.frameId, reason: result.fault, data: { frameId: frame.frameId } });
    return result.request;
  }

  /** Close-quarters settings indoors, near an opening on the path, within DOCK_WITHIN_M of an intervention standoff and while an intervention holds it. */
  private updateDocking(tick: Tick, target: SteeringGoal | null): void {
    const why = this.closeQuartersReason(target);
    const docking = why !== null;
    const quarters = why === HOLDING_INTERVENTION ? "station" : docking ? "dock" : "cruise";
    if (!this.slot.setCloseQuarters(quarters)) return;
    const reason = why === null
      ? "Cruise settings resumed."
      : quarters === "station"
        ? `Station keeping (close-quarters settings with a stiffer position hold against jet recoil): ${why}; same controller and features.`
        : `Close-quarters settings (slow, closer braking distances): ${why}; same controller and features.`;
    this.log.append({ tick, source: "motion", kind: docking ? "controller.docking" : "controller.cruise", subject: target?.proposalId ?? null, reason, data: { docking, quarters } });
  }

  private closeQuartersReason(target: SteeringGoal | null): string | null {
    if (target !== null) {
      const record = this.harness.record(target.proposalId);
      if (record !== null && INTERVENTION_KINDS.has(record.proposal.action.kind)) return HOLDING_INTERVENTION;
      const role = this.planner.meta.get(target.proposalId)?.role;
      const station = role === "station" || role === "preposition";
      if (station && (this.steer?.remainingM ?? Infinity) <= DOCK_WITHIN_M) return `within ${DOCK_WITHIN_M} m of an intervention standoff`;
      // The planner's dwell scans hold that station facing the affected region (the look before proposing, the waits
      // to face it, the hold while the commander decides), so they keep the close-quarters settings too. A breach
      // station sits about 0.6 m from the pane, where the cruise settings' 0.6 m forward and lateral range clearances
      // braked and turned the aircraft away from the glass and vetoed the turn back: 20–45° off the strike point, the
      // debris region's coverage fell from about 83% to 60%, below H6's breach floor (breach-dwell.test.ts).
      if (role === "dwell") return "holding an intervention's station, facing its affected region";
    }
    if (spaceOf(this.preset.prior, this.belief.pose.position) !== EXTERIOR) return "indoors";
    return this.steer?.nearAperture === true ? "threading a window or door on the path" : null;
  }

  private advance(tick: Tick): void {
    const batch = this.harness.step(this.context(tick), this.held);
    stepWorld(this.world, batch);
    if (this.envelope !== null) {
      // Motion owned by a harness contingency (or after a terminal failure) is not scored as late motion.
      const contingencyActive = this.harness.terminalFailure || this.harness.activeMotion()?.proposal.proposer === "contingency";
      recordTick(this.trace, this.world, this.envelope, { contingencyActive });
    }
    this.lastBatch = batch;
    this.previous = batch.motion?.executed ?? STILL;
    this.watch.announce(this.world, this.log, tick);
    if (this.envelope !== null && onCadence(this.world.tick, REPLAY_PERIOD_TICKS)) this.recordReplay();
    const state = { budgetTick: this.missionStartTick + this.preset.budgetTick, launchZone: this.preset.launchZone, missionAborted: this.harness.missionAborted, terminalFailure: this.harness.terminalFailure, motionExecuting: this.harness.activeMotion() !== null };
    if (this.envelope !== null && onCadence(this.world.tick, 10) && this.watch.over(this.world, state)) this.result = scoreRun(this.world, this.envelope, state, this.trace, this.log, tick);
  }

  /** Range readings given to motion (controller and detour): the latest arrived readings, or none without range assistance. */
  motionRanges(): RangeReadings | null {
    return this.rangeAssist ? this.sensing.latestRanges : null;
  }

  /** One protocol ReplayFrame (render snapshot + truth-free summary) as a JSON line. */
  private recordReplay(): void {
    const frame: ReplayFrame = {
      tick: this.world.tick,
      render: this.render(),
      summary: {
        status: this.status,
        controllerLabel: this.slot.label,
        deciderLabel: deciderLabel(this.planner.lastDecision),
        waterRemainingL: this.belief.aircraft.waterRemainingL,
        pendingApprovalId: pendingApproval(this.harness.records())?.proposal.id ?? null,
        contingency: this.contingencies.current?.kind ?? null,
        estimatedPosition: this.belief.pose.position,
      },
    };
    this.replay.push(`${JSON.stringify(frame)}\n`);
  }

  private plannerTick(tick: Tick): PlannerTick {
    return { ctx: this.context(tick), harness: this.harness, log: this.log, lastInterventionTick: this.harness.lastInterventionAt(tick), nowMs: this.nowMs() };
  }

  /**
   * The truth-free belief at `tick`. The evidence store refuses non-finite or negative estimates
   * (EvidenceRejection); that is logged once per tick as an estimator fault and the previous belief is kept.
   */
  private snapshot(tick: Tick): BeliefSnapshot {
    try {
      return this.evidence.snapshot({ tick, pose: estimatedPose(this.world), aircraft: aircraftStatus(this.world), landing: landingSupport(this.world) });
    } catch (error) {
      if (!(error instanceof EvidenceRejection) || this.belief === undefined) throw error;
      if (this.lastFaultTick !== tick) {
        this.lastFaultTick = tick;
        this.log.append({ tick, source: "evidence", kind: "estimator.fault", subject: null, reason: `The evidence store refused this tick's onboard estimates (${error.message}); the previous belief is kept.`, data: { code: error.code } });
      }
      return this.belief;
    }
  }

  private logFallback(tick: Tick, reason: string): void {
    this.log.append({ tick, source: "motion", kind: "controller.fallback", subject: this.slot.mode, reason: `${reason} Now flying with: ${this.slot.label}.`, data: { label: this.slot.label, actor: RUNTIME_ACTOR } });
    this.errors.push(`${reason} Switched to ${this.slot.label}.`);
  }
}

/** Exterior transit height: 1 m below the envelope's ceiling (null without an envelope). */
export function transitHeight(envelope: MissionEnvelope | null): number | null {
  if (envelope === null || envelope.regions.length === 0) return null;
  const ceiling = Math.max(...envelope.regions.map(region => regionBounds(region).max.z));
  return Number.isFinite(ceiling) ? ceiling - TRANSIT_BELOW_CEILING_M : null;
}

/** Before authorization there is no envelope: nothing may move and every proposal would fail H3. */
function unauthorizedEnvelope(runId: RunId): MissionEnvelope {
  return { runId, revision: 0, approvedBy: "", approvedTick: 0, regions: [], maxSpeedMps: 0, ambientCeilingC: 0, endTick: 0 };
}
