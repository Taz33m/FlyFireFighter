# Controller comparison: optical flow vs FlyVis readouts on procedural obstacle courses

November 8, 2026 · Simulation evidence (procedural courses, headless collider renderer) · Held-out test split · Bundle `evaluation/runs/2026-11-08T04-54-32-767Z-test-final` (git-ignored)

<!-- verdict:start -->
**Result: the trained FlyVis readout did not improve on the conventional optical-flow baseline in a meaningful way, and no controller solved this course family.** On 24 held-out courses each condition completed at most 1 course (95 % CI up to 20 %). Without range assistance the trained readout made the most planned-path progress (36 %, against 31 % for the tuned flow baseline and 32 % for the engineered readout). But it struck an obstacle in 22 of 24 runs and then stayed wedged; the tuned flow baseline struck in 10. With range assistance every condition had 0–1 collisions and similar progress (24–29 %), and the trained readout completed nothing (0/24). These differences are within what 24 courses can resolve, and none of them supports a claim that the trained readout is better. The flow baseline keeps its place as the classical fallback under its own name. The trained readout stays available under its actual label, "FlyVis flow/0000/000 + trained readout v1". This final run, on one recorded code state after the simulator review fixes (below), reproduced the earlier pre-fix run almost exactly; only `fly_readout+range` changed, from 1/24 to 0/24.
<!-- verdict:end -->

## What was compared

All conditions fly the same course specs with the same camera (rgb-front 320 × 180, 90° HFOV, 50 Hz, per-course exposure, keyed read noise), the same goal (one routine harness `move` per run, capped at the course's approach speed), the same harness (every actuator command goes through `ActionHarness.step` and `stepWorld`), the same speed limits and, in the `+range` conditions, the same range assistance (the reflex mapper's range brake, lateral push and yaw veto with identical `CommandConfig` values). Trajectories diverge naturally; sensor and camera noise are keyed by seed and tick.

| Condition | Motion source | Label | What decides braking and turning |
| --- | --- | --- | --- |
| `flow_baseline` | `flow_baseline` | Optical-flow baseline (tuned) | Dense Lucas–Kanade flow on an 80 × 45 grid → looming/centering/avoidance cues → shared reflex mapper. Tuned on train/validation (below). |
| `engineered_readout` | `engineered_readout` | FlyVis flow/0000/000 + engineered readout | Live FlyVis T4/T5 sector motion and expansion → hand-set engineered readout → shared reflex mapper. Committed defaults, **not** tuned on courses. |
| `fly_readout` | `fly_readout` | FlyVis flow/0000/000 + trained readout v1 | Live FlyVis features (24 T4a–d/T5a–d sector responses, horizontal motion, expansion and their EMAs), efference copy, goal and quality → trained MLP → forward speed and yaw rate. Shared caps only (arrival, quality ceiling, goal-approach cap, range assistance). |

FlyVis features come from the real service (`services/flyvis`, network `flow/0000/000`, checkpoint SHA-256 `d0e42857…cc3f`, upstream `0a69fa2f`), stepped statefully in lockstep with the simulation. The weights' licence is still recorded as unclear (local evaluation only).

## Courses and splits

One procedural family, `corridor-doorway/v1` (`src/lib/evaluation/courses/`): an 11–14 m corridor, 2.0–3.0 m wide, ceiling 2.6 m; 2–3 tall furniture blocks in room A and 1–2 in room B, each leaving ≥ 0.95 m to pass; a partition with a **0.85–1.10 m doorway** for the 0.55 m aircraft; 4–9 tall/low lateral clutter items; an optional free-standing column; and in ~60 % of courses **falling debris** (an `add_obstruction` experiment released when the aircraft passes a trigger 2–3.5 m before it). Sequence variation per course: corridor heading (4 directions under the fixed light), world origin (shifts the world-anchored texture), approach-speed cap 0.8/1.0/1.2/1.5 m/s, uniform smoke 0 or 0.08–0.35 m⁻¹ (`add_smoke`), exposure gain 0.7–1.3 (own calibration id), start offset and yaw (±0.35 rad). Every course is checked solvable at 0.36 m clearance before and after the debris with the truth planner.

Splits are by course seed, and a seed fixes both layout and sequence. The lists in `splits.ts` were drawn once before any frame was rendered: **40 train, 12 validation, 24 test**. Training data, DAgger rounds, readout selection and baseline tuning used only train/validation; the test list was used once, for this report.

