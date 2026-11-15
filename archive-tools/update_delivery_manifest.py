#!/usr/bin/env python3
"""Atomically rebuild a delivery manifest from declared archive roots."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import os
import stat
import tempfile
from pathlib import Path

ALLOWED_TOP_LEVEL = {
    "current", "tools", "candidate", "changes", "evidence",
    "README.md", "CURRENT.json", "SOURCE-MANIFEST.csv", "TEST-RESULTS.md",
    "UPDATE-PROTOCOL.md", "ARCHIVE-VERIFICATION.md", "CHANGES.md", "LICENSE",
    "DELIVERY-MANIFEST.csv",
}
SCAN_ROOTS = {"current", "tools", "candidate", "changes", "evidence"}


def collect(root: Path, output: Path, exclude: Path | None = None) -> list[tuple[str, int, str]]:
    unknown = sorted(p.name for p in root.iterdir()
                     if p.name not in ALLOWED_TOP_LEVEL and (exclude is None or p != exclude))
    if unknown:
        raise ValueError("archive contains undeclared top-level entries")
    rows: list[tuple[str, int, str]] = []
    for item in root.iterdir():
        if item == output or item == exclude:
            continue
        st = item.lstat()
        if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            raise ValueError("archive root contains a linked or reparse-point entry")
        if item.is_file():
            data = item.read_bytes()
            rows.append((item.name, len(data), hashlib.sha256(data).hexdigest()))
        elif item.is_dir() and item.name in SCAN_ROOTS:
            for path in item.rglob("*"):
                child_st = path.lstat()
                if stat.S_ISLNK(child_st.st_mode) or getattr(child_st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                    raise ValueError("archive scan root contains a linked or reparse-point entry")
                if path.is_dir():
                    continue
                if not path.is_file():
                    raise ValueError("archive scan root contains a non-regular object")
                relative = path.relative_to(root).as_posix()
                data = path.read_bytes()
                rows.append((relative, len(data), hashlib.sha256(data).hexdigest()))
    rows.sort(key=lambda row: row[0].encode("utf-8"))
    if len({row[0] for row in rows}) != len(rows):
        raise ValueError("archive contains duplicate relative paths")
    return rows


def render(rows: list[tuple[str, int, str]]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(("path", "bytes", "sha256"))
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def verify_rendered(data: bytes, expected: list[tuple[str, int, str]]) -> None:
    parsed = list(csv.reader(io.StringIO(data.decode("utf-8", errors="strict"), newline="")))
    if not parsed or parsed[0] != ["path", "bytes", "sha256"]:
        raise ValueError("generated manifest header is invalid")
    observed = []
    for row in parsed[1:]:
        if len(row) != 3 or not row[1].isdecimal() or len(row[2]) != 64:
            raise ValueError("generated manifest row is invalid")
        observed.append((row[0], int(row[1]), row[2]))
    if observed != expected:
        raise ValueError("generated manifest rows do not match inspected archive")


def update_manifest(root: Path) -> int:
    output = root / "DELIVERY-MANIFEST.csv"
    root_identity = (root.stat().st_dev, root.stat().st_ino)
    temporary: Path | None = None
    try:
        rows = collect(root, output)
        payload = render(rows)
        verify_rendered(payload, rows)
        fd, temp_name = tempfile.mkstemp(prefix=".DELIVERY-MANIFEST.csv.tmp-", dir=root)
        temporary = Path(temp_name)
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        temp_stat = temporary.lstat()
        if not stat.S_ISREG(temp_stat.st_mode) or temp_stat.st_nlink != 1:
            raise ValueError("temporary manifest identity is unsupported")
        verify_rendered(temporary.read_bytes(), rows)
        if (root.stat().st_dev, root.stat().st_ino) != root_identity:
            raise ValueError("archive root identity changed during generation")
        if collect(root, output, exclude=temporary) != rows:
            raise ValueError("archive contents changed during generation")
        os.replace(temporary, output)
        temporary = None
        print(f"WROTE {output.name}: {len(rows)} files")
        return 0
    except (OSError, ValueError) as exc:
        print(f"MANIFEST_UPDATE_REFUSED: {type(exc).__name__}")
        return 2
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=None)
    args = parser.parse_args()
    try:
        requested_root = args.root if args.root is not None else Path(__file__).absolute().parents[1]
        root = requested_root.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        print(f"MANIFEST_UPDATE_REFUSED: {type(exc).__name__}")
        return 2
    return update_manifest(root)


if __name__ == "__main__":
    raise SystemExit(main())
