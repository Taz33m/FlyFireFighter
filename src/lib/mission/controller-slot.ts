/**
 * The motion controller the run was configured with, and its honest label.
 *
 * - flow_baseline: the conventional optical-flow baseline ("Optical-flow baseline").
 * - engineered_readout: actual FlyVis features from the local service, awaited in lockstep on every visual
 *   tick (the simulation waits; frames are never skipped), mapped into the engineered readout's feature
 *   provider. On a connection, reset, timeout or protocol error the run switches for good to the flow
 *   baseline, labelled "Optical-flow baseline (classical fallback — FlyVis unavailable)" with neural status
 *   "fallback" and motion source "classical_fallback"; nothing is labelled fly-model inference after that.
 * - trained_readout: not trained yet. Creating it throws, so a run refuses to start rather than silently
 *   substituting another controller.
 */
import type { MotionCommand, MotionRequest, MotionSource } from "../contracts/actions.ts";
import type { CameraCalibration, CameraFrame } from "../contracts/camera.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { isFiniteVec3, rotateWorldToBody } from "../contracts/frames.ts";
import type { RunId } from "../contracts/ids.ts";
import type { NeuralFeatures, NeuralReady } from "../contracts/neural.ts";
import type { NeuralClient } from "../navigation/neural/client.ts";
import type { MotionFeatureVector } from "../navigation/reflex/engineered-readout.ts";
import type { CommandConfig } from "../navigation/reflex/command.ts";
import { DEFAULT_COMMAND_CONFIG } from "../navigation/reflex/command.ts";
import { EngineeredReadoutController } from "../navigation/reflex/engineered-readout.ts";
import { FlowBaselineController } from "../navigation/reflex/flow-baseline.ts";
import type { ControllerInput, ControllerOutput, GoalEstimate, RangeAssist } from "../navigation/reflex/types.ts";
import type { RangeReadings } from "../simulation/sensors/index.ts";
import type { ControllerMode, ControllerView } from "./protocol.ts";
import { StallMonitor } from "./stall.ts";

/**
 * The mission's cue → command settings, shared by every controller mode so paired runs differ only in the
 * features. Changed from DEFAULT_COMMAND_CONFIG, measured on the Troy approach with headless frames:
 * - cruise 1.2 → 1.8 m/s and exploration 0.6 → 0.8 m/s, still below the envelope's 2 m/s (the harness caps
 *   every request at min(hard limit, envelope, move cap) regardless);
 * - visual confidence ramp 0.15–0.6 → 0.05–0.3: confidence is the share of grid cells with trackable
 *   texture, and an outdoor frame is roughly half untextured sky, so it read 0.35–0.5 on open ground and
 *   held the cruise speed to 0.5–0.7 m/s by the vision scale alone. Braking (looming free distance and
 *   forward range) is unchanged.
 */
export const MISSION_COMMAND_CONFIG: CommandConfig = Object.freeze({
  ...DEFAULT_COMMAND_CONFIG,
  cruiseSpeedMps: 1.8,
  exploreSpeedMps: 0.8,
  // Smooth demo flight (2026-11-08): the vision and pose scales slowed the aircraft for most of the live run
  // ("Slowed · low visibility", "position uncertain") although the planar lidar covered it; the metric range
  // limits (forward brake, flank, lateral bounds) are unchanged and still bound every approach.
  minVisualConfidence: 0.05,
  fullVisualConfidence: 0.15,
  poseSigmaOkM: 0.6,
  poseSigmaMaxM: 2.0,
  minPoseSpeedScale: 0.75,
  rangeOnlySpeedMps: 0.8,
  // A lidar-clear space ahead (a return 3 m out or none ahead) is known: cruise, not exploration speed.
  rangeKnownM: 3,
  // Turn while moving toward a goal off the nose instead of nearly stopping to turn.
  turnSpeedExponent: 0.5,
});

