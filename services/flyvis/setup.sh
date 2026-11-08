#!/usr/bin/env bash
# Reproducible setup for services/flyvis:
#   1. Python 3.11 virtual environment at services/flyvis/.venv (git-ignored)
#   2. exact packages from requirements.lock (flyvis pinned to commit 0a69fa2f)
#   3. upstream pretrained weights into models/cache/flyvis (git-ignored), checked
#      against upstream's published SHA-256 and against weights.manifest.json
#   The lock includes websockets==17.4 for the WebSocket service
#   (.venv/bin/python -m flyvis_service.server, 127.0.0.1:3201).
#
# Usage: services/flyvis/setup.sh [--refresh-manifest]
#   --refresh-manifest  rewrite weights.manifest.json from the cache instead of
#                       verifying the cache against the committed manifest.
# Environment: FLYFIREFIGHTER_FLYVIS_CACHE overrides the weights cache directory.
# Network access: GitHub/PyPI for packages; Google Drive API for the weights archive
# (skipped when a verified archive is already cached). No credentials are required.
set -euo pipefail

cd "$(dirname "$0")"
PYTHON_VERSION="3.11.12"
VENV=".venv"

if command -v uv >/dev/null 2>&1; then
  if [ ! -x "$VENV/bin/python" ]; then
    # uv-managed interpreter; avoids picking up an incompatible system Python.
    UV_PYTHON_PREFERENCE=only-managed uv venv --python "$PYTHON_VERSION" "$VENV"
  fi
  uv pip install --python "$VENV/bin/python" -r requirements.lock
else
  PY="${PYTHON:-python3.11}"
  echo "uv not found; falling back to $PY -m venv + pip" >&2
  if [ ! -x "$VENV/bin/python" ]; then
    "$PY" -m venv "$VENV"
  fi
  "$VENV/bin/python" -m pip install -r requirements.lock
fi

"$VENV/bin/python" - <<'PY'
import sys
assert sys.version_info[:2] == (3, 11), f"expected Python 3.11, got {sys.version}"
from importlib.metadata import version
assert version("websockets") == "17.4", f"websockets {version('websockets')} != 17.4 (requirements.lock)"
print(f"python {sys.version.split()[0]}, torch {version('torch')}, flyvis {version('flyvis')}, websockets {version('websockets')}")
PY

"$VENV/bin/python" -m flyvis_service.weights fetch
if [ "${1:-}" = "--refresh-manifest" ] || [ ! -f weights.manifest.json ]; then
  "$VENV/bin/python" -m flyvis_service.weights manifest
fi
"$VENV/bin/python" -m flyvis_service.weights verify

echo "Setup complete. Tests: (cd services/flyvis && .venv/bin/python -m pytest)"
echo "Service:  (cd services/flyvis && .venv/bin/python -m flyvis_service.server)  # ws://127.0.0.1:3201"
