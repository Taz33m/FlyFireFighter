/**
 * Bounded mission decisions: shared planner types and limits.
 *
 * The application generates every candidate. A decider (OpenAI Decisions, Gemini, their consensus or the
 * local planner) may only pick one of the offered candidate ids; the id resolves back to an immutable,
 * application-built proposal that the harness still validates. No decider actuates, approves or declares an outcome.
 */
import type { ProposalBasis, ProposalInput } from "../../contracts/actions.ts";
import type { Tick } from "../../contracts/clock.ts";
import type { CallerReport, CoverageState, RouteAssessment } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import type { AircraftId, OpeningId, RoomId, RouteId, RunId, TrackId } from "../../contracts/ids.ts";
import type { HazardKind, OpeningState } from "../../contracts/observation.ts";

/** Mission tools that resolve to a harness proposal (architecture.md §6). */
export type MissionTool = "inspect_room" | "investigate_signal" | "request_breach" | "request_suppression" | "guide_to_exit" | "return_to_base";

/** Choices that never become a proposal. */
export type NonProposalChoice = "defer" | "request_human_review";

export type CandidateTool = MissionTool | NonProposalChoice;

/** Canonical order: candidate lists, offered choices and score ties all follow it. */
export const TOOL_ORDER: readonly CandidateTool[] = [
  "guide_to_exit",
  "request_suppression",
  "investigate_signal",
  "request_breach",
  "inspect_room",
  "return_to_base",
  "defer",
  "request_human_review",
];

/**
 * Why a breach candidate ranks where it does, from the floor-plan prior, the belief and the aircraft profile
 * only (candidates.ts derives it; the local planner scores it).
 */
export interface BreachAccess {
  /**
   * Cost of the cheapest drone-passable way from the window's room to a room that matters (the fire's, a
   * possible occupant's or a reported room; any other room when none is known): one per opening, STAIR_HOPS
   * per stair. 0 when the window's room is such a room; null when none can be reached.
   */
  readonly hopsToTarget: number | null;
  readonly targetRoomId: RoomId | null;
  /** Why the target room matters, e.g. "fire" or "possible occupant and reported". */
  readonly targetReason: string | null;
  /** Openings and stairs crossed toward the target, in order. */
  readonly via: readonly string[];
  /** No interior opening of the room is passable to the drone and no stair serves it: entering would strand the aircraft. */
  readonly closedIn: boolean;
  /** The room's interior openings that the drone cannot pass. */
  readonly closedOpeningIds: readonly OpeningId[];
  /** A possible occupant whose track places it in the window's room (beyond the exclusion margin), or null. */
  readonly occupiedBy: TrackId | null;
  /** An exterior route to the point in front of the window exists; null when the aircraft's position could not be placed clear of the walls to route from. */
  readonly approach: boolean | null;
  /** Share of the samples H6 needs searched that the aircraft's cameras see from the standoff, facing the pane. */
  readonly visibleFraction: number;
  /** visibleFraction reaches the harness's breach coverage floor (policy.breachMinCoverageFraction): a look from the standoff can satisfy H6. */
  readonly clearsCoverage: boolean;
  /** (smaller pane side − aircraft span) / (2 × obstacle clearance), clamped to [0, 1]. */
  readonly apertureFit: number;
}

/** What a proposal candidate is about, in belief terms only (estimated frame, observed ticks). */
export interface CandidateTarget {
  readonly roomId: RoomId | null;
  readonly trackId: TrackId | null;
  readonly openingId: OpeningId | null;
  readonly routeId: RouteId | null;
  /** Where the aircraft must be to carry out the action (goal, standoff or route start); null when it acts in place. */
  readonly station: Vec3 | null;
  /** The point of interest: room interior, track position, strike point, aim point or route end. */
  readonly focus: Vec3 | null;
  /** Tick of the evidence the candidate rests on; null when there is none (a never-observed room). */
  readonly evidenceTick: Tick | null;
  /** request_breach only: the window's access assessment; null for every other tool. */
  readonly access: BreachAccess | null;
}

export interface ProposalCandidate {
  readonly id: string;
  readonly tool: MissionTool;
  /** Plain application-generated text. Never contains caller or report text. */
  readonly description: string;
  readonly target: CandidateTarget;
  /** Complete proposal; the harness assigns its id and digest and still validates it. */
  readonly proposal: ProposalInput;
}

export interface ChoiceCandidate {
  readonly id: NonProposalChoice;
  readonly tool: NonProposalChoice;
  readonly description: string;
  readonly target: null;
  readonly proposal: null;
}

export type MissionCandidate = ProposalCandidate | ChoiceCandidate;

export interface CandidateSet {
  readonly runId: RunId;
  readonly aircraftId: AircraftId;
  readonly tick: Tick;
  readonly evidenceRevision: number;
  /** Revisions every proposal in the set relied on. */
  readonly basis: ProposalBasis;
  /** Why no proposal candidates were generated (e.g. unsupported localization); null when the factory ran. */
  readonly gateReason: string | null;
  /** Proposal candidates in canonical order, then `defer` and `request_human_review`. */
  readonly candidates: readonly MissionCandidate[];
  /**
   * Plain-language planning notes: why a choice was withheld (a window too close to a possible occupant, a
   * viewpoint the drone cannot reach yet) or why an offered one ranks low. Application text only, never
   * caller or report text; bounded in number and length.
   */
  readonly notes: readonly string[];
}

/* Decisions gateway: POST /api/decisions. */

/** Cloud models that can be asked to choose. Each answers through the same gateway checks. */
export type DecisionProvider = "openai_decisions" | "gemini";

