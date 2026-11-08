/**
 * Atlas persistence without Atlas: bundle ⇄ documents, the round trip of events and chunked replay through
 * the in-memory repository, save idempotence and conflicts, rejection of tampered or non-simulation bundles,
 * the real aggregation pipelines evaluated on a five-run fixture, and search with and without Atlas Search.
 * Scope: the persistence module's logic and the pipelines' semantics on the supported operator subset; the
 * driver calls themselves (mongo-repository.ts) need a live cluster and are not exercised here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sha256Hex as sha256 } from "../contracts/canonical.ts";
import { findBundleDirs, uploadBundleDirs } from "./batch-upload.ts";
import { readGitHead } from "./code-state.ts";
import { publicErrorMessage, readPersistenceConfig, redactSecrets } from "./config.ts";
import type { SaveContext } from "./documents.ts";
import { bundleToDocuments, createdAtFromRunId, documentsToBundle, gunzipText } from "./documents.ts";
import { evaluate, runPipeline } from "./memory-aggregate.ts";
import { createMemoryRepository } from "./memory-repository.ts";
import type { CodeState, Doc } from "./model.ts";
import { escapeRegex, statsPipeline } from "./pipelines.ts";
import { listRuns, loadBundle, saveBundle, searchLogs } from "./service.ts";
import type { FixtureOptions } from "./test-fixtures.ts";
import { fixtureBundle } from "./test-fixtures.ts";

const CODE: CodeState = { gitCommit: "0123456789abcdef0123456789abcdef01234567", gitBranch: "main", gitDirty: false, source: "git_cli" };
const ctx = (savedAt = new Date("2026-11-08T12:00:00Z")): SaveContext => ({ source: "workspace", savedAt, code: CODE });
// A workspace-style run id: run-<Date.now() base 36>-<random>.
const WORKSPACE_ID = `run-${Date.UTC(2026, 10, 8, 10, 30).toString(36)}-1a2b3c4d`;

function convert(o: FixtureOptions) {
  const conversion = bundleToDocuments(fixtureBundle(o), ctx());
  assert.ok(conversion.ok, conversion.ok ? "" : conversion.errors.join("\n"));
  return conversion.docs;
}

function withResults(o: FixtureOptions, edit: (results: Record<string, unknown>) => void) {
  const files = fixtureBundle(o);
  const results = JSON.parse(files["results.json"]) as Record<string, unknown>;
  edit(results);
  return { ...files, "results.json": JSON.stringify(results) };
}

describe("bundle to documents", () => {
  test("the run document carries configuration, the recomputed outcome, stage times, code state and replay facts", () => {
    const { run, events, decisions, replay } = convert({ runId: WORKSPACE_ID });
    assert.equal(run.evidence, "simulation");
    assert.deepEqual(run.config, { scenarioId: "troy-training/main", seed: "s1", controller: "flow_baseline", decider: "local", aircraftId: "tender-t1", commanderId: "commander-1", speed: 1 });
    assert.equal(run.outcome.completed, true);
    assert.equal(run.outcome.words, "Simulated evacuation completed");
    assert.equal(run.outcome.rescueLabel, "simulated_evacuation_completed");
    // Seconds after mission.authorized (tick 100): evidence 2100, breach 3100, spray 9100, exit 20100, end 30000; no guidance.
    assert.deepEqual(run.metrics.stageSeconds, { evidence: 20, breach: 30, spray: 90, guide: null, exit: 200, end: 299 });
    assert.equal(run.createdAtSource, "run_id");
    assert.equal(run.createdAt.toISOString(), "2026-11-08T10:30:00.000Z");
    assert.equal(run.code.gitCommit, CODE.gitCommit);
    assert.equal(run.timing.simulatedS, 300);
    assert.equal(events.length, run.metrics.events);
    assert.equal(replay?.metadata.frames, 30);
    assert.ok(replay !== null && replay.gzip.byteLength < replay.metadata.bytes, "the replay is stored compressed");
    assert.equal(decisions.length, 2);
  });

  test("decision documents keep what the planner recorded and infer nothing", () => {
    const { decisions } = convert({ runId: "run-dec" });
    const [local, cloud] = decisions;
    assert.equal(local.model, null);
    assert.equal(local.rationale, "Local planner selected: Move to observe the upstairs rear bedroom from outside window win-u-rear-bedroom-east.");
    assert.equal(local.matchesLocalChoice, true);
    assert.equal(local.agreement, null);
    assert.equal(cloud.model, "gpt-6-luna");
    assert.equal(cloud.rationale, "Water on the kitchen fire reopens the hallway as an exit for the occupant.");
    assert.equal(cloud.latencyMs, 412);
    assert.equal(cloud.agreement, "disagrees_with_local");
    assert.equal(cloud.matchesLocalChoice, false);
  });

  test("a stored outcome label is not trusted: the evaluator result decides, and the disagreement is kept", () => {
    const files = withResults({ runId: "run-label", arrivalTick: null }, r => { r.outcome = { rescueLabel: "simulated_evacuation_completed" }; });
    const conversion = bundleToDocuments(files, ctx());
    assert.ok(conversion.ok);
    assert.equal(conversion.docs.run.outcome.completed, false);
    assert.equal(conversion.docs.run.outcome.words, "Incomplete: human assistance needed");
    assert.ok(conversion.docs.run.problems.some(p => p.includes("disagrees")));
  });

  test("an unscored run is stored as incomplete and not scored", () => {
    const { run } = convert({ runId: "run-unscored", withResult: false });
    assert.equal(run.outcome.scored, false);
    assert.equal(run.outcome.completed, false);
    assert.equal(run.outcome.rescueLabel, null);
  });

  test("batch run ids carry no creation time; it falls back to the save time", () => {
    assert.equal(createdAtFromRunId("ev-main.flow-eval-seed-1"), null);
    const { run } = convert({ runId: "ev-main.flow-eval-seed-1" });
    assert.equal(run.createdAtSource, "saved_at");
  });
});

describe("rejected bundles store nothing", () => {
  const rejected = (files: Parameters<typeof bundleToDocuments>[0]) => {
    const conversion = bundleToDocuments(files, ctx());
    assert.equal(conversion.ok, false);
    return conversion.ok ? [] : conversion.errors.join("\n");
  };

  test("an edited event no longer matches the events SHA-256 in results.json", () => {
    const files = fixtureBundle({ runId: "run-t" });
    assert.match(String(rejected({ ...files, "events.jsonl": files["events.jsonl"].replace("possible occupant", "confirmed occupant") })), /events\.jsonl does not match the SHA-256/);
  });

  test("a replay that is not the recorded one is refused", () => {
    const files = fixtureBundle({ runId: "run-r" });
    assert.match(String(rejected({ ...files, "replay.jsonl": files["replay.jsonl"].slice(0, -200) + "\n" })), /replay\.jsonl does not match/);
  });

  test("only simulation bundles of the results schema with a usable run id are accepted", () => {
    assert.match(String(rejected(withResults({ runId: "run-f" }, r => { r.label = "UI fixture"; }))), /not labelled as a simulation run/);
    assert.match(String(rejected(withResults({ runId: "run-s" }, r => { r.schema = "other/1"; }))), /schema must be/);
    assert.match(String(rejected(withResults({ runId: "run-i" }, r => { r.runId = "../etc/passwd"; }))), /not a usable run id/);
  });

  test("malformed events: a gap in seq, another run's event, a reserved field name, an unreadable line", () => {
    const resign = (o: FixtureOptions, mutate: (lines: string[]) => string[]) => {
      const lines = mutate(fixtureBundle(o)["events.jsonl"].trimEnd().split("\n"));
      const events = `${lines.join("\n")}\n`;
      // Re-record the hash so only the event checks can reject it.
      return { ...withResults(o, r => { r.events = { sha256: sha256(events), count: lines.length }; }), "events.jsonl": events };
    };
    assert.match(String(rejected(resign({ runId: "run-g" }, l => l.filter((_, i) => i !== 1)))), /seq 3 where 2 was expected/);
    assert.match(String(rejected(resign({ runId: "run-o" }, l => [...l.slice(0, -1), l[l.length - 1].replace('"runId":"run-o"', '"runId":"run-x"')]))), /belongs to another run/);
    assert.match(String(rejected(resign({ runId: "run-d" }, l => [...l.slice(0, -1), l[l.length - 1].replace('"data":{}', '"data":{"$where":"1"}')]))), /reserved by MongoDB/);
    assert.match(String(rejected(resign({ runId: "run-b" }, l => [...l, "{not json"]))), /unreadable line/);
  });
});


describe("round trip through the repository", () => {
  test("events.jsonl, results.json and replay.jsonl come back byte-identical; the replay crosses several GridFS chunks", async () => {
    const repo = createMemoryRepository({ chunkSizeBytes: 512 });
    const files = fixtureBundle({ runId: WORKSPACE_ID, replayFrames: 80 });
    const saved = await saveBundle(repo, files, ctx());
    assert.equal(saved.status, "saved");
    assert.ok(repo.files[0].chunks.length > 2, `expected several chunks, got ${repo.files[0].chunks.length}`);
    assert.equal(repo.collections.events.length, 8);
    assert.equal(repo.collections.decisions.length, 2);
    const loaded = await loadBundle(repo, WORKSPACE_ID);
    assert.ok(loaded !== null);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.files["events.jsonl"], files["events.jsonl"]);
    assert.equal(loaded.files["results.json"], files["results.json"]);
    assert.equal(loaded.files["replay.jsonl"], files["replay.jsonl"]);
    assert.equal(await loadBundle(repo, "run-missing"), null);
  });

  test("damage in storage is reported on the way out, not hidden", async () => {
    const repo = createMemoryRepository();
    await saveBundle(repo, fixtureBundle({ runId: "run-damaged" }), ctx());
    (repo.collections.events[2] as { reason: string }).reason = "edited in the database";
    repo.collections.events.pop();
    const loaded = await loadBundle(repo, "run-damaged");
    assert.ok(loaded !== null);
    assert.ok(loaded.problems.some(p => p.includes("7 of the 8 events")));
    assert.ok(loaded.problems.some(p => p.includes("do not match the SHA-256")));
  });

  test("documentsToBundle without a stored replay returns events and results only", () => {
    const files = fixtureBundle({ runId: "run-noreplay" });
    const conversion = bundleToDocuments({ "results.json": files["results.json"], "events.jsonl": files["events.jsonl"] }, ctx());
    assert.ok(conversion.ok);
    assert.equal(conversion.docs.replay, null);
    const back = documentsToBundle(conversion.docs.run, conversion.docs.events, null);
    assert.equal(back.files["replay.jsonl"], undefined);
    assert.deepEqual(back.problems, []);
  });

  test("decompression is bounded", () => {
    assert.throws(() => gunzipText(new Uint8Array([1, 2, 3])));
  });

  test("saving is idempotent per run id, and a different bundle under the same id is refused without overwriting", async () => {
    const repo = createMemoryRepository();
    const first = fixtureBundle({ runId: "run-same" });
    assert.equal((await saveBundle(repo, first, ctx())).status, "saved");
    assert.equal((await saveBundle(repo, first, ctx())).status, "exists");
    const other = await saveBundle(repo, fixtureBundle({ runId: "run-same", arrivalTick: null }), ctx());
    assert.equal(other.status, "conflict");
    assert.equal(repo.collections.runs.length, 1);
    assert.equal((repo.collections.runs[0] as { outcome: { completed: boolean } }).outcome.completed, true);
    assert.equal(repo.indexBuilds(), 1);
  });

  test("an invalid bundle writes nothing", async () => {
    const repo = createMemoryRepository();
    const files = fixtureBundle({ runId: "run-bad" });
    const result = await saveBundle(repo, { ...files, "events.jsonl": `${files["events.jsonl"]}{"x":1}\n` }, ctx());
    assert.equal(result.status, "invalid");
    assert.equal(repo.collections.runs.length + repo.collections.events.length + repo.files.length, 0);
  });
});

/* A five-run fixture: three flow/local runs on main (one with a collision), two readout/decisions runs. */
const COLLISION = [{ tick: 15000, kind: "collision" as const, detail: "Contact with the hallway wall at 1.4 m/s (simulation)." }];
const FIVE: readonly FixtureOptions[] = [
  { runId: "run-a", seed: "s1", arrivalTick: 20100, evidenceTick: 2100 },
  { runId: "run-b", seed: "s2", arrivalTick: 22100, evidenceTick: 2600 },
  { runId: "run-c", seed: "s3", arrivalTick: 24100, evidenceTick: 3000, violations: COLLISION },
  { runId: "run-d", seed: "s1", controller: "engineered_readout", decider: "decisions", scenarioId: "troy-training/staged_spray", arrivalTick: null, evidenceTick: 3100, sprayTick: null },
  { runId: "run-e", seed: "s1", controller: "engineered_readout", decider: "decisions", arrivalTick: 21100, evidenceTick: 2100 },
];

