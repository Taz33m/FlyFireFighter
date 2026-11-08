# FlyVis service (Stage 3 foundation)

November 7, 2026 · Python 3.11 · upstream [TuragaLab/flyvis](https://github.com/TuragaLab/flyvis/tree/0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa) at `0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa` (MIT)

**Implemented:**
- the actual pinned FlyVis runtime in an isolated environment, with hash-verified pretrained weights;
- an adapter that runs one pretrained network *statefully* at 50 Hz on our own grayscale camera frames and returns T4/T5 motion features (left / center / right sectors plus an expansion measure);
- a local WebSocket service for protocol `flyfirefighter.neural/1` (`src/lib/contracts/neural.ts`);
- the worker-side TypeScript client in [src/lib/navigation/neural](../../src/lib/navigation/neural/index.ts).

Tests and a latency benchmark ship with it.

**Not implemented yet:** no trained readout or controller (the features are untrained engineering signals), no Three.js camera capture integration, no mission-worker wiring, no harness or simulation-clock integration, no ensemble or batching. Nothing here demonstrates obstacle avoidance, navigation or rescue capability. All numbers below come from synthetic test patterns, not from camera recordings or simulator renders.

## Setup

```bash
services/flyvis/setup.sh                      # venv + exact packages + weights (verified)
cd services/flyvis && .venv/bin/python -m pytest -s
cd services/flyvis && .venv/bin/python -m flyvis_service.server   # ws://127.0.0.1:3201
```

- Interpreter: uv-managed CPython 3.11.12 (`/usr/local/bin/python3.11` on this Mac is an x86_64 build that cannot run). Without uv, `setup.sh` falls back to `python3.11 -m venv` + pip.
- [requirements.lock](requirements.lock): 90 packages from `uv pip freeze`, including `flyvis @ git+https://github.com/TuragaLab/flyvis@0a69fa2f…`, `torch==2.15.0` (PyPI macOS arm64 wheel: CPU + MPS), `torchvision==0.29.2`, `numpy==2.4.6` and `websockets==17.4` (for the service; `setup.sh` checks its version). The installed copies of the six vendored Python files (`eye.py`, `network.py`, `network_view.py`, `stimulus.py`, `decoder.py`, `objectives.py`) are byte-identical to [vendor/flyvis-reference](../../vendor/flyvis-reference/README.md).
- Weights and FlyVis caches live in `models/cache/flyvis/` (git-ignored; override with `FLYFIREFIGHTER_FLYVIS_CACHE`). The adapter sets `FLYVIS_ROOT_DIR` before importing FlyVis and refuses to run if FlyVis was already imported with another root.
- Upstream side effects of `import flyvis`: sets the torch default device (CPU here), configures root logging at INFO with Europe/Berlin timestamps, and loads a `.env` file found from the working directory upwards (python-dotenv; existing variables are not overridden).

## Weights provenance

Recorded in [weights.manifest.json](weights.manifest.json); `setup.sh` checks the cache against it.

| Item | Value |
| --- | --- |
| Mechanism | Upstream `flyvis download-pretrained` ([flyvis_cli/download_pretrained_models.py](https://github.com/TuragaLab/flyvis/blob/0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa/flyvis_cli/download_pretrained_models.py)): Google Drive v3 API, public folder and API key embedded upstream. [weights.py](flyvis_service/weights.py) reads the folder id, key and checksum from the installed upstream file at run time (nothing key-like is copied into this repo) and downloads only `results_pretrained_models.zip`. No credentials of ours are involved. |
| Source | Drive folder `15_8gPaVVJV6wGAspwkrdN8r-2NxMY4Kj`, file `13cJr2nMn89j-jBAd5RduYRJpBcXwoNrC` (Drive: created 2024-08-07, modified 2024-10-15) |
| Archive | `results_pretrained_models.zip`, 3,417,042 bytes, SHA-256 `71c78d4070556a536b13b23ee3139cd2788aa2a9d07d430a223b4edead281db1`; equals upstream's hard-coded checksum and Drive's `sha256Checksum`. Downloaded 2026-11-07T21:39:31Z. 353 members (ensemble `flow/0000`, 50 networks), no licence or readme file inside. |
| Network loaded | `flow/0000/000` (members are sorted by task error; 000 is the lowest) |
| Checkpoint loaded | `results/flow/0000/000/chkpts/chkpt_00000`, 49,396 bytes, SHA-256 `d0e42857e738d0315897c2d50fde9eb3fb1a3fb1f071d55dfc13d53d72bccc3f`. This is what upstream's moving name "best" resolves to (argmin of `validation/loss.h5` over `chkpts/`; only one checkpoint exists). Upstream independently records the same hash for this model in its packaged `flyvis/data/responses_norm.h5`. The sibling `best_chkpt` (SHA-256 `d8a57a02…`) holds identical network tensors but is not the file loaded. |
| Loading | SHA-256 checked before loading; `torch.load(weights_only=True)` (restricted unpickler), then upstream `recover_network`. Upstream itself loads with `weights_only=False`. |
| **Licence** | **Unclear. No explicit licence or terms for the weights were found.** The paper's Data availability statement says “Data, trained models and interactive notebooks are available at https://www.github.com/TuragaLab/flyvis” (Lappalainen et al., *Nature* 634, 1132–1140 (2024), doi:10.1038/s41586-024-07939-3; the article's CC BY 4.0 licence covers the article). The repository's MIT licence covers “this software and associated documentation files”, but the weights are hosted separately on Google Drive. Searched: upstream readme, install/acknowledgements/FAQ/CLI docs, downloader source, Drive metadata and archive member names. **Use for local evaluation only; do not redistribute the archive or checkpoints** until upstream states terms (contact listed in the upstream readme). |

## Adapter

```python
from flyvis_service.stateful import StatefulFlyVis

fly = StatefulFlyVis()      # load flow/0000/000 (hash-checked), warm up once (~2 s)
fly.reset()                 # start of each run; restores the initial state
out = fly.step(frame)       # frame: (H, W) float32 luminance in [0, 1], row 0 = top
```

`step` returns `{"step", "t", "responses", "horizontal_motion", "expansion"}`; `fly.describe()` returns model version, checkpoint hash, eye geometry, sector rules and per-run baselines.

**Pipeline.** `frame → CameraEye (central square crop, resize, upstream BoxEye) → 721 hexals → network Stimulus buffer (R1–R8) → one Euler step at dt = 0.02 s → T4/T5 features`. dt equals the networks' training `dt` and upstream's limit (`dt ≤ 1/50`).

**Stateful stepping** ([stateful.py](flyvis_service/stateful.py)). Each frame takes one `Network._next_state` step, the same call `Network.forward` makes inside its time loop. The frozen parameter namespace is built once rather than per frame. Recurrent state is carried between calls. The adapter never calls `simulate()` per frame: its default `initial_state="auto"` repeats a 1 s grey warm-up on every call. The warm-up (upstream's grey steady state, 1 s at 0.5) is computed once per load; `reset()` restores it. `reset(warmup_frame=…)` instead fades the first frame in from grey, as upstream `fade_in_state` does, to avoid an onset transient. Both warm-ups run as step loops that keep only the current state. Upstream's versions keep all 50 intermediate states, costing ~315 MB of resident memory; tests show the loops give bit-identical results. `reset(first_frame_warmup=True)`, which the service uses, reinitializes the network and defers the warm-up to the first frame. That frame is held as a static stimulus for 50 steps, following upstream's `steady_state` procedure with the frame in place of grey; the result becomes the run's baseline, and then the frame is integrated as the first step. After 1 s the pooled T4/T5 features are within 0.005 of an 8 s static steady state. The class is single-network, batch 1, CPU, not thread-safe.

**Input conventions** ([eye.py](flyvis_service/eye.py)).
- Raster order with row 0 at the top. WebGL `readPixels` returns rows bottom-up, so flip those buffers first.
- Luminance in [0, 1] as in training: Sintel PNGs → PIL `convert("L")` / 255, i.e. Rec. 601 luma of gamma-encoded sRGB, not linear radiance. `rgb_to_luma601` reproduces it.
- Integer images, NaN/inf, values outside [0, 1] and non-2-D arrays are rejected.

**Field of view (our assumption, not an upstream calibration).**
- The central `min(H, W)` square is resized (antialiased) to a 417 px canvas. That is BoxEye's 391 px minimum plus a 13 px margin each side, the same margin upstream's Sintel splits keep. The margin keeps the 13 px box filter out of BoxEye's zero padding.
- Receptor centres span 390/417 = 93.5 % of the square crop. For a pinhole camera with focal length `f` px the lattice spans `2·atan(0.4676·min(H, W)/f)`; for example, 640×480 at 90° horizontal FOV gives ≈70° with ≈2.7° centre spacing (`CameraEye.angular_extent_deg`).
- BoxEye's lattice is not a regular hexagon in angle: columns are 13 px apart and alternate columns are offset by 6.5 px.
- The network has no angular-velocity calibration, so feature magnitudes depend on this choice. Lock the camera and crop for comparisons.

**Orientation (verified).**
- Hexal `i` ↔ lattice `(u, v)` in the connectome's photoreceptor order, sampling canvas pixel `(centre + 13·(u + v/2), centre + 13·v)`. Image-right is +v and image-down is +(u + v/2).
- Image-left content reaches columns `v < 0`.
- Upstream's moving-edge angle convention, which its preferred-direction labels use, matches our image frame: bars rendered by upstream `HexEye` at 0/90/180/270° move right/up/left/down in BoxEye image coordinates (test).
- The direction-selective cells respond in our frame as upstream labels them for the horizontal axis (below).

**Features** ([features.py](flyvis_service/features.py)).
- Cell populations are selected by name from the checkpoint's connectome metadata (`nodes.layer_index["T4a"]` … `["T5d"]`, `nodes.u/v`), never by hard-coded index.
- `responses[type] = [left, center, right]`: mean `relu(voltage)` of that type's cells per sector. The 31 image columns split 10 | 11 | 10 (v ≤ −6, −5…5, ≥ 6), giving 205 / 311 / 205 cells per type.
- `horizontal_motion[sector]`: mean over T4b and T5b minus mean over T4a and T5a, each taken relative to the run's initial-state baseline. Positive means rightward image motion. The type labels come from upstream `groundtruth_utils.preferred_directions` (0° = T4b/T5b, 180° = T4a/T5a).
- `expansion = (horizontal_motion[right] − horizontal_motion[left]) / 2`: positive for outward and negative for inward horizontal flow. This is a heuristic, not a time-to-contact estimate.

## WebSocket service (flyfirefighter.neural/1)

[server.py](flyvis_service/server.py) implements the contract in [neural.ts](../../src/lib/contracts/neural.ts). Run it with `.venv/bin/python -m flyvis_service.server` (`--threads 1..4`, default 4).

**Connection**
- Binds **127.0.0.1:3201 only**, with one network instance and **one client at a time**. A second connection gets `error` (`bad_request`, "service busy") and is closed with code 1013. A client whose connection is already closing no longer counts, so a client can reconnect immediately (`NeuralClient.closed` resolves once its socket is gone).
- A run ends with its connection, so reset again after reconnecting.
- Browser connections must come from `http://localhost:3200` or `http://127.0.0.1:3200`, which guards against cross-site WebSocket hijacking. Clients without an `Origin` header (local tools, tests) are accepted.
- Permessage-deflate is off. Messages are capped at 4 MiB.
- This is a local simulation service, not an authenticated endpoint.

**Reset → ready**
- The network is reinitialized and the eye mapping is locked to the reset's `width`, `height` and `horizontalFovDeg`. `dtS` must be 0.02.
- `ready` carries the model name, checkpoint path, checkpoint SHA-256, upstream commit and the exact `license.status` string from [weights.manifest.json](weights.manifest.json), plus `eye {extent: 15, hexals: 721}` and `warmupSteps: 50`.
- The contract's `ready` has no field for the lock, so the lock is logged per reset and exposed as `NeuralService.eye_lock`. For rgb-front/v1 (320×180, 90°) it is a 180 px central square, a 417 px canvas, a 55.5° lattice span and 2.0° centre column spacing.

**Step → features**
- A step is a JSON header followed by exactly one binary message of `width × height` bytes.
- **Encoding:** bytes are row-major from the top-left pixel, and orientation and flipping are the client's job. Byte `b` becomes luminance `b / 255` as float32. The camera's frame values are display-encoded luminance, `clamp((gain·L)^(1/gamma), 0, 1)`, quantized by `encodeLuminanceU8` as `round(v·255)`. So `b/255` restores them to within half a step, on the same display-encoded scale as the training frames (PIL `convert("L")/255` of sRGB). The camera uses Rec. 709 weights on linear RGB, whereas training used Rec. 601 weights on encoded RGB; that small mismatch is not corrected.
- **Ordering:** seq must run 0, 1, 2, … per run.
- **Errors:** a header for another run (`wrong_run`, including before any reset), a seq out of order (`out_of_order`), a wrong payload length, wrong dimensions or a malformed field (`bad_request`) is answered with `error` after its payload is consumed. The state does not advance, and a rejected first frame does not consume the warm-up. Unexpected exceptions become `internal`; missing or mismatching weights give `model_unavailable`.
- **First step:** the first step of a run performs the warm-up, so its `latencyMs` is about 75 ms.
- **`latencyMs`:** service compute time from receipt of the payload to features ready (decode, eye, network, pooling). JSON encoding and socket I/O are excluded.

**Worker client** ([src/lib/navigation/neural](../../src/lib/navigation/neural/index.ts))
- `NeuralClient` runs over an injected `NeuralTransport`; `connectWebSocketTransport()` uses the global WebSocket with `binaryType: "arraybuffer"` and buffers anything that arrives before the client listens.
- **reset:** `reset(runId, calibration)` validates `ready` strictly: exact fields, hex digests, and a hexal count consistent with the extent.
- **step:** `step(frame, tick)` checks the frame against the reset calibration, sends the header and `encodeLuminanceU8` payload, and resolves with features validated by `parseNeuralFeatures`.
- **Ordering and deadlines:** strictly one step is in flight, and replies for another run or seq are discarded and counted. There is a per-step deadline (default 50 ms) and a longer first-step deadline for the warm-up (default 2000 ms); either rejects with `NeuralTimeoutError`.
- **Failures:** any step failure leaves the run `desynchronized` until the next reset, and `reset` rejects whatever is pending as `superseded`. All failures are typed `NeuralClientError`s, so the mission runtime can switch to a labelled classical fallback.

## Tests

35 tests, `pytest` in `services/flyvis`, about 12 s on CPU with 4 threads and one network instance (test-process peak RSS 1.6 GB). Latest run: **35 passed**. Tests that need weights skip with a message if the cache is absent. All stimuli are synthetic ([synthetic.py](flyvis_service/synthetic.py)). TypeScript client tests are listed under the table.

| File | Scope |
| --- | --- |
| [test_eye.py](tests/test_eye.py) | (d) Eye output (721,) matches the network `Stimulus` input and is written to all 8 photoreceptor types. Hexal order equals the connectome photoreceptor `(u, v)` order. Upstream `HexEye` stimulus angles equal our image angles. Constant frames map to constant input. Left/top orientation. Centred crop. Resolution independence. Invalid-frame rejection. Luma conversion matches PIL. |
| [test_stateful.py](tests/test_stateful.py) | (a) Frame-by-frame stepping vs one `Network.simulate` call (upstream default warm-up) over 70 frames × 45,669 nodes: **max abs difference 0** (tolerance 1e-5). (b) `reset()` restores the initial state exactly, and replaying 25 frames reproduces features and activity exactly (difference 0). State carries over between frames: grey after motion vs grey after reset differs by up to 1.73. Naive per-frame `simulate` loses history: T4b 0.041 vs 0.515 stateful. Warm-up loops equal upstream `steady_state`/`fade_in_state` bit for bit. Fade-in cuts the first-frame jump on a 0.1 scene from 0.40 to 0.037. First-frame warm-up equals one upstream `simulate(initial_state=None)` over a 50-frame static prefix (difference 0) and cuts the first-step jump on a dim scene from 0.453 to 0.0007. |
| [test_direction.py](tests/test_direction.py) | (c) Direction sanity, retinotopy and expansion sign (numbers below). |
| [test_weights.py](tests/test_weights.py) | Manifest = cache = upstream archive checksum = upstream recorded checkpoint hash. A tampered hash, missing file or unpinned network is refused. |
| [test_server.py](tests/test_server.py) | WebSocket service in-process on an ephemeral loopback port, websockets client, 320×180 u8 frames. `ready` fields equal the manifest, and the eye lock is reported. Features over 25 frames, including the first-frame warm-up, equal direct adapter stepping (**max diff 0**, tolerance 1e-6). `out_of_order`, `wrong_run`, payloads 1 byte short or long, and wrong dimensions are refused without advancing state. Reconnect + reset reproduces outputs exactly. A second client is refused (1013) while the first keeps working. Protocol misuse gives `bad_request`, and a foreign browser origin is refused (403). Round-trip latency is measured. |

**TypeScript client** (`src/lib/navigation/neural`), all passing:
- `node --test --test-reporter=dot "src/lib/navigation/neural/**/*.test.ts"`: 27 tests with a fake transport and fake clock. They cover reset request and `ready` validation (wrong protocol, extra field, missing licence, bad hash, inconsistent hexals), reset deadline, service and busy errors, and seq ordering with a single step in flight. They also cover discarding stale run/seq replies, `NeuralTimeoutError` followed by desynchronization and recovery, and schema rejection, including a smuggled motion-command field. Reset clearing pending work, frame/calibration mismatches and close are covered too.
- `npx tsc --noEmit | grep src/lib/navigation/neural` reports nothing, and `npx eslint src/lib/navigation/neural --max-warnings=0` is clean.
- `live.test.ts` is opt-in (`FLYFIREFIGHTER_NEURAL_LIVE=1`, service running). It runs the real WebSocket transport from Node against the Python service in a separate process. The real `ready` passes the strict TS validation. Drift direction survives the wire: center `horizontalMotion` is +0.199 rightward and −0.313 leftward. It also exercises busy refusal and immediate reconnect after close. It passed in 3 of 3 runs.

**Direction results (c)** for drifting gratings (period 0.25 crop = 8 columns, 2 Hz, contrast 0.8). Values are center-sector mean `relu(voltage)` over the last 1 s; DI = |L→R − R→L| / (L→R + R→L):

| | T4a | T4b | T4c | T4d | T5a | T5b | T5c | T5d |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| left→right | 0.154 | 0.494 | 0.354 | 0.081 | 0.186 | 0.166 | 0.021 | 0.028 |
| right→left | 0.537 | 0.019 | 0.037 | 0.072 | 0.311 | 0.141 | 0.093 | 0.159 |
| grey baseline | 0.045 | 0.018 | 0.044 | 0.022 | 0.045 | 0.025 | 0.037 | 0.037 |
| DI | 0.55 | 0.93 | 0.81 | 0.06 | 0.25 | 0.08 | 0.63 | 0.70 |

- **Grating opponency:** `horizontal_motion` (left, center, right) is [0.224, 0.184, 0.151] for L→R and [−0.254, −0.320, −0.326] for R→L.
- **Edges:** ON edges at 0.5 crop/s give T4b 0.163 (L→R) vs 0.047 (R→L) and T4a 0.068 vs 0.175. OFF edges give T5b 0.072 vs 0.025 and T5a 0.062 vs 0.168.
- **Retinotopy:** a grating confined to the left quarter gives a sector response above grey of [0.090, 0.002, 0.001]; the right quarter gives [0.001, 0.000, 0.099].
- **Expansion:** +0.203 for outward flow and −0.275 for inward flow. Uniform drift (as from yaw) leaks in at −0.036 in both directions, a consistent bias of about 15 % of the expansion signal.

All direction assertions pass. The thresholds (DI ≥ 0.2, signs, a 2× sector ratio, uniform-drift leak below half the expansion magnitude) are generic and were not tuned.

**Full tuning** (`python -m flyvis_service.characterize`, 12 directions, center sector, vector-sum preferred direction in degrees counter-clockwise from image-right):

| Stimulus | T4a | T4b | T4c | T4d | T5a | T5b | T5c | T5d |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| upstream label | 180 | 0 | 90 | 270 | 180 | 0 | 90 | 270 |
| grating PD (DSI) | 179 (0.52) | 352 (0.66) | 61 (0.53) | 68 (0.13) | 172 (0.35) | 335 (0.17) | 115 (0.80) | 242 (0.42) |
| ON edge PD (DSI) | 171 (0.36) | 347 (0.67) | 49 (0.77) | 100 (0.37) | – | – | – | – |
| OFF edge PD (DSI) | – | – | – | – | 181 (0.90) | 354 (0.79) | 106 (0.26) | 241 (0.18) |

Only the pathway-appropriate edge polarity is shown (ON for T4, OFF for T5).
- T4a/T4b/T5a/T5b match upstream's horizontal labels. These are the only types the opponency and expansion features use.
- T4c/T5c prefer upward to up-right motion.
- T5d weakly prefers down-left.
- **T4d disagrees with its upstream label (270°).** Its gratings response is barely selective, and ON edges point up (100°) in the center sector. An exploratory run pooling a central disk instead gave 278°, so the T4d estimate is not robust in this checkpoint.

## Measured timing and memory

Apple M5 Pro (6 performance + 12 efficiency cores, 48 GB), macOS 27.0, torch 2.15.0. Each timed call is `StatefulFlyVis.step(frame)` on a 480×640 synthetic frame: validation, crop/resize, BoxEye, one network step and feature pooling. Batch 1, 1000 frames timed after 50 discarded, measured on 2026-11-07 with `python -m flyvis_service.benchmark`. The machine was shared with other work, and an earlier 4-thread run measured a median of 4.04 ms (p99 4.64 ms).

| Device | Threads | Median | p90 | p99 | Max | Eye / network / features (median) | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPU | 4 | 4.50 ms | 4.70 ms | 4.93 ms | 5.11 ms | 2.78 / 1.64 / 0.08 ms | 1,072 MB |
| CPU | 1 | 5.58 ms | 5.77 ms | 5.99 ms | 13.53 ms | 4.16 / 1.37 / 0.05 ms | 1,070 MB |
| MPS (experimental, unsupported) | 4 | 4.20 ms | 4.42 ms | 5.57 ms | 7.72 ms | 2.36 (CPU) / 1.37 / 0.46 ms (includes GPU sync) | 1,220 MB + 1,033 MB MPS driver |

- **Budget:** the 20 ms budget at 50 Hz holds with ~4× headroom in-process.
- **Service round trip at 320×180 u8 over localhost** (2026-11-07/08, 4 threads; client-observed time from sending the header until the features reply arrives):

  | Client | Steps | Median | p99 | Max | Service `latencyMs` median |
  | --- | --- | --- | --- | --- | --- |
  | websockets client in the pytest process (in-process server) | 300 after 50 | 4.12–4.14 ms | 4.33 ms | 4.44 ms | 3.90–3.92 ms |
  | `NeuralClient` + WebSocket transport in Node, service as a separate process | 298 per run, 3 runs | 4.32–4.37 ms | 4.83–5.07 ms | n/a | n/a |

  The first step of a run includes the 50-step warm-up and takes about 75 ms (in-process round trip 74.5–75.1 ms). A 320×180 frame is 57,600 bytes, about 2.9 MB/s at 50 Hz.
- **Memory:** RSS is 463 MB after imports and 942 MB after network load and warm-up (connectome and parameters). Load plus warm-up takes ~2 s with a warm connectome cache; the first-ever compile took ~9 s.
- **Cost split:** the eye costs more than the network. Upstream BoxEye convolves the whole 417² canvas to sample 721 points.
- **MPS:** upstream `Network` construction fails on MPS (`TypeError` converting float64 parameters). The experimental path builds on CPU, moves private index tensors and runs only the network step under an MPS device context. A global MPS default device breaks upstream BoxEye. It agrees with CPU within 1.5e-6 but gives no gain at batch 1. Use CPU.

## Open issues and risks for a 50 Hz simulation loop

- **Lockstep and ordering:** every step advances exactly 20 ms of model time. The service enforces seq order per run and the client discards stale replies. A timed-out step desynchronizes the run, because the client cannot know whether the service integrated it; the mission runtime must then reset (re-warm) or run the fallback. Wall-clock deadlines (50 ms default, 2000 ms for the first step) are the mission runtime's to tune.
- **First-step cost:** each reset's first step costs ~75 ms of service time (warm-up). Schedule resets outside the latency-critical path, or slow the simulation in labelled lockstep for that frame.
- **Not yet measured:** latency inside a browser Web Worker. The Node WebSocket client was used as the cross-process stand-in.
- **Photometry and geometry:** frames must be display-encoded luminance, top row first (WebGL `readPixels` must be flipped). Rec. 709 vs Rec. 601 weighting differs slightly from training. The crop/FOV choice is an uncalibrated assumption that scales every feature; rgb-front 16:9 frames lose 70 px each side to the central square, so the lattice spans 55.5° of the 90° field.
- **Features are untrained heuristics:**
  - `expansion` uses horizontal opponency only, so it ignores vertical expansion.
  - Uniform horizontal drift biases `expansion` by −0.036 (vs ±0.20 to 0.27 for real expansion), so yaw slightly reads as contraction.
  - T4d tuning is unreliable in this checkpoint.
  - A trained, held-out-evaluated readout remains P0 work.
- **Private upstream API:** the adapter calls `_param_api`, `_initial_state`, `_next_state` and `_state_api` at the pinned commit. Tests compare against the public `simulate`, `steady_state` and `fade_in_state`; rerun them on any upgrade.
- **Weights licence:** terms are unclear. Use locally only and confirm with upstream before any distribution or public release of model files.

## Files

- `flyvis_service/config.py`: pins, paths and FlyVis root setup.
- `flyvis_service/weights.py`: download, verify and manifest.
- `flyvis_service/model.py`: hash-checked loading.
- `flyvis_service/eye.py`: camera → hexals.
- `flyvis_service/stateful.py`: stateful stepping.
- `flyvis_service/features.py`: T4/T5 sectors.
- `flyvis_service/synthetic.py`: test patterns.
- `flyvis_service/server.py`: WebSocket service.
- `flyvis_service/benchmark.py` and `flyvis_service/characterize.py`.
- `tests/` (including `test_server.py`), `setup.sh`, `requirements.lock`, `weights.manifest.json`, `pytest.ini`.
- Worker client in `src/lib/navigation/neural/`:
  - `client.ts`, `transport.ts`, `messages.ts`, `errors.ts`, `index.ts`;
  - tests in `client.test.ts` and `messages.test.ts`, plus the opt-in `live.test.ts`.

Adapter code is ours. It uses the upstream FlyVis package unchanged: `BoxEye`, `Network`, `Stimulus`, `recover_network`, checkpoint resolution and the ground-truth preferred-direction table. FlyVis is © 2023 Lappalainen, Tschopp, McGill, Macke and Turaga, MIT licence. Cite Lappalainen et al. 2024 (above) when using results.
