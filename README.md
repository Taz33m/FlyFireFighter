# FlyFireFighter

**A rescue drone with a fly's reflexes and a firefighter in command.**

An independent greenfield project for a simulated exterior-to-interior rescue mission: find a possible occupant, suppress a small fire with individual commander approval, reassess the route and guide the occupant out.

Current state: contracts, action harness, evidence store, seeded simulator with fire/smoke, occupant and sensors, independent evaluator, route assessor, mission planner with OpenAI Decisions and Gemini gateways and a consensus mode, optical-flow and engineered fly-feature controllers, the pinned FlyVis runtime and service, the Blender-built Troy scene, the mission workspace UI and optional MongoDB Atlas persistence of simulation runs are committed and tested. The integrated mission runtime, trained fly readout with its held-out comparison, licensed rigged character and paired evaluation are in progress; see [PLAN.md](PLAN.md). If the mission worker cannot start, the workspace falls back to a clearly bannered UI fixture, never presented as a simulation run and never saved.

## Start locally

Use Node.js 24 (recorded in .nvmrc) and npm. Node 22.13 or newer in the 22.x line is also supported; Node 23 is not supported by the lint toolchain.

```sh
nvm use
npm ci
npm run dev
```

If using Homebrew instead of nvm, select the installed Node 24 runtime with `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` before running npm.

Open [localhost:3200](http://localhost:3200). The app needs no API keys, database, Convex service or source checkout; the cloud deciders and Atlas persistence below are optional. Use port 3200 to keep the older demos on 3100/3101 separate.

```sh
npm run check
npm run build
npm start
```

`npm run check` runs typecheck, lint and the behavioural test suite (Node's built-in runner with native TypeScript type stripping; no test dependencies).

The fly-model service is optional for the UI and required for FlyVis-driven runs. It uses its own Python environment and downloads the pretrained weights into the git-ignored `models/cache/` (see [services/flyvis](services/flyvis/README.md); the weights' licence is unclear upstream, so they are for local evaluation only):

```sh
services/flyvis/setup.sh
cd services/flyvis && .venv/bin/python -m flyvis_service.server   # 127.0.0.1:3201
```

## Optional: cloud deciders and Atlas persistence

Both are off by default. Their settings go in the git-ignored `.env.local` at the repository root; `.env.example` lists them. Never commit real values. Only the Next server and the scripts read them, never the browser. Restart `npm run dev` after changing the file.

```
# OpenAI Decisions
OPENAI_API_KEY=
# Gemini (a Google AI Studio key)
GEMINI_API_KEY=
# MongoDB Atlas: Connect → Drivers → Node.js, with the database user's password filled in
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.<id>.mongodb.net/?retryWrites=true&w=majority&appName=flyfirefighter
# Database name; empty means flyfirefighter
MONGODB_DB=flyfirefighter
```

**Mission planner** in run setup picks the decider: **Local planner** (no network call), **OpenAI Decisions**, **Gemini**, or **Consensus**, which asks both models in parallel and uses their choice only when they pick the same candidate. A model only chooses among the candidates the application built; the harness revalidates the result and the commander still approves each intervention. Without a key, or on refusal, timeout, error or disagreement, the local planner decides, and labels name a model only when its choice was used. Batch evaluation always uses the local planner. See [docs/llm-deciders.md](docs/llm-deciders.md).

For Atlas, create the cluster, database user and network access as in [docs/persistence.md](docs/persistence.md) and set `MONGODB_URI`. Then create the collections, indexes and the two Atlas Search indexes (idempotent; `--wait` waits until search is queryable):

```sh
node scripts/atlas-setup.ts --wait
```

After a restart, each finished simulation run in the workspace is saved automatically, never a UI-fixture run, and a status line in the workspace says whether it was saved. `/results` gains an Atlas panel: saved runs with filters, aggregates computed in Atlas and mission-log search. `/replay?atlas=<runId>` replays a saved run. The batch runner can upload as well:

```sh
node scripts/evaluate-missions.ts --smoke --save-atlas                   # run a batch, upload each finished bundle
node scripts/evaluate-missions.ts --upload-dir evaluation/runs/<batch>   # upload bundles already on disk; runs nothing
```

Without `MONGODB_URI` nothing is saved and the rest of the app works as before.

## Presentation status

Implemented. The derivation logic (phase rail, replay model, shortcuts, presets) is unit-tested; the layouts are not:
- **Presenter view** at `/`, a projector stage layout. The 3D view fills the viewport under the stage-size phase rail, with the action card beside it.
- The **phase rail**, derived only from the truth-free mission view and this run's evaluator outcome.
- The Auto camera director.
- **Commander shortcuts:** A approves, R rejects, Esc Esc aborts.
- The judge-challenge and localization-loss presets, the Q&A drawer and a local-only guidance voice.
- **Recorded replay** of a saved run bundle at `/replay` (stage) and `/results` (detail). It shows the phase rail, timeline and evaluator outcome, never re-runs a simulator, planner or cloud call, and validates bundles before scoring.

Not yet checked: the stage layout and replay page in a production build and headed Chrome at projector resolution.

Still required:
- the integrated end-to-end rescue
- a labelled saved full rescue for the replay fallback
- the headed three-minute rehearsal with live FlyVis
- the trained readout in the mission (it exists for the course comparison only)
- voice intake
- a full paired batch

See [docs/rehearsal.md](docs/rehearsal.md).

## Start reading here

- [PRD.md](PRD.md): product decisions and acceptance criteria.
- [DemoLoop.md](DemoLoop.md): full and short demonstrations, judge challenges and recovery.
- [Rehearsal script](docs/rehearsal.md): presenter lines, commander approvals and fallbacks for each phase-rail stage, with a pre-show checklist.
- [architecture.md](architecture.md): runtime ownership, trained FlyVis motion, OpenAI Decisions, harness contracts and evaluation.
- [LLM deciders](docs/llm-deciders.md): OpenAI Decisions, Gemini and consensus modes, what is sent, honesty labels and keys.
- [Run persistence](docs/persistence.md): MongoDB Atlas setup, data model, search, API and privacy.
- [Commander console](docs/commander-console.md): physical approve, reject and abort buttons on a Free-WiLi OG.
- [Scene and assets](docs/scene-and-assets.md): Blender workflow, Troy location, rigged scanned people and render budgets.
- [PLAN.md](PLAN.md): build sequence and current progress.
- [AGENTS.md](AGENTS.md): repository working rules.
- [Provenance](docs/reference/provenance.md): selected design references and scope of reuse.

## Structure

| Path | Purpose |
| --- | --- |
| src/app, src/components, src/hooks, src/lib/render | Mission workspace, Three.js twin and calibrated drone camera. |
| src/lib | Contracts, harness, evidence, simulation, evaluation, navigation, mission and server-only persistence modules. See the [module map](src/lib/README.md). |
| services/flyvis | Pinned FlyVis runtime, stateful adapter and WebSocket service (Python). |
| assets/blender, public/scenes | Deterministic Blender recipe and exported Troy scene with simulation metadata. |
| docs/reference | Earlier harness design, review, prior-art and character-licensing research. |
| vendor/flyvis-reference | Ten unmodified MIT-licensed upstream files and a hash manifest; [integration notes](vendor/flyvis-reference/README.md). |

This is a new local Git repository on main with its own dependency lockfile. No remote is configured yet. It is not a worktree, clone or symlink to Standard Response. No Standard Response application code, recordings, private environment files or credentials were imported.
