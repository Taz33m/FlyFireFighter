"""T4/T5 motion features pooled into left / center / right image sectors.

Cell populations are selected by *name* from the checkpoint's connectome metadata
(``connectome.nodes.layer_index[<type>]`` and ``connectome.nodes.u/v``); no neuron
indices are hard-coded. Each cell's horizontal image position is the BoxEye sampling
position of the photoreceptor column with the same ``(u, v)`` coordinate (columnar
cells share the photoreceptor lattice).

Feature definitions (per step)
    ``responses[type] = [left, center, right]``
        Mean rectified membrane voltage ``relu(v)`` of the cells of ``type`` whose column
        lies in that sector. Rectification follows upstream's decoders
        (``flyvis/task/decoder.py``: "outputs of the dvs-model are rectified potentials").
        Units are the model's arbitrary voltage units.
    Sectors
        The ``2*extent + 1`` image columns are split into thirds by count: for extent
        15 that is 10 | 11 | 10 columns, i.e. lattice column v <= -6 (left), -5..5
        (center), >= 6 (right), giving 205 / 311 / 205 cells per type. Means, not sums,
        so sector size does not bias the features.
    ``baseline``
        ``responses`` evaluated on the run's initial (warm-up) state; constant per run.
    ``horizontal_motion = [left, center, right]``
        Opponent signal: mean over the rightward-preferring types minus mean over the
        leftward-preferring types, each taken relative to ``baseline``. The direction
        labels come from upstream's ground-truth table
        (``flyvis.utils.groundtruth_utils.preferred_directions``: 0 deg = T4b/T5b,
        180 deg = T4a/T5a). tests/test_direction.py checks that this labelling holds in
        our image frame for this checkpoint. Positive = net rightward image motion.
    ``expansion = (horizontal_motion[right] - horizontal_motion[left]) / 2``
        Positive when the right sector reports rightward and the left sector leftward
        motion (expansion about the image centre, e.g. approach or looming); negative for
        contraction. A heuristic integration feature, not a trained or calibrated
        time-to-contact estimate.
"""

from __future__ import annotations

from typing import Dict, List, Sequence

import numpy as np

from . import config

config.configure_flyvis_root()

import torch  # noqa: E402

from flyvis.utils.groundtruth_utils import preferred_directions  # noqa: E402

from .eye import CameraEye  # noqa: E402

MOTION_TYPES = ("T4a", "T4b", "T4c", "T4d", "T5a", "T5b", "T5c", "T5d")
SECTORS = ("left", "center", "right")


def _decode(value) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


class MotionFeatures:
    """Pool T4a-d / T5a-d activity into sectors; build from a compiled connectome."""

    def __init__(self, connectome, eye: CameraEye, cell_types: Sequence[str] = MOTION_TYPES):
        nodes = connectome.nodes
        layer_index = {k: np.asarray(v[:]) for k, v in nodes.layer_index.items()}
        missing = [t for t in cell_types if t not in layer_index]
        if missing:
            raise KeyError(f"cell types {missing} not present in connectome")
        u_all = np.asarray(nodes.u[:])
        v_all = np.asarray(nodes.v[:])

        # Photoreceptor order == BoxEye hexal order (validated in tests); map (u, v) to
        # that hexal's horizontal sampling position.
        receptor_type = _decode(connectome.input_cell_types[0])
        receptors = layer_index[receptor_type]
        hexal_of = {(int(u_all[n]), int(v_all[n])): i for i, n in enumerate(receptors)}
        n_columns = 2 * eye.extent + 1
        side = n_columns // 3
        edge = eye.extent + 1 - side  # extent 15 -> side 10, left v <= -6, right v >= 6
        self.sector_columns = {
            "left": (-eye.extent, -edge),
            "center": (-edge + 1, edge - 1),
            "right": (edge, eye.extent),
        }

        self.cell_types = tuple(cell_types)
        self.sector_counts: Dict[str, List[int]] = {}
        rows, columns, weights = [], [], []
        gather: List[np.ndarray] = []
        offset = 0
        for t_i, cell_type in enumerate(self.cell_types):
            cells = layer_index[cell_type]
            try:
                hexals = np.array([hexal_of[(int(u_all[n]), int(v_all[n]))] for n in cells])
            except KeyError as error:
                raise ValueError(f"{cell_type} has a column outside the photoreceptor lattice") from error
            column = eye.hex_col[hexals]
            masks = (column <= -edge, np.abs(column) < edge, column >= edge)
            self.sector_counts[cell_type] = [int(m.sum()) for m in masks]
            for s_i, mask in enumerate(masks):
                if not mask.any():
                    raise ValueError(f"{cell_type} has no cells in sector {SECTORS[s_i]}")
                cols = offset + np.nonzero(mask)[0]
                rows.extend([t_i * len(SECTORS) + s_i] * len(cols))
                columns.extend(cols.tolist())
                weights.extend([1.0 / mask.sum()] * len(cols))
            gather.append(cells)
            offset += len(cells)

        self._gather = torch.as_tensor(np.concatenate(gather), dtype=torch.long, device="cpu")
        pool = torch.zeros(len(self.cell_types) * len(SECTORS), offset, dtype=torch.float32, device="cpu")
        pool[torch.as_tensor(rows), torch.as_tensor(columns)] = torch.as_tensor(weights, dtype=torch.float32)
        self._pool = pool

        rightward = [t for t in self.cell_types if preferred_directions.get(t) == 0]
        leftward = [t for t in self.cell_types if preferred_directions.get(t) == 180]
        if not rightward or not leftward:
            raise ValueError("need both rightward- and leftward-preferring types for opponency")
        self.rightward_types = tuple(rightward)
        self.leftward_types = tuple(leftward)
        self._right_rows = [self.cell_types.index(t) for t in rightward]
        self._left_rows = [self.cell_types.index(t) for t in leftward]
        self.baseline = np.zeros((len(self.cell_types), len(SECTORS)), dtype=np.float64)

    def pool(self, activity: torch.Tensor) -> np.ndarray:
        """(n_nodes,) voltages -> (n_types, 3) sector means of relu(voltage)."""
        selected = torch.relu(activity.to("cpu", torch.float32).index_select(-1, self._gather))
        pooled = self._pool @ selected
        return pooled.reshape(len(self.cell_types), len(SECTORS)).double().numpy()

    def set_baseline(self, activity: torch.Tensor) -> None:
        self.baseline = self.pool(activity)

    def __call__(self, activity: torch.Tensor) -> Dict[str, object]:
        responses = self.pool(activity)
        delta = responses - self.baseline
        horizontal = delta[self._right_rows].mean(axis=0) - delta[self._left_rows].mean(axis=0)
        return {
            "responses": {t: responses[i].tolist() for i, t in enumerate(self.cell_types)},
            "horizontal_motion": horizontal.tolist(),
            "expansion": float((horizontal[2] - horizontal[0]) / 2.0),
        }

    def describe(self) -> Dict[str, object]:
        return {
            "cell_types": list(self.cell_types),
            "sectors": list(SECTORS),
            "sector_rule": "image columns split into thirds by count (inclusive column ranges)",
            "sector_columns": self.sector_columns,
            "sector_counts": self.sector_counts,
            "response": "mean relu(membrane voltage) per type and sector",
            "rightward_types": list(self.rightward_types),
            "leftward_types": list(self.leftward_types),
            "baseline": {t: self.baseline[i].tolist() for i, t in enumerate(self.cell_types)},
        }
