"""Camera luminance frame -> FlyVis hexagonal photoreceptor input, via upstream BoxEye.

Upstream reference: ``flyvis/datasets/rendering/eye.py`` (``BoxEye``) and the Sintel
rendering in ``flyvis/datasets/sintel.py`` at commit 0a69fa2f (MIT). ``BoxEye`` itself
is used unchanged; this module only decides which pixels it sees.

Image convention (input)
    ``frame[row, col]`` with row 0 at the TOP and col 0 at the LEFT of the image as
    seen by the camera (standard raster order). WebGL ``readPixels`` returns rows
    bottom-up; flip such buffers vertically before calling this adapter.

Luminance convention (input)
    float in [0, 1]. The pretrained networks were trained on Sintel frames converted
    with PIL ``convert("L")`` / 255, i.e. Rec. 601 luma of gamma-encoded sRGB values,
    not linear radiance. :func:`rgb_to_luma601` reproduces that conversion.

Field of view (our assumption, not an upstream calibration)
    The central square of side ``min(H, W)`` is resized (antialiased bilinear) to a
    ``(391 + 2*13) = 417`` px canvas and passed to ``BoxEye(extent=15, kernel_size=13)``.
    The 721 receptor centres span 390 px (centre to centre) of the 417 px canvas, so the
    lattice covers ``390/417 = 93.5 %`` of the square crop in both directions, and the
    13 px box kernel never reaches BoxEye's zero padding (as in upstream's Sintel
    splits, which also kept a ``kernel_size`` margin). For a pinhole camera with
    focal length ``f`` px the lattice spans ``2*atan(0.4676*min(H, W)/f)``; see
    :meth:`CameraEye.angular_extent_deg`. The lattice is not a regular hexagon in
    angle: BoxEye places neighbouring columns 13 px apart horizontally and hexals
    13 px apart vertically, with alternate columns offset by 6.5 px.

Orientation (verified in tests/test_eye.py)
    Hexal ``i`` corresponds to lattice coordinate ``(u_i, v_i)`` in upstream order and
    samples canvas pixel ``(row, col) = (c + 13*(u + v/2), c + 13*v)`` (``c`` = centre,
    truncated to int as upstream does). Increasing ``v`` therefore moves RIGHT in the
    image and increasing ``u + v/2`` moves DOWN. The connectome's photoreceptors
    ``R1..R8`` use the same ``(u, v)`` order, so image-left reaches network columns
    with ``v < 0``.
"""

from __future__ import annotations

import math
from typing import Union

import numpy as np

from . import config

config.configure_flyvis_root()

import torch  # noqa: E402
import torchvision.transforms.functional as ttf  # noqa: E402

from flyvis.datasets.rendering import BoxEye  # noqa: E402

ArrayLike = Union[np.ndarray, torch.Tensor]


def rgb_to_luma601(rgb: ArrayLike) -> np.ndarray:
    """sRGB image (H, W, 3), uint8 or float in [0, 1] -> luma in [0, 1] like PIL "L".

    PIL documents L = R*299/1000 + G*587/1000 + B*114/1000 on 8-bit values; its
    fixed-point implementation can differ from this rounding by one 8-bit step.
    """
    rgb = np.asarray(rgb)
    if rgb.ndim != 3 or rgb.shape[-1] != 3:
        raise ValueError(f"expected (H, W, 3) RGB, got shape {rgb.shape}")
    if np.issubdtype(rgb.dtype, np.integer):
        values = rgb.astype(np.float64)
    else:
        values = np.clip(rgb.astype(np.float64), 0.0, 1.0) * 255.0
    luma = values @ np.array([0.299, 0.587, 0.114])
    return (np.floor(luma + 0.5) / 255.0).astype(np.float32)


