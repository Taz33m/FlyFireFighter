"""Stateful 50 Hz stepping of one pretrained FlyVis network on camera frames.

Upstream reference: ``flyvis/network/network.py`` (``Network.forward``, ``simulate``,
``steady_state``, ``fade_in_state``, ``_next_state``) and ``flyvis/network/stimulus.py``
at commit 0a69fa2f (MIT).

Why not ``Network.simulate`` per frame: ``simulate`` defaults to
``initial_state="auto"``, i.e. a fresh 1 s grey warm-up on every call, which would
erase the recurrent state (adaptation, motion history) between camera frames.

What this class does instead
    * Warm-up once: the grey steady state of ``simulate``'s "auto" mode
      (``steady_state(t_pre=1.0 s, value=0.5)``), computed once per network load.
      Optionally ``reset(warmup_frame=...)`` additionally applies the contrast ramp of
      upstream ``fade_in_state`` (first frame faded in from grey) so that a scene far
      from grey does not start with an onset transient. Both are run as a step loop
      that keeps only the current state: upstream's versions build the list of all
      intermediate states (each caching a 1.5M-element gather), which costs ~315 MB of
      resident memory that is not returned. The arithmetic is the same; tests check
      the results equal upstream's ``steady_state`` and ``fade_in_state`` exactly.
    * Protocol flyfirefighter.neural/1 uses ``reset(first_frame_warmup=True)``: the same
      ``steady_state`` procedure, but with the run's first frame held as the static
      stimulus instead of uniform grey (a grey warm-up spikes on dark interiors), then
      that frame is integrated as the first step. After 1 s (50 steps) the pooled
      T4/T5 features are within 0.005 of an 8 s static steady state.
    * Per frame: the frame is written into the network's own ``Stimulus`` buffer (which
      broadcasts the 721 luminance values to photoreceptors R1-R8) and one Euler step
      ``Network._next_state(params, state, x_t, dt)`` is taken, the same call
      ``Network.forward`` makes inside its time loop. Parameters are frozen, so the
      parameter namespace (``clamp`` + ``_param_api``) is built once instead of on every
      frame; ``tests/test_stateful.py`` checks frame-by-frame stepping against one
      batched ``Network.simulate`` call over the same frames.
    * ``reset()`` restores the run's initial state and the step counter.

Single network, batch size 1, CPU. Not thread-safe: one caller at a time.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

from . import config

config.configure_flyvis_root()

import torch  # noqa: E402

from flyvis.utils.tensor_utils import AutoDeref  # noqa: E402

from .eye import ArrayLike, CameraEye  # noqa: E402
from .features import MotionFeatures  # noqa: E402
from .model import LoadedNetwork, load_network  # noqa: E402


def _clone_state(state: AutoDeref) -> Dict[str, Dict[str, torch.Tensor]]:
    return {
        group: {k: dict.__getitem__(state[group], k).detach().clone() for k in state[group]}
        for group in ("nodes", "edges")
    }


class StatefulFlyVis:
    """Pretrained FlyVis network + CameraEye + T4/T5 features with carried state."""

    def __init__(
        self,
        loaded: Optional[LoadedNetwork] = None,
        *,
        dt: float = config.DT,
        warmup_s: float = 1.0,
        warmup_value: float = 0.5,
        eye: Optional[CameraEye] = None,
    ):
        if not 0 < dt <= 0.02 + 1e-12:
            raise ValueError(f"dt={dt} s; upstream integration requires dt <= 1/50 s")
        self.loaded = loaded or load_network()
        self.network = self.loaded.network
        self.dt = float(dt)
        self.warmup_s = float(warmup_s)
        self.warmup_value = float(warmup_value)
        self.eye = eye or CameraEye()
        stimulus = self.network.stimulus
        if self.eye.hexals != stimulus.n_input_elements:
            raise ValueError(
                f"eye produces {self.eye.hexals} hexals; network expects "
                f"{stimulus.n_input_elements} per photoreceptor type"
            )
        with torch.no_grad():
            self.network.clamp()
            self._params = self.network._param_api()
        self._grey_state = _clone_state(self._grey_warmup())
        self.features = MotionFeatures(self.network.connectome, self.eye)
        self.last_timing: Dict[str, float] = {}
        self.reset()

    # -- state -----------------------------------------------------------------

    def _build_state(self, saved: Dict[str, Dict[str, torch.Tensor]]) -> AutoDeref:
        state = AutoDeref(
            nodes=AutoDeref({k: v.clone() for k, v in saved["nodes"].items()}),
            edges=AutoDeref({k: v.clone() for k, v in saved["edges"].items()}),
        )
        return self.network._state_api(state)

    def _advance(self, state: AutoDeref, hexals: torch.Tensor) -> AutoDeref:
        """One Euler step: hexals (721,) -> Stimulus buffer (R1-R8) -> _next_state."""
        stimulus = self.network.stimulus
        stimulus.zero(1, 1)
        stimulus.add_input(hexals.reshape(1, 1, 1, -1))
        with torch.no_grad():
            return self.network._next_state(self._params, state, stimulus()[:, 0], self.dt)

    @property
    def warmup_steps(self) -> int:
        """Warm-up length in steps; upstream's frame count ``int(t_pre / dt)`` (50 for 1 s)."""
        return int(self.warmup_s / self.dt)

    def _static_warmup(self, hexals: torch.Tensor) -> AutoDeref:
        """Upstream ``steady_state`` procedure with ``hexals`` held as a static stimulus.

        Starts from the network's reinitialized state (``Network._initial_state``: resting
        potentials) and integrates ``warmup_steps`` steps, keeping only the current state.
        """
        with torch.no_grad():
            state = self.network._initial_state(self._params, 1)
        for _ in range(self.warmup_steps):
            state = self._advance(state, hexals)
        return state

    def _grey_warmup(self) -> AutoDeref:
        """Upstream ``steady_state(t_pre, dt, 1, value)``: static uniform grey input."""
        return self._static_warmup(torch.full((self.eye.hexals,), self.warmup_value))

    def _fade_in(self, hexals: torch.Tensor, fade_in_s: float, state: AutoDeref) -> AutoDeref:
        """Upstream ``fade_in_state``: contrast of ``hexals`` ramped 0 -> 1 from grey."""
        n = int(fade_in_s / self.dt)
        ramp = torch.linspace(0, 1, n)
        for i in range(n):
            state = self._advance(state, ramp[i] * (hexals - 0.5) + 0.5)
        return state

    def reset(
        self,
        warmup_frame: Optional[ArrayLike] = None,
        fade_in_s: float = 1.0,
        *,
        first_frame_warmup: bool = False,
    ) -> None:
        """Start a run.

        Default: the cached grey steady state. ``warmup_frame``: grey steady state, then
        that frame faded in (upstream ``fade_in_state``). ``first_frame_warmup=True``
        (protocol flyfirefighter.neural/1): reinitialize now; the first frame passed to
        :meth:`step`/:meth:`step_hex` is first held as a static stimulus for
        ``warmup_steps`` steps, which become the run's initial state and feature
        baseline, and is then integrated as the run's first step.
        """
        self.step_count = 0
        if first_frame_warmup:
            if warmup_frame is not None:
                raise ValueError("first_frame_warmup uses the first step's frame; do not pass warmup_frame")
            with torch.no_grad():
                initial = _clone_state(self.network._initial_state(self._params, 1))
            self._pending_first_frame_warmup = True
        elif warmup_frame is None:
            initial = self._grey_state
            self._pending_first_frame_warmup = False
        else:
            hexals = self.eye(warmup_frame)
            initial = _clone_state(self._fade_in(hexals, fade_in_s, self._build_state(self._grey_state)))
            self._pending_first_frame_warmup = False
        self._set_initial(initial)

    def _set_initial(self, initial: Dict[str, Dict[str, torch.Tensor]]) -> None:
        self._initial_state = initial
        self._state = self._build_state(initial)
        self.features.set_baseline(self._state.nodes.activity[0])

    @property
    def awaiting_first_frame(self) -> bool:
        """True after ``reset(first_frame_warmup=True)`` until the first step."""
        return self._pending_first_frame_warmup

    @property
    def activity(self) -> torch.Tensor:
        """Current membrane voltages of all nodes, shape (n_nodes,). Do not modify."""
        return self._state.nodes.activity[0]

    @property
    def initial_activity(self) -> torch.Tensor:
        return self._initial_state["nodes"]["activity"][0]

    # -- stepping --------------------------------------------------------------

    def step_hex(self, hexals: torch.Tensor) -> torch.Tensor:
        """Advance one dt with a (721,) hexagonal luminance input; return voltages."""
        if hexals.shape != (self.eye.hexals,):
            raise ValueError(f"expected ({self.eye.hexals},) hexals, got {tuple(hexals.shape)}")
        if self._pending_first_frame_warmup:
            self._set_initial(_clone_state(self._static_warmup(hexals)))
            self._pending_first_frame_warmup = False
        self._state = self._advance(self._state, hexals)
        self.step_count += 1
        return self._state.nodes.activity[0]

    def step(self, frame: ArrayLike) -> Dict[str, Any]:
        """Advance one 20 ms frame and return the feature dict for this step.

        Returns:
            ``{"step", "t", "responses", "horizontal_motion", "expansion"}`` where
            ``step`` counts frames since reset (1 for the first frame), ``t`` is the
            simulated time ``step * dt`` in seconds, and the rest is defined in
            :mod:`flyvis_service.features`.
        """
        t0 = time.perf_counter()
        hexals = self.eye(frame)
        t1 = time.perf_counter()
        activity = self.step_hex(hexals)
        t2 = time.perf_counter()
        out = self.features(activity)
        t3 = time.perf_counter()
        self.last_timing = {
            "eye_ms": 1e3 * (t1 - t0),
            "network_ms": 1e3 * (t2 - t1),
            "features_ms": 1e3 * (t3 - t2),
            "total_ms": 1e3 * (t3 - t0),
        }
        return {"step": self.step_count, "t": self.step_count * self.dt, **out}

    def describe(self) -> Dict[str, Any]:
        return {
            "model_version": self.loaded.model_version,
            "network": self.loaded.name,
            "checkpoint": str(self.loaded.checkpoint.relative_to(config.cache_dir())),
            "checkpoint_sha256": self.loaded.checkpoint_sha256,
            "flyvis_commit": config.FLYVIS_COMMIT,
            "dt_s": self.dt,
            "warmup": {
                "seconds": self.warmup_s,
                "steps": self.warmup_steps,
                "grey_value": self.warmup_value,
                "first_frame_pending": self._pending_first_frame_warmup,
            },
            "eye": {
                "extent": self.eye.extent,
                "kernel_size": self.eye.kernel_size,
                "hexals": self.eye.hexals,
                "canvas_px": self.eye.canvas_px,
                "crop": "central square of side min(H, W), antialiased resize to canvas",
                "lattice_fraction_of_crop": self.eye.lattice_fraction,
            },
            "features": self.features.describe(),
        }
