from __future__ import annotations

"""Exclusive project-state operation lock and owner verification."""

import hashlib
import json
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.filesystem import json_bytes as _json_bytes, mkdir_checked as _mkdir_checked
from project_state.foundation.paths import assert_plain_path
from project_state.foundation.state_paths import ensure_state_dir

class OperationLock:
    def __init__(self, path: Path, fd: int, token: str, identity: tuple[int, int], owner: dict[str, Any]):
        self.path, self.fd, self.token, self.identity, self.owner = path, fd, token, identity, owner

    def verify(self) -> None:
        assert_plain_path(self.path, hardlinks=True)
        path_stat = self.path.lstat()
        fd_stat = os.fstat(self.fd)
        if ((path_stat.st_dev, path_stat.st_ino) != self.identity
                or (fd_stat.st_dev, fd_stat.st_ino) != self.identity
                or path_stat.st_nlink != 1 or not stat.S_ISREG(path_stat.st_mode)):
            raise ProjectStateError("ELOCK_UNCERTAIN", "snapshot operation lock identity changed", 2)
        os.lseek(self.fd, 0, os.SEEK_SET)
        try:
            owner = json.loads(os.read(self.fd, 65536).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProjectStateError("ELOCK_UNCERTAIN", "snapshot operation lock owner is malformed", 2) from exc
        if not isinstance(owner, dict) or owner.get("token") != self.token:
            raise ProjectStateError("ELOCK_UNCERTAIN", "snapshot operation lock owner changed", 2)

    def release(self) -> None:
        try:
            self.verify()
        except BaseException:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
            raise
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)

def acquire_lock(root: Path, name: str) -> OperationLock:
    python_state = ensure_state_dir(root)
    lock_dir = python_state / "locks"
    _mkdir_checked(python_state)
    _mkdir_checked(lock_dir)
    token = secrets.token_hex(16)
    # All mutating commands share one OS lock. Per-snapshot locks let restore
    # race a differently named snapshot while the safety point is collected.
    path = lock_dir / "operation.lock"
    root_identity = hashlib.sha256(os.path.normcase(str(root)).encode("utf-8", errors="strict")).hexdigest()
    owner = {"schemaVersion": 1, "operation": "restore" if name == "transaction" else "snapshot",
             "name": name, "rootIdentity": root_identity,
             "token": token,
             "startedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd: int | None = None
    locked = False
    owner_write_started = False
    owner_write_complete = False
    try:
        try:
            existing = path.lstat()
        except FileNotFoundError:
            existing = None
        if existing is not None and (not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1):
            raise ProjectStateError(
                "ELOCK_FOREIGN",
                "operation lock uses an unsupported or foreign filesystem object; preserve it and use its matching project-state runtime",
                2,
            )
        fd = os.open(path, flags, 0o600)
        opened = os.fstat(fd)
        path_stat = path.lstat()
        if (opened.st_dev, opened.st_ino) != (path_stat.st_dev, path_stat.st_ino) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            os.close(fd)
            raise ProjectStateError("ELOCK_FOREIGN", "operation lock identity is unsupported; preserve it", 2)
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                os.close(fd)
                raise ProjectStateError("ELOCKED", "another project-state write operation holds the project lock", 2) from exc
            locked = True
            # Lock byte zero before initializing an empty file. A contender
            # must never write a sentinel into a lock object it does not own.
            if os.fstat(fd).st_size == 0:
                os.lseek(fd, 0, os.SEEK_SET)
                if os.write(fd, b"\0") != 1:
                    raise OSError("operation lock sentinel initialization made no progress")
                os.fsync(fd)
        else:
            import fcntl
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                os.close(fd)
                fd = None
                raise ProjectStateError("ELOCKED", "another project-state write operation holds the project lock", 2) from exc
            locked = True
        if opened.st_size:
            os.lseek(fd, 0, os.SEEK_SET)
            previous = os.read(fd, 65537)
            if previous != b"\0":
                try:
                    prior_owner = json.loads(previous.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ProjectStateError("ELOCK_UNCERTAIN", "operation lock owner record is malformed; preserve it", 2) from exc
                expected_fields = {"schemaVersion", "operation", "name", "rootIdentity", "token", "startedAt"}
                if (not isinstance(prior_owner, dict) or set(prior_owner) != expected_fields
                        or type(prior_owner.get("schemaVersion")) is not int or prior_owner.get("schemaVersion") != 1
                        or prior_owner.get("operation") not in {"snapshot", "restore"}
                        or not isinstance(prior_owner.get("name"), str)
                        or prior_owner.get("rootIdentity") != root_identity
                        or not isinstance(prior_owner.get("token"), str)
                        or not re.fullmatch(r"[a-f0-9]{32}", prior_owner["token"])
                        or not isinstance(prior_owner.get("startedAt"), str)):
                    raise ProjectStateError("ELOCK_FOREIGN", "operation lock owner does not match this project-state protocol; preserve it", 2)
        identity = (opened.st_dev, opened.st_ino)
        owner_bytes = _json_bytes(owner)
        os.lseek(fd, 0, os.SEEK_SET)
        owner_write_started = True
        os.ftruncate(fd, 0)
        view = memoryview(owner_bytes)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("operation owner write made no progress")
            view = view[written:]
        os.fsync(fd)
        owner_write_complete = True
        lock = OperationLock(path, fd, token, identity, owner)
        lock.verify()
        return lock
    except BaseException as exc:
        if fd is not None:
            if os.name == "nt" and locked and owner_write_started and not owner_write_complete:
                # The business operation cannot start until _lock returns.
                # Restore the Windows empty-lock sentinel so a later owner can
                # retry safely after an interrupted metadata publication.
                try:
                    os.ftruncate(fd, 0)
                    os.lseek(fd, 0, os.SEEK_SET)
                    if os.write(fd, b"\0") != 1:
                        raise OSError("operation lock sentinel restore made no progress")
                    os.fsync(fd)
                except OSError:
                    # Keep the object and return a stable failure; do not
                    # delete an identity we cannot prove safe to retire.
                    pass
            try:
                if locked:
                    if os.name == "nt":
                        import msvcrt
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass
        if isinstance(exc, ProjectStateError):
            raise
        if isinstance(exc, OSError):
            raise ProjectStateError("ELOCK_CREATE", "snapshot operation lock could not be acquired", 2) from exc
        raise

