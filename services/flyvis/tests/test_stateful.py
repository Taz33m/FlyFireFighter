"""Recurrent state across 50 Hz frames: continuity, reset and carry-over.

Scope: flyvis_service.stateful.StatefulFlyVis on the pinned pretrained network
(flow/0000/000), CPU, float32, dt = 0.02 s. Requires the cached weights.
"""

from __future__ import annotations

import numpy as np
import torch

from flyvis_service import synthetic

#: Frame-by-frame vs batched tolerance (float32 voltages; same operations in the same
#: order, so the expected difference is 0 - the bound allows for threaded reductions).
CONTINUITY_ATOL = 1e-5


def _hexals(runtime, frames) -> torch.Tensor:
    return torch.stack([runtime.eye(f) for f in frames])  # (T, 721)


def test_frame_by_frame_matches_single_batched_run(runtime):
    """(a) Stepping one frame at a time == one Network.simulate call over the sequence.

    The batched reference uses upstream's default initial_state="auto" (1 s grey
    warm-up), so this also checks that our once-per-run warm-up equals upstream's.
    """
    frames = np.concatenate(
        [
            synthetic.random_scene(seed=3, n_frames=30),
            synthetic.drifting_grating("left", n_frames=20),
            synthetic.moving_edge("up", "OFF", pre_frames=5)[0][:20],
        ]
    )
    hexals = _hexals(runtime, frames)

    with torch.no_grad():
        batched = runtime.network.simulate(hexals[None, :, None, :], runtime.dt)[0]  # (T, nodes)

    runtime.reset()
    stepped = torch.stack([runtime.step_hex(h).clone() for h in hexals])

    max_abs = (stepped - batched).abs().max().item()
    scale = batched.abs().max().item()
    print(f"\n[continuity] {len(frames)} frames x {batched.shape[1]} nodes: "
          f"max |stepped - batched| = {max_abs:.3g} (max |v| = {scale:.3g}, atol {CONTINUITY_ATOL})")
    assert batched.shape == stepped.shape == (len(frames), runtime.network.n_nodes)
    assert max_abs <= CONTINUITY_ATOL


def test_reset_restores_initial_state(runtime):
    """(b) reset() returns to the initial state; replaying the input replays the output."""
    run_a = synthetic.drifting_grating("right", n_frames=25)
    perturb = synthetic.moving_edge("left", "ON", pre_frames=0)[0][:30]

    runtime.reset()
    initial = runtime.activity.clone()
    first = [runtime.step(f) for f in run_a]
    first_activity = runtime.activity.clone()
    for f in perturb:
        runtime.step(f)
    assert not torch.equal(runtime.activity, initial)

    runtime.reset()
    assert runtime.step_count == 0
    assert torch.equal(runtime.activity, initial)
    second = [runtime.step(f) for f in run_a]

    assert [o["step"] for o in second] == list(range(1, len(run_a) + 1))
    assert second == first  # identical feature dicts, step by step
    diff = (runtime.activity - first_activity).abs().max().item()
    print(f"\n[reset] max |activity(run 2) - activity(run 1)| after {len(run_a)} frames = {diff:.3g}")
    assert diff == 0.0


def test_state_carries_over_between_frames(runtime):
    """A grey frame after motion is not the same as a grey frame after reset."""
    grey = np.full((240, 320), 0.5, dtype=np.float32)
    runtime.reset()
    runtime.step(grey)
    fresh = runtime.activity.clone()

    runtime.reset()
    for f in synthetic.drifting_grating("right", n_frames=25):
        runtime.step(f)
    runtime.step(grey)
    carried = runtime.activity.clone()
    diff = (carried - fresh).abs().max().item()
    print(f"\n[carry-over] max |grey-after-motion - grey-after-reset| = {diff:.3g}")
    assert diff > 1e-2


