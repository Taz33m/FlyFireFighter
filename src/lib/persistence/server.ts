/**
 * Server entry point of the persistence module: builds the Atlas repository from MONGODB_URI/MONGODB_DB and
 * the route dependencies for /api/runs. Imported only by route handlers under src/app/api/runs and by
 * scripts; never by client components, hooks, the Web Worker or simulation/harness/planner code
 * (src/lib/persistence-boundary.test.ts).
 *
 * One MongoClient per process, cached on globalThis so `next dev` hot reloads do not open a new pool each
 * time. The client connects lazily on first use with a small pool and short server-selection timeout.
 */
import { MongoClient } from "mongodb";
import { readGitHead } from "./code-state.ts";
import type { PersistenceConfig, PersistenceEnv } from "./config.ts";
import { readPersistenceConfig } from "./config.ts";
import type { RateLimiter } from "./guard.ts";
import { allowedHostsFromEnv, tokenBucket } from "./guard.ts";
import type { RunsHttpDeps } from "./http.ts";
import type { CodeState } from "./model.ts";
import { createMongoRepository } from "./mongo-repository.ts";
import type { RunRepository } from "./repository.ts";

interface Cached {
  readonly key: string;
  readonly client: MongoClient;
  readonly repository: RunRepository;
}

const GLOBAL_KEY = Symbol.for("flyfirefighter.atlas");
type Holder = { [GLOBAL_KEY]?: Cached };

export function createAtlasClient(uri: string): MongoClient {
  return new MongoClient(uri, { appName: "flyfirefighter", maxPoolSize: 5, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, retryWrites: true });
}

/** The process's Atlas repository, or null with the reason when persistence is not configured. */
export function atlasRepository(env: PersistenceEnv = process.env): { readonly repository: RunRepository | null; readonly config: PersistenceConfig } {
  const config = readPersistenceConfig(env);
  if (!config.configured) return { repository: null, config };
  const holder = globalThis as Holder;
  const key = `${config.dbName}\u0000${config.uri}`;
  if (holder[GLOBAL_KEY]?.key !== key) {
    void holder[GLOBAL_KEY]?.client.close().catch(() => undefined);
    const client = createAtlasClient(config.uri);
    holder[GLOBAL_KEY] = { key, client, repository: createMongoRepository(client, config.dbName) };
  }
  return { repository: holder[GLOBAL_KEY]?.repository ?? null, config };
}

/** Close the cached client (scripts call this before exiting). */
export async function closeAtlas(): Promise<void> {
  const holder = globalThis as Holder;
  const cached = holder[GLOBAL_KEY];
  delete holder[GLOBAL_KEY];
  await cached?.client.close();
}

let codeState: CodeState | null = null;

/** Route dependencies; env is read on every call so a changed .env.local takes effect after a restart. */
export function runsRouteDeps(limiter: RateLimiter): RunsHttpDeps {
  return {
    repository: () => atlasRepository().repository,
    notConfiguredReason: (() => {
      const config = readPersistenceConfig(process.env);
      return config.configured ? undefined : config.reason;
    })(),
    allowedHosts: allowedHostsFromEnv(process.env.PERSISTENCE_ALLOWED_HOSTS),
    limiter,
    code: () => (codeState ??= readGitHead(process.cwd())),
  };
}

/** Per-route token buckets: saving is rare and heavy; listing and search are interactive. */
export const routeLimits = {
  save: () => tokenBucket(4, 12),
  list: () => tokenBucket(20, 120),
  bundle: () => tokenBucket(8, 40),
  search: () => tokenBucket(10, 60),
  status: () => tokenBucket(10, 60),
} as const;
