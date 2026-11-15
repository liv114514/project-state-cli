from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path, *, max_bytes: int = 2_000_000) -> tuple[dict[str, Any], bytes]:
    try:
        assert_plain_path(path, hardlinks=True)
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
            raise ProjectStateError("EMANIFEST_INVALID", "snapshot metadata is not a bounded regular file", 1)
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("EUNSAFE_PATH", "snapshot metadata identity changed while opening", 1)
            raw = stream.read(max_bytes + 1)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except OSError as exc:
        raise ProjectStateError("EINVENTORY_UNREADABLE", "required snapshot metadata cannot be read") from exc
    if len(raw) > max_bytes or (before.st_dev, before.st_ino) != (after_fd.st_dev, after_fd.st_ino) or (after_fd.st_dev, after_fd.st_ino) != (after_path.st_dev, after_path.st_ino) or before.st_size != after_fd.st_size or before.st_mtime_ns != after_fd.st_mtime_ns:
        raise ProjectStateError("EARTIFACT_INTEGRITY", "snapshot metadata changed or exceeded its supported size", 1)
    try:
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite number")), object_pairs_hook=_unique_object)
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise ProjectStateError("EMANIFEST_INVALID", "snapshot metadata is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ProjectStateError("EMANIFEST_INVALID", "snapshot metadata must be a JSON object")
    return value, raw


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result
