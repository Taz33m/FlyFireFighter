/**
 * The small storage interface the persistence service uses. mongo-repository.ts implements it with the
 * official driver on Atlas; memory-repository.ts implements it in memory for offline tests. Everything above
 * this line (validation, documents, pipelines, HTTP handling) is shared by both.
 */
import type { SearchIndexState } from "../../components/results/atlas-wire.ts";
import type { CollectionName, Doc, EventDocument, RunDocument, RunDocuments } from "./model.ts";

export interface RunRepository {
  readonly kind: "atlas" | "memory";
  readonly databaseName: string;
  /** Create the ordinary indexes (idempotent; implementations run it once per process). */
  ensureIndexes(): Promise<void>;
  /** The run's id and bundle hash when it is already stored. */
  findRunHeader(runId: string): Promise<{ readonly runId: string; readonly bundleSha256: string | null } | null>;
  /** Store a run's documents and replay together. Throws DuplicateRunError when the run id exists. */
  insertRun(docs: RunDocuments): Promise<void>;
  /** Runs matching an exact-match filter, newest saved first, projected. */
  findRuns(match: Doc, projection: Doc, limit: number): Promise<Doc[]>;
  aggregate(collection: CollectionName, pipeline: readonly Doc[]): Promise<Doc[]>;
  getRun(runId: string): Promise<RunDocument | null>;
  getEvents(runId: string): Promise<EventDocument[]>;
  getReplayGzip(runId: string): Promise<Uint8Array | null>;
  searchIndexState(collection: CollectionName, name: string): Promise<SearchIndexState>;
  ping(): Promise<void>;
}

export class DuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is already stored.`);
    this.name = "DuplicateRunError";
  }
}
