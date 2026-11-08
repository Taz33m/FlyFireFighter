/**
 * Closed-loop course runner: simulated world + headless collider camera (50 Hz frames with keyed read
 * noise) + motion controller + action harness (one routine move to the course goal) + stepWorld at 100 Hz.
 *
 * Per visual tick: render the TRUE pose → add read noise → (FlyVis service step, awaited in lockstep) →
 * controller.step on truth-free inputs (frame, goal from the ESTIMATED pose, efference copy, rgb quality and,
 * only when range assistance is on, the buffered range readings) → request held for two ticks. Every tick:
 * harness.step → stepWorld. The environment side (truth): smoke at start, debris added when the aircraft
 * passes the trigger, and the evaluator metrics. The teacher (truth) labels states and can drive for
 * dataset collection (pure teacher, DART-noised teacher or a DAgger β-mixture); it is never a controller input.
 */
import type { MotionCommand, MotionRequest } from "../../contracts/actions.ts";
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import type { CameraFrame } from "../../contracts/camera.ts";
import { TICK_S, VISUAL_PERIOD_TICKS } from "../../contracts/clock.ts";
import { vec3, worldPointToBody } from "../../contracts/frames.ts";
import type { NeuralFeatures } from "../../contracts/neural.ts";
import { withReadNoise } from "../../mission/camera-source.ts";
import { HeadlessColliderRenderer } from "../../mission/headless-camera.ts";
import type { ControllerInput, GoalEstimate, MotionController } from "../../navigation/reflex/types.ts";
import { ReadoutFeatureBuilder } from "../../navigation/reflex/trained-readout.ts";
import { applyExperiment } from "../../simulation/experiments.ts";
import { estimatedPose } from "../../simulation/localization.ts";
import { keyedGaussian, keyedUniform } from "../../simulation/random.ts";
import type { RangeReadings } from "../../simulation/sensors/index.ts";
import { senseTick } from "../../simulation/sensors/index.ts";
import { createWorld, stepWorld } from "../../simulation/world.ts";
import type { WorldState } from "../../simulation/world-state.ts";
import type { CourseSpec } from "./course.ts";
import { courseCalibration, courseScene, toLocal } from "./course.ts";
import { courseHarness, startMove } from "./harness-context.ts";
import type { RunMetrics } from "./metrics.ts";
import { MetricsRecorder } from "./metrics.ts";
import type { TeacherCommand } from "./teacher.ts";
import { CourseTeacher } from "./teacher.ts";

export interface NeuralSource {
  reset(runId: string, calibration: ReturnType<typeof courseCalibration>): Promise<void>;
  step(frame: CameraFrame, tick: number): Promise<{ readonly features: NeuralFeatures; readonly roundTripMs: number }>;
}

export interface FeatureHolder {
  current: NeuralFeatures | null;
}

export type Driver = { readonly kind: "controller" } | { readonly kind: "teacher"; readonly noise?: { readonly forwardSigma: number; readonly yawSigma: number; readonly holdTicks: number } } | { readonly kind: "mixture"; readonly beta: number; readonly segmentTicks: number };

export interface Sample {
  readonly tick: number;
  readonly inputs: Float64Array;
  readonly teacher: TeacherCommand;
  readonly drivenBy: "teacher" | "controller";
}

export interface RunConfig {
  readonly spec: CourseSpec;
  readonly runId: string;
  readonly controller: MotionController | null;
  readonly neural: NeuralSource | null;
  readonly rangeAssist: boolean;
  readonly driver: Driver;
  /** Receives one sample per visual tick with usable readout inputs (requires `neural`). */
  readonly onSample?: (sample: Sample) => void;
  /** End early (incomplete) after this long without 0.3 m of progress toward the goal. */
  readonly stallS?: number;
  /** Holder the runner fills with the latest FlyVis features each visual tick; controllers read it. */
  readonly features?: FeatureHolder;
  /** Shared bias added to the reported goal distance (as the mission's path follower does), m. */
  readonly arrivalBiasM?: number;
}

