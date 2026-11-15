"""SQLite online-backup primitive; not yet wired to snapshot transactions."""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import stat
from pathlib import Path
from urllib.parse import quote

from project_state.foundation.state_paths import ensure_state_dir, state_dir
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root, validate_relative
from project_state.foundation.sqlite import SQLITE_NAME_PATTERN as _DB_NAME, schema_and_counts as _schema_and_counts
from project_state.foundation.sqlite_runtime import require_safe_sqlite



def discover_database_sources(root_value: str | os.PathLike[str]) -> list[str]:
    """Return supported root-level SQLite files after non-following preflight.

    A matching but unsafe entry is an error, not an omission: with an explicit
    seed request, silently skipping a database would falsely report success.
    Sidecars are intentionally left to SQLite's online backup API.
    """
    root = project_root(root_value)
    assert_plain_path(root)
    try:
        entries = list(os.scandir(root))
    except OSError as exc:
        raise ProjectStateError("EDATABASE_PREFLIGHT", "SQLite sources could not be enumerated safely", 2) from exc
    names: list[str] = []
    folded: set[str] = set()
    for entry in entries:
        name = entry.name
        if not _DB_NAME.fullmatch(name):
            continue
        path = root / name
        try:
            st = path.lstat()
        except OSError as exc:
            raise ProjectStateError("EDATABASE_PREFLIGHT", "a supported SQLite source could not be inspected", 2) from exc
        if is_reparse_point(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise ProjectStateError("EUNSAFE_PATH", "a supported SQLite source is not a single-link regular file", 2)
        key = name.casefold()
        if key in folded:
            raise ProjectStateError("EDATABASE_PREFLIGHT", "SQLite source names collide on this filesystem", 2)
        folded.add(key)
        names.append(name)
    return sorted(names, key=lambda item: (item.casefold(), item))


def _source_uri(path: Path) -> str:
    # Path.as_uri quotes spaces and Unicode while avoiding shell parsing.
    return path.as_uri() + "?mode=ro"


def _verify_source_identity(path: Path, before: os.stat_result) -> None:
    try:
        after = path.lstat()
    except OSError as exc:
        raise ProjectStateError("ESOURCE_CHANGED", "SQLite source identity changed during backup; no generation may be published", 2) from exc
    if ((before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
            or not stat.S_ISREG(after.st_mode) or is_reparse_point(after) or after.st_nlink != 1):
        raise ProjectStateError("ESOURCE_CHANGED", "SQLite source identity changed during backup; no generation may be published", 2)




def _file_digest(path: Path) -> tuple[int, str, tuple[int, int]]:
    assert_plain_path(path, hardlinks=True)
    before = path.lstat()
    if is_reparse_point(before) or not stat.S_ISREG(before.st_mode):
        raise ProjectStateError("EUNSAFE_PATH", "SQLite backup artifact is not a regular private file", 1)
    digest = hashlib.sha256()
    count = 0
    with path.open("rb", buffering=0) as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ProjectStateError("EUNSAFE_PATH", "SQLite backup identity changed while opening", 1)
        while chunk := stream.read(1024 * 1024):
            count += len(chunk)
            digest.update(chunk)
        after_fd = os.fstat(stream.fileno())
    after_path = path.lstat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns) or (after_fd.st_dev, after_fd.st_ino) != (after_path.st_dev, after_path.st_ino) or after_path.st_nlink > 1 or count != after_fd.st_size:
        raise ProjectStateError("EARTIFACT_INTEGRITY", "SQLite backup changed during verification", 1)
    return count, digest.hexdigest(), (after_fd.st_dev, after_fd.st_ino)


def online_backup(root_value: str | os.PathLike[str], source_name: str, destination_relative: str, *, timeout: float = 5.0) -> dict:
    """Create one consistent SQLite backup at an absent destination.

    The caller must already hold the project operation lock and choose a private,
    transaction-owned staging path. This primitive refuses links/hardlinks and
    never removes a path it cannot prove it created. It does not publish a
    generation, journal, pin, or restore a database.
    """
    require_safe_sqlite()
    root = project_root(root_value)
    ensure_state_dir(root)
    if not isinstance(source_name, str) or "/" in source_name or "\\" in source_name or not _DB_NAME.fullmatch(source_name):
        raise ProjectStateError("EUNSAFE_PATH", "SQLite source filename is outside the supported allowlist", 1)
    src = root / source_name
    private_root = state_dir(root) / "secrets"
    relative = validate_relative(destination_relative)
    dst = private_root.joinpath(*relative.split("/"))
    try:
        assert_plain_path(root)
        assert_plain_path(src.parent)
        assert_plain_path(src, hardlinks=True)
        assert_plain_path(private_root)
        assert_plain_path(dst.parent)
        try:
            dst.lstat()
        except FileNotFoundError:
            pass
        else:
            raise ProjectStateError("EEXISTS", "SQLite backup destination already exists", 1)
        src_stat = src.lstat()
        if is_reparse_point(src_stat) or not stat.S_ISREG(src_stat.st_mode) or src_stat.st_nlink > 1:
            raise ProjectStateError("EUNSAFE_PATH", "SQLite source is not a single-link regular file", 1)
        token = os.open(dst, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        created = os.fstat(token)
        os.close(token)
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EDATABASE_PREFLIGHT", "SQLite source or private staging path could not be verified", 2) from exc

    source_db = None
    target_db = None
    succeeded = False
    try:
        source_db = sqlite3.connect(_source_uri(src), uri=True, timeout=timeout)
        source_db.execute("PRAGMA query_only=ON")
        target_db = sqlite3.connect(str(dst), timeout=timeout)
        source_db.backup(target_db, pages=256, sleep=0.01)
        target_db.commit()
        # The source may use WAL. The private backup is self-contained, so move
        # only the staged copy to rollback-journal mode before publishing it.
        journal_mode = target_db.execute("PRAGMA journal_mode=DELETE").fetchone()[0].lower()
        if journal_mode != "delete":
            raise ProjectStateError("EDATABASE_SIDECAR", "SQLite backup could not leave WAL mode safely", 2)
        target_db.commit()
        integrity = [row[0] for row in target_db.execute("PRAGMA integrity_check")]
        if integrity != ["ok"]:
            raise ProjectStateError("EDATABASE_INTEGRITY", "SQLite online backup failed integrity_check", 2)
        tables, rows, schema_hash = _schema_and_counts(target_db)
        target_db.close(); target_db = None
        source_db.close(); source_db = None
        _verify_source_identity(src, src_stat)
        size, digest, identity = _file_digest(dst)
        if identity != (created.st_dev, created.st_ino):
            raise ProjectStateError("EUNSAFE_PATH", "SQLite staging object identity changed after backup", 2)
        # Sidecars after closing the staged DB indicate unresolved SQLite state.
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(dst) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                raise ProjectStateError("EDATABASE_SIDECAR", "SQLite backup staging contains an unexpected sidecar", 2)
        succeeded = True
        return {"size": size, "sha256": digest, "tables": tables, "totalRows": rows,
                "schemaFingerprint": schema_hash, "integrity": "ok", "identity": identity,
                "engine": sqlite3.sqlite_version, "consistentBackup": True}
    except ProjectStateError:
        raise
    except sqlite3.Error as exc:
        # Do not echo SQLite's raw message; it may disclose local paths or SQL.
        raise ProjectStateError("EDATABASE_BACKUP", "SQLite online backup failed; no generation may be published", 2) from exc
    except OSError as exc:
        raise ProjectStateError("EDATABASE_BACKUP", "SQLite backup artifact could not be verified", 2) from exc
    finally:
        if target_db is not None:
            try:
                target_db.close()
            except sqlite3.Error:
                pass
        if source_db is not None:
            try:
                source_db.close()
            except sqlite3.Error:
                pass
        try:
            if not succeeded:
                current = dst.lstat()
                sidecars = [Path(str(dst) + suffix) for suffix in ("-wal", "-shm", "-journal")]
                if all(not item.exists() and not item.is_symlink() for item in sidecars) and (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino) and current.st_nlink == 1:
                    dst.unlink()
        except OSError:
            # Preserve an uncertain object for manual inspection.
            pass