/**
 * Close-quarters ("docking") settings indoors, while threading a window or door on the path, for the last
 * metres to an intervention standoff and while holding it. The glass breaker
 * reaches 0.45 m and the Tender's collision sphere has a 0.275 m radius, so a strike needs the aircraft's
 * centre 0.275–0.37 m from the pane (planner-step.ts keeps a 0.08 m reach margin). With the cruise settings
 * looming braking holds 0.8 m from any surface ahead and range braking 0.6 m, so the breach was never in
 * reach (measured: the aircraft stopped 0.5–0.8 m short and every approval expired). Indoors, 0.6 m range
 * braking against a wall dithered with the goal turn (the forward reading hovered at 0.55–0.65 m: brake and
 * turn one frame, goal turn the next) and the aircraft sat still for 30 s. Docking flies at ≤ 0.7 m/s, brakes
 * at 0.3 m (looming and forward range), keeps 0.3 m laterally (an 0.8 m door leaves 0.4 m to each jamb) and
 * settles within 0.15 m (less the follower's arrival bias) of its goal. Same controller kind, same features.
 */
export const DOCKING_COMMAND_CONFIG: CommandConfig = Object.freeze({
  ...MISSION_COMMAND_CONFIG,
  cruiseSpeedMps: 0.7,
  exploreSpeedMps: 0.4,
  stopDistanceM: 0.3,
  brakeTimeS: 1.0,
  rangeClearanceM: 0.3,
  lateralClearanceM: 0.3,
  rangeOnlySpeedMps: 0.25,
  arrivalRadiusM: 0.15,
  // Indoors and at apertures, in smoke: the original vision ramp (a faster range-only crawl measures spurious
  // looming in smoke), no range-known cruise, and turns toward an off-nose goal before moving on. The pose
  // relaxation from the cruise settings is kept.
  fullVisualConfidence: 0.3,
  rangeKnownM: Infinity,
  turnSpeedExponent: 1,
});

/**
 * Station keeping while an intervention executes on its standoff: the docking settings with a stiffer position
 * hold. A spray's jet reaction (about 3.2 N on the 2.2 kg Tender at 0.2 L/s) leaves the simulated velocity loop
 * (τ 0.2 s) a standing error of about τ·F/m ≈ 0.29 m/s, which only the position hold corrects. At the docking
 * hold gain of 0.8 /s the aircraft settles about 0.15 + 0.29/0.8 ≈ 0.51 m off its standoff, beyond the
 * harness's 0.4 m tolerance (H11 stopped live sprays at 0.402–0.422 m). At 2.5 /s it settles about 0.27 m off,
 * and the outer loop stays well damped against the 0.2 s inner loop (ζ ≈ 0.7).
 */
export const STATION_KEEPING_COMMAND_CONFIG: CommandConfig = Object.freeze({ ...DOCKING_COMMAND_CONFIG, approachGain: 2.5 });

/** Which command settings fly: cruise, close quarters ("dock"), or station keeping under an executing intervention. */
export type CloseQuarters = "cruise" | "dock" | "station";

const QUARTER_CONFIGS: Readonly<Record<CloseQuarters, CommandConfig>> = Object.freeze({ cruise: MISSION_COMMAND_CONFIG, dock: DOCKING_COMMAND_CONFIG, station: STATION_KEEPING_COMMAND_CONFIG });

export const FLOW_LABEL = "Optical-flow baseline";
export const FALLBACK_LABEL = "Optical-flow baseline (classical fallback — FlyVis unavailable)";

/** Opens a connected NeuralClient (WebSocket in the worker; injectable in tests). */
export type NeuralConnector = () => Promise<NeuralClient>;

export interface ControllerStep {
  /** Null when the controller produced a non-finite request (a controller fault). */
  readonly request: MotionRequest | null;
  readonly output: ControllerOutput;
  /** Set on the step that switched to the classical fallback. */
  readonly fallbackReason: string | null;
  readonly fault: string | null;
  /** Set when the stale-memory monitor reset the controller this step (stall.ts). */
  readonly resense: string | null;
}

type NeuralStatus = "active" | "warming_up" | "fallback" | "unavailable";

export class ControllerSlot {
  readonly mode: ControllerMode;
  private readonly flows: Readonly<Record<CloseQuarters, FlowBaselineController>>;
  private readonly readouts: Readonly<Record<CloseQuarters, EngineeredReadoutController>> | null;
  private quarters: CloseQuarters = "cruise";
  private neural: NeuralClient | null;
  private ready: NeuralReady | null = null;
  private status: NeuralStatus | null;
  private current: MotionFeatureVector | null = null;
  private latencyMs: number | null = null;
  private lastOutput: ControllerOutput | null = null;
  private inputFrameId: string | null = null;
  private readonly stall = new StallMonitor();