## Training the readout

- **Teacher (labels only).** A truth planner (8-connected Dijkstra on true colliders in the flight band, clearance-weighted) and a pursuit/braking law (`teacher.ts`). It completes every course it was run on without driving noise. It never feeds a controller input.
- **Data.** Per visual step: the readout input vector (`READOUT_INPUT_NAMES`, built by the same `ReadoutFeatureBuilder` that deploys it) and the teacher's forward speed and yaw rate for the true state. Shards in `datasets/generated/readout-v1/` (27 MB, git-ignored) with per-shard SHA-256 in each part manifest.

| Part | Split | Driver | Runs | Rows | Runs completed | Wall |
| --- | --- | --- | --- | --- | --- | --- |
| train-r0 | train | teacher + DART noise (σ 0.2 m/s, 0.35 rad/s, held 0.3 s) | 40 | 28,947 | 38 | 363 s |
| train-r1 | train | DAgger mixture, β = 0.5, learner m0 | 40 | 30,698 | 32 | 402 s |
| train-r2 | train | learner m1 | 40 | 38,812 | 4 | 361 s |
| train-r3 | train | learner m2 | 40 | 43,424 | 2 | 403 s |
| val-teacher | validation | teacher + DART noise | 12 | 9,745 | 10 | 126 s |

Dataset generation wall time: **1,655 s (27.6 min)** for 172 runs, one FlyVis instance.

- **Fitting (`services/flyvis/training/train_readout.py`, numpy).** Ridge (6 λ) and one-hidden-layer tanh MLPs (16/32/64 units × 3 weight decays, Adam, early stopping on validation loss); the offline choice is the lowest validation MSE on standardized outputs (validation parts only).
- **Closed-loop selection (validation only, before the test run).** Each round's model flew the 12 validation courses without range assistance; the rule was the highest `tuningScore` (collision-free completion 1, completion with contact 0.5, otherwise 0.3 × path progress, −0.1 per collision).

| Model | Training parts (rows) | Masked inputs | Offline pick | Validation: completed | Mean path progress | Doorway passed | Collisions | Score |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m0 (chosen) | r0 (28,947) | – | mlp-h16-d0.001 | 1/12 | 39% | 2/12 | 12 | 0.90 |
| m1 | r0, r1 (59,645) | – | mlp-h32-d0.01 | 2/12 | 26% | 2/12 | 11 | 0.74 |
| m2 | r0, r1, r2 (98,457) | – | mlp-h64-d0.01 | 1/12 | 39% | 2/12 | 12 | 0.89 |
| m3 | r0, r1, r2, r3 (141,881) | – | mlp-h32-d0.01 | 0/12 | 25% | 0/12 | 16 | -0.71 |
| m3a | r0, r1, r2, r3 (141,881) | prev_forward, prev_yaw | mlp-h16-d0.01 | 0/12 | 28% | 0/12 | 16 | -0.58 |
| m3b | r0, r1, r2, r3 (141,881) | prev_forward | mlp-h64-d0.001 | 0/12 | 29% | 0/12 | 22 | -1.15 |

m0's offline fit (mlp-h16-d0.001): validation MSE 0.308 on standardized outputs, R² 0.85 (forward) and 0.61 (yaw) on teacher-driven validation data. DAgger made the learner fly into more contacts and wedge: m2 nearly tied m0, m3 failed every validation course, with or without the efference-copy inputs.

The chosen model, `models/readout/trained-readout-v1.json` (SHA-256 `a30c230b562e56ddd660d4c4be817d61a20d7d1b6f38fcfa9ad35ffac87fb224`), records the weights, input normalization, the training data hash `b308de33…6166`, the seed lists, the checkpoint SHA-256, every candidate's validation metrics and numpy self-check rows that the TypeScript test reproduces to 1e-9.

## Tuning the optical-flow baseline

