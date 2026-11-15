"""Resolver owner binding and identity-safe claim file primitives."""
from __future__ import annotations
import hashlib
import json
import os
import re
import secrets
import stat
from pathlib import Path
from typing import Any
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path

_HASH = re.compile(r"^[a-f0-9]{64}$")
_LOCK_ID = re.compile(r"^\d+:\d+$")

def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def owner_binding(lock: Any) -> dict[str, Any]:
    """Return the non-secret proof of the original operation lock owner."""
    owner = getattr(lock, "owner", None)
    token = getattr(lock, "token", None)
    identity = getattr(lock, "identity", None)
    if (not isinstance(owner, dict) or not isinstance(token, str)
            or not isinstance(identity, tuple) or len(identity) != 2
            or owner.get("token") != token):
        raise ProjectStateError("EOWNER_UNCERTAIN", "operation owner proof is unavailable", 2)
    return {
        "protocolVersion": 1,
        "operation": owner.get("operation"),
        "name": owner.get("name"),
        "startedAt": owner.get("startedAt"),
        "lockFileId": f"{identity[0]}:{identity[1]}",
        "ownerTokenSha256": _sha(token.encode("ascii")),
    }


def validate_owner(value: Any) -> None:
    required = {"protocolVersion", "operation", "name", "startedAt", "lockFileId", "ownerTokenSha256"}
    if (not isinstance(value, dict) or set(value) != required
            or type(value.get("protocolVersion")) is not int or value["protocolVersion"] != 1
            or value.get("operation") not in {"restore", "snapshot"}
            or not isinstance(value.get("name"), str) or not value["name"]
            or not isinstance(value.get("startedAt"), str) or not value["startedAt"]
            or not isinstance(value.get("lockFileId"), str) or not _LOCK_ID.fullmatch(value["lockFileId"])
            or not isinstance(value.get("ownerTokenSha256"), str) or not _HASH.fullmatch(value["ownerTokenSha256"])):
        raise ProjectStateError("EOWNER_UNCERTAIN", "operation owner binding is malformed; preserve its journal", 2)


def read_claim(path: Path) -> tuple[dict[str, Any], str]:
    assert_plain_path(path, hardlinks=True)
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1_000_000:
            raise ProjectStateError("ERESOLVER_UNCERTAIN", "resolver claim is not a supported single-link file", 2)
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("ERESOLVER_UNCERTAIN", "resolver claim identity changed while opening", 2)
            data = stream.read(1_000_001)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("ERESOLVER_UNREADABLE", "resolver claim cannot be read", 2) from exc
    if (len(data) > 1_000_000 or len(data) != before.st_size
            or (before.st_dev, before.st_ino, before.st_size) != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size)
            or (after_fd.st_dev, after_fd.st_ino) != (after_path.st_dev, after_path.st_ino)):
        raise ProjectStateError("ERESOLVER_UNCERTAIN", "resolver claim changed while reading", 2)
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProjectStateError("ERESOLVER_INVALID", "resolver claim is not valid unique-field JSON", 2) from exc
    if not isinstance(value, dict):
        raise ProjectStateError("ERESOLVER_INVALID", "resolver claim record is not an object", 2)
    return value, _sha(data)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def publish_claim(directory: Path, sequence: int, data: bytes) -> str:
    final = directory / f"claim-{sequence:06d}.json"
    temp = directory / f"claim-{sequence:06d}.tmp-{secrets.token_hex(8)}"
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        initial = os.fstat(fd)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("resolver journal write made no progress")
            view = view[count:]
        os.fsync(fd)
        completed = os.fstat(fd)
        on_path = temp.lstat()
        if ((initial.st_dev, initial.st_ino) != (completed.st_dev, completed.st_ino)
                or (completed.st_dev, completed.st_ino) != (on_path.st_dev, on_path.st_ino)
                or not stat.S_ISREG(completed.st_mode) or completed.st_nlink != 1
                or completed.st_size != len(data)):
            raise ProjectStateError("ERESOLVER_UNCERTAIN", "resolver staging identity changed", 2)
    finally:
        os.close(fd)
    assert_plain_path(temp, hardlinks=True)
    try:
        if os.name == "nt":
            os.rename(temp, final)
        else:
            os.link(temp, final, follow_symlinks=False)
    except FileExistsError as exc:
        raise ProjectStateError("ERESOLVER_CONFLICT", "resolver claim sequence already exists", 2) from exc
    final_stat = final.lstat()
    if ((final_stat.st_dev, final_stat.st_ino) != (on_path.st_dev, on_path.st_ino)
            or final_stat.st_nlink not in ({1} if os.name == "nt" else {2})
            or final.read_bytes() != data):
        raise ProjectStateError("ERESOLVER_UNCERTAIN", "published resolver claim failed identity verification", 2)
    if os.name != "nt":
        try:
            os.unlink(temp)
        except OSError:
            pass
    return _sha(data)
