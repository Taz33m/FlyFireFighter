"""Paths and pinned constants for the FlyVis service.

FlyVis reads ``FLYVIS_ROOT_DIR`` once, at import time, to decide where downloaded
models and compiled connectome caches live. :func:`configure_flyvis_root` must
therefore run before the first ``import flyvis`` in the process; every module in this
package that touches FlyVis calls it first.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

#: Upstream TuragaLab/flyvis commit this service is pinned to (MIT licensed code).
FLYVIS_COMMIT = "0a69fa2fc8e1bfe1d837d722c252ab5f5d6fcbfa"

#: Pretrained network loaded by default: ensemble ``flow/0000`` member ``000``.
#: Upstream sorts ensemble members by task error, so ``000`` has the lowest error.
DEFAULT_NETWORK = "flow/0000/000"

#: Integration and frame step of the visual loop (50 Hz simulated input).
DT = 0.02

SERVICE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_DIR.parents[1]
WEIGHTS_MANIFEST = SERVICE_DIR / "weights.manifest.json"

#: Override with FLYFIREFIGHTER_FLYVIS_CACHE; the default is git-ignored (models/cache/).
CACHE_ENV = "FLYFIREFIGHTER_FLYVIS_CACHE"


def cache_dir() -> Path:
    """Directory that FlyVis uses as its data root (weights, connectome cache)."""
    override = os.environ.get(CACHE_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return (REPO_ROOT / "models" / "cache" / "flyvis").resolve()


def configure_flyvis_root() -> Path:
    """Point FlyVis at our cache before it is imported, and verify afterwards.

    Raises:
        RuntimeError: if FlyVis was already imported with a different data root, in
            which case weights could be read from (or written to) another location.
    """
    root = cache_dir()
    if "flyvis" in sys.modules:
        imported_root = Path(sys.modules["flyvis"].root_dir).resolve()
        if imported_root != root:
            raise RuntimeError(
                f"flyvis was imported with root_dir={imported_root}, expected {root}. "
                "Import flyvis_service before flyvis."
            )
        return root
    root.mkdir(parents=True, exist_ok=True)
    os.environ["FLYVIS_ROOT_DIR"] = str(root)
    return root
