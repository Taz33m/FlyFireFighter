/**
 * MongoDB Atlas setup for FlyFireFighter run persistence. Idempotent: safe to run again.
 *
 *   node scripts/atlas-setup.ts            create the collections, the ordinary indexes and the two Atlas Search indexes
 *   node scripts/atlas-setup.ts --wait     then wait (up to 5 minutes) until the Search indexes are queryable
 *   node scripts/atlas-setup.ts --update   also push the definitions below onto Search indexes that already exist
 *   node scripts/atlas-setup.ts --print    print the Search index definitions as JSON for the Atlas UI (no connection)
 *
 * MONGODB_URI and MONGODB_DB (default "flyfirefighter") come from the environment or .env.local. Neither is
 * printed; errors show only the driver's error class and code name. Atlas Search indexes are created with
 * the driver's createSearchIndex, which needs an Atlas cluster (the free M0 tier supports up to 3 Search
 * indexes); on a local mongod this step reports that Search is unavailable and the app uses its regex fallback.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { MongoServerError } from "mongodb";
import type { Db } from "mongodb";
import { publicErrorMessage, readPersistenceConfig } from "../src/lib/persistence/config.ts";
import { COLLECTIONS } from "../src/lib/persistence/model.ts";
import { createAllIndexes } from "../src/lib/persistence/mongo-repository.ts";
import { REGULAR_INDEXES, SEARCH_INDEXES } from "../src/lib/persistence/search-indexes.ts";
import { createAtlasClient } from "../src/lib/persistence/server.ts";

const { values } = parseArgs({ options: { print: { type: "boolean", default: false }, wait: { type: "boolean", default: false }, update: { type: "boolean", default: false } } });

if (values.print) {
  console.log(JSON.stringify(SEARCH_INDEXES.map(({ collection, name, type, definition }) => ({ collection, name, type, definition })), null, 2));
  process.exit(0);
}

if (process.env.MONGODB_URI === undefined && existsSync(".env.local")) process.loadEnvFile(".env.local");
const config = readPersistenceConfig(process.env);
if (!config.configured) {
  console.error(config.reason);
  process.exit(1);
}

function describe(error: unknown): string {
  const code = error instanceof MongoServerError && typeof error.codeName === "string" ? ` [${error.codeName}]` : "";
  return `${publicErrorMessage(error)}${code}`;
}

async function ensureCollections(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const name of Object.values(COLLECTIONS)) {
    if (existing.has(name)) continue;
    await db.createCollection(name);
    console.log(`Created collection ${name}.`);
  }
}

async function ensureSearchIndexes(db: Db): Promise<void> {
  for (const spec of SEARCH_INDEXES) {
    const collection = db.collection(spec.collection);
    const [current] = await collection.listSearchIndexes(spec.name).toArray();
    if (current === undefined) {
      await collection.createSearchIndex({ name: spec.name, type: spec.type, definition: spec.definition });
      console.log(`Requested Atlas Search index ${spec.name} on ${spec.collection}; Atlas builds it in the background.`);
    } else if (values.update) {
      await collection.updateSearchIndex(spec.name, spec.definition);
      console.log(`Updated Atlas Search index ${spec.name} on ${spec.collection}.`);
    } else {
      const status = (current as { status?: unknown }).status;
      console.log(`Atlas Search index ${spec.name} on ${spec.collection} exists (${(current as { queryable?: unknown }).queryable === true ? "queryable" : String(status ?? "building")}).`);
    }
  }
}

async function waitForSearch(db: Db): Promise<boolean> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(SEARCH_INDEXES.map(async spec => (await db.collection(spec.collection).listSearchIndexes(spec.name).toArray())[0] as { queryable?: unknown } | undefined));
    if (states.every(s => s?.queryable === true)) return true;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return false;
}

const client = createAtlasClient(config.uri);
try {
  await client.connect();
  const db = client.db(config.dbName);
  console.log(`Connected to Atlas; database "${config.dbName}".`);
  await ensureCollections(db);
  await createAllIndexes(db);
  console.log(`Ordinary indexes ensured: ${REGULAR_INDEXES.map(i => `${i.collection}.${i.name}`).join(", ")}.`);
  try {
    await ensureSearchIndexes(db);
    if (values.wait) console.log((await waitForSearch(db)) ? "Atlas Search indexes are queryable." : "Atlas Search indexes are still building; search uses the regex fallback until they are ready.");
  } catch (error) {
    console.error(`Atlas Search indexes could not be created: ${describe(error)} Search uses the regex fallback until they exist (create them in the Atlas UI with the JSON from --print).`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(describe(error));
  process.exitCode = 1;
} finally {
  await client.close();
}