`cli/tune-baseline.ts`: six configurations screened on 12 train courses (no range), top two on all 12 validation courses with and without range assistance. The committed defaults barely moved on these frames (`hold_no_vision`: the headless renderer's texture gives a 5–15 % valid-flow fraction against a 0.15 confidence floor). Selected: `minEigen 1e-5`, visual-confidence ramp 0.03–0.2, `brakeTimeS 0.8`, `stopDistanceM 0.6` (`models/readout/flow-baseline-tuning.json`). Validation: 0/24 completed, mean path progress 18 % (no range) and 21 % (range). The engineered readout was not tuned.

## Held-out results (test split, 24 courses per condition)

<!-- results:start -->
| Condition | Completed (95% CI) | Collision-free completions | Mean path progress | Doorway passed | Debris passed | Collisions (runs with ≥1) | Median time to goal, s | False braking, s total (per run) | Median min gap, m | FlyVis steps > 20 ms / > 50 ms | End reasons |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flow_baseline | 0/24 = 0% (0%–14%) | 0/24 | 31% | 4/24 | 0/9 | 10 (10) | – | 73.9 (3.08) | 0.02 | n/a (no FlyVis) | stall 24 |
| flow_baseline+range | 0/24 = 0% (0%–14%) | 0/24 | 24% | 2/24 | 0/9 | 0 (0) | – | 58.4 (2.44) | 0.23 | n/a (no FlyVis) | stall 21, budget 3 |
| engineered_readout | 0/24 = 0% (0%–14%) | 0/24 | 32% | 3/24 | 1/9 | 27 (24) | – | 0.0 (0.00) | 0.00 | 1 / 0 of 21973 | stall 24 |
| engineered_readout+range | 1/24 = 4% (1%–20%) | 1/24 | 29% | 2/24 | 2/9 | 0 (0) | 38.1 | 23.7 (0.99) | 0.17 | 2 / 0 of 31841 | stall 20, completed 1, budget 3 |
| fly_readout | 1/24 = 4% (1%–20%) | 1/24 | 36% | 3/24 | 1/9 | 22 (22) | 11.3 | 0.0 (0.00) | 0.00 | 0 / 0 of 21641 | stall 23, completed 1 |
| fly_readout+range | 0/24 = 0% (0%–14%) | 0/24 | 28% | 3/24 | 1/9 | 1 (1) | – | 15.9 (0.66) | 0.23 | 7 / 1 of 29945 | stall 22, budget 2 |

Per course (✓ completed with time, ✗ with path progress; `Nc` = N collisions):

| Course | flow_baseline | flow_baseline+range | engineered_readout | engineered_readout+range | fly_readout | fly_readout+range |
| --- | --- | --- | --- | --- | --- | --- |
| test-94621f27 | ✗ 1c 63% | ✗ 19% | ✗ 1c 9% | ✗ 46% | ✗ 1c 24% | ✗ 24% |
| test-b46e42fd | ✗ 56% | ✗ 40% | ✗ 1c 75% | ✗ 40% | ✗ 1c 75% | ✗ 1c 60% |
| test-6987b937 | ✗ 1c 77% | ✗ 7% | ✗ 1c 12% | ✗ 7% | ✗ 1c 84% | ✗ 77% |
| test-0f7f787d | ✗ 1c 37% | ✗ 29% | ✗ 1c 37% | ✗ 30% | ✗ 1c 38% | ✗ 27% |
| test-35218a79 | ✗ 1c 28% | ✗ 6% | ✗ 1c 16% | ✗ 6% | ✗ 1c 36% | ✗ 27% |
| test-73cdf689 | ✗ 1c 19% | ✗ 53% | ✗ 1c 9% | ✗ 55% | ✗ 1c 3% | ✗ 2% |
| test-df216675 | ✗ 2% | ✗ 2% | ✗ 1c 21% | ✗ 18% | ✗ 1c 29% | ✗ 19% |
| test-eac78b7c | ✗ 1c 42% | ✗ 14% | ✗ 1c 44% | ✗ 15% | ✗ 1c 4% | ✗ 15% |
| test-a593ae7a | ✗ 72% | ✗ 92% | ✗ 1c 73% | ✓ 38.1s | ✓ 11.3s | ✗ 70% |
| test-c3930aee | ✗ 9% | ✗ 8% | ✗ 1c 17% | ✗ 11% | ✗ 1c 51% | ✗ 11% |
| test-117d5f82 | ✗ 40% | ✗ 27% | ✗ 1c 65% | ✗ 27% | ✗ 1c 28% | ✗ 25% |
| test-31b63691 | ✗ 41% | ✗ 17% | ✗ 1c 44% | ✗ 38% | ✗ 1c 43% | ✗ 38% |
| test-c817b50c | ✗ 1% | ✗ 1% | ✗ 1c 1% | ✗ 5% | ✗ 1c 2% | ✗ 7% |
| test-b0119266 | ✗ 24% | ✗ 23% | ✗ 1c 31% | ✗ 23% | ✗ 1c 39% | ✗ 25% |
| test-aa63752c | ✗ 31% | ✗ 31% | ✗ 2c 38% | ✗ 33% | ✗ 1c 12% | ✗ 7% |
| test-2e445a64 | ✗ 1c 19% | ✗ 9% | ✗ 1c 19% | ✗ 9% | ✗ 1c 28% | ✗ 19% |
| test-2d26453f | ✗ 4% | ✗ 4% | ✗ 1c 5% | ✗ 11% | ✗ 1c 5% | ✗ 23% |
| test-effc13ba | ✗ 18% | ✗ 20% | ✗ 1c 37% | ✗ 22% | ✗ 1c 36% | ✗ 22% |
| test-ecfc0503 | ✗ 62% | ✗ 61% | ✗ 1c 15% | ✗ 61% | ✗ 1c 72% | ✗ 72% |
| test-096a0d4f | ✗ 1c 29% | ✗ 27% | ✗ 1c 29% | ✗ 27% | ✗ 1c 28% | ✗ 27% |
| test-16591b79 | ✗ 1c 3% | ✗ 2% | ✗ 1c 2% | ✗ 33% | ✗ 0% | ✗ 0% |
| test-4f60469f | ✗ 1% | ✗ 25% | ✗ 1c 33% | ✗ 25% | ✗ 1c 36% | ✗ 25% |
| test-ae26841b | ✗ 1c 33% | ✗ 20% | ✗ 2c 91% | ✗ 22% | ✗ 1c 44% | ✗ 24% |
| test-df537799 | ✗ 39% | ✗ 38% | ✗ 2c 51% | ✗ 38% | ✗ 1c 51% | ✗ 33% |

<!-- results:end -->

Both completions are on one course, `test-a593ae7a`: the trained readout without range assistance (11.3 s) and the engineered readout with it (38.1 s). Without range assistance the usual failure is a first contact (median 2.7–3.5 s into the run) followed by a stall pressed against that obstacle. With range assistance the usual failure is braking and dithering in front of furniture or the doorway: 0.7–2.4 s of false braking per run, then stalls and budget timeouts.

Definitions (`metrics.ts`): *completed* = the harness's move completed (estimated arrival) and the true position is within 0.6 m of the goal inside the budget (2.5 × length / min(cap, 1.2) + 10 s). *Path progress* = 1 − best remaining truth-planner path / initial path. *Doorway/debris passed* = the true position went 0.3 m beyond them. *Collisions* = simulator truth events (debounced 0.5 s). *False braking* = time at < 0.25 m/s while the truth teacher would fly ≥ 0.6 m/s and the aircraft already faces the planned path. A run also ends after 15 s without 0.3 m of progress toward the goal (*stall*, counted incomplete) — stopping forever cannot win. *FlyVis > 20 ms* = service round trips longer than one visual frame; the batch runner waits instead of falling back, so these are counted, not acted on (the first, warm-up step of each run is excluded).

<!-- timing:start -->
**Timing (held-out run).** `flow_baseline`: controller p95 1.137 ms (no FlyVis); `flow_baseline+range`: controller p95 1.157 ms (no FlyVis); `engineered_readout`: FlyVis > 20 ms 1/21973, > 50 ms 0, p95 5.178 ms; controller p95 0.014 ms; `engineered_readout+range`: FlyVis > 20 ms 2/31841, > 50 ms 0, p95 5.03 ms; controller p95 0.012 ms; `fly_readout`: FlyVis > 20 ms 0/21641, > 50 ms 0, p95 4.981 ms; controller p95 0.019 ms; `fly_readout+range`: FlyVis > 20 ms 7/29945, > 50 ms 1, p95 5.276 ms; controller p95 0.018 ms. Evaluation wall time: **1,228 s (20.5 min)** for 144 runs, one FlyVis instance (the first, warm-up step of each run is excluded from deadline counts).
<!-- timing:end -->

Headless render median 3.6 ms per frame. An earlier held-out attempt aborted after 48 flow-baseline runs because the idle FlyVis socket missed keep-alive pings; it was discarded unread and fixed by connecting lazily. The pre-fix run that followed (bundle `2026-11-08T03-34-26-313Z-test-heldout`, 1,215 s) is superseded by this one. Readout selection on validation took 6 × ~2 min, and baseline tuning took 696 s.

## Code state

<!-- codestate:start -->
Held-out bundle `evaluation/runs/2026-11-08T04-54-32-767Z-test-final` ran every arm in one process on commit `60573d7a2c6e7282daef50295b068d543aa7d1e1`; uncommitted files under the run's source trees: 22, exactly this work's own files under `src/lib/evaluation/courses/` and `src/lib/navigation/reflex/trained-readout*.ts`, not yet committed (SHA-256 `4c2e9c4227123ec6d6869c34c40871c7c120e32f2ea8516f9e120e8fbe9e5c65`); uncommitted `src/lib/simulation` files: none. Full list in the bundle's `config.json`.
<!-- codestate:end -->

Training data, DAgger rounds, readout selection and baseline tuning were produced before code-state stamping existed, between 2026-11-08T02:27Z and 03:29Z, while HEAD moved from `db27702` to `76a29e8` and other workers' uncommitted simulator changes were present. They are kept as training/selection data with that approximate code state; only the held-out comparison is required to run on one recorded state. From now on every dataset manifest, tuning file and result bundle records `codeState` (`code-state.ts`: git commit, the list of uncommitted files under the run's source trees, a SHA-256 over them, and a separate SHA-256 over uncommitted `src/lib/simulation` files).

