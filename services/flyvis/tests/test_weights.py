"""Weights provenance and refusal paths.

Scope: weights.manifest.json against the cached files, upstream's published archive
checksum and upstream's independently recorded checkpoint hash; and load_network's
behaviour when the checkpoint is missing or does not match the manifest.
"""

from __future__ import annotations

import json

import pytest

from flyvis_service import config, model, weights


@pytest.fixture(scope="module")
def manifest():
    if not model.weights_available():
        pytest.skip("FlyVis pretrained weights not found under models/cache/flyvis (run setup.sh)")
    return json.loads(config.WEIGHTS_MANIFEST.read_text())


def test_manifest_matches_cache_and_upstream_records(manifest):
    pinned = manifest["network"]
    checkpoint = config.cache_dir() / pinned["checkpoint"]
    actual = weights.sha256_file(checkpoint)
    upstream_archive = weights.upstream_download_constants()["checksums"][weights.ARCHIVE_NAME]
    recorded = model.upstream_recorded_checkpoint(pinned["name"])

    assert actual == pinned["checkpoint_sha256"]
    assert manifest["archive"]["sha256"] == upstream_archive  # upstream-published checksum
    assert recorded is not None and recorded["sha256"] == actual  # upstream responses_norm.h5
    assert pinned["checkpoint"] == model.resolve_upstream_best_checkpoint(pinned["name"])["relative_path"]


def _write_manifest(tmp_path, monkeypatch, mutate):
    data = json.loads(config.WEIGHTS_MANIFEST.read_text())
    mutate(data)
    path = tmp_path / "weights.manifest.json"
    path.write_text(json.dumps(data))
    monkeypatch.setattr(config, "WEIGHTS_MANIFEST", path)


def test_load_refuses_checkpoint_with_unexpected_hash(manifest, tmp_path, monkeypatch):
    def tamper(data):
        data["network"]["checkpoint_sha256"] = "0" * 64

    _write_manifest(tmp_path, monkeypatch, tamper)
    with pytest.raises(model.ChecksumMismatch):
        model.load_network(manifest["network"]["name"])


def test_load_reports_missing_weights(manifest, tmp_path, monkeypatch):
    def relocate(data):
        data["network"]["checkpoint"] = "results/does-not-exist/chkpt_00000"

    _write_manifest(tmp_path, monkeypatch, relocate)
    assert not model.weights_available(manifest["network"]["name"])
    with pytest.raises(model.WeightsUnavailable):
        model.load_network(manifest["network"]["name"])


def test_load_refuses_a_network_the_manifest_does_not_pin(manifest):
    with pytest.raises(model.WeightsUnavailable):
        model.load_network("flow/0000/001")
