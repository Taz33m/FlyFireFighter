"""Measure per-frame latency of single-frame stateful stepping and peak memory.

Usage (from services/flyvis)::

    .venv/bin/python -m flyvis_service.benchmark --threads 4
    .venv/bin/python -m flyvis_service.benchmark --threads 4 --device mps-experimental

Input frames are synthetic (``synthetic.random_scene``), generated before timing.
Each timed call is ``StatefulFlyVis.step(frame)``: validate + crop/resize + upstream
BoxEye + one network Euler step + T4/T5 pooling, batch size 1, as a 50 Hz loop would
call it. Latency is wall time per call (``time.perf_counter``); nothing is estimated.

``--device mps-experimental`` is NOT a supported path: upstream ``Network``
construction fails on MPS (float64 parameter initialisation), so the benchmark builds
on CPU, moves the network's parameters and private index tensors to MPS and runs only
the network step under an MPS default-device context. The eye and feature pooling stay
on CPU; feature pooling copies the activity back, which synchronises every step.
Activity is compared against a CPU run over the same frames.
"""

from __future__ import annotations

import argparse
import json
import platform
import resource
import subprocess
import sys
import time
from typing import Any, Dict, List

import numpy as np

from . import config

config.configure_flyvis_root()

import torch  # noqa: E402


def _percentiles(samples_ms: List[float]) -> Dict[str, float]:
    a = np.asarray(samples_ms)
    return {
        "n": int(a.size),
        "mean": float(a.mean()),
        "median": float(np.median(a)),
        "p90": float(np.percentile(a, 90)),
        "p99": float(np.percentile(a, 99)),
        "max": float(a.max()),
    }


def _peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 2**20 if sys.platform == "darwin" else peak / 2**10  # bytes on macOS, KiB on Linux


def _hardware() -> Dict[str, Any]:
    info = {"machine": platform.machine(), "platform": platform.platform()}
    if sys.platform == "darwin":
        for key, name in (("machdep.cpu.brand_string", "cpu"), ("hw.memsize", "memory_bytes"),
                          ("hw.perflevel0.physicalcpu", "performance_cores"),
                          ("hw.perflevel1.physicalcpu", "efficiency_cores")):
            try:
                info[name] = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True,
                                            check=True).stdout.strip()
            except (OSError, subprocess.CalledProcessError):
                pass
    return info


def _migrate_to_mps(runtime) -> None:
    """Experimental: move a CPU-built network to MPS (see module docstring).

    Only the network step runs under an MPS default-device context: upstream
    ``target_sum``/``Stimulus``/dynamics allocate on the default device. Setting MPS as
    the global default instead breaks upstream BoxEye, whose internal
    ``torch.tensor([h, w])`` then lands on MPS next to its CPU ``min_frame_size``.
    """
    device = torch.device("mps")
    net = runtime.network
    net.to(device)
    net._source_indices = net._source_indices.to(device)
    net._target_indices = net._target_indices.to(device)
    for param in list(net.node_params.values()) + list(net.edge_params.values()):
        param.indices = param.indices.to(device)
        param.readers = {k: v.to(device) for k, v in param.readers.items()}
    with device, torch.no_grad():
        runtime._params = net._param_api()
        net.stimulus.zero(1, 2)  # force the 1-frame buffer to be re-allocated on MPS
    for saved in (runtime._grey_state, runtime._initial_state):
        for group in saved.values():
            for key in group:
                group[key] = group[key].to(device)
    cpu_advance = runtime._advance

    def advance_on_mps(state, hexals):
        with device:
            return cpu_advance(state, hexals.to(device))

    runtime._advance = advance_on_mps
    runtime.reset()


def run(threads: int, n_frames: int, warmup_frames: int, height: int, width: int, device: str) -> Dict[str, Any]:
    if threads > 4:
        raise SystemExit("threads must be <= 4 on the shared Mac")
    torch.set_num_threads(threads)
    import psutil  # upstream dependency

    from .stateful import StatefulFlyVis
    from .synthetic import iter_random_scene

    process = psutil.Process()
    memory: Dict[str, float] = {"rss_mb_after_imports": process.memory_info().rss / 2**20}

    def frames():  # generated one at a time, outside the timed region
        return iter_random_scene(seed=7, n_frames=warmup_frames + n_frames, height=height, width=width)

    t0 = time.perf_counter()
    runtime = StatefulFlyVis()
    load_s = time.perf_counter() - t0
    memory["rss_mb_after_load_and_warmup"] = process.memory_info().rss / 2**20
    memory["peak_rss_mb_after_load_and_warmup"] = _peak_rss_mb()

    reference: Dict[int, torch.Tensor] = {}
    every = 25  # compare MPS against CPU on every 25th frame (bounded memory)
    if device == "mps-experimental":
        if not torch.backends.mps.is_available():
            raise SystemExit("MPS not available")
        runtime.reset()
        for i, frame in enumerate(frames()):
            activity = runtime.step_hex(runtime.eye(frame))
            if i % every == 0 or i == warmup_frames + n_frames - 1:
                reference[i] = activity.clone()
        _migrate_to_mps(runtime)

    runtime.reset()
    total, eye, network, features = [], [], [], []
    max_diff = 0.0
    for i, frame in enumerate(frames()):
        t = time.perf_counter()
        runtime.step(frame)  # feature pooling copies T4/T5 activity to CPU: a sync point on MPS
        elapsed = 1e3 * (time.perf_counter() - t)
        if i in reference:
            activity = runtime.activity.to("cpu")
            max_diff = max(max_diff, float((activity - reference[i]).abs().max()))
        if i >= warmup_frames:
            total.append(elapsed)
            eye.append(runtime.last_timing["eye_ms"])
            network.append(runtime.last_timing["network_ms"])
            features.append(runtime.last_timing["features_ms"])

    result: Dict[str, Any] = {
        "date": time.strftime("%Y-%m-%d"),
        "device": device,
        "torch": torch.__version__,
        "torch_threads": torch.get_num_threads(),
        "mps_available": bool(torch.backends.mps.is_available()),
        "hardware": _hardware(),
        "model_version": runtime.loaded.model_version,
        "frame_shape": [height, width],
        "frames_timed": n_frames,
        "frames_discarded_as_warmup": warmup_frames,
        "load_and_warmup_s": load_s,
        "step_ms": _percentiles(total),
        "breakdown_median_ms": {
            "eye": float(np.median(eye)),
            "network": float(np.median(network)),
            "features": float(np.median(features)),
        },
        "budget_ms_at_50hz": 1000 * config.DT,
        "memory": {
            **memory,
            "rss_mb_after_run": process.memory_info().rss / 2**20,
            "peak_rss_mb_process": _peak_rss_mb(),
        },
    }
    if device == "mps-experimental":
        result["max_abs_diff_vs_cpu"] = max_diff
        result["compared_frames"] = len(reference)
        result["mps_driver_allocated_mb"] = torch.mps.driver_allocated_memory() / 2**20
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--frames", type=int, default=1000)
    parser.add_argument("--warmup-frames", type=int, default=50)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--device", choices=["cpu", "mps-experimental"], default="cpu")
    args = parser.parse_args(argv)
    result = run(args.threads, args.frames, args.warmup_frames, args.height, args.width, args.device)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
