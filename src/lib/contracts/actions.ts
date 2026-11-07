/**
 * Actions, proposals, approvals and actuation.
 *
 * Proposers submit a ProposalInput. The harness assigns the proposal id, computes the canonical digest,
 * decides the risk class and every safety check itself, and is the only issuer of actuator commands.
 * Approvals come only from the commander path and bind to the proposal id and digest; any substantive
 * change requires a new proposal and a new approval.
 */
import type { Tick } from "./clock.ts";
import type { Vec3 } from "./frames.ts";
import type { AircraftId, CommanderId, ObservationId, OpeningId, ProposalId, RouteId, RunId, TrackId } from "./ids.ts";
import { deepFreeze } from "./ids.ts";

export type ActionSpec =
  /** Advance toward a goal in the estimated world frame. */
  | { readonly kind: "move"; readonly goal: Vec3; readonly maxSpeedMps: number }
  | { readonly kind: "scan"; readonly lookAt: Vec3; readonly durationTicks: Tick }
  | { readonly kind: "hold"; readonly durationTicks: Tick }
  | { readonly kind: "return"; readonly routeId: RouteId }
  | { readonly kind: "land"; readonly site: Vec3 }
  | { readonly kind: "speak"; readonly templateId: string }
  | { readonly kind: "guide"; readonly trackId: TrackId; readonly routeId: RouteId; readonly templateIds: readonly string[]; readonly maxDurationTicks: Tick }
  /** Break the glass of one opening from a standoff position. The harness derives the debris region. */
  | { readonly kind: "breach_opening"; readonly openingId: OpeningId; readonly standoff: Vec3; readonly strikePoint: Vec3 }
  /** Water jet from a standoff toward an aim point. The harness derives the discharge sector and dose. */
  | { readonly kind: "spray"; readonly standoff: Vec3; readonly aimPoint: Vec3; readonly flowLps: number; readonly durationTicks: Tick }
  | { readonly kind: "release_payload"; readonly payloadId: string; readonly releasePoint: Vec3 };

export type ActionKind = ActionSpec["kind"];

export const ACTION_KINDS: readonly ActionKind[] = ["move", "scan", "hold", "return", "land", "speak", "guide", "breach_opening", "spray", "release_payload"];

/** Motion controllers (fly readout, optical-flow baseline) issue MotionRequests, not proposals. */
/** decisions_planner is OpenAI Decisions; gemini_planner and consensus_planner (OpenAI Decisions and Gemini agreeing) are the other cloud deciders. */
export type Proposer = "decisions_planner" | "gemini_planner" | "consensus_planner" | "local_planner" | "operator" | "contingency";

export const PROPOSERS: readonly Proposer[] = ["decisions_planner", "gemini_planner", "consensus_planner", "local_planner", "operator", "contingency"];

/** Revisions the proposer relied on. Profile, envelope and policy must still be current at execution. */
export interface ProposalBasis {
  readonly evidenceRevision: number;
  readonly mapRevision: number;
  readonly profileRevision: number;
  readonly envelopeRevision: number;
  readonly policyRevision: number;
}

export interface ProposalInput {
  readonly runId: RunId;
  readonly aircraftId: AircraftId;
  readonly proposer: Proposer;
  readonly action: ActionSpec;
  /** Shown to the commander. Never interpreted as instructions. */
  readonly rationale: string;
  readonly citedEvidence: readonly ObservationId[];
  readonly basis: ProposalBasis;
  readonly createdTick: Tick;
  readonly expiresTick: Tick;
}

/** Registered proposal. Immutable; digest = sha256(canonicalJson(ProposalInput)). */
export interface ActionProposal extends ProposalInput {
  readonly id: ProposalId;
  readonly digest: string;
}

/** Decided by the harness from the action kind; never accepted from a proposer. */
export type RiskClass = "routine" | "consequential";

export type ProposalStatus =
  | "proposed"
  | "validated"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "completed"
  | "rejected"
  | "expired"
  | "invalidated"
  | "aborted";

export const TERMINAL_STATUSES: readonly ProposalStatus[] = ["completed", "rejected", "expired", "invalidated", "aborted"];

export interface Approval {
  readonly runId: RunId;
  readonly proposalId: ProposalId;
  readonly digest: string;
  readonly commanderId: CommanderId;
  readonly issuedTick: Tick;
  /** Execution must start at or before this tick. */
  readonly expiresTick: Tick;
}

/** One rule decision, with the evidence that drove it. */
export interface Finding {
  readonly ruleId: string;
  readonly reason: string;
  readonly evidenceIds?: readonly ObservationId[];
}

/** Physical effects actually applied. Effects survive abort: spent water and broken glass stay recorded. */
export interface ActuationEffects {
  readonly waterDischargedL: number;
  readonly strikeDelivered: boolean;
  readonly payloadReleased: boolean;
  readonly cuesIssued: number;
  readonly ticksExecuted: number;
}

export interface ExecutionRecord {
  readonly proposalId: ProposalId;
  readonly startedTick: Tick;
  readonly endedTick: Tick | null;
  /** Every execution request received, including ignored duplicates. */
  readonly requestIds: readonly string[];
  readonly effects: ActuationEffects;
  readonly stopReason: string | null;
}

export interface ProposalHistoryEntry {
  readonly tick: Tick;
  readonly status: ProposalStatus;
  readonly reason: string;
  readonly ruleIds: readonly string[];
}

