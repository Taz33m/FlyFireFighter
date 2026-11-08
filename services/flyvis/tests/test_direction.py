"""Direction sanity of the T4/T5 features on synthetic moving patterns.

Scope: full adapter path (CameraEye -> pretrained flow/0000/000 -> MotionFeatures) at
50 Hz on synthetic gratings and edges (not camera or simulator data). Assertions were
fixed before looking at outcomes as far as possible and are deliberately coarse;
measured numbers are printed (run pytest with -s) and recorded in README.md. If the
model disagrees with an assertion, report it rather than tuning the threshold.
"""

from __future__ import annotations

import numpy as np
import pytest

from flyvis_service import synthetic
from flyvis_service.features import MOTION_TYPES, SECTORS

CENTER = SECTORS.index("center")
LEFT, RIGHT = SECTORS.index("left"), SECTORS.index("right")
#: "Measurably different": some T4/T5 type has a direction index of at least 0.2
#: (a 1.5 : 1 response ratio) in the center sector.
MIN_DIRECTION_INDEX = 0.2


def _run(runtime, frames, settle: int):
    """Reset, step every frame, average features over frames[settle:]."""
    runtime.reset()
    outs = [runtime.step(f) for f in frames][settle:]
    responses = np.mean([[o["responses"][t] for t in MOTION_TYPES] for o in outs], axis=0)  # (8, 3)
    horizontal = np.mean([o["horizontal_motion"] for o in outs], axis=0)
    expansion = float(np.mean([o["expansion"] for o in outs]))
    return responses, horizontal, expansion


def _table(title, rows):
    lines = [title, "        " + " ".join(f"{t:>7}" for t in MOTION_TYPES)]
    for label, values in rows:
        lines.append(f"{label:<7} " + " ".join(f"{v:7.4f}" for v in values))
    print("\n" + "\n".join(lines))


@pytest.fixture(scope="module")
def grating_runs(runtime):
    n = 100  # 2 s; average over the last 1 s
    rightward = _run(runtime, synthetic.drifting_grating("right", n_frames=n), settle=50)
    leftward = _run(runtime, synthetic.drifting_grating("left", n_frames=n), settle=50)
    return rightward, leftward


def test_left_right_grating_changes_t4_t5_responses(grating_runs, runtime):
    """(c) Left->right vs right->left drift gives measurably different T4/T5 responses."""
    (r_resp, r_h, _), (l_resp, l_h, _) = grating_runs
    base = runtime.features.baseline[:, CENTER]
    lr, rl = r_resp[:, CENTER], l_resp[:, CENTER]
    index = np.abs(lr - rl) / np.maximum(lr + rl, 1e-9)
    _table(
        "[direction] drifting grating, period 0.25 crop (8 columns), 2 Hz, contrast 0.8; "
        "center-sector mean relu voltage, last 1 s",
        [("L->R", lr), ("R->L", rl), ("grey", base), ("DI", index)],
    )
    print(f"horizontal_motion L->R {np.round(r_h, 4).tolist()}  R->L {np.round(l_h, 4).tolist()}")
    assert index.max() >= MIN_DIRECTION_INDEX


def test_opponent_signal_follows_upstream_direction_labels(grating_runs):
    """horizontal_motion (T4b/T5b minus T4a/T5a) is positive for L->R, negative for R->L."""
    (_, r_h, _), (_, l_h, _) = grating_runs
    assert r_h[CENTER] > 0 > l_h[CENTER]


@pytest.mark.parametrize(
    "polarity, rightward_type, leftward_type",
    [("ON", "T4b", "T4a"), ("OFF", "T5b", "T5a")],
)
def test_edges_drive_types_labelled_for_that_direction(runtime, polarity, rightward_type, leftward_type):
    """ON edges for T4, OFF edges for T5: b prefers L->R, a prefers R->L (upstream labels)."""
    frames_r, pre = synthetic.moving_edge("right", polarity)
    frames_l, _ = synthetic.moving_edge("left", polarity)
    r_resp, _, _ = _run(runtime, frames_r, settle=pre)
    l_resp, _, _ = _run(runtime, frames_l, settle=pre)
    _table(
        f"[edges] {polarity} edge, 0.5 crop/s; center-sector mean relu voltage over the sweep",
        [("L->R", r_resp[:, CENTER]), ("R->L", l_resp[:, CENTER])],
    )
    b, a = MOTION_TYPES.index(rightward_type), MOTION_TYPES.index(leftward_type)
    assert r_resp[b, CENTER] > l_resp[b, CENTER]
    assert l_resp[a, CENTER] > r_resp[a, CENTER]


def test_motion_is_reported_in_the_stimulated_sector(runtime):
    """Retinotopy through the network: motion only on the left reaches the left sector."""
    base = runtime.features.baseline
    results = {}
    for side, region in (("left", (-0.5, -0.25)), ("right", (0.25, 0.5))):
        frames = synthetic.drifting_grating("right", n_frames=100, region=region)
        responses, _, _ = _run(runtime, frames, settle=50)
        results[side] = (responses - base).mean(axis=0)  # mean over the 8 types, per sector
    print("\n[retinotopy] mean over T4/T5 of (response - grey), per sector "
          f"{list(SECTORS)}: left-only {np.round(results['left'], 4).tolist()}, "
          f"right-only {np.round(results['right'], 4).tolist()}")
    assert results["left"][LEFT] > 2 * abs(results["left"][RIGHT])
    assert results["right"][RIGHT] > 2 * abs(results["right"][LEFT])


def test_expansion_sign(runtime, grating_runs):
    """Expansion is positive for outward and negative for inward horizontal flow, and
    uniform horizontal drift (as from yaw) leaks in at under half that magnitude."""
    _, h_out, e_out = _run(runtime, synthetic.mirrored_grating(100, expanding=True), settle=50)
    _, h_in, e_in = _run(runtime, synthetic.mirrored_grating(100, expanding=False), settle=50)
    (_, _, e_right), (_, _, e_left) = grating_runs
    print(f"\n[expansion] outward: expansion {e_out:.4f}, horizontal_motion {np.round(h_out, 4).tolist()}; "
          f"inward: expansion {e_in:.4f}, horizontal_motion {np.round(h_in, 4).tolist()}; "
          f"uniform drift: expansion {e_right:.4f} (L->R), {e_left:.4f} (R->L)")
    assert e_out > 0 > e_in
    assert max(abs(e_right), abs(e_left)) < 0.5 * min(abs(e_out), abs(e_in))
