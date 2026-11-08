"""Fit the trained FlyVis readout (numpy only) from course datasets.

Reads dataset parts written by src/lib/evaluation/courses/cli/collect.ts
(datasets/generated/readout-v1/<part>/manifest.json + <run>.f32), fits small readouts from the
truth-free inputs (FlyVis T4/T5 features, efference copy, goal, quality) to the truth teacher's
(forward speed, yaw rate) labels, selects hyperparameters on VALIDATION parts only and exports
the model in schema flyfirefighter.trained-readout/1.

Candidates: ridge regression (closed form) over a lambda grid and a one-hidden-layer tanh MLP
(Adam, weight decay, early stopping on validation loss) over width/decay grids. Selection: the
lowest validation MSE on standardized outputs. The test split is never read.

    .venv/bin/python training/train_readout.py --train train-r0 [train-r1 ...] --val val-teacher \
        --out models/readout/trained-readout-v1.json [--family mlp|ridge|any]
"""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

N_LABELS = ("teacher_forward", "teacher_yaw")
SCHEMA = "flyfirefighter.trained-readout/1"
LABEL = "FlyVis flow/0000/000 + trained readout v1"


@dataclass
class Data:
    x: np.ndarray
    y: np.ndarray
    inputs: list[str]
    shards: list[dict]
    checkpoint: dict | None
    parts: list[str]