## Limitations

- **Single synthetic course family.** Box-world corridors with one doorway; results do not transfer to the Troy house or to real buildings. 24 test courses give wide confidence intervals.
- **Headless collider renderer.** Frames are CPU-rendered boxes with value-noise texture, a fixed light, no shadows or reflections (`headless-collider/v1`), not the presentation GLB renderer and not camera recordings. Low texture is why the untuned flow baseline could not see.
- **FlyVis field of view.** The service samples only the central square of the frame (≈ 55° lattice span of the 90° camera) and pools it into three sectors, so obstacles beside the aircraft and doorway edges close by are invisible to both FlyVis conditions; the flow baseline sees the full 90°.
- **Hand-tuned baseline, untuned engineered readout.** Six flow configurations is a small search; the engineered readout ran with committed defaults.
- **Imitation learning limits.** The teacher plans with the full map; a reactive readout cannot know where an off-axis doorway is before seeing it. Including the efference copy produced visible causal confusion (forward output tracking the previous command); masking it did not help in the time available. Three DAgger rounds made closed-loop validation worse, not better.
- **No commander approvals involved.** Each run is one routine move; no consequential action, so approval delay is not part of these numbers.
- **Batch timing.** Deadlines are measured with the simulation waiting for each step on an otherwise idle shared Mac; a live mission would fall back to the flow baseline on a timeout.

