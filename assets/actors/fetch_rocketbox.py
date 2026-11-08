"""Fetch the pinned Microsoft Rocketbox files for the interim occupant (standard library only).

    python3 -I assets/actors/fetch_rocketbox.py [--cache assets/cache/characters/rocketbox]

Downloads only the individual files listed in occupant_sources.json from the pinned commit
(raw.githubusercontent.com; these files are not stored in Git LFS) and verifies each SHA-256.
Existing files with the right hash are kept. Never clones the ~4 GB repository.
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", default=os.path.join(ROOT, "assets", "cache", "characters", "rocketbox"))
    args = parser.parse_args()
    with open(os.path.join(HERE, "occupant_sources.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    base = "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/" + manifest["commit"] + "/"
    failures = 0
    for entry in manifest["files"]:
        dest = os.path.join(args.cache, entry["path"])
        if os.path.exists(dest) and sha256(dest) == entry["sha256"]:
            print("ok     ", entry["path"])
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        url = base + urllib.parse.quote(entry["repoPath"])
        tmp = dest + ".part"
        with urllib.request.urlopen(url, timeout=120) as response, open(tmp, "wb") as out:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        got = sha256(tmp)
        if got != entry["sha256"]:
            os.remove(tmp)
            print("BAD    ", entry["path"], got, file=sys.stderr)
            failures += 1
            continue
        os.replace(tmp, dest)
        print("fetched", entry["path"])
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
