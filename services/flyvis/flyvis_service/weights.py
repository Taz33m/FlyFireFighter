"""Download, verify and record the upstream FlyVis pretrained weights.

Upstream (TuragaLab/flyvis, MIT) publishes its pretrained ensemble through
``flyvis download-pretrained`` (``flyvis_cli/download_pretrained_models.py``), which
lists a public Google Drive folder with the Drive v3 API and an API key embedded in
that upstream file, downloads every ZIP in the folder, checks each against a SHA-256
hard-coded upstream and unpacks it into ``FLYVIS_ROOT_DIR``.

This module follows the same path with three differences:

* it downloads only ``results_pretrained_models.zip`` (the networks); the UMAP and
  clustering archive is not needed for inference;
* it reads the folder id, key and expected checksum from the *installed upstream
  module* at run time (via ``ast``), so no key material is copied into this repository;
* it refuses archive members that would escape the cache directory, and it records
  provenance in ``services/flyvis/weights.manifest.json``.

Usage (from ``services/flyvis``)::

    .venv/bin/python -m flyvis_service.weights fetch      # download + verify + unpack
    .venv/bin/python -m flyvis_service.weights manifest   # resolve checkpoint, write manifest
    .venv/bin/python -m flyvis_service.weights verify     # re-hash against the manifest
"""

from __future__ import annotations

import argparse
import ast
import datetime as _dt
import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict

from . import config

ARCHIVE_NAME = "results_pretrained_models.zip"
DRIVE_API = "https://www.googleapis.com/drive/v3/files"
UPSTREAM_DOWNLOADER = "flyvis_cli/download_pretrained_models.py"


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def upstream_download_constants() -> Dict[str, Any]:
    """Parse folder id, API key and checksums from the installed upstream downloader.

    The module is parsed, not imported, so reading the constants has no side effects.
    """
    spec = importlib.util.find_spec("flyvis_cli.download_pretrained_models")
    if spec is None or spec.origin is None:
        raise RuntimeError("flyvis_cli is not installed in this environment")
    source_path = Path(spec.origin)
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    found: Dict[str, Any] = {"source_path": str(source_path)}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            for name in names:
                if name in {"checksums", "folder_id", "api_key"} and node.value is not None:
                    found[name] = ast.literal_eval(node.value)
    missing = {"checksums", "folder_id", "api_key"} - set(found)
    if missing:
        raise RuntimeError(f"could not find {sorted(missing)} in {source_path}")
    if ARCHIVE_NAME not in found["checksums"]:
        raise RuntimeError(f"upstream lists no checksum for {ARCHIVE_NAME}")
    return found


def _drive_get(url: str, params: Dict[str, str], stream: bool = False):
    import requests  # upstream dependency

    response = requests.get(url, params=params, stream=stream, timeout=60)
    if response.status_code != 200:
        # Never echo the request URL: it contains the API key.
        raise RuntimeError(
            f"Google Drive API returned HTTP {response.status_code}: "
            f"{response.text[:300]!r}"
        )
    return response


def list_drive_folder(constants: Dict[str, Any]) -> list:
    fields = "files(id,name,size,md5Checksum,sha256Checksum,createdTime,modifiedTime,description,webViewLink)"
    response = _drive_get(
        DRIVE_API,
        {
            "q": f"'{constants['folder_id']}' in parents and mimeType='application/zip'",
            "fields": fields,
            "key": constants["api_key"],
        },
    )
    return response.json().get("files", [])


def _safe_members(archive: zipfile.ZipFile, destination: Path) -> list:
    destination = destination.resolve()
    members = []
    for info in archive.infolist():
        name = PurePosixPath(info.filename)
        if name.is_absolute() or ".." in name.parts:
            raise RuntimeError(f"refusing unsafe archive member {info.filename!r}")
        target = (destination / Path(*name.parts)).resolve()
        if destination != target and destination not in target.parents:
            raise RuntimeError(f"archive member escapes cache: {info.filename!r}")
        # Reject symlinks stored in the archive (external_attr high bits = st_mode).
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise RuntimeError(f"refusing symlink archive member {info.filename!r}")
        members.append(info)
    return members