export interface RunOutput {
  readonly metrics: RunMetrics;
  readonly eventsJsonl: string;
}

const STILL: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };

function goalEstimate(world: WorldState, spec: CourseSpec, biasM: number): GoalEstimate {
  const pose = estimatedPose(world);
  const rel = worldPointToBody({ position: pose.position, yawRad: pose.yawRad }, spec.goal);
  return { bearingRad: Math.atan2(rel.y, rel.x), distanceM: Math.hypot(rel.x, rel.y) + biasM, heightErrorM: spec.goal.z - pose.position.z };
}

export async function runCourse(config: RunConfig): Promise<RunOutput> {
  const run = new CourseRun(config);
  await run.start();
  for (;;) {
    const end = await run.tick();
    if (end !== null) return end;
  }
}

/** One run's state; tick() advances one 100 Hz step and returns the output once the run has ended. */
class CourseRun {
  private readonly config: RunConfig;
  private readonly world: WorldState;
  private readonly calibration: ReturnType<typeof courseCalibration>;
  private readonly renderer: HeadlessColliderRenderer;
  private readonly budgetTicks: number;
  private readonly h: ReturnType<typeof courseHarness>;
  private readonly proposalId: string;
  private readonly teacher: CourseTeacher;
  private readonly builder: ReadoutFeatureBuilder | null;
  private readonly metrics: MetricsRecorder;
  private readonly holder: FeatureHolder;
  private readonly pendingRanges: RangeReadings[] = [];
  private ranges: RangeReadings | null = null;
  private rgbQuality = 1;
  private previous: MotionCommand = STILL;
  private held: MotionRequest | null = null;
  private debrisDone: boolean;

  constructor(config: RunConfig) {
    const { spec, runId } = config;
    this.config = config;
    this.world = createWorld(courseScene(spec), { scenarioId: spec.courseId, seed: spec.seed, runId, profile: TENDER_T1, fire: null, occupants: [], openingOverrides: {} });
    if (spec.smokePerM > 0) for (const roomId of ["room-a", "room-b"]) applyExperiment(this.world, { kind: "add_smoke", roomId, extinctionPerM: spec.smokePerM });
    this.calibration = courseCalibration(spec);
    this.renderer = new HeadlessColliderRenderer(this.calibration);
    this.budgetTicks = Math.round(spec.budgetS / TICK_S);
    this.h = courseHarness(spec, runId, this.budgetTicks);
    this.proposalId = startMove(this.h, spec, this.world);
    this.teacher = new CourseTeacher(spec);
    this.builder = config.onSample ? new ReadoutFeatureBuilder() : null;
    this.metrics = new MetricsRecorder(spec, runId, { controller: config.controller, neural: config.neural !== null, rangeAssist: config.rangeAssist, driver: config.driver.kind });
    this.holder = config.features ?? { current: null };
    this.debrisDone = spec.debris === null;
  }

  async start(): Promise<void> {
    this.config.controller?.reset();
    this.holder.current = null;
    if (this.config.neural) await this.config.neural.reset(this.config.runId, this.calibration);
  }

  async tick(): Promise<RunOutput | null> {
    const world = this.world;
    this.sense();
    if (world.tick % VISUAL_PERIOD_TICKS === 0) this.held = await this.visualStep();
    const batch = this.h.harness.step(this.h.context(world), this.held);
    for (const limit of batch.motion?.limits ?? []) this.metrics.limit(limit);
    stepWorld(world, batch);
    this.previous = batch.motion?.executed ?? STILL;
    this.environment();
    this.metrics.tick(world);
    const end = this.metrics.endReason(world, this.h.harness.record(this.proposalId)?.status ?? null, this.budgetTicks, this.config.stallS ?? 15);
    if (end === null) return null;
    return { metrics: this.metrics.finish(world, end), eventsJsonl: this.h.log.toJsonl() + world.truthEvents.map(e => `${JSON.stringify({ truth: true, ...e })}\n`).join("") };
  }

