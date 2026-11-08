/** Identifier aliases. All identifiers are opaque strings scoped to one run unless stated otherwise. */
export type RunId = string;
export type AircraftId = string;
export type ProposalId = string;
export type ObservationId = string;
export type ReportId = string;
export type TrackId = string;
export type RouteId = string;
export type RoomId = string;
export type OpeningId = string;
export type CommanderId = string;

/** Recursively freeze a plain data structure so shared contract values cannot be mutated in place. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
