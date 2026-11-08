# Run persistence in MongoDB Atlas

FlyFireFighter can save finished **simulation** runs to MongoDB Atlas and use them in the app:

- **Auto-save.** When a run in the mission workspace has its evaluator outcome, the app exports the run's bundle (`results.json`, `events.jsonl`, `replay.jsonl`) and saves it once. A line under the run controls says either "Saved to Atlas" or "Not saved to Atlas" and why. UI-fixture runs are never saved, because they are not simulation runs.
- **Results page.** `/results` lists the runs saved in Atlas next to local bundles. It shows aggregates computed in Atlas (completion, violations and median stage times by condition, controller, planner or scenario) and can load any saved run's record and replay.
- **Replay.** `/replay?atlas=<runId>` puts a saved run on the projector stage. The header has an "Atlas run" picker.
- **Search.** A search box on `/results` searches event reasons and planner rationales across every saved run.
- **Batch.** `scripts/evaluate-missions.ts --save-atlas` uploads each finished batch bundle. `--upload-dir <dir>` uploads bundles already on disk without running anything.

Persistence is optional. Without `MONGODB_URI` nothing is saved, every `/api/runs` route answers `503 {"status":"not_configured"}`, and the rest of the app works as before.

## Setup

1. **Create a free cluster.** In [MongoDB Atlas](https://cloud.mongodb.com), create a project, then go to *Create* and choose the **M0 Free** tier with a provider and region near you. M0 runs MongoDB 8 and supports transactions, GridFS and up to three Atlas Search indexes. This app uses two.
2. **Add a database user.** Go to *Security → Database Access → Add New Database User* and choose password authentication. The role *Read and write to any database* works. A custom role with `readWrite` on the `flyfirefighter` database alone is enough. Choose a generated password.
3. **Allow your network.** Go to *Security → Network Access → Add IP Address → Add Current IP Address*. Avoid `0.0.0.0/0`. If your address changes, connections time out and `/api/runs/status` reports `reachable: false`.
4. **Put the connection string in `.env.local`.** Go to *Connect → Drivers → Node.js* and copy the `mongodb+srv://…` string. Replace `<password>`, URL-encoding any special characters. Then add the string to the git-ignored `.env.local` at the repository root:

   ```
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.<id>.mongodb.net/?retryWrites=true&w=majority&appName=flyfirefighter
   MONGODB_DB=flyfirefighter
   ```

   Never commit this file. `.env.example` lists the variables with empty values.
5. **Install and set up.** Run `npm install` (the official `mongodb` driver is a dependency), then:

   ```
   node scripts/atlas-setup.ts --wait
   ```

   The script is idempotent. It creates the `runs`, `events` and `decisions` collections and the ordinary indexes, and requests the two Atlas Search indexes (`events_text`, `decisions_text`). With `--wait` it waits until the Search indexes are queryable, which usually takes about a minute. `--print` prints the Search index JSON, which you can paste into *Atlas Search → Create Search Index → JSON Editor* instead. `--update` pushes changed definitions onto existing indexes.
6. **Restart the dev server.** Restart `npm run dev`; Next reads `.env.local` at startup. Then check the connection:

   ```
   curl http://127.0.0.1:3200/api/runs/status
   # {"status":"ok","database":"flyfirefighter","reachable":true,"search":{"events":"ready","decisions":"ready"}}
   ```

7. **Optional: upload batch runs.** `node scripts/evaluate-missions.ts --upload-dir evaluation/runs/<batch>` uploads existing bundles. `node scripts/evaluate-missions.ts --smoke --save-atlas` runs a batch and uploads its bundles.

## Data model

| Collection | One document per | Contents |
| --- | --- | --- |
| `runs` | run | `runId` (unique), `savedAt`, `createdAt` (decoded from a workspace run id, otherwise the save time), `source` (`workspace` or `batch`), `label` and `evidence: "simulation"`, `config` (scenario, seed, controller, decider, aircraft, commander, speed), `controllerLabel`, `deciderLabel`, `conditionId` (batch), `outcome` (scored, completed, `rescueLabel`, display words, drone return, violation and collision counts), `violations`, `timing` (simulated seconds, wall ms, sim:wall), `code` (git commit and branch, a dirty flag when known, scene id, revision and hash, controller checkpoint hash, events and replay SHA-256), `metrics` (event, decision and replay frame counts, approvals, rejections, aborts, water used, and **stage ticks and seconds** for evidence, breach, spray, guidance, exit and end), `replay` (bytes, gzip bytes, SHA-256, frames), `bundleSha256`, the exact `resultsJson` text, and validation `problems` |
| `events` | mission event | `runId`, `seq`, `tick`, `source`, `kind`, `subject`, `ruleIds`, `reason`, `data`. Unique index on `{runId, seq}` |
| `decisions` | planner decision event (`decision.*`) | `runId`, `seq`, `tick`, `decider`, `deciderLabel`, `model` (only when recorded), `candidateId`, `rationale` (the recorded rationale, otherwise the event's reason), `latencyMs`, `agreement` (as recorded), `matchesLocalChoice`, `gatewayStatus`, `fallbackReason`, `risk`, `tool` |
| GridFS bucket `replays` | run | `replay.jsonl` gzip-compressed (a ten-minute run's 15 MB replay is about 1 MB), `metadata: {runId, sha256, bytes, frames, label}` |

Stage times are simulated seconds after `mission.authorized`. Each stage is the first event of its kind:

- evidence: the first `track.created`;
- breach, spray and guidance: the first `proposal.executing` of `breach_opening`, `spray` and `guide`;
- exit: the earliest evaluator-recorded arrival at the assembly point;
- end: the evaluator's `endedTick`.

**What a save checks.** A bundle is stored only if all of these hold:

- `results.json` has the `flyfirefighter.results/1` schema, a usable run id and a label starting with "simulation";
- every event line is a well-formed event of that run: gap-free `seq` from 1, ticks that never go back, a known source, bounded strings and no field names reserved by MongoDB;
- `events.jsonl` and `replay.jsonl` match the SHA-256 recorded in `results.json`.

The outcome is **recomputed** from the evaluator result with the results page's own code (`components/results/bundle.ts`), so a client-supplied label is never trusted. A disagreement is stored as a problem. Saving is idempotent per run id: an identical bundle answers "exists", and a different bundle under a stored run id answers `409` without overwriting anything.

**Reading a run back.** The app rebuilds `events.jsonl` from the `events` documents as canonical JSON, so the file is byte-identical. It checks the events and replay hashes again and reports any mismatch as a problem.

## Atlas features used

- **Multi-document transactions.** The `runs`, `events` and `decisions` inserts for one run commit together. The replay goes to GridFS first and is deleted again if the transaction fails.
- **GridFS.** Several-megabyte replays are stored compressed in 255 KB chunks and streamed back.
- **Aggregation pipelines** (`src/lib/persistence/pipelines.ts`). One `$facet` pass groups runs by condition, controller, decider and scenario. For each group it reports runs, scored, completed, completion rate, runs with violations, violations and collisions, and `$median` (approximate method) of each stage time over the runs that reached it, together with that count. `$unwind` + `$group` counts violations by kind. Filters are exact-value `$match` stages.
- **Atlas Search** (`src/lib/persistence/search-indexes.ts`). `events_text` indexes `events.reason` and `decisions_text` indexes `decisions.rationale`, both with the English analyzer, plus token fields (`runId`, `kind`, `source`, `decider`, `candidateId`). Queries use `$search` with a fuzzy `text` operator (one edit), an `equals` filter on `runId`, `searchScore` and `searchHighlights`.
- **Search fallback.** While an index is missing, still building or unsupported (for example on a local `mongod`), search runs an escaped, case-insensitive `$regex` instead. The reply's `mode` (`atlas_search` or `regex_fallback`) and `note` say which, and the UI shows it.
- **Indexes.** The ordinary indexes are `runs.runId` (unique), `runs.savedAt`, a condition and time compound index, `events {runId, seq}` (unique), `events {kind, runId}`, `decisions {runId, seq}` (unique) and `decisions {decider, runId}`. The app creates them idempotently on first save and `atlas-setup.ts` creates them too.

## API

All routes are under `/api/runs`, return JSON with `cache-control: no-store`, and apply these checks in order:

1. the local-caller guard of `/api/decisions`: Host must be `127.0.0.1:3200`, `localhost:3200` or an entry of `PERSISTENCE_ALLOWED_HOSTS`, and Origin, when sent, must be on one of those hosts. `Sec-Fetch-Site: cross-site` is refused. Otherwise the reply is `403`.
2. the not-configured check (`503`);
3. a per-route token bucket (`429` with `Retry-After`);
4. strict validation.

| Route | Purpose |
| --- | --- |
| `GET /api/runs/status` | Configured or not, database name, `reachable`, and the state of each Search index |
| `GET /api/runs?controller=&decider=&scenarioId=&outcome=completed\|incomplete&limit=1..200` | Saved runs, newest first, plus `stats` from the aggregation pipeline |
| `POST /api/runs` | Body `{"files": {"results.json", "events.jsonl", "replay.jsonl"?}}`, at most 64 MB in total: 1 MB for results, 24 MB for events, 48 MB for the replay. Replies `201` saved, `200` exists, `409` conflict, `422` invalid bundle, `400` malformed body, `413` too large, `415` not JSON |
| `GET /api/runs/<runId>` | The bundle files rebuilt from Atlas, plus `problems` |
| `GET /api/runs/search?q=&runId=&limit=1..50` | Matching events and decisions, with `mode` and `note` |

Driver failures return `502` with the driver's error class name only. Driver messages can contain host names, so they are never passed on.

## Credentials and privacy

- `MONGODB_URI` and `MONGODB_DB` are read only on the server, by the route handlers and the scripts. They are never sent to the browser, returned in a reply or logged. Replies name the variable, never its value. A boundary test (`src/lib/persistence-boundary.test.ts`) fails if any client component, hook, the Web Worker or simulation, harness or planner code imports the persistence module or the driver.
- The guard is not authentication. A local process that can reach `127.0.0.1:3200` can read and add runs, as with `/api/decisions`. Anyone holding the database user's credentials can read the stored runs.
- **What is stored:** simulation data only. That covers the configuration and seed, the event log (planner choices, approvals, harness decisions, evaluator outcome), recorded replay snapshots of the simulated world, the commander id string, and the git commit. Caller and judge **report text is stored verbatim** inside `report.received` events. The protocol also has a voice channel, but only text is ever recorded; no audio is stored. Do not put real names, addresses or other personal information into reports during a demo. No camera frames, audio or browser data are stored.
- Data lives in the Atlas region you chose for the cluster. To delete one run in `mongosh`, run `db.runs.deleteOne({runId})`, `db.events.deleteMany({runId})` and `db.decisions.deleteMany({runId})`, then delete the `replays.files` entry with `metadata.runId` and its chunks. You can also drop the `flyfirefighter` database in the Atlas UI.

## Tests

`node --test src/lib/persistence/*.test.ts src/lib/persistence-boundary.test.ts` runs offline, with no Atlas. The tests cover:

- bundle-to-document conversion and back, including byte-identical round trips of events, results and a replay split over several GridFS-style chunks;
- rejection of tampered, malformed and non-simulation bundles;
- idempotent saves and conflicts;
- the real aggregation pipelines evaluated on a five-run fixture by a small in-memory evaluator, which throws on any operator it does not implement;
- search pipeline construction and the regex fallback;
- the route guard, rate limit, size limits and validation, and "not configured" replies;
- redaction of credentials from errors;
- code state, the batch upload and the import boundary.

The in-memory evaluator computes an exact median where Atlas uses its approximate method, and it does not evaluate `$search`. The driver code in `mongo-repository.ts` needs a live cluster to test.
