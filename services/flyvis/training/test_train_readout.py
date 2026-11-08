"""Tests for training/train_readout.py on synthetic dataset parts (no FlyVis, no simulator).

Scope: shard loading and hash verification, the train/validation split guard, that ridge and the MLP
recover a known input->label mapping, validation-only selection, and the exported model's schema,
shapes and self-check rows. Run: .venv/bin/python -m pytest training/test_train_readout.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import train_readout as tr  # noqa: E402

INPUTS = [f"in_{i}" for i in range(6)]
COLUMNS = INPUTS + ["teacher_forward", "teacher_yaw", "driven_by_teacher", "tick", "teacher_gap"]


def write_part(root: Path, part: str, split: str, seed: int, rows: int = 600, nonlinear: bool = False) -> None:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(rows, len(INPUTS)))
    fwd = 0.6 + 0.3 * x[:, 0] - 0.2 * x[:, 1]
    yaw = 0.8 * x[:, 2] + (0.5 * np.tanh(2 * x[:, 3]) if nonlinear else 0.4 * x[:, 3])
    m = np.column_stack([x, fwd, yaw, np.ones(rows), np.arange(rows), np.full(rows, 0.5)]).astype("<f4")
    (root / part).mkdir(parents=True)
    raw = m.tobytes()
    (root / part / "run.f32").write_bytes(raw)
    shard = {"runId": f"{part}-run", "courseId": f"{split}-c{seed}", "split": split, "driver": "teacher", "rows": rows, "file": "run.f32", "sha256": hashlib.sha256(raw).hexdigest(), "endReason": "completed", "collisions": 0}
    manifest = {"part": part, "split": split, "columns": COLUMNS, "shards": [shard], "checkpoint": {"name": "flow/0000/000", "checkpointSha256": "d" * 64}}
    (root / part / "manifest.json").write_text(json.dumps(manifest))


def test_ridge_recovers_linear_mapping_and_exports_valid_model(tmp_path: Path) -> None:
    write_part(tmp_path, "tr", "train", 1)
    write_part(tmp_path, "va", "validation", 2)
    model, candidates = tr.train(tmp_path, ["tr"], ["va"], family="ridge")
    best = min(candidates, key=lambda c: c["valMse"])
    assert best["valR2"][0] > 0.99 and best["valR2"][1] > 0.99
    assert model["schema"] == tr.SCHEMA and model["inputs"] == INPUTS
    assert len(model["normalization"]["mean"]) == len(INPUTS)
    assert np.asarray(model["layers"][0]["weights"]).shape == (2, len(INPUTS))
    assert model["training"]["trainCourses"] == ["train-c1"] and model["training"]["valCourses"] == ["validation-c2"]
    check = model["training"]["selfCheck"]
    x = np.asarray(check["inputs"])
    pred = tr.forward(model["layers"], (x - model["normalization"]["mean"]) / np.asarray(model["normalization"]["std"]))
    pred = pred * np.asarray(model["outputScale"]["std"]) + np.asarray(model["outputScale"]["mean"])
    np.testing.assert_allclose(pred, check["outputs"], rtol=1e-9)


def test_mlp_beats_ridge_on_a_nonlinear_label_and_is_selected_on_validation(tmp_path: Path) -> None:
    write_part(tmp_path, "tr", "train", 3, rows=3000, nonlinear=True)
    write_part(tmp_path, "va", "validation", 4, rows=800, nonlinear=True)
    model, candidates = tr.train(tmp_path, ["tr"], ["va"], family="any")
    ridge = min((c for c in candidates if c["name"].startswith("ridge")), key=lambda c: c["valMse"])
    mlp = min((c for c in candidates if c["name"].startswith("mlp")), key=lambda c: c["valMse"])
    assert mlp["valMse"] < ridge["valMse"]
    assert model["training"]["selected"] == min(candidates, key=lambda c: c["valMse"])["name"]
    assert model["layers"][-1]["activation"] == "linear"


def test_refuses_wrong_split_and_tampered_shards(tmp_path: Path) -> None:
    write_part(tmp_path, "tr", "train", 5)
    write_part(tmp_path, "va", "validation", 6)
    write_part(tmp_path, "te", "test", 7)
    with pytest.raises(ValueError, match="only train/validation"):
        tr.train(tmp_path, ["tr"], ["te"])
    with pytest.raises(ValueError, match="validation-split only"):
        tr.train(tmp_path, ["tr"], ["tr"])
    data = bytearray((tmp_path / "tr" / "run.f32").read_bytes())
    data[0] ^= 0xFF
    (tmp_path / "tr" / "run.f32").write_bytes(bytes(data))
    with pytest.raises(ValueError, match="does not match"):
        tr.train(tmp_path, ["tr"], ["va"])


def test_masked_inputs_get_exactly_zero_weight(tmp_path: Path) -> None:
    write_part(tmp_path, "tr", "train", 8)
    write_part(tmp_path, "va", "validation", 9)
    model, _ = tr.train(tmp_path, ["tr"], ["va"], family="any", mask=("in_0",))
    assert all(row[0] == 0.0 for row in model["layers"][0]["weights"])
    assert model["training"]["maskedInputs"] == ["in_0"]
    with pytest.raises(ValueError, match="unknown masked"):
        tr.train(tmp_path, ["tr"], ["va"], mask=("nope",))
