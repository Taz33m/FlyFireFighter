"""Shared fixtures. One network instance per test session (shared 16 GB Mac)."""

from __future__ import annotations

import pytest

from flyvis_service import config as service_config

service_config.configure_flyvis_root()

import torch  # noqa: E402

torch.set_num_threads(min(4, torch.get_num_threads()))

SKIP_REASON = (
    "FlyVis pretrained weights not found under models/cache/flyvis "
    "(run services/flyvis/setup.sh to download and verify them)"
)


def pytest_report_header(config):
    from flyvis_service.model import weights_available

    present = weights_available()
    return [
        f"flyvis commit {service_config.FLYVIS_COMMIT}, torch {torch.__version__}, "
        f"threads {torch.get_num_threads()}",
        f"weights cache {service_config.cache_dir()} "
        f"({'present' if present else 'ABSENT - weight-dependent tests will be skipped'})",
    ]


@pytest.fixture(scope="session")
def runtime():
    """The stateful adapter around the pinned pretrained network (skips without weights)."""
    from flyvis_service.model import weights_available

    if not weights_available():
        pytest.skip(SKIP_REASON)
    from flyvis_service.stateful import StatefulFlyVis

    return StatefulFlyVis()


@pytest.fixture(scope="session")
def connectome(request):
    """Compiled upstream connectome; reuses the runtime's when weights are present."""
    from flyvis_service.model import weights_available

    if weights_available():
        return request.getfixturevalue("runtime").network.connectome
    from flyvis.connectome import ConnectomeFromAvgFilters

    return ConnectomeFromAvgFilters(file="fib25-fib19_v2.2.json", extent=15, n_syn_fill=1)
