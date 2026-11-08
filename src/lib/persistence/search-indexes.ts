/**
 * Atlas Search index definitions for the mission logs. Atlas Search indexes are not ordinary indexes: they
 * are created with the driver's createSearchIndex (scripts/atlas-setup.ts does this) or pasted into the
 * Atlas UI (Atlas Search → Create Search Index → JSON editor; `node scripts/atlas-setup.ts --print` prints
 * these definitions). Static mappings index only the named fields:
 *
 * - events_text on `events`: reason as English full text; runId, kind and source as tokens for filters.
 * - decisions_text on `decisions`: rationale as English full text; runId, decider and candidateId as tokens.
 */
import type { CollectionName } from "./model.ts";
import { COLLECTIONS } from "./model.ts";

export const SEARCH_INDEX_NAMES = { events: "events_text", decisions: "decisions_text" } as const;

export interface SearchIndexSpec {
  readonly collection: CollectionName;
  readonly name: string;
  readonly type: "search";
  readonly definition: { readonly mappings: { readonly dynamic: false; readonly fields: { readonly [field: string]: { readonly type: string; readonly analyzer?: string } } } };
}

export const SEARCH_INDEXES: readonly SearchIndexSpec[] = [
  {
    collection: COLLECTIONS.events,
    name: SEARCH_INDEX_NAMES.events,
    type: "search",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          reason: { type: "string", analyzer: "lucene.english" },
          runId: { type: "token" },
          kind: { type: "token" },
          source: { type: "token" },
        },
      },
    },
  },
  {
    collection: COLLECTIONS.decisions,
    name: SEARCH_INDEX_NAMES.decisions,
    type: "search",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          rationale: { type: "string", analyzer: "lucene.english" },
          runId: { type: "token" },
          decider: { type: "token" },
          candidateId: { type: "token" },
        },
      },
    },
  },
];

/** Ordinary indexes, created idempotently (createIndexes with the same spec is a no-op). */
export const REGULAR_INDEXES: readonly { readonly collection: CollectionName; readonly key: { readonly [field: string]: 1 | -1 }; readonly name: string; readonly unique?: boolean }[] = [
  { collection: COLLECTIONS.runs, key: { runId: 1 }, name: "runId_unique", unique: true },
  { collection: COLLECTIONS.runs, key: { savedAt: -1 }, name: "savedAt_desc" },
  { collection: COLLECTIONS.runs, key: { "config.controller": 1, "config.decider": 1, "config.scenarioId": 1, savedAt: -1 }, name: "condition_savedAt" },
  { collection: COLLECTIONS.events, key: { runId: 1, seq: 1 }, name: "runId_seq_unique", unique: true },
  { collection: COLLECTIONS.events, key: { kind: 1, runId: 1 }, name: "kind_runId" },
  { collection: COLLECTIONS.decisions, key: { runId: 1, seq: 1 }, name: "runId_seq_unique", unique: true },
  { collection: COLLECTIONS.decisions, key: { decider: 1, runId: 1 }, name: "decider_runId" },
];
