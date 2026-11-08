"""Load one specific pretrained FlyVis network from a pinned, hash-verified checkpoint.

Upstream reference: ``flyvis/network/network_view.py`` (``NetworkView``,
``CheckpointedNetwork``) and ``flyvis/utils/chkpt_utils.py`` (``recover_network``,
``best_checkpoint_default_fn``) at commit 0a69fa2f (MIT). Differences from upstream:

* The checkpoint is the *resolved file* recorded in ``weights.manifest.json`` and its
  SHA-256 is checked before loading. Upstream resolves the moving name "best" each
  time.
* The file is read with ``torch.load(weights_only=True)`` (restricted unpickler) and
  the resulting dict is handed to upstream ``recover_network``. Upstream calls
  ``torch.load(weights_only=False)``, which can execute code embedded in a pickle.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config

config.configure_flyvis_root()

import torch  # noqa: E402
import yaml  # noqa: E402

import flyvis  # noqa: E402
from flyvis.network.network import Network  # noqa: E402
from flyvis.utils.chkpt_utils import (  # noqa: E402
    best_checkpoint_default_fn,
    checkpoint_index_to_path_map,
    recover_network,
)

# NetworkView's default rule for "best" at the pinned commit.
_BEST_KWARGS = {"validation_subdir": "validation", "loss_file_name": "epe"}


class WeightsUnavailable(RuntimeError):
    """The pretrained weights are not in the cache (run setup.sh / weights fetch)."""


class ChecksumMismatch(RuntimeError):
    """A checkpoint on disk does not match the hash recorded in the manifest."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def network_dir(network_name: str = config.DEFAULT_NETWORK) -> Path:
    return Path(flyvis.results_dir) / network_name


def resolve_upstream_best_checkpoint(network_name: str = config.DEFAULT_NETWORK) -> Dict[str, Any]:
    """Resolve upstream's moving name "best" to a concrete file, as NetworkView does."""
    path = network_dir(network_name)
    if not (path / "_meta.yaml").exists():
        raise WeightsUnavailable(f"no pretrained network at {path}")
    chkpt_dir = path / "chkpts"
    indices, paths = checkpoint_index_to_path_map(chkpt_dir, glob="chkpt_*")
    best = Path(best_checkpoint_default_fn(path, **_BEST_KWARGS))
    return {
        "path": best,
        "relative_path": str(best.relative_to(config.cache_dir())),
        "index": int(indices[[Path(p) for p in paths].index(best)]),
        "available": [str(Path(p).relative_to(config.cache_dir())) for p in paths],
        "rule": (
            "flyvis.utils.chkpt_utils.best_checkpoint_default_fn(validation_subdir='validation', "
            "loss_file_name='epe'): argmin of the recorded validation loss over chkpts/chkpt_*. "
            "These archives store validation/loss.h5 only, so upstream falls back to 'loss'."
        ),
    }


def network_files(network_name: str = config.DEFAULT_NETWORK) -> List[Dict[str, Any]]:
    root = network_dir(network_name)
    files = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() and "__cache__" not in p.parts):
        files.append(
            {
                "path": str(path.relative_to(config.cache_dir())),
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            }
        )
    return files


def upstream_recorded_checkpoint(network_name: str = config.DEFAULT_NETWORK) -> Optional[Dict[str, str]]:
    """Checkpoint name and SHA-256 that upstream recorded for a released model.

    Upstream v1.2.0 ships ``flyvis/data/responses_norm.h5`` with, per ensemble member,
    the checkpoint and its SHA-256 the normalization constants were computed from.
    This is an independent upstream reference for the checkpoint we load.
    """
    import h5py

    path = Path(flyvis.package_dir) / "data" / "responses_norm.h5"
    ensemble, _, member = network_name.rpartition("/")
    if not path.exists() or not ensemble:
        return None

    def _text(value: Any) -> str:
        return value.decode() if isinstance(value, bytes) else str(value)

    with h5py.File(path, "r") as handle:
        if ensemble not in handle:
            return None
        group = handle[ensemble]
        names = [_text(x) for x in group["model_names"][:]]
        if network_name not in names:
            return None
        i = names.index(network_name)
        return {
            "source": f"flyvis/data/responses_norm.h5 (package data at commit {config.FLYVIS_COMMIT[:8]})",
            "checkpoint": _text(group["checkpoints"][i]),
            "sha256": _text(group["checkpoint_hashes"][i]),
        }


def read_manifest() -> Optional[Dict[str, Any]]:
    if not config.WEIGHTS_MANIFEST.exists():
        return None
    return json.loads(config.WEIGHTS_MANIFEST.read_text())


@dataclass(frozen=True)
class LoadedNetwork:
    network: Network
    name: str
    checkpoint: Path
    checkpoint_sha256: str
    config: Dict[str, Any]

    @property
    def model_version(self) -> str:
        """Short identifier for UI/logs: network name + checkpoint hash prefix."""
        return f"flyvis@{config.FLYVIS_COMMIT[:8]}:{self.name}:{self.checkpoint.name}:{self.checkpoint_sha256[:12]}"


def weights_available(network_name: str = config.DEFAULT_NETWORK) -> bool:
    manifest = read_manifest()
    if manifest is None or manifest["network"]["name"] != network_name:
        return False
    return (config.cache_dir() / manifest["network"]["checkpoint"]).exists()


def load_network(network_name: str = config.DEFAULT_NETWORK) -> LoadedNetwork:
    """Build the upstream Network from its stored config and load pinned weights.

    The network is returned in eval mode with all parameters frozen.
    """
    manifest = read_manifest()
    if manifest is None:
        raise WeightsUnavailable(f"{config.WEIGHTS_MANIFEST} is missing; run setup.sh")
    pinned = manifest["network"]
    if pinned["name"] != network_name:
        raise WeightsUnavailable(
            f"manifest pins {pinned['name']!r}, not {network_name!r}; regenerate the manifest"
        )
    checkpoint = config.cache_dir() / pinned["checkpoint"]
    meta = network_dir(network_name) / "_meta.yaml"
    if not checkpoint.exists() or not meta.exists():
        raise WeightsUnavailable(f"checkpoint {checkpoint} not found; run setup.sh")
    actual = _sha256(checkpoint)
    if actual != pinned["checkpoint_sha256"]:
        raise ChecksumMismatch(
            f"{checkpoint} has SHA-256 {actual}, manifest expects {pinned['checkpoint_sha256']}"
        )

    network_config = yaml.safe_load(meta.read_text())["config"]["network"]
    network = Network(**network_config)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    recover_network(network, state, ensemble_and_network_id=network_name)
    network.eval()
    for parameter in network.parameters():
        parameter.requires_grad_(False)
    return LoadedNetwork(
        network=network,
        name=network_name,
        checkpoint=checkpoint,
        checkpoint_sha256=actual,
        config=network_config,
    )
