/**
 * Wire format of the /api/runs endpoints: MongoDB Atlas persistence of SIMULATION run bundles.
 *
 * Shared by the server handlers (src/lib/persistence/http.ts imports these types) and the browser client
 * (atlas-client.ts). It holds no credentials and imports nothing server-side, so client code never needs the
 * persistence module (src/lib/persistence-boundary.test.ts enforces that). Pure and browser-safe.
 *
 * Every run stored in Atlas is a simulation run: outcome words come from the evaluator result recorded in
 * the bundle (rescueLabel), recomputed on the server when the bundle is saved, never from a client field.
 */

/** Mission stages whose first tick is stored per run, in mission order. */
export const STAGES = ["evidence", "breach", "spray", "guide", "exit", "end"] as const;
export type StageName = (typeof STAGES)[number];

/** How each stage's tick is found, for captions. Times are simulated seconds after mission.authorized. */
export const STAGE_WORDS: Readonly<Record<StageName, string>> = {
  evidence: "Possible-occupant evidence",
  breach: "Breach executing",
  spray: "Spray executing",
  guide: "Guidance started",
  exit: "Occupant at assembly point",
  end: "Run ended",
};

/** Run ids become URL path segments and Atlas keys. Workspace ids look like run-<base36>-<hex>; batch ids like ev-main.flow-eval-seed-1. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/;

export type StageValues = { readonly [stage in StageName]: number | null };
export type StageCounts = { readonly [stage in StageName]: number };

export type RunSource = "workspace" | "batch";

export interface AtlasRunSummary {
  readonly runId: string;
  /** ISO times. createdAt comes from the workspace run id when it encodes one, otherwise it equals savedAt. */
  readonly savedAt: string;
  readonly createdAt: string;
  readonly source: RunSource;
  readonly label: string;
  readonly scenarioId: string | null;
  readonly seed: string | null;
  readonly controller: string | null;
  readonly controllerLabel: string;
  readonly decider: string | null;
  readonly deciderLabel: string;
  readonly conditionId: string | null;
  readonly status: string | null;
  readonly outcome: {
    readonly scored: boolean;
    readonly completed: boolean;
    /** Display words chosen from rescueLabel(result) only. */
    readonly words: string;
    readonly droneReturn: string | null;
    readonly violationCount: number;
    readonly collisions: number;
  };
  readonly stageSeconds: StageValues;
  readonly counts: { readonly events: number; readonly decisions: number; readonly replayFrames: number };
  readonly simulatedS: number | null;
  readonly gitCommit: string | null;
  /** Validation notes recorded with the bundle (e.g. an unusable evaluator result). */
  readonly problems: number;
}

export interface AtlasStatsRow {
  /** null for totals; a string for one dimension; {controller, decider, scenarioId} for a condition. */
  readonly key: string | null | { readonly controller: string | null; readonly decider: string | null; readonly scenarioId: string | null };
  readonly runs: number;
  readonly scored: number;
  readonly completed: number;
  readonly completionRate: number | null;
  readonly runsWithViolation: number;
  readonly violations: number;
  readonly collisions: number;
  /** Atlas $median (approximate method) of each stage time over the runs that reached it. */
  readonly medianStageS: StageValues;
  readonly stageCounts: StageCounts;
}

export interface AtlasStats {
  readonly totals: AtlasStatsRow | null;
  readonly byController: readonly AtlasStatsRow[];
  readonly byDecider: readonly AtlasStatsRow[];
  readonly byScenario: readonly AtlasStatsRow[];
  readonly byCondition: readonly AtlasStatsRow[];
  readonly violationKinds: readonly { readonly kind: string; readonly count: number; readonly runs: number }[];
}

export interface AtlasRunFilter {
  readonly controller?: string;
  readonly decider?: string;
  readonly scenarioId?: string;
  readonly outcome?: "completed" | "incomplete";
  readonly limit?: number;
}

export interface AtlasNotConfigured {
  readonly status: "not_configured";
  readonly message: string;
}

export interface AtlasFailure {
  readonly status: "error" | "invalid" | "forbidden" | "rate_limited" | "not_found" | "conflict" | "too_large";
  readonly message: string;
  readonly errors?: readonly string[];
}

export type AtlasStatusReply =
  | AtlasNotConfigured
  | AtlasFailure
  | { readonly status: "ok"; readonly database: string; readonly reachable: boolean; readonly search: { readonly events: SearchIndexState; readonly decisions: SearchIndexState } };

export type SearchIndexState = "ready" | "pending" | "missing" | "unsupported" | "unknown";

export type AtlasListReply = AtlasNotConfigured | AtlasFailure | { readonly status: "ok"; readonly runs: readonly AtlasRunSummary[]; readonly stats: AtlasStats };

export const BUNDLE_FILE_NAMES = ["results.json", "events.jsonl", "replay.jsonl"] as const;
export type AtlasBundleFiles = { readonly "results.json": string; readonly "events.jsonl": string; readonly "replay.jsonl"?: string };

export type AtlasBundleReply =
  | AtlasNotConfigured
  | AtlasFailure
  | { readonly status: "ok"; readonly runId: string; readonly savedAt: string; readonly source: RunSource; readonly files: AtlasBundleFiles; readonly problems: readonly string[] };

export type AtlasSaveReply =
  | AtlasNotConfigured
  | AtlasFailure
  | { readonly status: "saved" | "exists"; readonly runId: string; readonly counts: { readonly events: number; readonly decisions: number; readonly replayFrames: number } };

export interface SearchHighlight {
  readonly texts: readonly { readonly value: string; readonly type: "hit" | "text" }[];
}

export interface EventHit {
  readonly runId: string;
  readonly seq: number;
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  readonly reason: string;
  /** Atlas Search relevance; null in the regex fallback. */
  readonly score: number | null;
  readonly highlights: readonly SearchHighlight[];
}

export interface DecisionHit {
  readonly runId: string;
  readonly seq: number;
  readonly tick: number;
  readonly decider: string | null;
  readonly candidateId: string | null;
  readonly rationale: string;
  readonly score: number | null;
  readonly highlights: readonly SearchHighlight[];
}

export type SearchMode = "atlas_search" | "regex_fallback";

export type AtlasSearchReply =
  | AtlasNotConfigured
  | AtlasFailure
  | { readonly status: "ok"; readonly mode: SearchMode; readonly note: string | null; readonly events: readonly EventHit[]; readonly decisions: readonly DecisionHit[] };

export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_MAX = 50;