export interface ProposalRecord {
  readonly proposal: ActionProposal;
  readonly risk: RiskClass;
  readonly status: ProposalStatus;
  readonly approval: Approval | null;
  readonly execution: ExecutionRecord | null;
  readonly findings: readonly Finding[];
  readonly history: readonly ProposalHistoryEntry[];
}

/* Commands. Every command carries its runId; commands for another run are rejected (abort excepted). */

export interface ApproveCommand {
  readonly type: "approve";
  readonly runId: RunId;
  readonly proposalId: ProposalId;
  /** The digest of the proposal the commander was shown. */
  readonly digest: string;
  readonly commanderId: CommanderId;
  readonly tick: Tick;
}

export interface RejectCommand {
  readonly type: "reject";
  readonly runId: RunId;
  readonly proposalId: ProposalId;
  readonly commanderId: CommanderId;
  readonly tick: Tick;
  readonly reason: string;
}

export interface ExecuteCommand {
  readonly type: "execute";
  readonly runId: RunId;
  readonly proposalId: ProposalId;
  readonly digest: string;
  /** Idempotency key for this request; duplicates never repeat effects. */
  readonly requestId: string;
  readonly tick: Tick;
}

export interface AbortCommand {
  readonly type: "abort";
  readonly runId: RunId;
  readonly scope: "mission" | ProposalId;
  readonly by: CommanderId;
  readonly tick: Tick;
  readonly reason: string;
}

/* Actuation. */

export type ActuatorCommand =
  /**
   * Gimballed nozzle aimed at aimPoint in the ESTIMATED world frame. The simulator converts the aim through
   * the estimated pose into a body-frame direction and applies it from the true pose, so localization
   * error produces a real miss.
   */
  | { readonly kind: "water"; readonly proposalId: ProposalId; readonly flowLps: number; readonly volumeL: number; readonly aimPoint: Vec3 }
  | { readonly kind: "strike"; readonly proposalId: ProposalId; readonly openingId: OpeningId; readonly point: Vec3 }
  | { readonly kind: "release"; readonly proposalId: ProposalId; readonly payloadId: string; readonly point: Vec3 }
  | { readonly kind: "light_cue"; readonly proposalId: ProposalId; readonly target: Vec3 }
  | { readonly kind: "audio"; readonly proposalId: ProposalId; readonly templateId: string };

export type MotionSource = "fly_readout" | "engineered_readout" | "flow_baseline" | "classical_fallback" | "contingency" | "operator";

/** Velocity request in the body frame (forward, left, up) in m/s plus yaw rate in rad/s. */
export interface MotionRequest {
  readonly source: MotionSource;
  readonly tick: Tick;
  readonly velocityBody: Vec3;
  readonly yawRateRadps: number;
}

export interface MotionCommand {
  readonly velocityBody: Vec3;
  readonly yawRateRadps: number;
}

export type MotionLimit =
  | "speed"
  /** Closing speed on a possible occupant limited to keep the harness's person clearance (H18, motion guard). */
  | "person_clearance"
  | "vertical_speed"
  | "yaw_rate"
  | "acceleration"
  | "no_active_goal"
  | "localization"
  | "envelope_boundary"
  | "mission_aborted";

export interface GuardedMotion {
  readonly requested: MotionRequest;
  readonly executed: MotionCommand;
  readonly limits: readonly MotionLimit[];
}

/** Everything the simulator may apply for one tick. The simulator accepts only harness-issued batches. */
export interface ActuatorBatch {
  readonly runId: RunId;
  readonly tick: Tick;
  readonly motion: GuardedMotion | null;
  readonly commands: readonly ActuatorCommand[];
}

/** A supported contingency, or an explicit failure when no supported maneuver remains. */
export type Contingency =
  | { readonly kind: "return"; readonly routeId: RouteId; readonly reason: string; readonly evidenceIds: readonly ObservationId[]; readonly termination: string }
  | { readonly kind: "alternate_route"; readonly routeId: RouteId; readonly reason: string; readonly evidenceIds: readonly ObservationId[]; readonly termination: string }
  | { readonly kind: "hold"; readonly maxTicks: Tick; readonly reason: string; readonly evidenceIds: readonly ObservationId[]; readonly termination: string }
  | { readonly kind: "land"; readonly site: Vec3; readonly reason: string; readonly evidenceIds: readonly ObservationId[]; readonly termination: string }
  | { readonly kind: "failure"; readonly terminalBehavior: "brake_and_descend"; readonly reason: string; readonly evidenceIds: readonly ObservationId[]; readonly termination: string };

/** Approved scenario speech. Templates that mention dispatch require a commander-entered dispatch fact. */
export interface SpeechTemplate {
  readonly id: string;
  readonly text: string;
  readonly requiresDispatchConfirmed: boolean;
}

export const SPEECH_TEMPLATES: readonly SpeechTemplate[] = deepFreeze([
  { id: "follow-light", text: "Follow the light. It leads the way out.", requiresDispatchConfirmed: false },
  { id: "stay-low", text: "Stay low, below the smoke.", requiresDispatchConfirmed: false },
  { id: "wait-for-light", text: "Wait here until the light moves.", requiresDispatchConfirmed: false },
  { id: "exit-ahead", text: "The way out is ahead. Keep going.", requiresDispatchConfirmed: false },
  { id: "firefighters-dispatched", text: "Firefighters have been dispatched.", requiresDispatchConfirmed: true },
]);