def load_parts(root: Path, parts: list[str]) -> Data:
    xs, ys, shards, inputs, checkpoint = [], [], [], None, None
    for part in parts:
        manifest = json.loads((root / part / "manifest.json").read_text())
        columns = manifest["columns"]
        n_inputs = columns.index("teacher_forward")
        if inputs is None:
            inputs = columns[:n_inputs]
        elif inputs != columns[:n_inputs]:
            raise ValueError(f"part {part} has different input columns")
        if manifest["split"] not in ("train", "validation"):
            raise ValueError(f"part {part} is from split {manifest['split']}; only train/validation may be read")
        checkpoint = checkpoint or manifest.get("checkpoint")
        for shard in manifest["shards"]:
            raw = (root / part / shard["file"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != shard["sha256"]:
                raise ValueError(f"shard {shard['file']} does not match its manifest hash")
            m = np.frombuffer(raw, dtype="<f4").reshape(-1, len(columns)).astype(np.float64)
            xs.append(m[:, :n_inputs])
            ys.append(m[:, [columns.index(c) for c in N_LABELS]])
            shards.append({**shard, "part": part, "split": manifest["split"]})
    x = np.concatenate(xs)
    y = np.concatenate(ys)
    keep = np.isfinite(x).all(axis=1) & np.isfinite(y).all(axis=1)
    return Data(x[keep], y[keep], inputs or [], shards, checkpoint, parts)


def data_hash(shards: list[dict]) -> str:
    h = hashlib.sha256()
    for s in sorted(shards, key=lambda s: (s["part"], s["file"])):
        h.update(f"{s['part']}/{s['file']}:{s['sha256']}\n".encode())
    return h.hexdigest()


def standardize(train: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mean = train.mean(axis=0)
    std = train.std(axis=0)
    std[std < 1e-6] = 1.0
    return mean, std


def fit_ridge(x: np.ndarray, y: np.ndarray, lam: float) -> list[dict]:
    xb = np.hstack([x, np.ones((len(x), 1))])
    reg = lam * np.eye(xb.shape[1])
    reg[-1, -1] = 0.0
    w = np.linalg.solve(xb.T @ xb + reg * len(x) / 1000.0, xb.T @ y)
    return [{"weights": w[:-1].T.tolist(), "bias": w[-1].tolist(), "activation": "linear"}]


def forward(layers: list[dict], x: np.ndarray) -> np.ndarray:
    h = x
    for layer in layers:
        h = h @ np.asarray(layer["weights"]).T + np.asarray(layer["bias"])
        if layer["activation"] == "tanh":
            h = np.tanh(h)
        elif layer["activation"] == "relu":
            h = np.maximum(h, 0.0)
    return h


def fit_mlp(x, y, xv, yv, hidden: int, decay: float, seed: int = 0, epochs: int = 200, batch: int = 256, lr: float = 2e-3):
    rng = np.random.default_rng(seed)
    n_in, n_out = x.shape[1], y.shape[1]
    params = {
        "w1": rng.normal(0, 1 / np.sqrt(n_in), (hidden, n_in)), "b1": np.zeros(hidden),
        "w2": rng.normal(0, 1 / np.sqrt(hidden), (n_out, hidden)), "b2": np.zeros(n_out),
    }
    m = {k: np.zeros_like(v) for k, v in params.items()}
    v = {k: np.zeros_like(val) for k, val in params.items()}
    best, best_loss, patience, step = None, np.inf, 0, 0
    for epoch in range(epochs):
        rate = lr * 0.98 ** epoch
        order = rng.permutation(len(x))
        for start in range(0, len(x), batch):
            idx = order[start:start + batch]
            xb, yb = x[idx], y[idx]
            h = np.tanh(xb @ params["w1"].T + params["b1"])
            out = h @ params["w2"].T + params["b2"]
            g_out = 2 * (out - yb) / len(idx) / n_out
            grads = {"w2": g_out.T @ h + decay * params["w2"], "b2": g_out.sum(0)}
            g_h = (g_out @ params["w2"]) * (1 - h ** 2)
            grads["w1"] = g_h.T @ xb + decay * params["w1"]
            grads["b1"] = g_h.sum(0)
            step += 1
            for k in params:
                m[k] = 0.9 * m[k] + 0.1 * grads[k]
                v[k] = 0.999 * v[k] + 0.001 * grads[k] ** 2
                params[k] -= rate * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(v[k] / (1 - 0.999 ** step)) + 1e-8)
        layers = to_layers(params)
        loss = float(np.mean((forward(layers, xv) - yv) ** 2))
        if loss < best_loss - 1e-5:
            best, best_loss, patience = layers, loss, 0
        else:
            patience += 1
            if patience >= 20:
                break
    return best


def to_layers(p) -> list[dict]:
    return [
        {"weights": p["w1"].tolist(), "bias": p["b1"].tolist(), "activation": "tanh"},
        {"weights": p["w2"].tolist(), "bias": p["b2"].tolist(), "activation": "linear"},
    ]


def r2(pred: np.ndarray, y: np.ndarray) -> list[float]:
    return [float(1 - np.sum((pred[:, i] - y[:, i]) ** 2) / max(np.sum((y[:, i] - y[:, i].mean()) ** 2), 1e-12)) for i in range(y.shape[1])]


def mask_layers(layers: list[dict], masked: list[int]) -> list[dict]:
    """Zero the first-layer weights of masked inputs, so the deployed model provably ignores them."""
    first = np.asarray(layers[0]["weights"])
    first[:, masked] = 0.0
    return [{**layers[0], "weights": first.tolist()}, *layers[1:]]


def train(root: Path, train_parts: list[str], val_parts: list[str], family: str = "any", mask: tuple[str, ...] = ()) -> tuple[dict, list[dict]]:
    tr = load_parts(root, train_parts)
    va = load_parts(root, val_parts)
    if {s["split"] for s in tr.shards} != {"train"} or {s["split"] for s in va.shards} != {"validation"}:
        raise ValueError("training parts must be train-split only and validation parts validation-split only")
    xm, xs = standardize(tr.x)
    ym, ys = standardize(tr.y)
    unknown = [name for name in mask if name not in tr.inputs]
    if unknown:
        raise ValueError(f"unknown masked inputs: {unknown}")
    masked = [tr.inputs.index(name) for name in mask]
    xt, yt = (tr.x - xm) / xs, (tr.y - ym) / ys
    xv, yv = (va.x - xm) / xs, (va.y - ym) / ys
    xt[:, masked] = 0.0
    xv[:, masked] = 0.0
    candidates = []
    if family in ("any", "ridge"):
        for lam in (1e-3, 1e-2, 1e-1, 1.0, 10.0, 100.0):
            candidates.append({"name": f"ridge-l{lam:g}", "layers": fit_ridge(xt, yt, lam)})
    if family in ("any", "mlp"):
        for hidden in (16, 32, 64):
            for decay in (1e-4, 1e-3, 1e-2):
                candidates.append({"name": f"mlp-h{hidden}-d{decay:g}", "layers": fit_mlp(xt, yt, xv, yv, hidden, decay)})
    for c in candidates:
        c["layers"] = mask_layers(c["layers"], masked)
        pv = forward(c["layers"], xv)
        pt = forward(c["layers"], xt)
        c["valMse"] = float(np.mean((pv - yv) ** 2))
        c["trainMse"] = float(np.mean((pt - yt) ** 2))
        c["valR2"] = r2(pv, yv)
    best = min(candidates, key=lambda c: c["valMse"])
    probe = va.x[np.linspace(0, len(va.x) - 1, 5).astype(int)]
    expected = forward(best["layers"], (probe - xm) / xs) * ys + ym
    model = {
        "schema": SCHEMA, "id": "trained-readout-v1", "label": LABEL,
        "checkpoint": {"name": (tr.checkpoint or {}).get("name", "flow/0000/000"), "sha256": (tr.checkpoint or {}).get("checkpointSha256", "")},
        "inputs": tr.inputs, "outputs": ["forwardMps", "yawRateRadps"],
        "featureConfig": {"emaAlpha": 0.25, "goalDistanceCapM": 4},
        "normalization": {"mean": xm.tolist(), "std": xs.tolist()},
        "outputScale": {"mean": ym.tolist(), "std": ys.tolist()},
        "layers": best["layers"],
        "training": {
            "selected": best["name"], "maskedInputs": list(mask), "selection": "lowest validation MSE (standardized outputs); validation parts only",
            "dataHash": data_hash(tr.shards), "valDataHash": data_hash(va.shards),
            "trainParts": train_parts, "valParts": val_parts, "trainRows": int(len(tr.x)), "valRows": int(len(va.x)),
            "trainCourses": sorted({s["courseId"] for s in tr.shards}), "valCourses": sorted({s["courseId"] for s in va.shards}),
            "candidates": [{k: c[k] for k in ("name", "valMse", "trainMse", "valR2")} for c in candidates],
            "selfCheck": {"inputs": probe.tolist(), "outputs": expected.tolist(), "note": "numpy forward pass on raw inputs; the TS test must reproduce it"},
            "labels": "truth teacher (src/lib/evaluation/courses/teacher.ts); teacher truth is never a model input",
        },
    }
    return model, candidates


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default="datasets/generated/readout-v1")
    parser.add_argument("--train", nargs="+", required=True)
    parser.add_argument("--val", nargs="+", required=True)
    parser.add_argument("--family", default="any", choices=("any", "ridge", "mlp"))
    parser.add_argument("--splits", help="splits.json with the fixed seed lists, embedded in the export")
    parser.add_argument("--mask", default="", help="comma-separated input names the model must ignore (zero weights)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    model, candidates = train(Path(args.root), args.train, args.val, args.family, tuple(n for n in args.mask.split(",") if n))
    if args.splits:
        model["training"]["seedLists"] = json.loads(Path(args.splits).read_text())
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(model, indent=1) + "\n")
    for c in sorted(candidates, key=lambda c: c["valMse"]):
        print(f"{c['name']:>18}  val {c['valMse']:.4f}  train {c['trainMse']:.4f}  R2 fwd {c['valR2'][0]:.3f} yaw {c['valR2'][1]:.3f}")
    print(f"selected {model['training']['selected']} -> {args.out} (data {model['training']['dataHash'][:12]}, {model['training']['trainRows']} rows)")


if __name__ == "__main__":
    main()
