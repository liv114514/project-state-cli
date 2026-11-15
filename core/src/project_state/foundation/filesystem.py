from __future__ import annotations

"""Low-level no-replace staging and byte serialization."""

import json
import os
import stat
from pathlib import Path
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path

def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, separators=(",", ": ")) + "\n").encode("utf-8")

def mkdir_checked(path: Path) -> None:
    try:
        path.mkdir()
    except FileExistsError:
        assert_plain_path(path)
        if not path.is_dir():
            raise ProjectStateError("EUNSAFE_PATH", "storage path is not a real directory", 1)

def write_new(path: Path, data: bytes, mode: int = 0o600) -> tuple[int, int]:
    assert_plain_path(path.parent)
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags, mode)
        before = os.fstat(fd)
        with os.fdopen(fd, "wb", closefd=True) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        after = path.lstat()
    except FileExistsError as exc:
        raise ProjectStateError("EEXISTS", "snapshot publication destination already exists", 1) from exc
    except OSError as exc:
        raise ProjectStateError("EIO", "snapshot staging write failed; preserve the staging data", 2) from exc
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or after.st_size != len(data):
        raise ProjectStateError("EUNSAFE_PATH", "snapshot staging identity changed during write", 2)
    return before.st_dev, before.st_ino

