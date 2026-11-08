/**
 * Bundle sources for the results page:
 * - Files the user picks or drops (the workspace export names them `<runId>-events.jsonl` etc.; plain
 *   `events.jsonl`/`results.json`/`replay.jsonl` from one folder work too).
 * - Published bundles under public/runs/: an optional index.json listing them, e.g.
 *   `{ "runs": [{ "id": "run-main-1", "label": "Recorded full rescue" }] }` (or `["run-main-1"]`), each with
 *   files at /runs/<id>/results.json, events.jsonl and replay.jsonl. A missing index means none are published.
 */
import type { BundleFile, RunBundle } from "./bundle";
import { BUNDLE_FILES, buildBundle, groupFiles } from "./bundle";

export const RUNS_BASE = "/runs/";
/** Refuse single files above this size; the page holds bundles in memory on the shared 16 GB Mac. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface LoadReport {
  readonly bundles: readonly RunBundle[];
  readonly notes: readonly string[];
}

export async function loadDroppedFiles(list: FileList | readonly File[]): Promise<LoadReport> {
  const files = Array.from(list);
  const notes: string[] = [];
  const texts: { name: string; text: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      notes.push(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB and was not read.`);
      continue;
    }
    texts.push({ name: file.webkitRelativePath || file.name, text: await file.text() });
  }
  const { groups, ignored } = groupFiles(texts);
  if (ignored.length > 0) notes.push(`Ignored: ${ignored.join(", ")}.`);
  const bundles = [...groups.values()].map(group => {
    const contents: Partial<Record<BundleFile, string>> = {};
    for (const file of BUNDLE_FILES) if (group[file] !== undefined) contents[file] = group[file].text;
    return buildBundle(contents, { kind: "file", names: Object.values(group).map(g => g.name) });
  });
  if (bundles.length === 0 && files.length > 0) notes.push("No bundle files found. Expected results.json, events.jsonl and replay.jsonl.");
  return { bundles, notes };
}

export interface IndexEntry {
  readonly id: string;
  readonly label: string | null;
}

function parseIndex(value: unknown): IndexEntry[] {
  const list = Array.isArray(value) ? value : value !== null && typeof value === "object" && Array.isArray((value as { runs?: unknown }).runs) ? (value as { runs: unknown[] }).runs : null;
  if (list === null) throw new Error("index.json has no runs list");
  return list.flatMap((entry): IndexEntry[] => {
    if (typeof entry === "string") return [{ id: entry, label: null }];
    if (entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      const label = (entry as { label?: unknown }).label;
      return [{ id: (entry as { id: string }).id, label: typeof label === "string" ? label : null }];
    }
    return [];
  }).filter(e => /^[A-Za-z0-9._-]+$/.test(e.id)); // Ids become URL path segments.
}

async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

export type PublishedIndex =
  | { readonly state: "none" }
  | { readonly state: "listed"; readonly entries: readonly IndexEntry[] }
  | { readonly state: "unreadable"; readonly note: string };

/** The published index alone (no bundle files): "none" when public/runs/index.json is absent, which is not an error. */
export async function loadPublishedIndex(signal: AbortSignal): Promise<PublishedIndex> {
  const indexText = await fetchText(`${RUNS_BASE}index.json`, signal);
  if (indexText === null) return { state: "none" };
  try {
    return { state: "listed", entries: parseIndex(JSON.parse(indexText)) };
  } catch (error) {
    return { state: "unreadable", note: `public/runs/index.json could not be read: ${error instanceof Error ? error.message : String(error)}.` };
  }
}

/** One published bundle; its three files are fetched together. Missing files become bundle problems. */
export async function loadPublishedBundle(entry: IndexEntry, signal: AbortSignal): Promise<RunBundle> {
  const base = `${RUNS_BASE}${entry.id}/`;
  const texts = await Promise.all(BUNDLE_FILES.map(file => fetchText(`${base}${file}`, signal)));
  const contents: Partial<Record<BundleFile, string>> = {};
  BUNDLE_FILES.forEach((file, i) => {
    const text = texts[i];
    if (text !== null) contents[file] = text;
  });
  return buildBundle(contents, { kind: "published", url: base, label: entry.label });
}

/** Published bundles; `listed` is null when there is no index (nothing published), which is not an error. */
export async function loadPublished(signal: AbortSignal): Promise<LoadReport & { readonly listed: number | null }> {
  const index = await loadPublishedIndex(signal);
  if (index.state === "none") return { bundles: [], notes: [], listed: null };
  if (index.state === "unreadable") return { bundles: [], notes: [index.note], listed: 0 };
  const notes: string[] = [];
  const bundles: RunBundle[] = [];
  for (const entry of index.entries) {
    try {
      bundles.push(await loadPublishedBundle(entry, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      notes.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { bundles, notes, listed: index.entries.length };
}

/** The published id of a bundle loaded from /runs/<id>/, or null for files chosen in this tab. */
export function publishedId(bundle: RunBundle): string | null {
  if (bundle.origin.kind !== "published") return null;
  const match = new RegExp(`^${RUNS_BASE}([A-Za-z0-9._-]+)/$`).exec(bundle.origin.url);
  return match === null ? null : match[1];
}

/** SHA-256 (lowercase hex) of a text as UTF-8, matching the export's sha256Hex. */
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