def test_simulate_per_frame_with_default_warmup_loses_history(runtime):
    """Why the adapter does not call simulate() per frame (architecture.md section 3)."""
    frames = synthetic.drifting_grating("right", n_frames=25)
    hexals = _hexals(runtime, frames)
    runtime.reset()
    for h in hexals:
        stateful = runtime.step_hex(h).clone()
    with torch.no_grad():
        naive = runtime.network.simulate(hexals[-1:][None, :, None, :], runtime.dt)[0, -1]
    t4b = torch.as_tensor(runtime.network.connectome.nodes.layer_index["T4b"][:])
    stateful_t4b = torch.relu(stateful[t4b]).mean().item()
    naive_t4b = torch.relu(naive[t4b]).mean().item()
    print(f"\n[naive simulate] T4b mean relu after 25 rightward frames: stateful {stateful_t4b:.4f}, "
          f"simulate(last frame, auto warm-up) {naive_t4b:.4f}")
    assert abs(stateful_t4b - naive_t4b) > 0.05


def test_warmup_loops_equal_upstream_steady_state_and_fade_in(runtime):
    """Our memory-lean warm-up loops reproduce upstream's functions bit for bit."""
    net = runtime.network
    with torch.no_grad():
        upstream_grey = net.steady_state(runtime.warmup_s, runtime.dt, 1, runtime.warmup_value)
    runtime.reset()
    assert torch.equal(runtime.initial_activity, upstream_grey.nodes.activity[0])

    scene = synthetic.random_scene(seed=11, n_frames=1)[0]
    hexals = runtime.eye(scene)
    with torch.no_grad():
        upstream_faded = net.fade_in_state(1.0, runtime.dt, hexals.view(1, 1, -1), state=upstream_grey)
    runtime.reset(warmup_frame=scene, fade_in_s=1.0)
    assert torch.equal(runtime.initial_activity, upstream_faded.nodes.activity[0])
    runtime.reset()


def test_first_frame_warmup_equals_batched_run_with_static_prefix(runtime):
    """Protocol warm-up: from the reinitialized state, the first frame is held static for
    warmup_steps and then integrated - i.e. one upstream simulate() call (initial_state=None)
    over [first frame x warmup_steps, frames...]."""
    frames = synthetic.random_scene(seed=13, n_frames=20, height=180, width=320) * 0.3  # dim interior
    hexals = _hexals(runtime, frames)
    n = runtime.warmup_steps
    movie = torch.cat([hexals[:1].repeat(n, 1), hexals])
    with torch.no_grad():
        batched = runtime.network.simulate(movie[None, :, None, :], runtime.dt, initial_state=None)[0]

    runtime.reset(first_frame_warmup=True)
    assert runtime.awaiting_first_frame and runtime.step_count == 0
    stepped = torch.stack([runtime.step_hex(h).clone() for h in hexals])
    assert not runtime.awaiting_first_frame
    assert torch.equal(runtime.initial_activity, batched[n - 1])  # warm-up end = run baseline
    max_abs = (stepped - batched[n:]).abs().max().item()

    runtime.reset()  # grey warm-up, for comparison of the onset on this dim scene
    grey_jump = (runtime.step_hex(hexals[0]) - runtime.initial_activity).abs().max().item()
    first_jump = (stepped[0] - batched[n - 1]).abs().max().item()
    print(f"\n[first-frame warm-up] {n} static steps; max |stepped - batched| = {max_abs:.3g}; "
          f"first-step max |dv| on a dim scene: grey warm-up {grey_jump:.3g}, first-frame warm-up {first_jump:.3g}")
    assert max_abs <= CONTINUITY_ATOL
    assert first_jump < grey_jump


def test_fade_in_warmup_is_per_run_and_reset_clears_it(runtime):
    dark = np.full((240, 320), 0.1, dtype=np.float32)
    runtime.reset()
    grey_initial = runtime.initial_activity.clone()

    runtime.reset(warmup_frame=dark)
    faded_initial = runtime.initial_activity.clone()
    assert not torch.equal(faded_initial, grey_initial)
    jump_faded = (runtime.step_hex(runtime.eye(dark)) - faded_initial).abs().max().item()

    runtime.reset()
    assert torch.equal(runtime.initial_activity, grey_initial)
    jump_grey = (runtime.step_hex(runtime.eye(dark)) - grey_initial).abs().max().item()
    print(f"\n[fade-in] first-frame max |dv| on a 0.1 scene: grey start {jump_grey:.3g}, "
          f"faded-in start {jump_faded:.3g}")
    assert jump_faded < jump_grey
