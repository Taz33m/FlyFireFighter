/**
 * The Atlas data model for simulation run bundles (docs/persistence.md describes it for readers).
 *
 * - `runs`: one document per run: configuration, evaluator outcome and violations, timing, code state,
 *   summary metrics (stage ticks and seconds) and the exact results.json text, so an export is byte-exact.
 * - `events`: one document per mission event, unique on {runId, seq}. events.jsonl is rebuilt from these by
 *   canonical JSON and checked against the SHA-256 recorded in results.json.
 * - `decisions`: one document per planner decision event (decision.*), with the decider, model, chosen
 *   candidate, rationale, latency and agreement status when the event carries them.
 * - GridFS bucket `replays`: replay.jsonl gzip-compressed (several MB per run), one file per run with
 *   metadata {runId, sha256, bytes, frames}.
 */
import type { JsonValue } from "../contracts/canonical.ts";
import type { RunSource, StageValues } from "../../components/results/atlas-wire.ts";

export const COLLECTIONS = { runs: "runs", events: "events", decisions: "decisions" } as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
export const REPLAY_BUCKET = "replays";
export const RUN_DOCUMENT_SCHEMA = "flyfirefighter.atlas.run/1";

/** A MongoDB document as seen through the repository: plain JSON-like values plus Date and Uint8Array. */
export type Doc = { [key: string]: unknown };

export interface CodeState {
  readonly gitCommit: string | null;
  readonly gitBranch: string | null;
  /** Known only when the uploader ran `git status` (batch); null from the web server. */
  readonly gitDirty: boolean | null;
  readonly source: "git_head_file" | "git_cli" | "unknown";
}

export interface RunDocument {
  readonly schema: typeof RUN_DOCUMENT_SCHEMA;
  readonly runId: string;
  readonly label: string;
  readonly evidence: "simulation";
  readonly source: RunSource;
  readonly createdAt: Date;
  readonly createdAtSource: "run_id" | "saved_at";
  readonly savedAt: Date;
  /** SHA-256 over the three file hashes: the identity of the stored bundle (a second save must match it). */
  readonly bundleSha256: string;
  readonly conditionId: string | null;
  readonly config: {
    readonly scenarioId: string | null;
    readonly seed: string | null;
    readonly controller: string | null;
    readonly decider: string | null;
    readonly aircraftId: string | null;
    readonly commanderId: string | null;
    readonly speed: number | null;
  };
  readonly controllerLabel: string;
  readonly deciderLabel: string;
  readonly deciderStatus: string | null;
  readonly status: string | null;
  readonly outcome: {
    readonly scored: boolean;
    readonly completed: boolean;
    readonly rescueLabel: string | null;
    readonly words: string;
    readonly droneReturn: string | null;
    readonly violationCount: number;
    readonly collisions: number;
  };
  readonly violations: readonly { readonly tick: number; readonly kind: string; readonly detail: string }[];
  readonly timing: { readonly simulatedS: number | null; readonly wallMs: number | null; readonly simToWallRatio: number | null };
  readonly code: CodeState & {
    readonly sceneId: string | null;
    readonly sceneRevision: number | null;
    readonly sceneMetaSha256: string | null;
    readonly controllerCheckpointSha256: string | null;
    readonly eventsSha256: string;
    readonly replaySha256: string | null;
  };
  readonly metrics: {
    readonly events: number;
    readonly decisions: number;
    readonly replayFrames: number;
    readonly stageTicks: StageValues;
    readonly stageSeconds: StageValues;
    readonly approvals: number;
    readonly rejections: number;
    readonly aborts: number;
    readonly waterDischargedL: number;
  };
  readonly replay: { readonly stored: boolean; readonly bytes: number; readonly gzipBytes: number; readonly sha256: string | null; readonly frames: number };
  /** results.json exactly as uploaded. */
  readonly resultsJson: string;
  readonly problems: readonly string[];
}

export interface EventDocument {
  readonly runId: string;
  readonly seq: number;
  readonly tick: number;
  readonly source: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly data: { readonly [key: string]: JsonValue };
}

export interface DecisionDocument {
  readonly runId: string;
  readonly seq: number;
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  readonly decider: string | null;
  readonly deciderLabel: string | null;
  /** Recorded model id; null unless the event names one (nothing is inferred). */
  readonly model: string | null;
  readonly candidateId: string | null;
  /** The event's rationale field when present, otherwise its plain-language reason. */
  readonly rationale: string;
  readonly latencyMs: number | null;
  /** Agreement status exactly as recorded by the planner, when present. */
  readonly agreement: JsonValue | null;
  /** Whether the chosen candidate equals the local planner's own choice, when both are recorded. */
  readonly matchesLocalChoice: boolean | null;
  readonly gatewayStatus: string | null;
  readonly fallbackReason: string | null;
  readonly risk: string | null;
  readonly tool: string | null;
}

export interface ReplayFileMetadata {
  readonly runId: string;
  readonly encoding: "gzip";
  readonly contentType: "application/x-ndjson";
  readonly bytes: number;
  readonly sha256: string;
  readonly frames: number;
  readonly label: "simulation truth for the labelled replay view";
}

export interface RunDocuments {
  readonly run: RunDocument;
  readonly events: readonly EventDocument[];
  readonly decisions: readonly DecisionDocument[];
  readonly replay: { readonly gzip: Uint8Array; readonly metadata: ReplayFileMetadata } | null;
}

export function replayFileName(runId: string): string {
  return `${runId}.replay.jsonl.gz`;
}
