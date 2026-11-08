/**
 * Mission worker ↔ command UI protocol ("flyfirefighter.mission/1").
 *
 * The Web Worker owns the simulation clock, world, evidence, planner, harness and event log. The UI sends
 * commands and renders what the worker posts. Two views are kept apart:
 * - MissionView is truth-free. Every command panel (action card, rescue record, timeline, fly reflex
 *   panel, results) reads only this.
 * - RenderSnapshot is privileged simulation truth. Only the 3D renderer may read it: to draw the labelled
 *   simulation view and to render the drone camera from where the aircraft really is. Its contents never
 *   enter planner, harness or controller inputs, and panels never display it except in a labelled
 *   post-run evaluator overlay.
 *
 * Camera loop: the worker posts render_request at the visual cadence (50 Hz of simulation time); the UI
 * renders that exact pose with the locked calibration and replies with camera_frame tagged with the same
 * runId/tick/frameId. A frame for another run, tick or id is discarded. Rendering never advances physics.
 *
 * Lifecycle: the worker posts `ready` once on startup. `reset` stops and discards the current run (every
 * old approval and reply becomes invalid) without starting another; `start_run` starts a run with a new
 * runId, confirmed by `run_started`.
 */
import type { ActuatorCommand, AbortCommand, ApproveCommand, Contingency, GuardedMotion, MotionSource, ProposalRecord, RejectCommand } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { MissionEvent } from "../contracts/events.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import type { RunId } from "../contracts/ids.ts";
import type { MissionResult } from "../contracts/outcomes.ts";
import type { OccupancySummary } from "../evidence/summary.ts";

export const MISSION_PROTOCOL = "flyfirefighter.mission/1";

/* Configuration. */

/** Which motion controller drives the aircraft. Fly readouts consume actual FlyVis features. */
export type ControllerMode = "flow_baseline" | "engineered_readout" | "trained_readout";

/**
 * Who chooses among the harness-built candidates: the local planner only; OpenAI Decisions or Gemini (local
 * fallback); or "consensus", both models in parallel with their choice used only when they agree.
 */
export type DeciderMode = "local" | "decisions" | "gemini" | "consensus";

export interface RunConfig {
  readonly scenarioId: string;
  readonly seed: string;
  readonly aircraftId: string;
  readonly controller: ControllerMode;
  readonly decider: DeciderMode;
  readonly commanderId: string;
  /** Display pacing only (simulated seconds per wall second); physics stays at the fixed 100 Hz step. */
  readonly speed: number;
}

/* Experiment controls: they act on the simulated world, so their effects reach command only through the
 * normal sensor → evidence path. */
export type Experiment =
  | { readonly kind: "add_smoke"; readonly roomId: string; readonly extinctionPerM: number }
  | { readonly kind: "add_obstruction"; readonly min: Vec3; readonly max: Vec3 }
  | { readonly kind: "degrade_localization"; readonly sigmaIncreaseM: number }
  /** Judge challenge: a person steps into the pending spray region; sensors must detect them normally. */
  | { readonly kind: "add_occupant"; readonly position: Vec3 }
  | { readonly kind: "set_door"; readonly openingId: string; readonly state: "open" | "closed" };

/* UI → worker. */

export type UiCommand =
  | { readonly type: "start_run"; readonly config: RunConfig }
  | { readonly type: "reset" }
  | { readonly type: "pause"; readonly runId: RunId }
  | { readonly type: "resume"; readonly runId: RunId }
  | { readonly type: "set_speed"; readonly runId: RunId; readonly speed: number }
  | { readonly type: "report"; readonly runId: RunId; readonly text: string; readonly channel: "typed" | "voice"; readonly source: "judge" | "caller" }
  /** Commander starts the bounded mission (approves the preset mission envelope). */
  | { readonly type: "authorize_mission"; readonly runId: RunId; readonly commanderId: string }
  | ApproveCommand
  | RejectCommand
  | AbortCommand
  | { readonly type: "experiment"; readonly runId: RunId; readonly experiment: Experiment }
  | CameraFrameMessage
  | { readonly type: "export_run"; readonly runId: RunId };

export interface CameraFrameMessage {
  readonly type: "camera_frame";
  readonly runId: RunId;
  readonly tick: Tick;
  readonly frameId: string;
  readonly calibrationId: string;
  readonly width: number;
  readonly height: number;
  /** Renderer and texture-set identity, e.g. "three-glb/procedural-detail/v1" or "headless-collider/v1". */
  readonly renderer: string;
  /** Row-major from the TOP-left pixel (flip WebGL readPixels rows), display-encoded luminance in [0, 1]. */
  readonly luminance: Float32Array;
}

/* Worker → UI. */

export type MissionStatus = "awaiting_report" | "awaiting_authorization" | "running" | "paused" | "aborted" | "ended";

export interface ControllerView {
  readonly mode: ControllerMode;
  /** Exact label, e.g. "FlyVis flow/0000/000 + engineered readout" or "Optical-flow baseline"; fallbacks say so. */
  readonly label: string;
  readonly source: MotionSource;
  readonly features: { readonly [name: string]: number };
  readonly neural: {
    readonly status: "active" | "warming_up" | "fallback" | "unavailable";
    readonly model: string | null;
    readonly checkpointSha256: string | null;
    readonly latencyMs: number | null;
  } | null;
  /** Frame id of the actual controller input shown in the fly reflex panel. */
  readonly inputFrameId: string | null;
  /**
   * The last controller step's "<source>/<mode>" label (ControllerOutput.label, e.g. "flow_baseline/slow_range"),
   * which the fly reflex panel words as a callout; null before the first step. Optional so fixture views need not set it.
   */
  readonly stepLabel?: string | null;
}