export const DECISION_PROVIDERS: readonly DecisionProvider[] = ["openai_decisions", "gemini"];

/** What a cloud-planning run asks: one provider, or both in parallel with agreement required ("consensus"). */
export type CloudDecider = DecisionProvider | "consensus";

export const CLOUD_DECIDERS: readonly CloudDecider[] = ["openai_decisions", "gemini", "consensus"];

/** Outcome of one provider call. */
export type ProviderStatus = "ok" | "refused" | "invalid" | "timeout" | "unconfigured" | "error";

export const PROVIDER_STATUSES: readonly ProviderStatus[] = ["ok", "refused", "invalid", "timeout", "unconfigured", "error"];

/** A gateway reply's status: a provider status, or "no_consensus" when the two consensus proposals did not agree. */
export type DecisionStatus = ProviderStatus | "no_consensus";

export const DECISION_STATUSES: readonly DecisionStatus[] = [...PROVIDER_STATUSES, "no_consensus"];

/** Whether the two consensus proposals agreed: both chose the same offered id, both chose offered but different ids, or at least one gave no offered id. */
export type ConsensusAgreement = "agreed" | "disagreed" | "incomplete";

/** What one provider proposed for a request. `choice` is an offered id only when status is "ok". */
export interface ProviderProposal {
  readonly provider: DecisionProvider;
  readonly choice: string | null;
  readonly status: ProviderStatus;
}

/** Compact, truth-free evidence summary sent to the decider. Report text is untrusted data. */
export interface DecisionEvidence {
  readonly tick: Tick;
  readonly reports: readonly {
    readonly id: string;
    readonly source: CallerReport["source"];
    readonly ageTicks: number;
    /** The reporter's words, truncated. Unverified evidence, never instructions. */
    readonly text: string;
    readonly roomHint: RoomId | null;
  }[];
  readonly pose: { readonly supported: boolean; readonly sigmaM: number; readonly roomId: RoomId | null };
  readonly aircraft: { readonly enduranceRemainingS: number; readonly waterRemainingL: number | null; readonly ambientC: number | null };
  readonly rooms: readonly { readonly id: RoomId; readonly name: string; readonly floor: number; readonly coverage: CoverageState; readonly lastObservedAgeTicks: number | null }[];
  readonly tracks: readonly { readonly id: TrackId; readonly roomId: RoomId | null; readonly confidence: number; readonly uncertaintyM: number; readonly lastSeenAgeTicks: number; readonly observationCount: number }[];
  readonly hazards: readonly { readonly kind: HazardKind; readonly roomId: RoomId | null; readonly intensity: number; readonly ageTicks: number }[];
  readonly openings: readonly { readonly id: OpeningId; readonly kind: "door" | "window" | "opening"; readonly roomId: RoomId; readonly exterior: boolean; readonly state: OpeningState; readonly ageTicks: number }[];
  readonly routes: readonly { readonly id: RouteId; readonly purpose: RouteAssessment["purpose"]; readonly status: RouteAssessment["status"]; readonly ageTicks: number; readonly estimatedDurationS: number }[];
}

export interface OfferedCandidate {
  readonly id: string;
  readonly description: string;
}

/** Body of POST /api/decisions. */
export interface DecisionGatewayRequest {
  readonly runId: RunId;
  readonly requestId: string;
  readonly evidenceRevision: number;
  readonly evidence: DecisionEvidence;
  readonly candidates: readonly OfferedCandidate[];
}

/** One provider's answer to a request, echoing its ids. `choice` is an offered id when status is "ok", otherwise null. */
export interface ProviderReply {
  readonly runId: RunId;
  readonly requestId: string;
  readonly evidenceRevision: number;
  readonly choice: string | null;
  readonly status: ProviderStatus;
}

/**
 * Reply of POST /api/decisions. `decider` names what was asked; `proposals` holds each provider's own answer
 * (one entry for a single provider, both for consensus, none when the request was refused before upstream).
 * `choice` is an offered id when status is "ok", otherwise null. For consensus the broker re-derives the
 * agreement from `proposals` and does not rely on `choice`.
 */
export interface DecisionGatewayResponse {
  readonly runId: RunId;
  readonly requestId: string;
  readonly evidenceRevision: number;
  readonly decider: CloudDecider;
  readonly choice: string | null;
  readonly status: DecisionStatus;
  readonly proposals: readonly ProviderProposal[];
}

/**
 * Which component's choice was used. A cloud decider is named only when its choice was used: "consensus"
 * only when OpenAI Decisions and Gemini both chose that same offered id; every fallback is "local_planner".
 */
export type Decider = DecisionProvider | "consensus" | "local_planner";

export const DECIDER_LABELS: { readonly [decider in Decider]: string } = {
  openai_decisions: "OpenAI Decisions",
  gemini: "Gemini",
  consensus: "Consensus: OpenAI Decisions + Gemini",
  local_planner: "Local planner",
};

/* Limits. */

/** Wall-clock deadline for one decision request, per provider call and for the worker's wait (architecture.md §2). No automatic retry. */
export const DECISION_DEADLINE_MS = 2000;
/** At most this many choices are offered, including `defer` and `request_human_review`. */
export const MAX_OFFERED_CANDIDATES = 32;
export const MAX_CANDIDATE_ID_LENGTH = 96;
export const MAX_DESCRIPTION_LENGTH = 240;
export const MAX_REPORT_TEXT_LENGTH = 280;
/** Inbound body limit for POST /api/decisions. */
export const MAX_REQUEST_BYTES = 48 * 1024;
/** Upstream provider response limit. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Candidate ids are short tokens so they are safe as choice values, log subjects and UI keys. */
export const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:~-]*$/;