async function fiveRunRepo() {
  const repo = createMemoryRepository();
  for (const [i, o] of FIVE.entries()) {
    const saved = await saveBundle(repo, fixtureBundle(o), ctx(new Date(Date.UTC(2026, 10, 8, 12, i))));
    assert.equal(saved.status, "saved");
  }
  return repo;
}

describe("aggregation pipelines on the fixture", () => {
  test("completion, violations and median stage times by controller, decider, scenario and condition", async () => {
    const repo = await fiveRunRepo();
    const { runs, stats } = await listRuns(repo, {});
    assert.deepEqual(runs.map(r => r.runId), ["run-e", "run-d", "run-c", "run-b", "run-a"]);
    assert.equal(stats.totals?.runs, 5);
    assert.equal(stats.totals?.completed, 3);
    assert.equal(stats.totals?.completionRate, 0.6);

    const [flow, readout] = stats.byController;
    assert.equal(flow.key, "flow_baseline");
    assert.deepEqual([flow.runs, flow.completed, flow.runsWithViolation, flow.violations, flow.collisions], [3, 2, 1, 1, 1]);
    assert.ok(Math.abs((flow.completionRate ?? 0) - 2 / 3) < 1e-12);
    // Exit after authorization: 200, 220, 240 s → 220 (n = 3); evidence 20, 25, 29 s → 25.
    assert.equal(flow.medianStageS.exit, 220);
    assert.equal(flow.stageCounts.exit, 3);
    assert.equal(flow.medianStageS.evidence, 25);
    assert.equal(readout.key, "engineered_readout");
    assert.deepEqual([readout.runs, readout.completed, readout.stageCounts.exit, readout.medianStageS.exit, readout.stageCounts.spray], [2, 1, 1, 210, 1]);

    assert.deepEqual(stats.byDecider.map(r => [r.key, r.runs, r.completed]), [["local", 3, 2], ["decisions", 2, 1]]);
    assert.deepEqual(stats.byScenario.map(r => [r.key, r.runs]), [["troy-training/main", 4], ["troy-training/staged_spray", 1]]);
    assert.equal(stats.byCondition.length, 3);
    assert.deepEqual(stats.byCondition[0].key, { controller: "flow_baseline", decider: "local", scenarioId: "troy-training/main" });
    assert.deepEqual(stats.violationKinds, [{ kind: "collision", count: 1, runs: 1 }]);
  });

  test("filters narrow both the list and the aggregates, and accept only exact values", async () => {
    const repo = await fiveRunRepo();
    const flow = await listRuns(repo, { controller: "flow_baseline" });
    assert.equal(flow.runs.length, 3);
    assert.equal(flow.stats.totals?.runs, 3);
    const incomplete = await listRuns(repo, { outcome: "incomplete", limit: 1 });
    assert.equal(incomplete.runs.length, 1);
    assert.equal(incomplete.stats.totals?.runs, 2);
    assert.deepEqual(statsPipeline({ controller: "flow_baseline" })[0], { $match: { "config.controller": "flow_baseline" } });
    const none = await listRuns(repo, { scenarioId: "no-such-scenario" });
    assert.deepEqual([none.runs.length, none.stats.totals, none.stats.byController.length], [0, null, 0]);
  });

  test("the evaluator refuses operators it does not implement, so no pipeline passes vacuously", () => {
    assert.throws(() => runPipeline([{ a: 1 }], [{ $lookup: {} }]), /unsupported stage/);
    assert.throws(() => evaluate({ $concat: ["a", "b"] }, {}), /unsupported expression/);
    assert.throws(() => runPipeline([{ a: 1 }], [{ $group: { _id: null, x: { $stdDevPop: "$a" } } }]), /unsupported accumulator/);
    assert.throws(() => runPipeline([{ a: 1 }], [{ $match: { $where: "1" } }]), /unsupported query operator/);
  });
});