export interface DeciderView {
  /**
   * Names only a model that produced the choice used: "OpenAI Decisions" or "Gemini" for that provider's
   * choice, "Consensus: OpenAI Decisions + Gemini" only when both chose the same candidate; otherwise
   * "Local planner" (the status then says why, e.g. "Local planner (consensus not reached: …)").
   */
  readonly label: "OpenAI Decisions" | "Gemini" | "Consensus: OpenAI Decisions + Gemini" | "Local planner";
  readonly status: string;
  readonly lastChoice: { readonly candidateId: string; readonly description: string; readonly tick: Tick } | null;
}

/** Truth-free state for every command panel. */
export interface MissionView {
  readonly runId: RunId;
  readonly config: RunConfig;
  readonly status: MissionStatus;
  readonly tick: Tick;
  /** Simulated seconds advanced per wall second over the last second; null until measured. */
  readonly simToWallRatio: number | null;
  readonly envelope: MissionEnvelope | null;
  readonly belief: BeliefSnapshot;
  readonly occupancy: OccupancySummary;
  readonly proposals: readonly ProposalRecord[];
  /** The single decision waiting for the commander, if any (the action card). */
  readonly pendingApproval: ProposalRecord | null;
  /** Harness-derived affected regions, keyed by proposal id, for display. */
  readonly affectedRegions: readonly { readonly proposalId: string; readonly region: Region }[];
  readonly motion: GuardedMotion | null;
  readonly controller: ControllerView;
  readonly decider: DeciderView;
  readonly contingency: Contingency | null;
  readonly water: { readonly remainingL: number | null; readonly dischargedL: number };
}

/** Privileged simulation truth for the renderer only. */
export interface RenderSnapshot {
  readonly label: "simulation_truth_for_rendering";
  readonly tick: Tick;
  readonly drone: { readonly position: Vec3; readonly yawRad: number; readonly velocity: Vec3 };
  readonly occupants: readonly {
    readonly key: string;
    readonly position: Vec3;
    readonly yawRad: number;
    readonly animation: "idle" | "crouch" | "cough" | "walk" | "follow";
    readonly activity: string;
  }[];
  readonly fires: readonly { readonly id: string; readonly region: Region; readonly heatReleaseKW: number; readonly extinguished: boolean }[];
  readonly rooms: readonly { readonly id: string; readonly smokeExtinctionPerM: number; readonly temperatureC: number }[];
  readonly openings: readonly { readonly id: string; readonly state: "closed" | "open" | "broken" | "blocked" }[];
  /** Collider ids removed since load (broken glass, opened doors) and colliders added by experiments. */
  readonly removedColliderIds: readonly string[];
  readonly addedColliders: readonly { readonly id: string; readonly min: Vec3; readonly max: Vec3 }[];
  readonly cues: { readonly light: { readonly origin: Vec3; readonly target: Vec3 } | null; readonly audioTemplateId: string | null };
  /** Commands applied this tick (e.g. an active water jet), for effects rendering. */
  readonly actuators: readonly ActuatorCommand[];
  /** The TRUE jet this tick (nozzle origin, unit axis, cone and range), so a miss caused by localization error is visible. */
  readonly waterJet: { readonly origin: Vec3; readonly axis: Vec3; readonly halfAngleRad: number; readonly rangeM: number } | null;
}

export interface RenderRequest {
  readonly type: "render_request";
  readonly runId: RunId;
  readonly tick: Tick;
  readonly frameId: string;
  readonly calibrationId: string;
  /** TRUE aircraft pose: the physical camera is where the aircraft actually is. */
  readonly pose: { readonly position: Vec3; readonly yawRad: number };
  /** World state at that tick, so smoke, fire, openings and actors match the frame being rendered. */
  readonly world: RenderSnapshot;
}

/**
 * One line of replay.jsonl in an exported run bundle (written at ≤ 10 Hz of simulation time). A replay
 * plays these recorded snapshots back; it never re-runs cloud calls. The summary is truth-free.
 */
export interface ReplayFrame {
  readonly tick: Tick;
  readonly render: RenderSnapshot;
  readonly summary: {
    readonly status: MissionStatus;
    readonly controllerLabel: string;
    readonly deciderLabel: DeciderView["label"];
    readonly waterRemainingL: number | null;
    readonly pendingApprovalId: string | null;
    readonly contingency: Contingency["kind"] | null;
    /** The aircraft's ESTIMATED position (the belief's pose, never simulation truth), for the truth-free replay rail. */
    readonly estimatedPosition: Vec3 | null;
  };
}

/** Files in an exported run bundle (the "export" message and evaluation/runs/<run>/). */
export const RUN_BUNDLE_FILES = ["events.jsonl", "results.json", "replay.jsonl"] as const;

export type WorkerMessage =
  | { readonly type: "ready"; readonly protocol: typeof MISSION_PROTOCOL }
  | { readonly type: "run_started"; readonly runId: RunId; readonly config: RunConfig; readonly scene: { readonly sceneId: string; readonly revision: number; readonly baseUrl: string } }
  | { readonly type: "view"; readonly runId: RunId; readonly view: MissionView; readonly render: RenderSnapshot }
  | RenderRequest
  | { readonly type: "events"; readonly runId: RunId; readonly events: readonly MissionEvent[] }
  | { readonly type: "outcome"; readonly runId: RunId; readonly result: MissionResult }
  | { readonly type: "export"; readonly runId: RunId; readonly files: { readonly [name: string]: string } }
  | { readonly type: "error"; readonly runId: RunId | null; readonly message: string };