  /** Sensor suite (pure read): rgb quality and range readings, used once they have arrived. */
  private sense(): void {
    const frame = senseTick(this.world);
    for (const o of frame.observations) if (o.modality === "rgb") this.rgbQuality = o.quality;
    if (frame.ranges) this.pendingRanges.push(frame.ranges);
    while (this.pendingRanges.length > 0 && this.pendingRanges[0].arrivalTick <= this.world.tick) this.ranges = this.pendingRanges.shift() as RangeReadings;
  }

  private async visualStep(): Promise<MotionRequest | null> {
    const { spec, runId, controller, driver } = this.config;
    const world = this.world;
    const tick = world.tick;
    const frame = withReadNoise(this.renderer.render(world, { frameId: `${runId}/f${tick}`, tick, pose: { position: world.drone.position, yawRad: world.drone.yawRad } }), this.calibration, spec.seed, tick);
    this.metrics.render(this.renderer.lastStats.ms);
    if (this.config.neural) {
      const result = await this.config.neural.step(frame, tick);
      this.holder.current = result.features;
      // The first step of a run also runs the service's warm-up (its own, longer deadline): not counted.
      if (tick > 0) this.metrics.neural(result.roundTripMs);
    }
    const input: ControllerInput = {
      tick, frame, goal: goalEstimate(world, spec, this.config.arrivalBiasM ?? 0.12), previous: this.previous,
      quality: { frame: this.rgbQuality, poseSigmaM: estimatedPose(world).sigmaM }, ranges: this.rangeAssist(),
    };
    const label = this.teacher.command(world);
    let request: MotionRequest | null = null;
    if (controller) {
      const started = performance.now();
      const out = controller.step(input);
      this.metrics.controller(performance.now() - started, out.label);
      request = out.request;
    }
    const teacherDrives = controller === null || driver.kind === "teacher" || (driver.kind === "mixture" && keyedUniform(spec.seed, `${runId}/beta`, Math.floor(tick / driver.segmentTicks)) < driver.beta);
    if (teacherDrives) request = teacherRequest(label, input, spec.seed, runId, driver);
    this.metrics.visual(world, label);
    const x = this.builder?.build(this.holder.current, input) ?? null;
    if (x && this.config.onSample) this.config.onSample({ tick, inputs: x, teacher: label, drivenBy: teacherDrives ? "teacher" : "controller" });
    return request;
  }

  /** Range readings for the controller: only in the range-assisted condition, and only once arrived. */
  private rangeAssist(): ControllerInput["ranges"] {
    const r = this.config.rangeAssist ? this.ranges : null;
    return r ? { forwardM: r.forwardM, leftM: r.leftM, rightM: r.rightM, downM: r.downM } : null;
  }

  /** Environment side: the debris falls once the aircraft passes its trigger (truth position). */
  private environment(): void {
    const { spec } = this.config;
    if (this.debrisDone || !spec.debris) return;
    if (toLocal(spec, this.world.drone.position.x, this.world.drone.position.y)[0] < spec.debris.triggerU) return;
    applyExperiment(this.world, { kind: "add_obstruction", id: spec.debris.box.id, min: spec.debris.box.min, max: spec.debris.box.max });
    this.metrics.debris(this.world.tick);
    this.debrisDone = true;
  }
}

/** Teacher command as a request; DART-style keyed perturbation when configured (labels stay clean). */
function teacherRequest(label: TeacherCommand, input: ControllerInput, seed: string, runId: string, driver: Driver): MotionRequest {
  let forward = label.forwardMps;
  let yaw = label.yawRateRadps;
  if (driver.kind === "teacher" && driver.noise) {
    const segment = Math.floor(input.tick / driver.noise.holdTicks);
    forward = Math.max(0, forward + driver.noise.forwardSigma * keyedGaussian(seed, `${runId}/dart-v`, segment));
    yaw += driver.noise.yawSigma * keyedGaussian(seed, `${runId}/dart-w`, segment);
  }
  const vz = input.goal ? input.goal.heightErrorM : 0;
  return { source: "operator", tick: input.tick, velocityBody: vec3(forward, 0, Math.max(-0.8, Math.min(0.8, vz))), yawRateRadps: yaw };
}
