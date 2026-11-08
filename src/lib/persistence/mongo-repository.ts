/**
 * RunRepository on MongoDB Atlas with the official Node driver.
 *
 * - Ordinary indexes are created once per process with createIndexes (idempotent).
 * - A run is written as: replay uploaded to the GridFS bucket `replays` (gzip, metadata.runId), then one
 *   multi-document transaction inserting the `runs`, `events` and `decisions` documents. If the transaction
 *   fails, the uploaded replay is deleted again, so a failed save leaves nothing behind.
 * - Atlas Search readiness comes from listSearchIndexes (`queryable`); on a deployment without Atlas Search
 *   (e.g. a local mongod) the call fails and the state is "unsupported", which selects the regex fallback.
 *
 * Server-only. Credentials stay inside the MongoClient; nothing here logs or returns them.
 */
import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { ClientSession, Db, MongoClient, ObjectId } from "mongodb";
import { GridFSBucket, MongoServerError } from "mongodb";
import type { SearchIndexState } from "../../components/results/atlas-wire.ts";
import type { CollectionName, Doc, EventDocument, RunDocument, RunDocuments } from "./model.ts";
import { COLLECTIONS, REPLAY_BUCKET, replayFileName } from "./model.ts";
import type { RunRepository } from "./repository.ts";
import { DuplicateRunError } from "./repository.ts";
import { REGULAR_INDEXES } from "./search-indexes.ts";

const INSERT_BATCH = 1000;
const QUERY_MAX_TIME_MS = 15_000;

export async function createAllIndexes(db: Db): Promise<void> {
  for (const name of Object.values(COLLECTIONS)) {
    const specs = REGULAR_INDEXES.filter(index => index.collection === name).map(index => ({ key: { ...index.key }, name: index.name, unique: index.unique ?? false }));
    if (specs.length > 0) await db.collection(name).createIndexes(specs);
  }
}

async function uploadReplay(bucket: GridFSBucket, docs: RunDocuments): Promise<unknown> {
  if (docs.replay === null) return null;
  const stream = bucket.openUploadStream(replayFileName(docs.run.runId), { metadata: { ...docs.replay.metadata } });
  const finished = once(stream, "finish");
  stream.end(Buffer.from(docs.replay.gzip.buffer, docs.replay.gzip.byteOffset, docs.replay.gzip.byteLength));
  await finished;
  return stream.id;
}

async function insertInBatches(db: Db, name: CollectionName, docs: readonly object[], session: ClientSession): Promise<void> {
  for (let i = 0; i < docs.length; i += INSERT_BATCH) {
    await db.collection(name).insertMany(docs.slice(i, i + INSERT_BATCH).map(d => ({ ...d })), { session, ordered: true });
  }
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return new Uint8Array(Buffer.concat(chunks));
}

export function createMongoRepository(client: MongoClient, databaseName: string): RunRepository {
  const db = client.db(databaseName);
  const bucket = new GridFSBucket(db, { bucketName: REPLAY_BUCKET });
  let indexes: Promise<void> | null = null;

  return {
    kind: "atlas",
    databaseName,
    ensureIndexes() {
      indexes ??= createAllIndexes(db).catch(error => {
        indexes = null;
        throw error;
      });
      return indexes;
    },
    async findRunHeader(runId) {
      const run = await db.collection(COLLECTIONS.runs).findOne({ runId }, { projection: { _id: 0, runId: 1, bundleSha256: 1 } });
      if (run === null) return null;
      return { runId, bundleSha256: typeof run.bundleSha256 === "string" ? run.bundleSha256 : null };
    },
    async insertRun(docs) {
      const fileId = await uploadReplay(bucket, docs);
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await db.collection(COLLECTIONS.runs).insertOne({ ...docs.run }, { session });
          await insertInBatches(db, COLLECTIONS.events, docs.events, session);
          await insertInBatches(db, COLLECTIONS.decisions, docs.decisions, session);
        });
      } catch (error) {
        if (fileId !== null) await bucket.delete(fileId as ObjectId).catch(() => undefined);
        if (isDuplicateKey(error)) throw new DuplicateRunError(docs.run.runId);
        throw error;
      } finally {
        await session.endSession();
      }
    },
    async findRuns(match, projection, limit) {
      return db.collection(COLLECTIONS.runs).find(match, { projection, maxTimeMS: QUERY_MAX_TIME_MS }).sort({ savedAt: -1 }).limit(limit).toArray() as Promise<Doc[]>;
    },
    async aggregate(collection, pipeline) {
      return db.collection(collection).aggregate(pipeline.map(stage => ({ ...stage })), { maxTimeMS: QUERY_MAX_TIME_MS }).toArray() as Promise<Doc[]>;
    },
    async getRun(runId) {
      return (await db.collection(COLLECTIONS.runs).findOne({ runId }, { projection: { _id: 0 } })) as RunDocument | null;
    },
    async getEvents(runId) {
      return (await db.collection(COLLECTIONS.events).find({ runId }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray()) as unknown as EventDocument[];
    },
    async getReplayGzip(runId) {
      const [file] = await bucket.find({ "metadata.runId": runId }).sort({ uploadDate: -1 }).limit(1).toArray();
      return file === undefined ? null : readAll(bucket.openDownloadStream(file._id));
    },
    async searchIndexState(collection, name): Promise<SearchIndexState> {
      try {
        const [index] = await db.collection(collection).listSearchIndexes(name).toArray();
        if (index === undefined) return "missing";
        return (index as { readonly queryable?: unknown }).queryable === true ? "ready" : "pending";
      } catch {
        return "unsupported";
      }
    },
    async ping() {
      await db.command({ ping: 1 });
    },
  };
}
