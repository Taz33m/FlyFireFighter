/**
 * In-memory RunRepository for offline tests: no network, no Atlas. Documents are deep-copied across the
 * boundary (as BSON would), the run id is unique, a run's documents are committed together, the replay is
 * split into GridFS-style chunks and reassembled, and aggregation pipelines run through memory-aggregate.ts.
 * $search pipelines (Atlas only) are answered by an injectable responder, so tests can check the pipeline
 * the service sends and how results map, without pretending to implement Atlas Search.
 */
import type { SearchIndexState } from "../../components/results/atlas-wire.ts";
import { matches, project, runPipeline } from "./memory-aggregate.ts";
import type { CollectionName, Doc, EventDocument, ReplayFileMetadata, RunDocument, RunDocuments } from "./model.ts";
import { replayFileName } from "./model.ts";
import type { RunRepository } from "./repository.ts";
import { DuplicateRunError } from "./repository.ts";

export interface StoredFile {
  readonly filename: string;
  readonly metadata: ReplayFileMetadata;
  readonly chunks: readonly Uint8Array[];
}

export interface MemoryRepositoryOptions {
  readonly databaseName?: string;
  readonly searchState?: SearchIndexState;
  readonly searchResponder?: (collection: CollectionName, pipeline: readonly Doc[]) => Doc[];
  readonly chunkSizeBytes?: number;
  readonly failPing?: boolean;
}

export interface MemoryRepository extends RunRepository {
  readonly collections: { readonly [name in CollectionName]: Doc[] };
  readonly files: StoredFile[];
  readonly calls: { readonly collection: CollectionName; readonly pipeline: readonly Doc[] }[];
  readonly indexBuilds: () => number;
}

function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) chunks.push(bytes.slice(offset, offset + size));
  return chunks;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

const copy = <T>(value: T): T => structuredClone(value);

export function createMemoryRepository(options: MemoryRepositoryOptions = {}): MemoryRepository {
  const collections: { [name in CollectionName]: Doc[] } = { runs: [], events: [], decisions: [] };
  const files: StoredFile[] = [];
  const calls: { collection: CollectionName; pipeline: readonly Doc[] }[] = [];
  const chunkSize = options.chunkSizeBytes ?? 255 * 1024;
  let indexBuilds = 0;

  return {
    kind: "memory",
    databaseName: options.databaseName ?? "flyfirefighter-test",
    collections,
    files,
    calls,
    indexBuilds: () => indexBuilds,
    async ensureIndexes() {
      indexBuilds += 1;
    },
    async findRunHeader(runId) {
      const run = collections.runs.find(r => r.runId === runId) as unknown as RunDocument | undefined;
      return run === undefined ? null : { runId, bundleSha256: run.bundleSha256 };
    },
    async insertRun(docs: RunDocuments) {
      if (collections.runs.some(r => r.runId === docs.run.runId)) throw new DuplicateRunError(docs.run.runId);
      // Built completely first, then committed in one step (the Atlas implementation uses a transaction).
      const staged = { run: copy(docs.run) as unknown as Doc, events: docs.events.map(e => copy(e) as unknown as Doc), decisions: docs.decisions.map(d => copy(d) as unknown as Doc) };
      if (docs.replay !== null) files.push({ filename: replayFileName(docs.run.runId), metadata: copy(docs.replay.metadata), chunks: chunk(docs.replay.gzip, chunkSize) });
      collections.runs.push(staged.run);
      collections.events.push(...staged.events);
      collections.decisions.push(...staged.decisions);
    },
    async findRuns(match, projection, limit) {
      const found = collections.runs.filter(r => matches(r, match));
      found.sort((a, b) => (b.savedAt as Date).getTime() - (a.savedAt as Date).getTime());
      return found.slice(0, limit).map(r => project(r, projection));
    },
    async aggregate(collection, pipeline) {
      calls.push({ collection, pipeline: copy(pipeline) });
      if (pipeline.some(stage => "$search" in stage)) {
        if (options.searchResponder === undefined) throw new Error("Atlas Search is not available in the in-memory repository.");
        return options.searchResponder(collection, pipeline);
      }
      return runPipeline(collections[collection], pipeline);
    },
    async getRun(runId) {
      const run = collections.runs.find(r => r.runId === runId);
      return run === undefined ? null : (copy(run) as unknown as RunDocument);
    },
    async getEvents(runId) {
      return collections.events.filter(e => e.runId === runId).sort((a, b) => (a.seq as number) - (b.seq as number)).map(e => copy(e) as unknown as EventDocument);
    },
    async getReplayGzip(runId) {
      const file = files.find(f => f.metadata.runId === runId);
      return file === undefined ? null : concat(file.chunks);
    },
    async searchIndexState() {
      return options.searchState ?? "unsupported";
    },
    async ping() {
      if (options.failPing) throw new Error("unreachable");
    },
  };
}

