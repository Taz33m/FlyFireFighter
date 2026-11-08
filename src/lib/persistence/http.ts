/**
 * The /api/runs route logic, independent of Next so it is testable offline with Request objects and the
 * in-memory repository.
 *
 * Order for every route: caller admission (403, nothing read), persistence configured (503
 * "not_configured"), the route's token bucket (429), then strict validation (400/413/415/422) and the work.
 * Failures from Atlas become 502 with only the driver's error class name (config.ts publicErrorMessage).
 * Replies are JSON and never cached.
 */
import type { AtlasBundleReply, AtlasFailure, AtlasListReply, AtlasNotConfigured, AtlasRunFilter, AtlasSaveReply, AtlasSearchReply, AtlasStatusReply, SearchIndexState } from "../../components/results/atlas-wire.ts";
import { RUN_ID_PATTERN, SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX } from "../../components/results/atlas-wire.ts";
import { NOT_CONFIGURED_MESSAGE, publicErrorMessage } from "./config.ts";
import type { CodeState } from "./model.ts";
import { COLLECTIONS } from "./model.ts";
import type { RateLimiter } from "./guard.ts";
import { checkCaller, declaredLength, readBoundedText } from "./guard.ts";
import { MAX_LIST_LIMIT } from "./pipelines.ts";
import type { RunRepository } from "./repository.ts";
import { SEARCH_INDEX_NAMES } from "./search-indexes.ts";
import { listRuns, loadBundle, saveBundle, searchLogs } from "./service.ts";
import { MAX_SAVE_BODY_BYTES, parseSaveBody } from "./validate.ts";

export interface RunsHttpDeps {
  /** The repository, or null when persistence is not configured. */
  readonly repository: () => RunRepository | null;
  readonly notConfiguredReason?: string;
  readonly allowedHosts: readonly string[];
  readonly limiter: RateLimiter;
  readonly now?: () => Date;
  readonly code?: () => CodeState;
}

type Reply = AtlasStatusReply | AtlasListReply | AtlasBundleReply | AtlasSaveReply | AtlasSearchReply;

const FILTER_VALUE = /^[A-Za-z0-9._:/ -]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const UNKNOWN_CODE: CodeState = { gitCommit: null, gitBranch: null, gitDirty: null, source: "unknown" };

function reply(status: number, body: Reply, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, "cache-control": "no-store" } });
}

function failure(status: number, kind: AtlasFailure["status"], message: string, errors?: readonly string[]): Response {
  return reply(status, errors === undefined ? { status: kind, message } : { status: kind, message, errors });
}

/** Admission, configuration and rate limit; a Response when the request stops here. */
function admit(request: Request, deps: RunsHttpDeps): RunRepository | Response {
  if (!checkCaller(request.headers, deps.allowedHosts).ok) return failure(403, "forbidden", "Only local callers of this app may use the run store.");
  const repo = deps.repository();
  if (repo === null) return reply(503, { status: "not_configured", message: deps.notConfiguredReason ?? NOT_CONFIGURED_MESSAGE } satisfies AtlasNotConfigured);
  const token = deps.limiter.take();
  if (!token.ok) return reply(429, { status: "rate_limited", message: "Too many run-store requests; try again shortly." }, { "retry-after": String(Math.max(1, Math.ceil(token.retryAfterMs / 1000))) });
  return repo;
}

async function guarded(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return failure(502, "error", publicErrorMessage(error));
  }
}

/* POST /api/runs */

export async function handleSaveRequest(request: Request, deps: RunsHttpDeps): Promise<Response> {
  if (!checkCaller(request.headers, deps.allowedHosts).ok) return failure(403, "forbidden", "Only local callers of this app may use the run store.");
  if (!/^application\/json\b/i.test((request.headers.get("content-type") ?? "").trim())) return failure(415, "invalid", "Send the bundle as application/json.");
  if (declaredLength(request.headers) > MAX_SAVE_BODY_BYTES) return failure(413, "too_large", `The bundle is larger than ${MAX_SAVE_BODY_BYTES / 1024 / 1024} MB.`);
  const repo = admit(request, deps);
  if (repo instanceof Response) return repo;
  const text = await readBoundedText(request.body, MAX_SAVE_BODY_BYTES);
  if (!text.ok) return text.reason === "too_large" ? failure(413, "too_large", `The bundle is larger than ${MAX_SAVE_BODY_BYTES / 1024 / 1024} MB.`) : failure(400, "invalid", "The body is not readable UTF-8.");
  let json: unknown;
  try {
    json = JSON.parse(text.text);
  } catch {
    return failure(400, "invalid", "The body is not JSON.");
  }
  const body = parseSaveBody(json);
  if (!body.ok) return body.tooLarge ? failure(413, "too_large", "A bundle file is over its size limit.", body.errors) : failure(400, "invalid", "The body is not {files: {results.json, events.jsonl, replay.jsonl?}}.", body.errors);
  return guarded(async () => {
    const saved = await saveBundle(repo, body.files, { source: "workspace", savedAt: (deps.now ?? (() => new Date()))(), code: (deps.code ?? (() => UNKNOWN_CODE))() });
    if (saved.status === "invalid") return failure(422, "invalid", "The bundle was not stored.", saved.errors);
    if (saved.status === "conflict") return failure(409, "conflict", saved.message);
    return reply(saved.status === "saved" ? 201 : 200, saved);
  });
}

