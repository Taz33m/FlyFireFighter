/**
 * Evidence: attributed reports, possible-occupant tracks, corrections, confirmations, coverage and the
 * truth-free BeliefSnapshot. Planners and the harness read only `EvidenceStore.snapshot()`.
 */
export type { EvidenceConfig } from "./config.ts";
export { defaultEvidenceConfig, EVIDENCE_DEFAULTS } from "./config.ts";
export type { EvidenceErrorCode } from "./errors.ts";
export { EvidenceRejection } from "./errors.ts";
export type { FireClassCue, FireStatement, ReportInterpretation } from "./interpret.ts";
export { fireClassCues, fireStatements, interpretReport } from "./interpret.ts";
export type { FireClassEvidence } from "./fire-class.ts";
export { assessFireClass, FIRE_CLASS_LABELS, NEAR_FIRE_M } from "./fire-class.ts";
export type { IngestRejectionReason, IngestResult, MapChangeInput, SnapshotInput } from "./store.ts";
export { EvidenceStore, snapshotInputProblems } from "./store.ts";
export { FRESHNESS_RESOLUTION, searchedFractionSince } from "./coverage.ts";
export { supersessionProblem, supersessions } from "./supersession.ts";
export type { OccupancySummary, PossibleTrackAccount, ReportAccount } from "./summary.ts";
export { occupancySummary } from "./summary.ts";
export type { TrackChange, TrackCorrection } from "./tracks.ts";
