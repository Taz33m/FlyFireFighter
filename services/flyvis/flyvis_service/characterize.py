"""Preferred image direction of each T4/T5 type through the full adapter path.

Usage (from services/flyvis)::

    .venv/bin/python -m flyvis_service.characterize

Drives StatefulFlyVis with synthetic gratings and ON/OFF edges moving in 12 directions
(degrees counter-clockwise from image-right, image-up = 90) and reports, per type,
the vector-sum preferred direction (PD) and direction selectivity index
``DSI = |sum_k r_k e^{i theta_k}| / sum_k r_k`` of the center-sector response above a
reference level (grey initial state for gratings, adapted pre-stimulus level for
edges; negative values clipped to 0). Upstream's ground-truth
labels (``flyvis.utils.groundtruth_utils.preferred_directions``) are printed for
comparison. Synthetic stimuli only; this characterises one checkpoint, not flies.
"""

from __future__ import annotations

import json
import sys
from typing import Dict

import numpy as np

from . import config

config.configure_flyvis_root()

import torch  # noqa: E402

from flyvis.utils.groundtruth_utils import preferred_directions  # noqa: E402

from . import synthetic  # noqa: E402
from .features import MOTION_TYPES, SECTORS  # noqa: E402
from .stateful import StatefulFlyVis  # noqa: E402

ANGLES = np.arange(0, 360, 30)
CENTER = SECTORS.index("center")


def _center_response(runtime: StatefulFlyVis, frames, settle: int, relative_to: str) -> np.ndarray:
    """Mean center-sector response over frames[settle:] minus a reference level.

    relative_to="initial": the run's initial (grey) state - for gratings, whose mean
    luminance is the grey level. relative_to="pre": the last pre-stimulus frame - for
    edges, which start with uniform pre-adaptation frames at the luminance ahead of
    the edge, so the direction-independent response to that luminance cancels.
    """
    runtime.reset()
    outs = [runtime.step(f) for f in frames]
    center = np.array([[o["responses"][t][CENTER] for t in MOTION_TYPES] for o in outs])
    reference = runtime.features.baseline[:, CENTER] if relative_to == "initial" else center[settle - 1]
    return center[settle:].mean(axis=0) - reference


def _summary(responses: np.ndarray) -> Dict[str, Dict[str, float]]:
    r = np.clip(responses, 0.0, None)  # (angles, types)
    vector = (r * np.exp(1j * np.radians(ANGLES))[:, None]).sum(axis=0)
    total = np.maximum(r.sum(axis=0), 1e-12)
    return {
        t: {
            "pd_deg": float(np.degrees(np.angle(vector[i])) % 360),
            "dsi": float(np.abs(vector[i]) / total[i]),
            "argmax_deg": int(ANGLES[int(np.argmax(r[:, i]))]),
        }
        for i, t in enumerate(MOTION_TYPES)
    }


def characterize(runtime: StatefulFlyVis) -> Dict[str, Dict[str, Dict[str, float]]]:
    results = {}
    gratings = np.array(
        [_center_response(runtime, synthetic.drifting_grating(a, n_frames=100), 50, "initial") for a in ANGLES]
    )
    results["grating_0.25crop_2Hz"] = _summary(gratings)
    for polarity in ("ON", "OFF"):
        edges = []
        for a in ANGLES:
            frames, pre = synthetic.moving_edge(a, polarity)
            edges.append(_center_response(runtime, frames, pre, "pre"))
        results[f"{polarity}_edge_0.5crop_per_s"] = _summary(np.array(edges))
    return results


def main() -> int:
    torch.set_num_threads(min(4, torch.get_num_threads()))
    runtime = StatefulFlyVis()
    results = characterize(runtime)
    header = "stimulus                   " + " ".join(f"{t:>7}" for t in MOTION_TYPES)
    print(header)
    print("upstream label (deg)       " + " ".join(f"{preferred_directions[t]:>7}" for t in MOTION_TYPES))
    for name, summary in results.items():
        print(f"{name:<26} " + " ".join(f"{summary[t]['pd_deg']:7.0f}" for t in MOTION_TYPES) + "   PD")
        print(f"{'':<26} " + " ".join(f"{summary[t]['dsi']:7.2f}" for t in MOTION_TYPES) + "   DSI")
    print(json.dumps({"model_version": runtime.loaded.model_version, "results": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
