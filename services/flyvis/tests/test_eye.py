"""Camera frame -> hexagonal input: shape, lattice order, orientation and validation.

Scope: flyvis_service.eye.CameraEye with upstream BoxEye(15, 13) and the upstream
connectome's photoreceptor layout. Needs the compiled connectome, not the weights.
"""

from __future__ import annotations

import numpy as np
import pytest
import torch

from flyvis_service.eye import CameraEye, rgb_to_luma601
from flyvis_service.synthetic import crop_coordinates


@pytest.fixture(scope="module")
def eye() -> CameraEye:
    return CameraEye()


def _decode(x):
    return x.decode() if isinstance(x, bytes) else str(x)


def test_eye_output_matches_network_input(eye, connectome):
    """(d) The eye emits exactly what the network's Stimulus buffer expects."""
    from flyvis.network.stimulus import Stimulus

    frame = np.random.default_rng(0).random((480, 640), dtype=np.float32)
    hexals = eye(frame)
    stimulus = Stimulus(connectome, n_samples=1, n_frames=1)
    input_types = [_decode(t) for t in connectome.input_cell_types[:]]

    assert hexals.shape == (stimulus.n_input_elements,) == (721,)
    assert hexals.dtype == torch.float32
    assert stimulus.input_index.shape == (len(input_types), 721)

    stimulus.add_input(hexals.view(1, 1, 1, -1))  # (samples, frames, 1, hexals) as upstream requires
    buffer = stimulus()[0, 0]
    written = torch.zeros(buffer.shape[0], dtype=torch.bool)
    for cell_type in input_types:
        index = torch.as_tensor(connectome.nodes.layer_index[cell_type][:])
        assert torch.equal(buffer[index], hexals), cell_type
        written[index] = True
    assert torch.count_nonzero(buffer[~written]) == 0


def test_hexal_order_matches_photoreceptor_lattice(eye, connectome):
    """Hexal i samples the pixel of photoreceptor column (u_i, v_i) in every R type."""
    u_all, v_all = connectome.nodes.u[:], connectome.nodes.v[:]
    centers = eye.box.receptor_centers.cpu().numpy()  # (row, col) offsets from canvas centre
    k = eye.kernel_size
    for cell_type in (_decode(t) for t in connectome.input_cell_types[:]):
        nodes = connectome.nodes.layer_index[cell_type][:]
        u, v = u_all[nodes], v_all[nodes]
        np.testing.assert_array_equal(centers[:, 1], k * v)  # column: +v is image-right
        np.testing.assert_array_equal(centers[:, 0], np.trunc(k * (u + v / 2)).astype(int))  # row: down
    np.testing.assert_array_equal(eye.hex_col, v_all[connectome.nodes.layer_index["R1"][:]])


def test_upstream_stimulus_angles_are_our_image_angles(connectome):
    """Upstream's preferred-direction labels are in moving-edge angles rendered by HexEye.

    Render upstream HexEye bars at two offsets for each angle and measure where the
    bar moves in our BoxEye image frame (x = v right, y = u + v/2 down): angle 0 must
    move right, 90 up, 180 left and 270 down. Small ppo keeps memory low.
    """
    from flyvis.datasets.rendering import HexEye
    from flyvis.utils.hex_utils import get_hex_coords

    u, v = (np.asarray(a) for a in get_hex_coords(15))
    receptors = connectome.nodes.layer_index["R1"][:]
    np.testing.assert_array_equal(u, connectome.nodes.u[:][receptors])
    np.testing.assert_array_equal(v, connectome.nodes.v[:][receptors])
    x, y = v.astype(float), u + v / 2.0

    hexeye = HexEye(721, ppo=3, dtype=torch.float32)
    led = np.radians(2.25)
    expected = {0: (1.0, 0.0), 90: (0.0, -1.0), 180: (-1.0, 0.0), 270: (0.0, 1.0)}
    for angle, direction in expected.items():
        centroids = []
        for offset in (-6, 6):  # increasing offset = forward motion of upstream's bar
            bar = hexeye.render_bar(
                bar_width_rad=4 * led, bar_height_rad=60 * led,
                bar_loc_theta=np.radians(90) + offset * led, bar_loc_phi=np.radians(90),
                n_bars=1, bar_intensity=1.0, bg_intensity=0.0, moving_angle=angle,
            )
            w = np.clip(bar.cpu().numpy().ravel(), 0, None)
            centroids.append(((w * x).sum() / w.sum(), (w * y).sum() / w.sum()))
        motion = np.subtract(centroids[1], centroids[0])
        assert motion @ np.array(direction) > 0.95 * np.linalg.norm(motion), (angle, motion)