/* GET /api/runs */

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

function filterValue(name: string, value: string, errors: string[]): string {
  if (!FILTER_VALUE.test(value)) errors.push(`${name}: not an accepted value`);
  return value;
}

function parseLimit(value: string, max: number, errors: string[]): number {
  const n = Number(value);
  if (!/^[0-9]{1,4}$/.test(value) || n < 1 || n > max) errors.push(`limit: an integer from 1 to ${max}`);
  return n;
}

export function parseRunFilter(params: URLSearchParams): Parsed<AtlasRunFilter> {
  const errors: string[] = [];
  const filter: { -readonly [K in keyof AtlasRunFilter]: AtlasRunFilter[K] } = {};
  for (const [name, value] of params) {
    if (name === "controller" || name === "decider" || name === "scenarioId") filter[name] = filterValue(name, value, errors);
    else if (name === "outcome") {
      if (value === "completed" || value === "incomplete") filter.outcome = value;
      else errors.push("outcome: completed or incomplete");
    } else if (name === "limit") filter.limit = parseLimit(value, MAX_LIST_LIMIT, errors);
    else errors.push(`${name}: unknown parameter`);
  }
  return errors.length === 0 ? { ok: true, value: filter } : { ok: false, errors };
}

export async function handleListRequest(request: Request, deps: RunsHttpDeps): Promise<Response> {
  const repo = admit(request, deps);
  if (repo instanceof Response) return repo;
  const filter = parseRunFilter(new URL(request.url).searchParams);
  if (!filter.ok) return failure(400, "invalid", "The run filter is not valid.", filter.errors);
  return guarded(async () => reply(200, { status: "ok", ...(await listRuns(repo, filter.value)) }));
}

/* GET /api/runs/[runId] */

export async function handleBundleRequest(request: Request, runId: string, deps: RunsHttpDeps): Promise<Response> {
  const repo = admit(request, deps);
  if (repo instanceof Response) return repo;
  if (!RUN_ID_PATTERN.test(runId)) return failure(400, "invalid", "Not a run id.");
  return guarded(async () => {
    const loaded = await loadBundle(repo, runId);
    if (loaded === null) return failure(404, "not_found", `Run ${runId} is not stored in Atlas.`);
    return reply(200, { status: "ok", runId, savedAt: loaded.run.savedAt.toISOString(), source: loaded.run.source, files: loaded.files, problems: loaded.problems });
  });
}

/* GET /api/runs/search */

export function parseSearch(params: URLSearchParams): Parsed<{ readonly q: string; readonly runId?: string; readonly limit: number }> {
  const errors: string[] = [];
  let q: string | null = null;
  let runId: string | undefined;
  let limit = 20;
  for (const [name, value] of params) {
    if (name === "q") q = value.trim();
    else if (name === "runId") {
      if (RUN_ID_PATTERN.test(value)) runId = value;
      else errors.push("runId: not a run id");
    } else if (name === "limit") limit = parseLimit(value, SEARCH_LIMIT_MAX, errors);
    else errors.push(`${name}: unknown parameter`);
  }
  if (q === null || q.length < 2 || q.length > SEARCH_QUERY_MAX || CONTROL.test(q)) errors.push(`q: 2 to ${SEARCH_QUERY_MAX} characters of text`);
  return errors.length === 0 && q !== null ? { ok: true, value: { q, runId, limit } } : { ok: false, errors };
}

export async function handleSearchRequest(request: Request, deps: RunsHttpDeps): Promise<Response> {
  const repo = admit(request, deps);
  if (repo instanceof Response) return repo;
  const search = parseSearch(new URL(request.url).searchParams);
  if (!search.ok) return failure(400, "invalid", "The search is not valid.", search.errors);
  const { q, ...options } = search.value;
  return guarded(async () => reply(200, { status: "ok", ...(await searchLogs(repo, q, options)) }));
}

/* GET /api/runs/status */

export async function handleStatusRequest(request: Request, deps: RunsHttpDeps): Promise<Response> {
  const repo = admit(request, deps);
  if (repo instanceof Response) return repo;
  try {
    await repo.ping();
  } catch {
    return reply(200, { status: "ok", database: repo.databaseName, reachable: false, search: { events: "unknown", decisions: "unknown" } });
  }
  const state = (collection: typeof COLLECTIONS.events | typeof COLLECTIONS.decisions, name: string): Promise<SearchIndexState> => repo.searchIndexState(collection, name).catch(() => "unknown" as const);
  const [events, decisions] = await Promise.all([state(COLLECTIONS.events, SEARCH_INDEX_NAMES.events), state(COLLECTIONS.decisions, SEARCH_INDEX_NAMES.decisions)]);
  return reply(200, { status: "ok", database: repo.databaseName, reachable: true, search: { events, decisions } });
}