  private constructor(mode: ControllerMode, neural: NeuralClient | null, ready: NeuralReady | null, status: NeuralStatus | null) {
    this.mode = mode;
    const flow = (command: CommandConfig) => new FlowBaselineController({ command });
    this.flows = { cruise: flow(MISSION_COMMAND_CONFIG), dock: flow(DOCKING_COMMAND_CONFIG), station: flow(STATION_KEEPING_COMMAND_CONFIG) };
    this.neural = neural;
    this.ready = ready;
    this.status = status;
    const readout = (command: CommandConfig) => new EngineeredReadoutController({ features: () => this.current, command });
    this.readouts = mode === "engineered_readout" ? { cruise: readout(MISSION_COMMAND_CONFIG), dock: readout(DOCKING_COMMAND_CONFIG), station: readout(STATION_KEEPING_COMMAND_CONFIG) } : null;
  }

  private get flow(): FlowBaselineController {
    return this.flows[this.quarters];
  }

  private get readout(): EngineeredReadoutController | null {
    return this.readouts === null ? null : this.readouts[this.quarters];
  }

  /** The command settings of the controller now flying. */
  get commandConfig(): CommandConfig {
    return QUARTER_CONFIGS[this.quarters];
  }

  get isDocking(): boolean {
    return this.quarters !== "cruise";
  }

  get closeQuarters(): CloseQuarters {
    return this.quarters;
  }

  /**
   * Switch between the cruise and docking settings (same controller kind and features, different command
   * mapping). The newly active controller starts from a clean temporal state. Returns true on a change.
   */
  setDocking(docking: boolean): boolean {
    return this.setCloseQuarters(docking ? "dock" : "cruise");
  }

  /** Switch command settings (cruise, close quarters, station keeping); the newly active controller starts clean. */
  setCloseQuarters(quarters: CloseQuarters): boolean {
    if (quarters === this.quarters) return false;
    this.quarters = quarters;
    this.flow.reset();
    this.readout?.reset();
    return true;
  }

  /**
   * Build the slot for a run. For the engineered readout, connect and reset the FlyVis service first; if
   * that fails the slot starts in the labelled classical fallback and reports why in `startupFallback`.
   */
  static async create(mode: ControllerMode, runId: RunId, calibration: CameraCalibration, connect: NeuralConnector | null): Promise<{ slot: ControllerSlot; startupFallback: string | null }> {
    if (mode === "trained_readout") throw new Error("The trained FlyVis readout is not available yet (not trained); choose the optical-flow baseline or the engineered readout.");
    if (mode === "flow_baseline") return { slot: new ControllerSlot(mode, null, null, null), startupFallback: null };
    if (connect === null) return { slot: new ControllerSlot(mode, null, null, "fallback"), startupFallback: "No FlyVis service connection is configured." };
    let client: NeuralClient | null = null;
    try {
      client = await connect();
      const ready = await client.reset(runId, calibration);
      return { slot: new ControllerSlot(mode, client, ready, "warming_up"), startupFallback: null };
    } catch (error) {
      client?.close();
      return { slot: new ControllerSlot(mode, null, null, "fallback"), startupFallback: `FlyVis service unavailable: ${message(error)}` };
    }
  }

  get source(): MotionSource {
    if (this.mode === "flow_baseline") return "flow_baseline";
    return this.status === "fallback" ? "classical_fallback" : "engineered_readout";
  }

  get label(): string {
    if (this.mode === "flow_baseline") return FLOW_LABEL;
    if (this.status === "fallback" || this.ready === null) return FALLBACK_LABEL;
    return `FlyVis ${this.ready.model.name} + engineered readout`;
  }

  get checkpointSha256(): string | null {
    return this.status === "fallback" ? null : this.ready?.model.checkpointSha256 ?? null;
  }