class CameraEye:
    """Convert one grayscale frame into the 721-element hexagonal input of a network."""

    def __init__(self, extent: int = 15, kernel_size: int = 13):
        self.box = BoxEye(extent=extent, kernel_size=kernel_size)
        self.extent = extent
        self.kernel_size = kernel_size
        self.hexals = int(self.box.hexals)
        self.lattice_px = int(self.box.min_frame_size.max())
        self.canvas_px = self.lattice_px + 2 * kernel_size
        centers = self.box.receptor_centers.to("cpu", torch.float64)
        half = self.canvas_px / 2.0
        #: Hexal positions in the square crop, in units of the crop half-width.
        #: x: -1 (left edge) .. +1 (right edge); y: -1 (top) .. +1 (bottom).
        self.hex_x = (centers[:, 1] / half).numpy()
        self.hex_y = (centers[:, 0] / half).numpy()
        #: Integer horizontal column of each hexal (-extent .. +extent, left to right);
        #: BoxEye places column v at x = kernel_size * v exactly.
        col = centers[:, 1].numpy() / kernel_size
        if not np.allclose(col, np.round(col)):
            raise ValueError("BoxEye receptor columns are not on integer multiples of kernel_size")
        self.hex_col = np.round(col).astype(np.int64)
        #: Fraction of the square crop spanned by the receptor lattice.
        self.lattice_fraction = (self.lattice_px - 1) / self.canvas_px

    @staticmethod
    def _validate(frame: ArrayLike) -> torch.Tensor:
        if isinstance(frame, np.ndarray):
            if not np.issubdtype(frame.dtype, np.floating):
                raise TypeError(
                    f"frame dtype {frame.dtype} is not floating point; pass luminance in [0, 1]"
                )
            tensor = torch.from_numpy(np.ascontiguousarray(frame, dtype=np.float32))
        elif isinstance(frame, torch.Tensor):
            if not frame.is_floating_point():
                raise TypeError(f"frame dtype {frame.dtype} is not floating point")
            tensor = frame.detach().to("cpu", torch.float32)
        else:
            raise TypeError(f"unsupported frame type {type(frame)!r}")
        if tensor.ndim != 2:
            raise ValueError(f"expected a single (H, W) frame, got shape {tuple(tensor.shape)}")
        if min(tensor.shape) < 2:
            raise ValueError(f"frame too small: {tuple(tensor.shape)}")
        if not torch.isfinite(tensor).all():
            raise ValueError("frame contains NaN or infinite values")
        lo, hi = float(tensor.min()), float(tensor.max())
        if lo < -1e-6 or hi > 1 + 1e-6:
            raise ValueError(f"frame values must lie in [0, 1]; got [{lo:.4g}, {hi:.4g}]")
        return tensor.clamp(0.0, 1.0)

    def canvas(self, frame: ArrayLike) -> torch.Tensor:
        """Central square crop resized to the BoxEye canvas, shape (canvas, canvas)."""
        tensor = self._validate(frame)
        h, w = tensor.shape
        side = min(h, w)
        top, left = (h - side) // 2, (w - side) // 2
        square = tensor[top : top + side, left : left + side]
        if side != self.canvas_px:
            square = ttf.resize(
                square[None], [self.canvas_px, self.canvas_px], antialias=True
            )[0]
        return square

    def __call__(self, frame: ArrayLike) -> torch.Tensor:
        """Return the hexagonal input for one frame, shape (721,), float32 on CPU."""
        canvas = self.canvas(frame)
        hexals = self.box(canvas[None, None], ftype="mean", hex_sample=True)
        return hexals.reshape(self.hexals).to(torch.float32)

    def angular_extent_deg(self, frame_height: int, frame_width: int, hfov_deg: float) -> dict:
        """Approximate angles covered by the lattice for a pinhole camera.

        Args:
            frame_height, frame_width: camera resolution in pixels.
            hfov_deg: horizontal field of view of the full camera frame.
        """
        f = (frame_width / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
        side = min(frame_height, frame_width)
        half_span = 0.5 * self.lattice_fraction * side
        spacing_px = side * self.kernel_size / self.canvas_px
        return {
            "lattice_span_deg": 2.0 * math.degrees(math.atan(half_span / f)),
            "center_column_spacing_deg": math.degrees(math.atan(spacing_px / f)),
            "square_crop_px": side,
        }
