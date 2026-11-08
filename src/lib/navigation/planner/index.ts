/**
 * Bounded mission decisions: deterministic candidate factory, local planner, Decisions gateway (server)
 * and decision broker (mission worker). A decider only chooses among application-generated candidates; it
 * never actuates, approves or declares success.
 */
export type { BrokerOptions, BrokerStep, DecisionRecord, DiscardedReply, DiscardReason } from "./broker.ts";
export { attributeProposal, buildGatewayRequest, DecisionBroker, decisionEvent, discardEvent } from "./broker.ts";
export type { AvoidedPoint, CandidateFactoryInput, GuidedTrack, Incumbent } from "./candidates.ts";
export { breachAccessOf, buildCandidateSet, candidateId, isHomeward, isReturnRefresh, isStandClear, nextSweepStep, resolveCandidate, STAIR_HOPS } from "./candidates.ts";
export type { DecisionLoopOptions, DecisionTransport } from "./client.ts";
export { DecisionLoop, httpDecisionTransport } from "./client.ts";
export { decisionEvidenceSchema, summarizeEvidence } from "./evidence-summary.ts";
export type { DecisionGatewayRejection, DecisionsApiBody, DecisionsApiOptions, FetchLike } from "./gateway.ts";
export {
  buildDecisionsApiBody,
  callDecisionsApi,
  DECISION_INSTRUCTIONS,
  DECISION_QUESTION_NAME,
  DECISIONS_ENDPOINT,
  DECISIONS_MODEL,
  handleDecisionHttpRequest,
  interpretDecisionsResponse,
  parseDecisionRequest,
  parseGatewayResponse,
} from "./gateway.ts";
export type { LocalPlan, RankedCandidate, ScoreBreakdown } from "./local-planner.ts";
export { BREACH_ACCESS_WEIGHTS, breachAccessScore, UNCONFIRMED_ACCESS_FACTOR, unconfirmedAccessScore } from "./access-score.ts";
export { PLANNER_WEIGHTS, rankCandidates } from "./local-planner.ts";
export type {
  BreachAccess,
  CandidateSet,
  CandidateTarget,
  CandidateTool,
  ChoiceCandidate,
  Decider,
  DecisionEvidence,
  DecisionGatewayRequest,
  DecisionGatewayResponse,
  DecisionStatus,
  MissionCandidate,
  MissionTool,
  NonProposalChoice,
  OfferedCandidate,
  ProposalCandidate,
} from "./types.ts";
export { DECIDER_LABELS, DECISION_DEADLINE_MS, DECISION_STATUSES, MAX_OFFERED_CANDIDATES, TOOL_ORDER } from "./types.ts";
