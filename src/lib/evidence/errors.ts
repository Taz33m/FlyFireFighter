/** Why the evidence store refused an input. The store's state is unchanged whenever one is raised. */
export type EvidenceErrorCode =
  /** The input belongs to another run (for example a reply that arrived after a reset). */
  | "other_run"
  /** An input with this identifier was already accepted. */
  | "duplicate_id"
  /** An observation claims to have arrived before it was captured. */
  | "arrival_before_capture"
  /** The input fails its boundary schema (unknown fields, non-finite numbers, malformed regions). */
  | "invalid"
  /** The input links to a report, track, room or observation the store does not hold. */
  | "unknown_reference"
  /** The requested correction does not apply to the current state (e.g. retracting a merged track). */
  | "invalid_state"
  /** A snapshot was requested for a tick before accepted evidence or before an earlier snapshot. */
  | "clock";

export class EvidenceRejection extends Error {
  readonly code: EvidenceErrorCode;

  constructor(code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = "EvidenceRejection";
    this.code = code;
  }
}