def fetch(force: bool = False) -> Dict[str, Any]:
    """Download, verify and unpack the pretrained-network archive into the cache."""
    root = config.cache_dir()
    downloads = root / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    archive_path = downloads / ARCHIVE_NAME
    record_path = downloads / f"{ARCHIVE_NAME}.download.json"

    constants = upstream_download_constants()
    expected = constants["checksums"][ARCHIVE_NAME]
    previous = json.loads(record_path.read_text()) if record_path.exists() else {}

    if (
        archive_path.exists()
        and not force
        and previous.get("drive_file")
        and sha256_file(archive_path) == expected
    ):
        # Verified cached archive: no network access needed.
        entry = previous["drive_file"]
        print(f"Archive already present and verified: {archive_path}")
    else:
        files = list_drive_folder(constants)
        entry = next((f for f in files if f.get("name") == ARCHIVE_NAME), None)
        if entry is None:
            raise RuntimeError(
                f"{ARCHIVE_NAME} not found in upstream Drive folder; found "
                f"{[f.get('name') for f in files]}"
            )
        tmp_path = archive_path.with_suffix(".zip.part")
        response = _drive_get(
            f"{DRIVE_API}/{entry['id']}",
            {"alt": "media", "key": constants["api_key"]},
            stream=True,
        )
        size = int(entry.get("size") or 0)
        written = 0
        with open(tmp_path, "wb") as handle:
            for block in response.iter_content(chunk_size=1 << 20):
                handle.write(block)
                written += len(block)
                if size:
                    print(f"\rDownloading {ARCHIVE_NAME}: {100 * written // size}%", end="")
        print()
        actual = sha256_file(tmp_path)
        if actual != expected:
            tmp_path.unlink(missing_ok=True)
            raise RuntimeError(
                f"SHA-256 mismatch for {ARCHIVE_NAME}: expected {expected}, got {actual}"
            )
        tmp_path.replace(archive_path)
        print(f"Checksum OK ({actual}).")

    with zipfile.ZipFile(archive_path) as archive:
        members = _safe_members(archive, root)
        archive.extractall(root, members=members)
        member_names = [m.filename for m in members]
    print(f"Unpacked {len(member_names)} archive members into {root}")

    record = {
        "archive": ARCHIVE_NAME,
        "archive_path": str(archive_path),
        "archive_sha256": sha256_file(archive_path),
        "archive_bytes": archive_path.stat().st_size,
        "upstream_expected_sha256": expected,
        "downloaded_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "drive_file": {k: v for k, v in entry.items()},
        "drive_folder_id": constants["folder_id"],
        "upstream_downloader": UPSTREAM_DOWNLOADER,
        "n_members": len(member_names),
        "license_like_members": [
            n for n in member_names if any(t in n.lower() for t in ("licen", "readme", "terms", "notice"))
        ],
    }
    # Keep the first download date if this is a re-verification of the same archive.
    if previous.get("archive_sha256") == record["archive_sha256"]:
        record["downloaded_utc"] = previous.get("downloaded_utc", record["downloaded_utc"])
    record_path.write_text(json.dumps(record, indent=2) + "\n")
    return record


def _compare_sibling_best(checkpoint: Path) -> Dict[str, Any]:
    """Record whether <network>/best_chkpt holds the same network tensors (not loaded)."""
    import torch

    sibling = checkpoint.parent.parent / "best_chkpt"
    if not sibling.exists():
        return {"present": False}
    a = torch.load(checkpoint, map_location="cpu", weights_only=True)["network"]
    b = torch.load(sibling, map_location="cpu", weights_only=True)["network"]
    same = a.keys() == b.keys() and all(torch.equal(a[k], b[k]) for k in a)
    return {
        "present": True,
        "path": str(sibling.relative_to(config.cache_dir())),
        "sha256": sha256_file(sibling),
        "identical_network_tensors": bool(same),
        "loaded": False,
    }


