/**
 * /api/runs route logic with Request objects and the in-memory repository: the local-caller guard (Host,
 * Origin, Sec-Fetch-Site) before anything else, "not configured" when MONGODB_URI is unset, the token
 * bucket, content-type, size limits and strict validation, status codes for saved/existing/conflicting/
 * invalid bundles, list filters, bundle reads, search parameters, status, and driver failures reported
 * without their messages. Next's routing itself is not exercised.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AtlasBundleReply, AtlasListReply, AtlasSaveReply, AtlasSearchReply, AtlasStatusReply } from "../../components/results/atlas-wire.ts";
import { allowedHostsFromEnv, checkCaller, readBoundedText, tokenBucket } from "./guard.ts";
import type { RunsHttpDeps } from "./http.ts";
import { handleBundleRequest, handleListRequest, handleSaveRequest, handleSearchRequest, handleStatusRequest, parseRunFilter } from "./http.ts";
import type { MemoryRepository, MemoryRepositoryOptions } from "./memory-repository.ts";
import { createMemoryRepository } from "./memory-repository.ts";
import type { RunRepository } from "./repository.ts";
import { fixtureBundle } from "./test-fixtures.ts";
import { MAX_FILE_BYTES } from "./validate.ts";

const BASE = "http://127.0.0.1:3200";
const LOCAL = { host: "127.0.0.1:3200" };

function deps(repo: RunRepository | null, extra: Partial<RunsHttpDeps> = {}): RunsHttpDeps & { readonly touched: () => number } {
  let touched = 0;
  return {
    repository: () => {
      touched += 1;
      return repo;
    },
    allowedHosts: allowedHostsFromEnv(undefined),
    limiter: tokenBucket(100, 600),
    now: () => new Date("2026-11-08T12:00:00Z"),
    touched: () => touched,
    ...extra,
  };
}

function memory(options: MemoryRepositoryOptions = {}): MemoryRepository {
  return createMemoryRepository(options);
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/api/runs`, { method: "POST", headers: { ...LOCAL, "content-type": "application/json", origin: BASE, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function get(path: string, headers: Record<string, string> = LOCAL): Request {
  return new Request(`${BASE}${path}`, { headers });
}

async function json<T>(response: Response): Promise<T> {
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as T;
}

describe("caller admission comes first", () => {
  test("a foreign Host, a cross-site Origin or Sec-Fetch-Site is refused before the repository is touched", async () => {
    const d = deps(memory());
    const attempts = [
      handleListRequest(get("/api/runs", { host: "evil.example:3200" }), d),
      handleListRequest(get("/api/runs", { ...LOCAL, origin: "https://evil.example" }), d),
      handleSearchRequest(get("/api/runs/search?q=fire", { ...LOCAL, "sec-fetch-site": "cross-site" }), d),
      handleSaveRequest(post({ files: {} }, { host: "rebound.example" }), d),
      handleBundleRequest(get("/api/runs/run-a", { host: "localhost:9999" }), "run-a", d),
      handleStatusRequest(get("/api/runs/status", { host: "" }), d),
    ];
    for (const response of await Promise.all(attempts)) {
      assert.equal(response.status, 403);
      assert.equal((await json<{ status: string }>(response)).status, "forbidden");
    }
    assert.equal(d.touched(), 0);
  });

  test("the guard admits the app's own hosts and extra hosts only when well formed", () => {
    const hosts = allowedHostsFromEnv("192.168.1.20:3200, https://bad.example, *.example, ");
    assert.deepEqual(hosts, ["127.0.0.1:3200", "localhost:3200", "192.168.1.20:3200"]);
    assert.equal(checkCaller(new Headers({ host: "localhost:3200", origin: "http://localhost:3200", "sec-fetch-site": "same-origin" }), hosts).ok, true);
    assert.equal(checkCaller(new Headers({ host: "localhost:3200", origin: "http://localhost:3200/path" }), hosts).ok, false);
  });
});

describe("not configured", () => {
  test("every route answers 503 not_configured, naming the variable and nothing else", async () => {
    const d = deps(null, { notConfiguredReason: undefined });
    const responses = await Promise.all([
      handleListRequest(get("/api/runs"), d),
      handleSearchRequest(get("/api/runs/search?q=fire"), d),
      handleSaveRequest(post({ files: fixtureBundle({ runId: "run-a" }) }), d),
      handleBundleRequest(get("/api/runs/run-a"), "run-a", d),
      handleStatusRequest(get("/api/runs/status"), d),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 503);
      const body = await json<{ status: string; message: string }>(response);
      assert.equal(body.status, "not_configured");
      assert.match(body.message, /MONGODB_URI/);
    }
  });
});

describe("rate limit", () => {
  test("admitted callers beyond the bucket get 429 with Retry-After", async () => {
    let now = 0;
    const d = deps(memory(), { limiter: tokenBucket(1, 6, () => now) });
    assert.equal((await handleListRequest(get("/api/runs"), d)).status, 200);
    const throttled = await handleListRequest(get("/api/runs"), d);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("retry-after"), "10");
    now = 10_000;
    assert.equal((await handleListRequest(get("/api/runs"), d)).status, 200);
  });
});

describe("POST /api/runs", () => {
  test("saves a valid bundle (201), reports a repeat as existing (200) and a different bundle under the same id as a conflict (409)", async () => {
    const repo = memory();
    const d = deps(repo);
    const files = fixtureBundle({ runId: "run-a" });
    const first = await handleSaveRequest(post({ files }), d);
    assert.equal(first.status, 201);
    assert.deepEqual(await json<AtlasSaveReply>(first), { status: "saved", runId: "run-a", counts: { events: 8, decisions: 2, replayFrames: 30 } });
    assert.equal((await handleSaveRequest(post({ files }), d)).status, 200);
    const conflict = await handleSaveRequest(post({ files: fixtureBundle({ runId: "run-a", arrivalTick: null }) }), d);
    assert.equal(conflict.status, 409);
    assert.equal(repo.collections.runs[0].source, "workspace");
  });

  test("content type, declared length, body size and per-file limits are enforced", async () => {
    const d = deps(memory());
    assert.equal((await handleSaveRequest(post("{}", { "content-type": "text/plain" }), d)).status, 415);
    assert.equal((await handleSaveRequest(post("{}", { "content-length": String(65 * 1024 * 1024) }), d)).status, 413);
    const huge = { ...fixtureBundle({ runId: "run-big" }), "results.json": "x".repeat(MAX_FILE_BYTES["results.json"] + 1) };
    const tooLarge = await handleSaveRequest(post({ files: huge }), d);
    assert.equal(tooLarge.status, 413);
    assert.match(JSON.stringify(await tooLarge.json()), /results\.json: larger than 1 MB/);
    const bounded = await readBoundedText(new Blob(["a".repeat(2000)]).stream(), 1000);
    assert.deepEqual(bounded, { ok: false, reason: "too_large" });
  });

  test("the body shape is strict: unknown members, non-text files and missing files are 400; a bad bundle is 422", async () => {
    const d = deps(memory());
    const files = fixtureBundle({ runId: "run-v" });
    assert.equal((await handleSaveRequest(post("not json"), d)).status, 400);
    const extra = await handleSaveRequest(post({ files, source: "batch" }), d);
    assert.equal(extra.status, 400);
    assert.deepEqual((await json<{ errors: string[] }>(extra)).errors, ["$.source: unknown field"]);
    assert.equal((await handleSaveRequest(post({ files: { ...files, "events.jsonl": 42 } }), d)).status, 400);
    assert.equal((await handleSaveRequest(post({ files: { "results.json": files["results.json"] } }), d)).status, 400);
    assert.equal((await handleSaveRequest(post({ files: { ...files, "notes.txt": "hi" } }), d)).status, 400);
    const tampered = await handleSaveRequest(post({ files: { ...files, "events.jsonl": files["events.jsonl"].replace("Thermal", "Visual") } }), d);
    assert.equal(tampered.status, 422);
    assert.match(JSON.stringify(await tampered.json()), /does not match the SHA-256/);
  });
});

describe("GET routes", () => {
  async function seeded() {
    const repo = memory();
    const d = deps(repo);
    for (const runId of ["run-a", "run-b"]) assert.equal((await handleSaveRequest(post({ files: fixtureBundle({ runId, controller: runId === "run-b" ? "engineered_readout" : "flow_baseline" }) }), d)).status, 201);
    return { repo, d };
  }

  test("the list returns runs with the aggregation's stats and honours filters", async () => {
    const { d } = await seeded();
    const all = await json<AtlasListReply>(await handleListRequest(get("/api/runs"), d));
    assert.ok(all.status === "ok");
    assert.equal(all.runs.length, 2);
    assert.equal(all.stats.totals?.runs, 2);
    const flow = await json<AtlasListReply>(await handleListRequest(get("/api/runs?controller=flow_baseline&limit=5"), d));
    assert.ok(flow.status === "ok");
    assert.deepEqual(flow.runs.map(r => r.runId), ["run-a"]);
  });

  test("filter parameters are exact values: operators, unknown parameters and bad limits are 400", async () => {
    const { d } = await seeded();
    for (const query of ["controller=%7B%22%24ne%22%3A1%7D", "sort=savedAt", "limit=0", "limit=201", "outcome=all"]) {
      assert.equal((await handleListRequest(get(`/api/runs?${query}`), d)).status, 400, query);
    }
    assert.deepEqual(parseRunFilter(new URLSearchParams("scenarioId=troy-training/main&outcome=completed")), { ok: true, value: { scenarioId: "troy-training/main", outcome: "completed" } });
  });

  test("one bundle comes back byte-identical; unknown and malformed ids are 404 and 400", async () => {
    const { d } = await seeded();
    const reply = await json<AtlasBundleReply>(await handleBundleRequest(get("/api/runs/run-a"), "run-a", d));
    assert.ok(reply.status === "ok");
    assert.equal(reply.files["events.jsonl"], fixtureBundle({ runId: "run-a" })["events.jsonl"]);
    assert.equal(reply.savedAt, "2026-11-08T12:00:00.000Z");
    assert.equal((await handleBundleRequest(get("/api/runs/run-zzz"), "run-zzz", d)).status, 404);
    assert.equal((await handleBundleRequest(get("/api/runs/..%2Fx"), "../x", d)).status, 400);
  });

  test("search validates q, runId and limit, then answers with the mode used", async () => {
    const { d } = await seeded();
    for (const query of ["", "q=a", `q=${"x".repeat(201)}`, "q=fire&runId=..%2Fx", "q=fire&limit=99", "q=fire&index=other", "q=fire%00"]) {
      assert.equal((await handleSearchRequest(get(`/api/runs/search?${query}`), d)).status, 400, query);
    }
    const reply = await json<AtlasSearchReply>(await handleSearchRequest(get("/api/runs/search?q=kitchen%20fire&runId=run-b"), d));
    assert.ok(reply.status === "ok");
    assert.equal(reply.mode, "regex_fallback");
    assert.ok(reply.events.length > 0 && reply.events.every(e => e.runId === "run-b"));
  });

  test("status reports the database, reachability and each Search index state", async () => {
    const ok = await json<AtlasStatusReply>(await handleStatusRequest(get("/api/runs/status"), deps(memory({ searchState: "pending" }))));
    assert.deepEqual(ok, { status: "ok", database: "flyfirefighter-test", reachable: true, search: { events: "pending", decisions: "pending" } });
    const down = await json<AtlasStatusReply>(await handleStatusRequest(get("/api/runs/status"), deps(memory({ failPing: true }))));
    assert.ok(down.status === "ok" && down.reachable === false);
  });

  test("a driver failure is 502 with the error class only, never the driver's message", async () => {
    const failing: RunRepository = {
      ...memory(),
      async findRuns() {
        throw Object.assign(new Error("connection to mongodb+srv://admin:hunter2@cluster0.abcde.mongodb.net failed"), { name: "MongoServerSelectionError" });
      },
    };
    const response = await handleListRequest(get("/api/runs"), deps(failing));
    assert.equal(response.status, 502);
    const text = JSON.stringify(await response.json());
    assert.match(text, /MongoServerSelectionError/);
    assert.ok(!text.includes("hunter2") && !text.includes("cluster0") && !text.includes("mongodb+srv"));
  });
});
