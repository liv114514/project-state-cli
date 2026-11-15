from __future__ import annotations

"""Small, append-only journal primitives for the config restore candidate.

This module is intentionally private. A journal record is published with a
no-replace hard link after its bytes are completely written and flushed. The
operation never treats a temporary record as authorization to mutate a target.
"""

import hashlib
import json
import os
import re
import secrets
import stat
from pathlib import Path
from typing import Any, Callable

from project_state.foundation.state_paths import state_dir
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path

_OP_ID = re.compile(r"^[a-f0-9]{32}$")
_RECORD = re.compile(r"^record-(\d{6})\.json$")
_TEMP = re.compile(r"^record-(\d{6})\.tmp-([a-f0-9]{16})$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_FILE_ID = re.compile(r"^\d+:\d+$")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def operation_dir(root: Path, operation_id: str) -> Path:
    if not isinstance(operation_id, str) or not _OP_ID.fullmatch(operation_id):
        raise ProjectStateError("EOPERATION_ID", "operation ID is invalid", 1)
    return state_dir(root) / "operations" / operation_id


def append_record(root: Path, operation_id: str, value: dict[str, Any], *, validate_record: Callable, validate_transition: Callable, validate_initial: Callable) -> dict[str, Any]:
    """Publish a full journal state record without replacing prior evidence."""
    base = operation_dir(root, operation_id)
    assert_plain_path(base.parent)
    validate_record(value)
    try:
        base.mkdir()
    except FileExistsError:
        assert_plain_path(base)
        if not base.is_dir():
            raise ProjectStateError("EJOURNAL_UNSAFE", "operation journal path is not a directory", 2)
    entries = list(base.iterdir())
    records: list[tuple[int, Path]] = []
    for item in entries:
        assert_plain_path(item, hardlinks=True)
        match = _RECORD.fullmatch(item.name)
        if match:
            records.append((int(match.group(1)), item))
        elif _TEMP.fullmatch(item.name):
            # A temp is never a committed record and never grants authority.
            # Preserve it for diagnosis; later code may continue only from the
            # latest committed record after revalidating the actual target.
            continue
        else:
            raise ProjectStateError("EJOURNAL_UNSAFE", "operation journal contains an unrecognized entry", 2)
    records.sort()
    if [seq for seq, _ in records] != list(range(len(records))):
        raise ProjectStateError("EJOURNAL_INVALID", "operation journal sequence is incomplete", 2)
    previous = None
    if records:
        values = load_records(root, operation_id, validate_record=validate_record, validate_transition=validate_transition, validate_initial=validate_initial)
        latest = values[-1]
        latest_path = records[-1][1]
        _, previous = _read_record_with_digest(latest_path, validate_record=validate_record)
        if latest.get("operationId") != operation_id or latest.get("sequence") != records[-1][0]:
            raise ProjectStateError("EJOURNAL_INVALID", "operation journal identity is inconsistent", 2)
        if value.get("sequence") != len(records) or value.get("previousRecordSha256") != previous:
            raise ProjectStateError("EJOURNAL_INVALID", "next operation record does not extend the committed journal", 2)
        validate_transition(latest, value)
    else:
        if value.get("sequence") != 0 or value.get("previousRecordSha256") is not None:
            raise ProjectStateError("EJOURNAL_INVALID", "initial operation record has invalid chain fields", 2)
    if value.get("operationId") != operation_id:
        raise ProjectStateError("EJOURNAL_INVALID", "operation record ID does not match its directory", 2)
    data = json_bytes(value)
    sequence = len(records)
    final = base / f"record-{sequence:06d}.json"
    temp = base / f"record-{sequence:06d}.tmp-{secrets.token_hex(8)}"
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temp, flags, 0o600)
    try:
        initial = os.fstat(fd)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("journal write made no progress")
            view = view[count:]
        os.fsync(fd)
        completed = os.fstat(fd)
        temp_stat = temp.lstat()
        if ((initial.st_dev, initial.st_ino) != (completed.st_dev, completed.st_ino)
                or (completed.st_dev, completed.st_ino) != (temp_stat.st_dev, temp_stat.st_ino)
                or not stat.S_ISREG(completed.st_mode) or completed.st_nlink != 1
                or completed.st_size != len(data)):
            raise ProjectStateError("EJOURNAL_UNCERTAIN", "operation journal staging identity changed", 2)
    finally:
        os.close(fd)
    assert_plain_path(temp, hardlinks=True)
    try:
        if os.name == "nt":
            # Windows rename refuses an existing destination, giving the
            # journal record a no-replace publication primitive without
            # requiring the caller to hold the hard-link privilege.
            os.rename(temp, final)
        else:
            os.link(temp, final, follow_symlinks=False)
    except FileExistsError as exc:
        raise ProjectStateError("EJOURNAL_CONFLICT", "operation journal sequence already exists", 2) from exc
    final_stat = final.lstat()
    expected_links = 1 if os.name == "nt" else 2
    if ((final_stat.st_dev, final_stat.st_ino) != (temp_stat.st_dev, temp_stat.st_ino)
            or final_stat.st_nlink != expected_links or final.read_bytes() != data):
        raise ProjectStateError("EJOURNAL_UNCERTAIN", "published operation record failed identity verification", 2)
    # Failure to unlink the second name is safe: both names still refer to the
    # same verified record. Retain them for inspect rather than deleting blindly.
    if os.name != "nt":
        try:
            os.unlink(temp)
        except OSError:
            pass
    return {"sequence": sequence, "path": final, "sha256": sha256(data)}