describe("searching mission logs", () => {
  test("without an Atlas Search index, a literal case-insensitive match over events and decisions, labelled as the fallback", async () => {
    const repo = await fiveRunRepo();
    const result = await searchLogs(repo, "KITCHEN fire", { limit: 50 });
    assert.equal(result.mode, "regex_fallback");
    assert.match(result.note ?? "", /not available on this deployment/);
    // Four runs logged the spray executing and all five logged the cloud decision to suppress the kitchen fire.
    assert.equal(result.events.length, 9);
    assert.ok(result.events.every(e => e.score === null && /kitchen fire/i.test(e.reason)));
    assert.equal(result.decisions.length, 5);
    assert.ok(result.decisions.every(d => d.rationale.startsWith("Water on the kitchen fire")));
    const rationale = await searchLogs(repo, "hallway as an exit", { runId: "run-b", limit: 50 });
    assert.deepEqual(rationale.decisions.map(d => [d.runId, d.candidateId]), [["run-b", "spray_fire:fire-kitchen"]]);
    // Metacharacters are matched literally.
    assert.deepEqual((await searchLogs(repo, "(kitchen", { limit: 5 })).events, []);
    assert.equal(escapeRegex("a.b*(c)"), "a\\.b\\*\\(c\\)");
  });

  test("with a ready index, the service sends $search with fuzzy text, highlights and a run filter, and maps scores", async () => {
    const seen: Doc[][] = [];
    const repo = createMemoryRepository({
      searchState: "ready",
      searchResponder: (collection, pipeline) => {
        seen.push([...pipeline]);
        return collection === "events"
          ? [{ runId: "run-a", seq: 7, tick: 9100, kind: "proposal.executing", source: "harness", reason: "Approved spray on the kitchen fire is executing.", score: 3.2, highlights: [{ path: "reason", score: 1, texts: [{ value: "Approved spray on the ", type: "text" }, { value: "kitchen", type: "hit" }] }] }]
          : [];
      },
    });
    const result = await searchLogs(repo, "kitchn", { runId: "run-a", limit: 10 });
    assert.equal(result.mode, "atlas_search");
    assert.equal(result.note, null);
    assert.equal(result.events[0].score, 3.2);
    assert.deepEqual(result.events[0].highlights[0].texts[1], { value: "kitchen", type: "hit" });
    const events = seen.find(p => (p[0].$search as Doc).index === "events_text");
    assert.ok(events !== undefined);
    assert.deepEqual(events[0], {
      $search: {
        index: "events_text",
        compound: { must: [{ text: { query: "kitchn", path: "reason", fuzzy: { maxEdits: 1, prefixLength: 2 } } }], filter: [{ equals: { path: "runId", value: "run-a" } }] },
        highlight: { path: "reason" },
      },
    });
    assert.deepEqual(events[1], { $limit: 10 });
    assert.ok(seen.some(p => (p[0].$search as Doc).index === "decisions_text"));
  });

  test("a failing $search falls back to the regex match and says so", async () => {
    const repo = createMemoryRepository({ searchState: "ready" });
    await saveBundle(repo, fixtureBundle({ runId: "run-a" }), ctx());
    const result = await searchLogs(repo, "kitchen", { limit: 10 });
    assert.equal(result.mode, "regex_fallback");
    assert.match(result.note ?? "", /Atlas Search on events failed/);
    assert.ok(result.events.length > 0);
  });
});