## Reproduce

```bash
cd services/flyvis && .venv/bin/python -m flyvis_service.server &        # one instance, 127.0.0.1:3201
node src/lib/evaluation/courses/cli/collect.ts --part train-r0 --split train --driver dart
node src/lib/evaluation/courses/cli/collect.ts --part val-teacher --split validation --driver dart
node src/lib/evaluation/courses/cli/splits-json.ts > datasets/generated/readout-v1/splits.json
services/flyvis/.venv/bin/python services/flyvis/training/train_readout.py --train train-r0 --val val-teacher \
  --splits datasets/generated/readout-v1/splits.json --out datasets/generated/readout-v1/models/m0.json
# DAgger rounds: collect.ts --driver mixture --beta 0.5 / --driver learner --model <previous model>, then retrain
node src/lib/evaluation/courses/cli/tune-baseline.ts
node src/lib/evaluation/courses/cli/evaluate.ts --split test --controllers flow_baseline,engineered_readout,fly_readout \
  --assist both --model models/readout/trained-readout-v1.json --flow-tuning models/readout/flow-baseline-tuning.json
node src/lib/evaluation/courses/cli/report.ts evaluation/runs/<bundle>/results.json
```

The bundle holds `config.json` (seeds and split, scene SHA-256 per course, calibration ids, renderer, harness policy revision, model and tuning hashes, thresholds), `results.json` (every run and the summaries) and `events/<run>.events.jsonl` (harness log plus truth events).
