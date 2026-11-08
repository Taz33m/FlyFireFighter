"""Synthetic luminance sequences for tests and benchmarks.

These are procedurally generated test patterns, not camera frames, recordings or
simulator renders. Spatial scales are given as fractions of the square crop that
:class:`flyvis_service.eye.CameraEye` uses (side ``min(H, W)``), so a pattern means the
same thing to the network at any resolution: a period of 0.25 crop equals 8 receptor
column spacings. Directions are degrees counter-clockwise from image-right with
image-up = 90 (so "right" = 0, "up" = 90, "left" = 180, "down" = 270), the same
convention upstream uses for its moving-edge stimuli.
"""

from __future__ import annotations

from typing import Optional, Tuple, Union

import numpy as np

NAMED_DIRECTIONS = {"right": 0.0, "up": 90.0, "left": 180.0, "down": 270.0}


def _direction(direction: Union[str, float]) -> Tuple[float, float]:
    degrees = NAMED_DIRECTIONS[direction] if isinstance(direction, str) else float(direction)
    rad = np.radians(degrees)
    return float(np.cos(rad)), float(-np.sin(rad))  # image y points down


def crop_coordinates(height: int, width: int) -> Tuple[np.ndarray, np.ndarray]:
    """Pixel coordinates relative to the crop centre, in units of the crop side."""
    side = min(height, width)
    rows = (np.arange(height, dtype=np.float64) + 0.5 - height / 2.0) / side
    cols = (np.arange(width, dtype=np.float64) + 0.5 - width / 2.0) / side
    return np.meshgrid(cols, rows)  # x (right), y (down)


def drifting_grating(
    direction: Union[str, float],
    n_frames: int,
    height: int = 240,
    width: int = 320,
    period: float = 0.25,
    temporal_hz: float = 2.0,
    contrast: float = 0.8,
    mean: float = 0.5,
    dt: float = 0.02,
    region: Optional[Tuple[float, float]] = None,
) -> np.ndarray:
    """Sinusoidal grating drifting in ``direction``; shape (n_frames, H, W), float32.

    Args:
        region: optional (x_min, x_max) in crop units (-0.5 .. 0.5); outside it the
            frame is uniform ``mean``.
    """
    x, y = crop_coordinates(height, width)
    dx, dy = _direction(direction)
    along = x * dx + y * dy
    speed = period * temporal_hz
    frames = np.empty((n_frames, height, width), dtype=np.float32)
    for i in range(n_frames):
        t = (i + 1) * dt
        frames[i] = mean + 0.5 * contrast * np.sin(2 * np.pi * (along - speed * t) / period)
    if region is not None:
        outside = (x < region[0]) | (x > region[1])
        frames[:, outside] = mean
    return frames


def moving_edge(
    direction: Union[str, float],
    polarity: str,
    height: int = 240,
    width: int = 320,
    speed: float = 0.5,
    dt: float = 0.02,
    low: float = 0.1,
    high: float = 0.9,
    pre_frames: int = 25,
) -> Tuple[np.ndarray, int]:
    """Luminance edge sweeping across the crop; returns (frames, pre_frames).

    ``polarity="ON"``: bright region trails the edge (dark -> bright, ON stimulus);
    ``"OFF"``: dark region trails. The first ``pre_frames`` frames are uniform at the
    luminance ahead of the edge. ``speed`` is in crop sides per second.
    """
    if polarity not in ("ON", "OFF"):
        raise ValueError("polarity must be 'ON' or 'OFF'")
    behind, ahead = (high, low) if polarity == "ON" else (low, high)
    x, y = crop_coordinates(height, width)
    dx, dy = _direction(direction)
    along = x * dx + y * dy
    start, stop = -0.55, 0.55
    n_sweep = int(np.ceil((stop - start) / (speed * dt)))
    frames = np.empty((pre_frames + n_sweep, height, width), dtype=np.float32)
    frames[:pre_frames] = ahead
    for i in range(n_sweep):
        position = start + (i + 1) * speed * dt
        frames[pre_frames + i] = np.where(along < position, behind, ahead)
    return frames, pre_frames


def mirrored_grating(
    n_frames: int,
    expanding: bool = True,
    height: int = 240,
    width: int = 320,
    period: float = 0.25,
    temporal_hz: float = 2.0,
    contrast: float = 0.8,
    mean: float = 0.5,
    dt: float = 0.02,
) -> np.ndarray:
    """Vertical-stripe grating moving away from (or towards) the vertical midline.

    Expanding: the right half drifts right and the left half drifts left, the
    horizontal component of the optic flow seen when approaching a surface.
    """
    x, _ = crop_coordinates(height, width)
    sign = -1.0 if expanding else 1.0
    speed = period * temporal_hz
    frames = np.empty((n_frames, height, width), dtype=np.float32)
    for i in range(n_frames):
        t = (i + 1) * dt
        frames[i] = mean + 0.5 * contrast * np.sin(2 * np.pi * (np.abs(x) + sign * speed * t) / period)
    return frames


def iter_random_scene(seed: int, n_frames: int, height: int = 240, width: int = 320, dt: float = 0.02):
    """Yield frames of a deterministic textured scene translating with a random walk."""
    rng = np.random.default_rng(seed)
    texture = rng.random((height // 8 + 3, width // 8 + 3))
    texture = (0.15 + 0.7 * np.kron(texture, np.ones((8, 8)))).astype(np.float32)
    velocity = rng.normal(0.0, 40.0, size=2)  # px/s
    position = np.zeros(2)
    for _ in range(n_frames):
        velocity += rng.normal(0.0, 20.0, size=2)
        position = np.clip(position + velocity * dt, 0, 15.99)
        r, c = int(position[0]), int(position[1])
        yield np.ascontiguousarray(texture[r : r + height, c : c + width])


def random_scene(seed: int, n_frames: int, height: int = 240, width: int = 320, dt: float = 0.02) -> np.ndarray:
    """Deterministic textured scene translating with a random walk; (n_frames, H, W)."""
    return np.stack(list(iter_random_scene(seed, n_frames, height, width, dt)))