describe("configuration, secrets and code state", () => {
  test("persistence is configured only by a mongodb URI; values are never echoed", () => {
    assert.equal(readPersistenceConfig({}).configured, false);
    const bad = readPersistenceConfig({ MONGODB_URI: "https://user:secret@example.com" });
    assert.ok(!bad.configured && !bad.reason.includes("secret"));
    assert.deepEqual(readPersistenceConfig({ MONGODB_URI: " mongodb+srv://u:p@cluster0.example.mongodb.net/ " }), { configured: true, uri: "mongodb+srv://u:p@cluster0.example.mongodb.net/", dbName: "flyfirefighter" });
    assert.equal(readPersistenceConfig({ MONGODB_URI: "mongodb://localhost", MONGODB_DB: "bad name!" }).configured, false);
    assert.equal(redactSecrets("failed for mongodb+srv://u:pw@c.example.net/db and u2:pw2@host"), "failed for mongodb://[redacted] and [redacted]@host");
    const error = Object.assign(new Error("getaddrinfo ENOTFOUND cluster0.secret-host.mongodb.net"), { name: "MongoServerSelectionError" });
    const message = publicErrorMessage(error);
    assert.match(message, /MongoServerSelectionError/);
    assert.ok(!message.includes("secret-host"));
  });

  test("the commit is read from .git (loose ref, packed ref, detached HEAD) without running git", () => {
    const root = mkdtempSync(join(tmpdir(), "fff-git-"));
    try {
      const sha = "0123456789abcdef0123456789abcdef01234567";
      mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
      assert.deepEqual(readGitHead(root), { gitCommit: sha, gitBranch: "main", gitDirty: null, source: "git_head_file" });
      rmSync(join(root, ".git", "refs", "heads", "main"));
      writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);
      assert.equal(readGitHead(root).gitCommit, sha);
      writeFileSync(join(root, ".git", "HEAD"), `${sha}\n`);
      assert.deepEqual(readGitHead(root), { gitCommit: sha, gitBranch: null, gitDirty: null, source: "git_head_file" });
      assert.equal(readGitHead(join(root, "nowhere")).gitCommit, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("batch upload", () => {
  test("uploads every bundle directory with its condition id, skips incomplete ones and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "fff-batch-"));
    try {
      for (const id of ["ev-main.flow-eval-seed-1", "ev-main.flow-eval-seed-2"]) {
        const dir = join(root, id);
        mkdirSync(dir);
        for (const [name, text] of Object.entries(fixtureBundle({ runId: id }))) writeFileSync(join(dir, name), text);
        writeFileSync(join(dir, "run.json"), JSON.stringify({ schema: "flyfirefighter.batch-run/1", runId: id, condition: { id: "main.flow" } }));
      }
      mkdirSync(join(root, "ev-broken"));
      writeFileSync(join(root, "ev-broken", "results.json"), "{}");
      const repo = createMemoryRepository();
      const dirs = findBundleDirs(root);
      assert.equal(dirs.length, 3);
      const lines: string[] = [];
      const reports = await uploadBundleDirs(repo, dirs, { code: CODE, now: () => new Date("2026-11-08T12:00:00Z") }, line => lines.push(line));
      assert.deepEqual(reports.map(r => r.result.status), ["skipped", "saved", "saved"]);
      assert.deepEqual(repo.collections.runs.map(r => [r.source, r.conditionId]), [["batch", "main.flow"], ["batch", "main.flow"]]);
      assert.equal(lines.length, 3);
      const again = await uploadBundleDirs(repo, dirs.slice(1), { code: CODE, now: () => new Date() }, () => undefined);
      assert.deepEqual(again.map(r => r.result.status), ["exists", "exists"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