def write_manifest(network_name: str = config.DEFAULT_NETWORK) -> Dict[str, Any]:
    """Resolve the checkpoint the adapter loads and write weights.manifest.json."""
    from .model import network_files, resolve_upstream_best_checkpoint, upstream_recorded_checkpoint

    root = config.cache_dir()
    record_path = root / "downloads" / f"{ARCHIVE_NAME}.download.json"
    if not record_path.exists():
        raise RuntimeError("no download record; run `python -m flyvis_service.weights fetch`")
    record = json.loads(record_path.read_text())

    best = resolve_upstream_best_checkpoint(network_name)
    checkpoint_sha256 = sha256_file(best["path"])
    recorded = upstream_recorded_checkpoint(network_name)
    files = network_files(network_name)
    drive = record["drive_file"]
    manifest = {
        "schema": "flyfirefighter.flyvis.weights/1",
        "upstream": {
            "repository": "https://github.com/TuragaLab/flyvis",
            "commit": config.FLYVIS_COMMIT,
            "code_license": "MIT (license file in the upstream repository and vendor/flyvis-reference/license)",
            "download_mechanism": (
                f"{record['upstream_downloader']} at the pinned commit: Google Drive v3 API, "
                "public folder and API key embedded upstream; this service downloads only "
                f"{ARCHIVE_NAME}."
            ),
        },
        "source": {
            "drive_folder_url": f"https://drive.google.com/drive/folders/{record['drive_folder_id']}",
            "drive_file_url": f"https://drive.google.com/file/d/{drive['id']}",
            "api_media_url": f"{DRIVE_API}/{drive['id']}?alt=media (API key parameter omitted)",
            "drive_file_id": drive["id"],
            "drive_reported": {
                k: drive.get(k)
                for k in ("name", "size", "md5Checksum", "sha256Checksum", "createdTime", "modifiedTime", "description")
            },
        },
        "license": {
            "status": "UNCLEAR - no explicit license or terms found for the downloaded weights",
            "stated": [
                {
                    "text": "Data, trained models and interactive notebooks are available at https://www.github.com/TuragaLab/flyvis.",
                    "where": "Lappalainen et al., Nature 634, 1132-1140 (2024), Data availability section, doi:10.1038/s41586-024-07939-3 (article itself is CC BY 4.0; that licence covers the article, not the model files)",
                },
                {
                    "text": "MIT License ... this software and associated documentation files (the 'Software')",
                    "where": "license file of TuragaLab/flyvis at the pinned commit; covers the repository contents. The weights are not stored in the repository but in a Google Drive folder.",
                },
            ],
            "searched_without_finding_weight_terms": [
                "upstream readme.md, docs/docs/install.md, docs/docs/acknowledgements.md, docs/docs/faq.md, "
                "docs/docs/reference/flyvis_cli/download_pretrained_models.md, flyvis_cli/download_pretrained_models.py",
                "Google Drive file metadata (description field)",
                "archive member names (license_like_members below)",
            ],
            "archive_license_like_members": record.get("license_like_members", []),
            "use_restriction": "Local evaluation only until upstream states terms for the weights. Do not redistribute the archive or checkpoints.",
        },
        "archive": {
            "name": record["archive"],
            "sha256": record["archive_sha256"],
            "bytes": record["archive_bytes"],
            "upstream_expected_sha256": record["upstream_expected_sha256"],
            "sha256_matches_upstream": record["archive_sha256"] == record["upstream_expected_sha256"],
            "downloaded_utc": record["downloaded_utc"],
            "cache_path": str(Path(record["archive_path"]).relative_to(config.REPO_ROOT))
            if Path(record["archive_path"]).is_relative_to(config.REPO_ROOT)
            else record["archive_path"],
        },
        "network": {
            "name": network_name,
            "selection": "ensemble flow/0000, member 000 (upstream sorts members by task error; 000 is lowest)",
            "upstream_best_rule": best["rule"],
            "checkpoint": best["relative_path"],
            "checkpoint_sha256": checkpoint_sha256,
            "checkpoint_bytes": best["path"].stat().st_size,
            "checkpoint_index": best["index"],
            "available_checkpoints": best["available"],
            "upstream_recorded": recorded,
            "matches_upstream_recorded_sha256": bool(recorded) and recorded["sha256"] == checkpoint_sha256,
            "sibling_best_chkpt": _compare_sibling_best(best["path"]),
            "files": files,
        },
        "loading": {
            "torch_load": "weights_only=True (safe unpickler) in flyvis_service.model; upstream recover_network uses weights_only=False",
            "verified_before_load": "checkpoint SHA-256 must equal network.checkpoint_sha256 above",
        },
    }
    config.WEIGHTS_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def verify() -> bool:
    manifest = json.loads(config.WEIGHTS_MANIFEST.read_text())
    root = config.cache_dir()
    ok = True
    archive = config.REPO_ROOT / manifest["archive"]["cache_path"]
    if archive.exists():
        actual = sha256_file(archive)
        ok &= actual == manifest["archive"]["sha256"]
        print(f"archive    {'OK ' if actual == manifest['archive']['sha256'] else 'BAD'} {archive}")
    else:
        print(f"archive    missing (optional after unpacking): {archive}")
    checkpoint = root / manifest["network"]["checkpoint"]
    actual = sha256_file(checkpoint) if checkpoint.exists() else None
    ok &= actual == manifest["network"]["checkpoint_sha256"]
    print(f"checkpoint {'OK ' if actual == manifest['network']['checkpoint_sha256'] else 'BAD'} {checkpoint}")
    return bool(ok)


def main(argv: list | None = None) -> int:
    config.configure_flyvis_root()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["fetch", "manifest", "verify", "list"])
    parser.add_argument("--force", action="store_true", help="re-download even if verified")
    parser.add_argument("--network", default=config.DEFAULT_NETWORK)
    args = parser.parse_args(argv)
    if args.command == "list":
        for f in list_drive_folder(upstream_download_constants()):
            print(json.dumps(f))
        return 0
    if args.command == "fetch":
        record = fetch(force=args.force)
        print(json.dumps({k: record[k] for k in ("archive_sha256", "archive_bytes", "n_members")}, indent=2))
        return 0
    if args.command == "manifest":
        manifest = write_manifest(args.network)
        print(json.dumps(manifest["network"] | {"files": "..."}, indent=2))
        return 0
    return 0 if verify() else 1


if __name__ == "__main__":
    sys.exit(main())