def test_constant_frame_gives_constant_input(eye):
    """Box filter is a true mean and the crop margin keeps zero padding out."""
    for shape in ((480, 640), (417, 417), (120, 90)):
        hexals = eye(np.full(shape, 0.3, dtype=np.float32))
        np.testing.assert_allclose(hexals.numpy(), 0.3, atol=1e-6)


def test_left_and_top_of_image_reach_left_and_top_columns(eye):
    """Orientation: image-left -> columns v < 0, image-top -> negative row offset."""
    x, y = crop_coordinates(300, 300)
    left = np.where(x < -1 / 6, 1.0, 0.0).astype(np.float32)
    top = np.where(y < -1 / 6, 1.0, 0.0).astype(np.float32)

    h_left = eye(left).numpy()
    assert h_left[eye.hex_col <= -6].mean() > 0.95
    assert h_left[eye.hex_col >= 0].max() < 0.05

    h_top = eye(top).numpy()
    assert h_top[eye.hex_y < -0.45].mean() > 0.95
    assert h_top[eye.hex_y > 0].max() < 0.05


def test_landscape_frame_uses_centred_square_crop(eye):
    """Pixels outside the central min(H, W) square never reach the lattice."""
    frame = np.zeros((480, 640), dtype=np.float32)
    frame[:, :80] = 1.0  # left margin, outside the 480 x 480 crop
    frame[:, -80:] = 1.0  # right margin
    assert eye(frame).abs().max().item() < 1e-6
    frame[:, 80:110] = 1.0  # first 30 columns inside the crop
    hexals = eye(frame).numpy()
    assert hexals[eye.hex_col == -15].min() > 0.95  # leftmost lattice column sees it
    assert hexals[eye.hex_col >= -13].max() < 0.05  # nothing further right does


def test_same_scene_at_different_resolutions_gives_same_input(eye):
    """The field of view is set by the crop, not by camera resolution."""

    def scene(h, w):
        x, y = crop_coordinates(h, w)
        return (0.5 + 0.3 * np.sin(2 * np.pi * 1.5 * x) * np.cos(2 * np.pi * y)).astype(np.float32)

    low, high = eye(scene(240, 320)), eye(scene(960, 1280))
    assert (low - high).abs().max().item() < 0.02


def test_rejects_invalid_frames(eye):
    with pytest.raises(TypeError):
        eye(np.zeros((32, 32), dtype=np.uint8))  # 0..255 images must be converted first
    with pytest.raises(ValueError):
        eye(np.full((32, 32), 1.5, dtype=np.float32))
    with pytest.raises(ValueError):
        eye(np.full((32, 32), np.nan, dtype=np.float32))
    with pytest.raises(ValueError):
        eye(np.zeros((32, 32, 3), dtype=np.float32))


def test_rgb_to_luma_matches_pil_convert_l():
    """Training luminance was PIL convert('L') / 255; the helper reproduces it."""
    from PIL import Image

    rgb = np.random.default_rng(1).integers(0, 256, size=(17, 23, 3), dtype=np.uint8)
    expected = np.asarray(Image.fromarray(rgb, "RGB").convert("L"), dtype=np.float32) / 255
    np.testing.assert_allclose(rgb_to_luma601(rgb), expected, atol=1 / 255 + 1e-6)
