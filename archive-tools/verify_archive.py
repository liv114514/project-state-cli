#!/usr/bin/env python3
"""Verify the archived current source, artifacts, and delivery file list."""

from __future__ import annotations

import csv
import hashlib
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_MANIFEST = ROOT / "SOURCE-MANIFEST.csv"
DELIVERY_MANIFEST = ROOT / "DELIVERY-MANIFEST.csv"
CURRENT = ROOT / "CURRENT.json"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_rows() -> list[tuple[str, int, str]]:
    with SOURCE_MANIFEST.open("r", encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    parsed = [(row["path"], int(row["bytes"]), row["sha256"]) for row in rows]
    if len({row[0] for row in parsed}) != len(parsed):
        raise ValueError("duplicate source manifest path")
    return parsed


def aggregate(rows: list[tuple[str, int, str]]) -> str:
    result = hashlib.sha256()
    for path, size, file_hash in sorted(rows, key=lambda row: row[0].encode("utf-8")):
        result.update(path.encode("utf-8"))
        result.update(b"\0")
        result.update(str(size).encode("ascii"))
        result.update(b"\0")
        result.update(file_hash.encode("ascii"))
        result.update(b"\n")
    return result.hexdigest()


def verify_source(current: dict) -> None:
    manifest_rows = source_rows()
    source_root = ROOT / "current"
    actual_paths = {
        path.relative_to(source_root).as_posix()
        for path in source_root.rglob("*")
        if path.is_file()
    }
    listed_paths = {row[0] for row in manifest_rows}
    if actual_paths != listed_paths:
        raise ValueError("source file set differs from SOURCE-MANIFEST.csv")
    for relative, expected_size, expected_hash in manifest_rows:
        data = (source_root / Path(relative)).read_bytes()
        if len(data) != expected_size or digest(data) != expected_hash:
            raise ValueError(f"source bytes differ: {relative}")
    identity = current["source"]
    if len(manifest_rows) != identity["fileCount"]:
        raise ValueError("source file count differs from CURRENT.json")
    if aggregate(manifest_rows) != identity["aggregateSha256"]:
        raise ValueError("source aggregate differs from CURRENT.json")


def verify_artifacts(current: dict) -> None:
    for item in current["artifacts"].values():
        data = (ROOT / Path(item["path"])).read_bytes()
        if len(data) != item["bytes"] or digest(data) != item["sha256"]:
            raise ValueError(f"artifact identity differs: {Path(item['path']).name}")


def verify_delivery_manifest() -> None:
    with DELIVERY_MANIFEST.open("r", encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
    listed = {row["path"]: (int(row["bytes"]), row["sha256"]) for row in rows}
    if len(listed) != len(rows):
        raise ValueError("duplicate delivery manifest path")
    actual_files = {
        path.relative_to(ROOT).as_posix()
        for path in ROOT.rglob("*")
        if path.is_file() and path != DELIVERY_MANIFEST
    }
    if actual_files != set(listed):
        raise ValueError("delivery file set differs from DELIVERY-MANIFEST.csv")
    for relative, (expected_size, expected_hash) in listed.items():
        data = (ROOT / Path(relative)).read_bytes()
        if len(data) != expected_size or digest(data) != expected_hash:
            raise ValueError(f"delivery file bytes differ: {relative}")


def main() -> int:
    try:
        current = json.loads(CURRENT.read_bytes())
        verify_source(current)
        verify_artifacts(current)
        verify_delivery_manifest()
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"ARCHIVE_INVALID: {error}", file=sys.stderr)
        return 1
    print("ARCHIVE_VALID: source, artifacts, and delivery file set match their manifests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
