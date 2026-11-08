/**
 * Browser client for /api/runs (simulation run bundles in MongoDB Atlas). Only fetches same-origin JSON;
 * no credentials are involved on this side. Replies are checked for a status before use, and any network
 * or parse failure becomes {status: "error"} so callers always render something honest.
 */
import type { AtlasBundleFiles, AtlasBundleReply, AtlasListReply, AtlasRunFilter, AtlasSaveReply, AtlasSearchReply, AtlasStatusReply } from "./atlas-wire";
import type { RunBundle } from "./bundle";
import { buildBundle } from "./bundle";

const API = "/api/runs";

async function call<T extends { readonly status: string }>(url: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(url, { ...init, cache: "no-store" });
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && typeof (body as { status?: unknown }).status === "string") return body as T;
    return { status: "error", message: `Unexpected reply from ${url} (HTTP ${response.status}).` } as unknown as T;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    return { status: "error", message: `The run store could not be reached: ${error instanceof Error ? error.message : String(error)}` } as unknown as T;
  }
}

export function fetchAtlasStatus(signal?: AbortSignal): Promise<AtlasStatusReply> {
  return call<AtlasStatusReply>(`${API}/status`, { signal });
}

export function filterQuery(filter: AtlasRunFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export function fetchAtlasRuns(filter: AtlasRunFilter, signal?: AbortSignal): Promise<AtlasListReply> {
  return call<AtlasListReply>(`${API}${filterQuery(filter)}`, { signal });
}

export function saveBundleToAtlas(files: AtlasBundleFiles, signal?: AbortSignal): Promise<AtlasSaveReply> {
  return call<AtlasSaveReply>(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }), signal });
}

export function searchAtlas(q: string, runId: string | null, signal?: AbortSignal): Promise<AtlasSearchReply> {
  const params = new URLSearchParams({ q });
  if (runId !== null) params.set("runId", runId);
  return call<AtlasSearchReply>(`${API}/search?${params.toString()}`, { signal });
}

export type AtlasBundleLoad = { readonly ok: true; readonly bundle: RunBundle } | { readonly ok: false; readonly message: string; readonly notConfigured: boolean };

/** One saved run as a RunBundle (validated exactly like dropped files), with Atlas's own checks as problems. */
export async function fetchAtlasBundle(runId: string, signal?: AbortSignal): Promise<AtlasBundleLoad> {
  const reply = await call<AtlasBundleReply>(`${API}/${encodeURIComponent(runId)}`, { signal });
  if (reply.status !== "ok") return { ok: false, message: reply.message, notConfigured: reply.status === "not_configured" };
  const bundle = buildBundle(reply.files, { kind: "atlas", runId: reply.runId, savedAt: reply.savedAt });
  // The server repeats the notes recorded at save time (the same files give the same notes here); keep only its new findings.
  const fresh = reply.problems.filter(p => !bundle.problems.includes(p));
  return { ok: true, bundle: fresh.length === 0 ? bundle : { ...bundle, problems: [...fresh.map(p => `Atlas: ${p}`), ...bundle.problems] } };
}