  /** One visual-tick controller step on the frame actually consumed. */
  async step(input: ControllerInput, frame: CameraFrame): Promise<ControllerStep> {
    let fallbackReason: string | null = null;
    if (this.readout !== null && this.status !== "fallback" && this.neural !== null) {
      try {
        const started = performance.now();
        const features = await this.neural.step(frame, input.tick);
        this.latencyMs = performance.now() - started;
        this.current = featureVector(features);
        this.status = "active";
      } catch (error) {
        fallbackReason = `FlyVis step failed at tick ${input.tick}: ${message(error)}`;
        this.enterFallback();
      }
    }
    const useReadout = this.readout !== null && this.status === "active";
    const raw = useReadout && this.readout !== null ? this.readout.step(input) : this.flow.step(input);
    const output: ControllerOutput = { ...raw, request: { ...raw.request, source: this.source } };
    this.lastOutput = output;
    this.inputFrameId = frame.frameId;
    const fault = finiteRequest(output.request) ? null : `Controller ${this.label} produced a non-finite request at tick ${input.tick}; it was not passed to the harness.`;
    const resense = this.stall.update(input, output.features, this.commandConfig.stopDistanceM, this.commandConfig.arrivalRadiusM);
    if (resense !== null) (useReadout && this.readout !== null ? this.readout : this.flow).reset();
    return { request: fault === null ? output.request : null, output, fallbackReason, fault, resense };
  }

  view(): ControllerView {
    const neural = this.mode === "flow_baseline" ? null : {
      status: this.status ?? "unavailable",
      model: this.status === "fallback" ? null : this.ready?.model.name ?? null,
      checkpointSha256: this.checkpointSha256,
      latencyMs: this.status === "fallback" ? null : this.latencyMs,
    };
    return { mode: this.mode, label: this.label, source: this.source, features: { ...(this.lastOutput?.features ?? {}) }, neural, inputFrameId: this.inputFrameId, stepLabel: this.lastOutput?.label ?? null };
  }

  close(): void {
    this.neural?.close();
    this.neural = null;
  }

  private enterFallback(): void {
    this.status = "fallback";
    this.current = null;
    this.neural?.close();
    this.neural = null;
    this.flows.cruise.reset();
    this.flows.dock.reset();
  }
}

/** FlyVis sector features → the engineered readout's feature vector (sector order is [left, center, right]). */
export function featureVector(features: NeuralFeatures): MotionFeatureVector {
  const [left, center, right] = features.horizontalMotion;
  return { leftMotion: left, centerMotion: center, rightMotion: right, expansion: features.expansion };
}

export interface InputParts {
  readonly tick: number;
  readonly frame: CameraFrame;
  readonly goal: GoalEstimate | null;
  /** Measured motion (measuredMotion()), or the executed command when no measurement is available. */
  readonly previous: MotionCommand;
  readonly frameQuality: number;
  readonly poseSigmaM: number;
  readonly ranges: RangeReadings | null;
}

/**
 * The aircraft's measured motion for the controller's `previous` slot: the IMU gyro's yaw rate and the
 * localization estimate's velocity in the body frame (both noisy onboard measurements, never truth). The
 * controllers use `previous` to derotate flow and to turn looming into distance; the executed command is
 * not what the camera saw when the airframe lags it. Measured on the Troy run: with the command copy, a
 * yaw request that the airframe's yaw lag never realised was subtracted from the flow as if it had happened,
 * the residual read as a centering cue of the opposite sign, and the request flipped sign every frame
 * (±0.45 rad/s, zero net turn) in front of the rear bedroom window. Falls back to the command when the
 * IMU has not reported yet.
 */
export function measuredMotion(command: MotionCommand, gyroYawRateRadps: number | null, velocityWorld: Vec3 | null, yawRad: number): MotionCommand {
  const yawRateRadps = gyroYawRateRadps !== null && Number.isFinite(gyroYawRateRadps) ? gyroYawRateRadps : command.yawRateRadps;
  const velocityBody = velocityWorld !== null && isFiniteVec3(velocityWorld) && Number.isFinite(yawRad) ? rotateWorldToBody(yawRad, velocityWorld) : command.velocityBody;
  return { velocityBody, yawRateRadps };
}

/** The controller's whole input: frame, estimated goal, measured motion, explicit quality and range assistance. */
export function controllerInput(parts: InputParts): ControllerInput {
  const ranges: RangeAssist | null = parts.ranges === null ? null : { forwardM: parts.ranges.forwardM, leftM: parts.ranges.leftM, rightM: parts.ranges.rightM, downM: parts.ranges.downM };
  return { tick: parts.tick, frame: parts.frame, goal: parts.goal, previous: parts.previous, quality: { frame: parts.frameQuality, poseSigmaM: parts.poseSigmaM }, ranges };
}

function finiteRequest(request: MotionRequest): boolean {
  return isFiniteVec3(request.velocityBody) && Number.isFinite(request.yawRateRadps);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