def _read_record_with_digest(path: Path, *, validate_record: Callable) -> tuple[dict[str, Any], str]:
    assert_plain_path(path, hardlinks=True)
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 2_000_000:
            raise ProjectStateError("EJOURNAL_UNSAFE", "operation record is not a supported single-link file", 2)
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("EJOURNAL_UNCERTAIN", "operation record identity changed while opening", 2)
            data = stream.read(2_000_001)
            after = os.fstat(stream.fileno())
        final = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EJOURNAL_UNREADABLE", "operation record cannot be read", 2) from exc
    if (len(data) > 2_000_000 or len(data) != before.st_size
            or (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size)
            or (after.st_dev, after.st_ino) != (final.st_dev, final.st_ino)):
        raise ProjectStateError("EJOURNAL_UNCERTAIN", "operation record changed while reading", 2)
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProjectStateError("EJOURNAL_INVALID", "operation record is not valid canonical JSON", 2) from exc
    if (not isinstance(value, dict) or type(value.get("schemaVersion")) is not int
            or value.get("schemaVersion") not in {1, 2}):
        raise ProjectStateError("EJOURNAL_INVALID", "operation record schema is unsupported", 2)
    validate_record(value)
    return value, sha256(data)


def read_record(path: Path, *, validate_record: Callable) -> dict[str, Any]:
    return _read_record_with_digest(path, validate_record=validate_record)[0]


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def load_records(root: Path, operation_id: str, *, validate_record: Callable, validate_transition: Callable, validate_initial: Callable) -> list[dict[str, Any]]:
    base = operation_dir(root, operation_id)
    assert_plain_path(base)
    records: list[tuple[int, Path]] = []
    for item in base.iterdir():
        assert_plain_path(item, hardlinks=True)
        match = _RECORD.fullmatch(item.name)
        if match:
            records.append((int(match.group(1)), item))
        elif _TEMP.fullmatch(item.name):
            continue
        else:
            raise ProjectStateError("EJOURNAL_UNSAFE", "operation journal contains an unrecognized entry", 2)
    records.sort()
    if not records or [seq for seq, _ in records] != list(range(len(records))):
        raise ProjectStateError("EJOURNAL_INVALID", "operation journal has no complete sequence", 2)
    values: list[dict[str, Any]] = []
    previous = None
    for seq, path in records:
        value, digest = _read_record_with_digest(path, validate_record=validate_record)
        if value.get("operationId") != operation_id or value.get("sequence") != seq or value.get("previousRecordSha256") != previous:
            raise ProjectStateError("EJOURNAL_INVALID", "operation journal chain or identity is invalid", 2)
        if seq == 0:
            validate_initial(value)
        previous = digest
        if values:
            validate_transition(values[-1], value)
        values.append(value)
    return values
