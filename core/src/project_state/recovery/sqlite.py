from __future__ import annotations

"""Conservative SQLite restore for an absent destination only.

The operation reuses the v2 private backup, the shared project write lock, and
an append-only operation journal. Existing databases and any SQLite sidecar
are refused. No SQL stored in the snapshot is executed.
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import uuid
from pathlib import Path
from typing import Any

from project_state.foundation.location import check_restore_location
from project_state.foundation.state_paths import state_dir
from project_state.foundation.sqlite import SQLITE_NAME_PATTERN as _DB_NAME, schema_and_counts as _schema_and_counts
from project_state.foundation.sqlite_runtime import require_safe_sqlite
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.git_state import inspect_git
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root, require_same_volume, require_windows_path_budget, validate_snapshot_name
from project_state.foundation.locking import acquire_lock as _lock
from project_state.foundation.filesystem import mkdir_checked as _mkdir_checked
from project_state.foundation.storage import validate_pair
from project_state.recovery.operation_gate import assert_no_unresolved_operations
from project_state.recovery.sqlite_journal import (_root_id, _operation_dir, _record_bytes,
    _load_records, _validate_record, _NEXT, _unique_pairs)
from project_state.recovery.resolver import owner_binding, begin_recovery, complete_recovery, latest_operation_record_sha
from project_state.recovery.resolver import load_claims

_OP = re.compile(r"^[a-f0-9]{32}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_SIDECARS = ("-wal", "-shm", "-journal")


def _db_target(root: Path, value: Any) -> Path:
    if not isinstance(value, str) or "/" in value or "\\" in value or not _DB_NAME.fullmatch(value):
        raise ProjectStateError("EUNSAFE_PATH", "database target is outside the supported filename allowlist", 2)
    path = root / value
    assert_plain_path(path.parent)
    return path


def _sidecars(target: Path) -> list[str]:
    found = []
    for suffix in _SIDECARS:
        path = Path(str(target) + suffix)
        try:
            st = path.lstat()
        except FileNotFoundError:
            continue
        if is_reparse_point(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise ProjectStateError("EUNSAFE_PATH", "SQLite sidecar path is not a supported regular file", 2)
        found.append(path.name)
    return found


def _proof(path: Path) -> dict[str, Any]:
    try:
        before = path.lstat()
    except FileNotFoundError:
        return {"exists": False, "size": 0, "sha256": None, "fileId": None, "links": 0}
    assert_plain_path(path, hardlinks=True)
    if is_reparse_point(before) or not stat.S_ISREG(before.st_mode) or before.st_nlink not in {1, 2}:
        raise ProjectStateError("EUNSAFE_PATH", "SQLite file is not a supported regular single-object path", 2)
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("EIDENTITY_CHANGED", "SQLite file identity changed while opening", 2)
            while block := stream.read(1024 * 1024):
                size += len(block)
                digest.update(block)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EDATABASE_UNREADABLE", "SQLite file could not be verified", 2) from exc
    if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink)
            != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
            or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
            != (after_path.st_dev, after_path.st_ino, after_path.st_size, after_path.st_mtime_ns, after_path.st_nlink)
            or size != after_fd.st_size):
        raise ProjectStateError("EIDENTITY_CHANGED", "SQLite file changed during verification", 2)
    return {"exists": True, "size": size, "sha256": digest.hexdigest(),
            "fileId": f"{after_fd.st_dev}:{after_fd.st_ino}", "links": after_fd.st_nlink}


def _same_object(a: dict[str, Any], b: dict[str, Any], *, links: bool = False) -> bool:
    if not a.get("exists") or not b.get("exists"):
        return a.get("exists") is b.get("exists")
    keys = ("size", "sha256", "fileId") + (("links",) if links else ())
    return all(a.get(key) == b.get(key) for key in keys)


def _publish_no_replace(stage: Path, target: Path) -> None:
    # Windows MoveFile semantics reject an existing destination. POSIX rename
    # replaces it, so this candidate refuses database publication there until
    # a native no-replace primitive is implemented and independently tested.
    if os.name != "nt":
        raise ProjectStateError("EPLATFORM_UNVERIFIED", "SQLite restore is enabled only on verified Windows no-replace publication", 2)
    require_same_volume(stage.parent, target.parent)
    try:
        os.rename(stage, target)
    except FileExistsError as exc:
        raise ProjectStateError("EDATABASE_EXISTS", "destination appeared at publication; external data was preserved", 2) from exc


def _selected(pair: dict[str, Any], target_name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    matches = [a for a in pair["artifacts"] if a.get("layer") == "database" and a.get("kind") == "sqlite-backup" and a.get("target") == target_name]
    rows = pair["layers"].get("database", {}).get("databases", [])
    metadata = [r for r in rows if isinstance(r, dict) and r.get("file") == target_name and r.get("mode") == "backup"]
    if len(matches) != 1 or len(metadata) != 1:
        raise ProjectStateError("ERESTORE_SELECTION", "choose an exact database filename present in this snapshot", 2)
    artifact, row = matches[0], metadata[0]
    if (artifact.get("restore") != "sqlite-create-missing" or artifact.get("privacy") != "private"
            or artifact.get("required") is not True or artifact.get("id") != row.get("artifactId")):
        raise ProjectStateError("ERESTORE_INPUT", "SQLite artifact policy or metadata does not match", 2)
    return artifact, row


def plan_database_restore(root_value: str | os.PathLike[str], snapshot_name: str, target_name: str) -> dict[str, Any]:
    require_safe_sqlite()
    if os.name != "nt":
        raise ProjectStateError("EPLATFORM_UNVERIFIED", "SQLite restore is currently enabled only on verified Windows no-replace publication", 2)
    root = project_root(root_value)
    validate_snapshot_name(snapshot_name)
    target = _db_target(root, target_name)
    check_restore_location(target, state_dir(root))
    operation_placeholder = "0" * 32
    state = state_dir(root)
    require_windows_path_budget([
        target, state / "locks" / "operation.lock",
        state / "staging" / operation_placeholder / "private" / "database.stage",
        state / "staging" / operation_placeholder / "private" / "database.rollback",
        state / "operations" / operation_placeholder / "db-record-999999.json",
        state / "operations" / operation_placeholder / "db-record-999999.tmp-0123456789abcdef",
        state / "pins" / f"{operation_placeholder}.json",
        state / "resolvers" / operation_placeholder / "claim-999999.tmp-0123456789abcdef",
    ])
    pair = validate_pair(root, snapshot_name)
    artifact, meta = _selected(pair, target_name)
    try:
        target.lstat()
    except FileNotFoundError:
        pass
    else:
        raise ProjectStateError("EDATABASE_EXISTS", "database restore is supported only when the destination is absent", 2)
    sidecars = _sidecars(target)
    if sidecars:
        raise ProjectStateError("EDATABASE_SIDECAR", "database restore refuses a destination with existing SQLite sidecars", 2)
    git = inspect_git(root, extra_paths=[target_name])
    if git["isGit"] and not git["clean"]:
        raise ProjectStateError("EGIT_DIRTY", "database restore preview is refused while the Git worktree or index is dirty", 2)
    return {"resultSchemaVersion": 1, "command": "restore", "mode": "preview-only",
            "snapshot": snapshot_name, "generation": pair["generation"], "selectedLayers": ["database"],
            "targets": [{"target": target_name, "action": "create", "current": {"exists": False},
                         "snapshot": {"size": artifact["size"], "integrity": "verified",
                                      "schemaFingerprint": meta["schemaFingerprint"], "tableCount": len(meta["tables"]),
                                      "rowCount": meta["totalRows"]}}],
            "git": {"state": "clean" if git["isGit"] else "not-a-repository", "head": git.get("head"), "branchRef": git.get("branchRef")},
            "businessWrites": 0, "safetyPointCreated": False,
            "nextStep": "after reviewing the absent destination and exact database filename, --yes creates only this file; existing database or sidecars are refused"}


def _verify_sqlite(path: Path, metadata: dict[str, Any]) -> None:
    require_safe_sqlite()
    uri = path.as_uri() + "?mode=ro"
    connection = None
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=2.0)
        connection.execute("PRAGMA query_only=ON")
        result = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        if result != ["ok"]:
            raise ProjectStateError("EDATABASE_INTEGRITY", "SQLite integrity_check did not pass", 2)
        tables, rows, schema = _schema_and_counts(connection)
        if (schema != metadata["schemaFingerprint"] or tables != metadata["tables"]
                or rows != metadata["totalRows"]):
            raise ProjectStateError("EDATABASE_VERIFY", "restored SQLite schema or row counts differ from the validated snapshot metadata", 2)
    except ProjectStateError:
        raise
    except sqlite3.Error as exc:
        raise ProjectStateError("EDATABASE_VERIFY", "restored SQLite database could not be verified", 2) from exc
    finally:
        if connection is not None:
            connection.close()


def _append(root: Path, operation_id: str, state: dict[str, Any]) -> dict[str, Any]:
    base = _operation_dir(root, operation_id)
    _mkdir_checked(state_dir(root))
    _mkdir_checked(base.parent)
    _mkdir_checked(base)
    records = _load_records(root, operation_id) if any(base.glob("db-record-*.json")) else []
    sequence = len(records)
    prior = None
    if records:
        prior_path = base / f"db-record-{sequence - 1:06d}.json"
        prior = hashlib.sha256(prior_path.read_bytes()).hexdigest()
    value = {**state, "schemaVersion": 1, "operationId": operation_id,
             "sequence": sequence, "previousRecordSha256": prior}
    _validate_record(value, operation_id)
    if records and value["phase"] not in _NEXT.get(records[-1]["phase"], set()):
        raise ProjectStateError("EJOURNAL_INVALID", "database operation transition is not monotonic", 2)
    if records and any(value.get(k) != records[0].get(k) for k in ("rootIdentity", "source", "target", "stage", "pin", "ownerBinding")):
        raise ProjectStateError("EJOURNAL_INVALID", "database operation changed its immutable plan", 2)
    if records and records[-1].get("resolverClaim") is not None and value.get("resolverClaim") != records[-1].get("resolverClaim"):
        old_claim, new_claim = records[-1]["resolverClaim"], value.get("resolverClaim")
        if not isinstance(new_claim, dict) or type(new_claim.get("sequence")) is not int or new_claim["sequence"] <= old_claim["sequence"]:
            raise ProjectStateError("EJOURNAL_INVALID", "database resolver claim did not advance monotonically", 2)
    data = _record_bytes(value)
    temp = base / f"db-record-{sequence:06d}.tmp-{secrets.token_hex(8)}"
    final = base / f"db-record-{sequence:06d}.json"
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temp, flags, 0o600)
    try:
        initial = os.fstat(fd)
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            if n <= 0:
                raise OSError("journal write made no progress")
            view = view[n:]
        os.fsync(fd)
        after = os.fstat(fd)
        on_path = temp.lstat()
        if ((initial.st_dev, initial.st_ino) != (after.st_dev, after.st_ino)
                or (after.st_dev, after.st_ino) != (on_path.st_dev, on_path.st_ino)
                or after.st_nlink != 1 or after.st_size != len(data)):
            raise ProjectStateError("EJOURNAL_UNCERTAIN", "database journal staging identity changed", 2)
    finally:
        os.close(fd)
    if os.name == "nt":
        os.rename(temp, final)
    else:
        os.link(temp, final, follow_symlinks=False)
        os.unlink(temp)
    return value


def _stage_copy(root: Path, operation_id: str, source: Path, expected_size: int, expected_hash: str) -> dict[str, Any]:
    state = state_dir(root)
    staging = state / "staging"
    operation = staging / operation_id
    private = operation / "private"
    _mkdir_checked(state)
    _mkdir_checked(staging)
    try:
        operation.mkdir()
    except FileExistsError as exc:
        raise ProjectStateError("EEXISTS", "database restore staging operation already exists", 2) from exc
    private.mkdir()
    assert_plain_path(operation)
    assert_plain_path(private)
    assert_plain_path(source, hardlinks=True)
    source_before = source.lstat()
    target = private / "database.stage"
    fd_source = os.open(source, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    fd_target = None
    digest = hashlib.sha256()
    size = 0
    try:
        src_open = os.fstat(fd_source)
        if (src_open.st_dev, src_open.st_ino) != (source_before.st_dev, source_before.st_ino) or source_before.st_nlink != 1:
            raise ProjectStateError("EARTIFACT_UNCERTAIN", "private SQLite source identity is not stable", 2)
        fd_target = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600)
        dst_initial = os.fstat(fd_target)
        while True:
            block = os.read(fd_source, 1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > expected_size:
                raise ProjectStateError("EARTIFACT_INTEGRITY", "SQLite source exceeds its declared size", 2)
            digest.update(block)
            view = memoryview(block)
            while view:
                n = os.write(fd_target, view)
                if n <= 0:
                    raise OSError("database staging write made no progress")
                view = view[n:]
        os.fsync(fd_target)
        dst_after = os.fstat(fd_target)
        src_after = os.fstat(fd_source)
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EDATABASE_STAGE", "private SQLite restore staging failed", 2) from exc
    finally:
        if fd_source is not None:
            os.close(fd_source)
        if fd_target is not None:
            os.close(fd_target)
    source_after = source.lstat()
    stage_path = target.lstat()
    if ((source_before.st_dev, source_before.st_ino, source_before.st_size, source_before.st_mtime_ns)
            != (src_after.st_dev, src_after.st_ino, src_after.st_size, src_after.st_mtime_ns)
            or (src_after.st_dev, src_after.st_ino) != (source_after.st_dev, source_after.st_ino)
            or size != expected_size or digest.hexdigest() != expected_hash
            or (dst_initial.st_dev, dst_initial.st_ino) != (dst_after.st_dev, dst_after.st_ino)
            or (dst_after.st_dev, dst_after.st_ino) != (stage_path.st_dev, stage_path.st_ino)
            or stage_path.st_nlink != 1 or stage_path.st_size != expected_size):
        raise ProjectStateError("EARTIFACT_INTEGRITY", "SQLite restore staging did not match the validated private backup", 2)
    return {"relativePath": f"staging/{operation_id}/private/database.stage", "fileId": f"{stage_path.st_dev}:{stage_path.st_ino}",
            "size": size, "sha256": digest.hexdigest()}


def _stage_path(root: Path, operation_id: str, item: dict[str, Any]) -> Path:
    rel = item.get("relativePath")
    if not isinstance(rel, str) or "\\" in rel or ".." in rel.split("/"):
        raise ProjectStateError("EJOURNAL_INVALID", "database restore stage path is invalid", 2)
    parts = rel.split("/")
    if (len(parts) != 4 or parts[0] != "staging" or parts[1] != operation_id
            or parts[2] != "private" or parts[3] != "database.stage"):
        raise ProjectStateError("EJOURNAL_INVALID", "database restore stage path is invalid", 2)
    path = state_dir(root) / Path(*parts)
    assert_plain_path(path, hardlinks=True)
    proof = _proof(path)
    if proof["fileId"] != item.get("fileId") or proof["size"] != item.get("size") or proof["sha256"] != item.get("sha256") or proof["links"] not in {1, 2}:
        raise ProjectStateError("EJOURNAL_UNCERTAIN", "database restore stage no longer matches its journal proof", 2)
    return path


def _write_pin(root: Path, operation_id: str, source: dict[str, Any]) -> dict[str, Any]:
    directory = state_dir(root) / "pins"
    _mkdir_checked(state_dir(root))
    _mkdir_checked(directory)
    path = directory / f"{operation_id}.json"
    value = {"schemaVersion": 1, "kind": "database-restore", "operationId": operation_id,
             "rootIdentity": _root_id(root), "source": source, "token": secrets.token_hex(16)}
    data = _record_bytes(value)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        before = os.fstat(fd)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise OSError("pin write made no progress")
            view = view[count:]
        os.fsync(fd)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    final = path.lstat()
    if ((before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
            or (after.st_dev, after.st_ino) != (final.st_dev, final.st_ino)
            or final.st_nlink != 1 or final.st_size != len(data)):
        raise ProjectStateError("EPIN_UNCERTAIN", "database restore pin identity could not be verified", 2)
    return {"relativePath": f"pins/{operation_id}.json", "fileId": f"{final.st_dev}:{final.st_ino}",
            "sha256": hashlib.sha256(data).hexdigest(), "token": value["token"], "source": source}


def _verify_pin(root: Path, operation_id: str, record: dict[str, Any]) -> Path:
    pin = record.get("pin")
    if not isinstance(pin, dict) or pin.get("relativePath") != f"pins/{operation_id}.json":
        raise ProjectStateError("EPIN_UNCERTAIN", "database restore pin reference is invalid", 2)
    path = state_dir(root) / "pins" / f"{operation_id}.json"
    assert_plain_path(path, hardlinks=True)
    proof = _proof(path)
    if not proof["exists"] or proof["fileId"] != pin.get("fileId") or proof["sha256"] != pin.get("sha256") or proof["links"] != 1:
        raise ProjectStateError("EPIN_UNCERTAIN", "database restore pin changed; preserve operation and snapshot", 2)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProjectStateError("EPIN_UNCERTAIN", "database restore pin is unreadable", 2) from exc
    if value.get("operationId") != operation_id or value.get("token") != pin.get("token") or value.get("source") != pin.get("source") or value.get("rootIdentity") != _root_id(root):
        raise ProjectStateError("EPIN_UNCERTAIN", "database restore pin ownership does not match its journal", 2)
    return path


def _release_pin(root: Path, operation_id: str, record: dict[str, Any]) -> None:
    path = _verify_pin(root, operation_id, record)
    path.unlink()


def _release_pin_if_present(root: Path, operation_id: str, record: dict[str, Any]) -> None:
    path = state_dir(root) / "pins" / f"{operation_id}.json"
    try:
        path.lstat()
    except FileNotFoundError:
        return
    _release_pin(root, operation_id, record)


def _classify(root: Path, record: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any]]:
    target = _db_target(root, record.get("target"))
    stage = state_dir(root) / Path(*record["stage"]["relativePath"].split("/"))
    expected = record["stage"]
    try:
        current = _proof(target)
    except FileNotFoundError:
        current = _proof(target)
    try:
        staged = _proof(stage)
    except FileNotFoundError:
        staged = {"exists": False, "size": 0, "sha256": None, "fileId": None, "links": 0}
    phase = record["phase"]
    if record["status"] == "completed":
        if current["exists"] and current.get("fileId") == record.get("post", {}).get("fileId") and current.get("size") == expected["size"] and current.get("sha256") == expected["sha256"]:
            return "completed", current, staged
        return "uncertain", current, staged
    if record["status"] == "cancelled":
        return "cancelled-not-published", current, staged
    if record["status"] == "rolled-back":
        quarantine = state_dir(root) / Path(*record["quarantine"]["relativePath"].split("/"))
        qproof = _proof(quarantine)
        return ("rolled-back", current, staged) if (not current["exists"] and
                _same_object(record["rollbackExpected"], qproof, links=True)) else ("uncertain", current, staged)
    if record["status"] == "rolling-back":
        quarantine = state_dir(root) / Path(*record["quarantine"]["relativePath"].split("/"))
        try:
            qproof = _proof(quarantine)
        except FileNotFoundError:
            qproof = {"exists": False, "fileId": None, "size": 0, "sha256": None, "links": 0}
        if current["exists"] and not qproof["exists"] and _same_object(record["rollbackExpected"], current, links=True):
            return "rollback-awaiting-displacement", current, staged
        if not current["exists"] and qproof["exists"] and _same_object(record["rollbackExpected"], qproof, links=True):
            return "rollback-awaiting-retained", current, staged
        return "uncertain", current, staged
    if current["exists"]:
        if current.get("fileId") == expected["fileId"] and current["size"] == expected["size"] and current["sha256"] == expected["sha256"]:
            return "published-awaiting-verification", current, staged
        return "uncertain", current, staged
    if staged["exists"] and staged.get("fileId") == expected["fileId"] and staged["size"] == expected["size"] and staged["sha256"] == expected["sha256"]:
        return "prepared-awaiting-publication", current, staged
    return "uncertain", current, staged


def _load_source_for_record(root: Path, record: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    source = record["source"]
    pair = validate_pair(root, source["name"], source["generation"])
    artifact, metadata = _selected(pair, record["target"])
    if (artifact["id"] != source["artifactId"] or artifact["sha256"] != source["sha256"]
            or artifact["size"] != source["size"]):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "pinned SQLite source generation no longer matches the operation plan", 2)
    return artifact, metadata


def _cancel_not_published_proof(root: Path, operation_id: str,
                                record: dict[str, Any]) -> dict[str, Any] | None:
    """Prove a failed SQLite publication did not create or retire a target."""
    if (record.get("status") != "in-progress"
            or record.get("phase") not in {"prepared", "publish-intent"}):
        return None
    target = _db_target(root, record["target"])
    try:
        staged = _proof(state_dir(root) / Path(*record["stage"]["relativePath"].split("/")))
    except FileNotFoundError:
        return None
    if (staged.get("fileId") != record["stage"].get("fileId")
            or staged.get("size") != record["stage"].get("size")
            or staged.get("sha256") != record["stage"].get("sha256")):
        return None
    _verify_pin(root, operation_id, record)
    _load_source_for_record(root, record)
    if record.get("phase") == "prepared":
        # A prepared-only journal proves the publish-intent record was never
        # committed. No business path is touched by this cancellation; an
        # externally created destination is deliberately left in place.
        return {"preparedBeforePublication": True, "stageFileId": staged["fileId"],
                "stageSha256": staged["sha256"], "pinSha256": record["pin"]["sha256"]}
    classification, current, _ = _classify(root, record)
    if classification != "prepared-awaiting-publication" or current.get("exists") or _sidecars(target):
        return None
    return {"targetAbsent": True, "stageFileId": staged["fileId"],
            "stageSha256": staged["sha256"], "pinSha256": record["pin"]["sha256"]}


def _complete_interrupted_terminal_claim(root: Path, operation_id: str,
                                         record: dict[str, Any], lock: Any) -> None:
    pointer = record.get("resolverClaim")
    claims = load_claims(root, operation_id, "database", record) if record.get("ownerBinding") is not None else []
    if not claims or not isinstance(pointer, dict):
        return
    latest, _ = claims[-1]
    if latest.get("status") == "active":
        successor = begin_recovery(root, operation_id, "database", record, lock,
                                   "rollback" if record.get("status") in {"cancelled", "rolled-back"} else "continue")
        complete_recovery(root, operation_id, "database", record, lock, successor,
                          latest_operation_record_sha(root, operation_id, "database", record))
        lock.verify()


def _complete(root: Path, operation_id: str, record: dict[str, Any], current: dict[str, Any], stage: dict[str, Any]) -> dict[str, Any]:
    target = _db_target(root, record["target"])
    _verify_pin(root, operation_id, record)
    artifact, metadata = _load_source_for_record(root, record)
    _verify_sqlite(target, metadata)
    post = _proof(target)
    if post.get("fileId") != record["stage"]["fileId"] or post["size"] != record["stage"]["size"] or post["sha256"] != record["stage"]["sha256"]:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "published SQLite object no longer matches the staged publication proof", 2)
    if _sidecars(target):
        raise ProjectStateError("EDATABASE_SIDECAR", "SQLite sidecars appeared during verification; preserve the database", 2)
    if post["links"] != 1:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "restored SQLite target has unexpected hard links", 2)
    if stage["exists"]:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "private staging path still exists after publication; preserve all operation files", 2)
    completed = {**record, "phase": "completed", "status": "completed", "post": post}
    _append(root, operation_id, completed)
    return {"operationId": operation_id, "status": "verified", "target": record["target"],
            "snapshot": record["source"]["name"], "generation": record["source"]["generation"],
            "size": post["size"], "integrity": "ok", "schemaFingerprint": metadata["schemaFingerprint"],
            "totalRows": metadata["totalRows"], "rollbackPin": "retained-until-rollback-or-resolution",
            "applicationHealth": "not-tested"}


def apply_database_restore(root_value: str | os.PathLike[str], snapshot_name: str, target_name: str) -> dict[str, Any]:
    require_safe_sqlite()
    if os.name != "nt":
        raise ProjectStateError("EPLATFORM_UNVERIFIED", "SQLite restore is enabled only on verified Windows no-replace publication", 2)
    root = project_root(root_value)
    validate_snapshot_name(snapshot_name)
    target = _db_target(root, target_name)
    operation_placeholder = "0" * 32
    state = state_dir(root)
    require_windows_path_budget([
        target, state / "locks" / "operation.lock",
        state / "staging" / operation_placeholder / "private" / "database.stage",
        state / "staging" / operation_placeholder / "private" / "database.rollback",
        state / "operations" / operation_placeholder / "db-record-999999.json",
        state / "operations" / operation_placeholder / "db-record-999999.tmp-0123456789abcdef",
        state / "pins" / f"{operation_placeholder}.json",
        state / "resolvers" / operation_placeholder / "claim-999999.tmp-0123456789abcdef",
    ])
    check_restore_location(target, state)
    lock = _lock(root, "transaction")
    operation_id = uuid.uuid4().hex
    try:
        assert_no_unresolved_operations(root)
        preview = plan_database_restore(root, snapshot_name, target_name)
        pair = validate_pair(root, snapshot_name, preview["generation"])
        artifact, metadata = _selected(pair, target_name)
        # Refuse an already occupied destination before creating a restore
        # transaction, stage or pin. Repeat this check at publication below to
        # cover an external creator racing the preflight.
        if target.exists() or target.is_symlink() or _sidecars(target):
            raise ProjectStateError("EDATABASE_EXISTS", "destination or SQLite sidecar already exists; existing data was preserved", 2)
        source_path = Path(artifact["absolutePath"])
        source = {"name": snapshot_name, "generation": preview["generation"], "artifactId": artifact["id"],
                  "sha256": artifact["sha256"], "size": artifact["size"]}
        stage = _stage_copy(root, operation_id, source_path, artifact["size"], artifact["sha256"])
        stage_path = state_dir(root) / Path(*stage["relativePath"].split("/"))
        _verify_sqlite(stage_path, metadata)
        pin = _write_pin(root, operation_id, source)
        state = {"kind": "sqlite-create-missing", "rootIdentity": _root_id(root), "source": source,
                 "target": target_name, "stage": stage, "pin": pin, "phase": "prepared", "status": "in-progress",
                 "ownerBinding": owner_binding(lock)}
        _append(root, operation_id, state)
        lock.verify()
        # Re-run all path and sidecar checks at the business write boundary.
        if target.exists() or target.is_symlink() or _sidecars(target):
            raise ProjectStateError("EDATABASE_EXISTS", "destination or SQLite sidecar appeared after preview; external data was preserved", 2)
        _load_source_for_record(root, {**state})
        intent = {**state, "phase": "publish-intent"}
        _append(root, operation_id, intent)
        try:
            _publish_no_replace(stage_path, target)
        except ProjectStateError:
            raise
        current = _proof(target)
        if current.get("fileId") != stage["fileId"] or current["size"] != stage["size"] or current["sha256"] != stage["sha256"] or current["links"] != 1:
            raise ProjectStateError("EOPERATION_UNCERTAIN", "published SQLite object does not match its private stage identity", 2)
        published = {**intent, "phase": "published", "post": current}
        _append(root, operation_id, published)
        result = _complete(root, operation_id, published, current, _proof(stage_path))
        lock.verify()
        return result
    finally:
        lock.release()


def inspect_database_operation(root_value: str | os.PathLike[str], operation_id: str) -> dict[str, Any]:
    root = project_root(root_value)
    records = _load_records(root, operation_id)
    record = records[-1]
    claims = load_claims(root, operation_id, "database", record) if record.get("ownerBinding") is not None else []
    classification, current, stage = _classify(root, record)
    pin_path = state_dir(root) / "pins" / f"{operation_id}.json"
    try:
        pin_path.lstat()
    except FileNotFoundError:
        pin_state = "released" if record["status"] in {"rolled-back", "cancelled"} else "missing-unexpected"
    else:
        try:
            _verify_pin(root, operation_id, record)
            pin_state = "verified"
        except ProjectStateError:
            pin_state = "invalid-preserved"
    recovery_actions: list[str] = []
    if record.get("ownerBinding") is not None:
        if classification == "prepared-awaiting-publication":
            recovery_actions = ["--continue"]
            if _cancel_not_published_proof(root, record["operationId"], record) is not None:
                recovery_actions.append("--rollback")
        elif classification in {"published-awaiting-verification",
                                "rollback-awaiting-displacement", "rollback-awaiting-retained"}:
            recovery_actions = ["--continue"]
        elif classification == "completed":
            recovery_actions = ["--rollback"]
    return {"resultSchemaVersion": 1, "operationId": operation_id, "status": record["status"],
            "phase": record["phase"], "classification": classification, "target": record["target"],
            "source": {"name": record["source"]["name"], "generation": record["source"]["generation"]},
            "current": {"exists": current["exists"], "size": current["size"]},
            "stageIntegrity": "verified" if stage["exists"] else "absent",
            "pin": pin_state,
            "recoveryActions": recovery_actions,
            "resolver": ("legacy-unbound" if record.get("ownerBinding") is None else
                         "completed" if claims and claims[-1][0].get("status") == "completed" else
                         "active-or-not-started"),
            "databaseValues": "withheld"}


def continue_database_operation(root_value: str | os.PathLike[str], operation_id: str) -> dict[str, Any]:
    if os.name != "nt":
        raise ProjectStateError("EPLATFORM_UNVERIFIED", "SQLite recovery writes are enabled only on verified Windows no-replace publication", 2)
    root = project_root(root_value)
    lock = _lock(root, "transaction")
    try:
        record = _load_records(root, operation_id)[-1]
        classification, current, staged = _classify(root, record)
        if classification == "cancelled-not-published":
            _complete_interrupted_terminal_claim(root, operation_id, record, lock)
            lock.verify()
            return {"operationId": operation_id, "status": "cancelled", "target": record["target"],
                    "idempotent": True, "restoreApplied": False}
        if classification == "completed":
            _verify_pin(root, operation_id, record)
            _, metadata = _load_source_for_record(root, record)
            _verify_sqlite(_db_target(root, record["target"]), metadata)
            _complete_interrupted_terminal_claim(root, operation_id, record, lock)
            lock.verify()
            return {"operationId": operation_id, "status": "verified", "target": record["target"], "idempotent": True}
        if classification == "uncertain":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "SQLite target, stage, or journal does not prove a safe continuation; preserve all files and pins", 2)
        if classification == "prepared-awaiting-publication":
            require_same_volume(_db_target(root, record["target"]), state_dir(root))
        pointer = begin_recovery(root, operation_id, "database", record, lock, "continue")
        record = {**record, "resolverClaim": pointer}
        _append(root, operation_id, record)
        if record["status"] == "rolling-back":
            _verify_pin(root, operation_id, record)
            _load_source_for_record(root, record)
            result = _continue_database_rollback(root, operation_id, record)
            terminal = _load_records(root, operation_id)[-1]
            if terminal["status"] == "rolled-back":
                complete_recovery(root, operation_id, "database", terminal, lock, pointer,
                                  latest_operation_record_sha(root, operation_id, "database", terminal))
            return result
        _verify_pin(root, operation_id, record)
        _load_source_for_record(root, record)
        target = _db_target(root, record["target"])
        if classification == "prepared-awaiting-publication":
            stage_path = _stage_path(root, operation_id, record["stage"])
            lock.verify()
            if target.exists() or target.is_symlink() or _sidecars(target):
                raise ProjectStateError("EDATABASE_EXISTS", "destination or sidecar appeared before continuation; external data was preserved", 2)
            intent = record if record["phase"] == "publish-intent" else {**record, "phase": "publish-intent"}
            if intent is not record:
                _append(root, operation_id, intent)
            _publish_no_replace(stage_path, target)
            current = _proof(target)
            if (current.get("fileId") != record["stage"]["fileId"]
                    or current["sha256"] != record["stage"]["sha256"] or current["links"] != 1):
                raise ProjectStateError("EOPERATION_UNCERTAIN", "continued SQLite publication identity is uncertain", 2)
            published = {**intent, "phase": "published", "post": current}
            _append(root, operation_id, published)
            result = _complete(root, operation_id, published, current, _proof(stage_path))
        else:
            result = _complete(root, operation_id, record, current, staged)
        terminal = _load_records(root, operation_id)[-1]
        if terminal["status"] == "completed":
            complete_recovery(root, operation_id, "database", terminal, lock, pointer,
                              latest_operation_record_sha(root, operation_id, "database", terminal))
        lock.verify()
        return result
    finally:
        lock.release()


def rollback_database_operation(root_value: str | os.PathLike[str], operation_id: str) -> dict[str, Any]:
    if os.name != "nt":
        raise ProjectStateError("EPLATFORM_UNVERIFIED", "SQLite rollback is enabled only on verified Windows no-replace publication", 2)
    root = project_root(root_value)
    lock = _lock(root, "transaction")
    try:
        records = _load_records(root, operation_id)
        record = records[-1]
        classification, current, staged = _classify(root, record)
        if classification == "rolled-back":
            _release_pin_if_present(root, operation_id, record)
            _complete_interrupted_terminal_claim(root, operation_id, record, lock)
            lock.verify()
            return {"operationId": operation_id, "status": "rolled-back", "target": record["target"],
                    "privateQuarantineRetained": True, "idempotent": True}
        if classification == "cancelled-not-published":
            _complete_interrupted_terminal_claim(root, operation_id, record, lock)
            _release_pin_if_present(root, operation_id, record)
            lock.verify()
            return {"operationId": operation_id, "status": "cancelled", "target": record["target"],
                    "restoreApplied": False, "idempotent": True}
        cancel_proof = _cancel_not_published_proof(root, operation_id, record)
        if cancel_proof is None:
            require_same_volume(_db_target(root, record["target"]), state_dir(root))
        if record["status"] != "rolling-back" and cancel_proof is None and classification != "completed":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "database rollback requires a verified completed operation; preserve evidence", 2)
        if classification == "completed":
            _verify_pin(root, operation_id, record)
            _load_source_for_record(root, record)
            lock.verify()
        pointer = begin_recovery(root, operation_id, "database", record, lock, "rollback")
        record = {**record, "resolverClaim": pointer}
        _append(root, operation_id, record)
        if cancel_proof is not None:
            confirmed = _cancel_not_published_proof(root, operation_id, record)
            if confirmed is None:
                raise ProjectStateError("EOPERATION_UNCERTAIN", "SQLite target, stage, or rollback pin changed before cancellation; preserve operation evidence", 2)
            terminal = {**record, "phase": "cancelled", "status": "cancelled", "cancelProof": confirmed}
            _append(root, operation_id, terminal)
            _release_pin_if_present(root, operation_id, terminal)
            complete_recovery(root, operation_id, "database", terminal, lock, pointer,
                              latest_operation_record_sha(root, operation_id, "database", terminal))
            lock.verify()
            return {"operationId": operation_id, "status": "cancelled", "target": record["target"],
                    "verified": True, "restoreApplied": False, "rollbackPin": "released"}
        if record["status"] == "rolling-back":
            _verify_pin(root, operation_id, record)
            _load_source_for_record(root, record)
            result = _continue_database_rollback(root, operation_id, record)
            terminal = _load_records(root, operation_id)[-1]
            if terminal["status"] == "rolled-back":
                complete_recovery(root, operation_id, "database", terminal, lock, pointer,
                                  latest_operation_record_sha(root, operation_id, "database", terminal))
            return result
        if classification != "completed":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "database rollback requires a fully verified operation-created target", 2)
        expected = record.get("post")
        if not current["exists"] or not _same_object(expected or {}, current, links=True):
            raise ProjectStateError("ESOURCE_CHANGED", "database target identity or bytes changed; external data was preserved", 2)
        if _sidecars(_db_target(root, record["target"])):
            raise ProjectStateError("EDATABASE_SIDECAR", "database rollback refuses a target with SQLite sidecars", 2)
        quarantine_rel = f"staging/{operation_id}/private/database.rollback"
        quarantine = state_dir(root) / Path(*quarantine_rel.split("/"))
        if quarantine.exists() or quarantine.is_symlink():
            raise ProjectStateError("EOPERATION_UNCERTAIN", "database rollback quarantine already exists", 2)
        intent = {**record, "phase": "rollback-intent", "status": "rolling-back",
                  "rollbackExpected": expected, "quarantine": {"relativePath": quarantine_rel}}
        _append(root, operation_id, intent)
        result = _continue_database_rollback(root, operation_id, intent)
        terminal = _load_records(root, operation_id)[-1]
        if terminal["status"] == "rolled-back":
            complete_recovery(root, operation_id, "database", terminal, lock, pointer,
                              latest_operation_record_sha(root, operation_id, "database", terminal))
        lock.verify()
        return result
    finally:
        lock.release()


def _continue_database_rollback(root: Path, operation_id: str, record: dict[str, Any]) -> dict[str, Any]:
    if os.name != "nt":
        raise ProjectStateError("EPLATFORM_UNVERIFIED", "SQLite rollback is enabled only on verified Windows no-replace publication", 2)
    classification, current, _ = _classify(root, record)
    target = _db_target(root, record["target"])
    quarantine = state_dir(root) / Path(*record["quarantine"]["relativePath"].split("/"))
    if classification == "rollback-awaiting-displacement":
        if _sidecars(target):
            raise ProjectStateError("EDATABASE_SIDECAR", "SQLite sidecars appeared during rollback; preserve database", 2)
        require_same_volume(target.parent, quarantine.parent)
        try:
            os.rename(target, quarantine)
        except OSError as exc:
            raise ProjectStateError("EOPERATION_UNCERTAIN", "database could not be retired to private quarantine", 2) from exc
        moved = _proof(quarantine)
        if not _same_object(record["rollbackExpected"], moved, links=True):
            try:
                if not _proof(target)["exists"]:
                    require_same_volume(quarantine.parent, target.parent)
                    os.rename(quarantine, target)
            except OSError:
                pass
            raise ProjectStateError("EOPERATION_UNCERTAIN", "retired database identity differs; preserve target and quarantine", 2)
        classification = "rollback-awaiting-retained"
    if classification == "rollback-awaiting-retained":
        proof = _proof(quarantine)
        if not _same_object(record["rollbackExpected"], proof, links=True):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback quarantine changed; preserve it", 2)
    else:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "database rollback interruption is not safely resumable", 2)
    if target.exists() or target.is_symlink() or _sidecars(target):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "database or sidecar reappeared during rollback recovery", 2)
    final = {**record, "phase": "rolled-back", "status": "rolled-back"}
    _append(root, operation_id, final)
    _release_pin_if_present(root, operation_id, final)
    return {"operationId": operation_id, "status": "rolled-back", "target": record["target"],
            "verified": True, "privateQuarantineRetained": True}


def has_database_operation(root_value: str | os.PathLike[str], operation_id: str) -> bool:
    base = _operation_dir(project_root(root_value), operation_id)
    try:
        base.lstat()
    except FileNotFoundError:
        return False
    assert_plain_path(base)
    if not stat.S_ISDIR(base.lstat().st_mode):
        raise ProjectStateError("EJOURNAL_UNSAFE", "operation journal path is not a directory", 2)
    entries = list(base.iterdir())
    database_names = [entry for entry in entries if entry.name.startswith("db-record-")]
    config_names = [entry for entry in entries if entry.name.startswith("record-")]
    if database_names and config_names:
        raise ProjectStateError("EJOURNAL_CONFLICT", "operation directory contains both database and config journal evidence", 2)
    # Route based on record-family presence, including temporary/uncommitted
    # names. The database parser remains responsible for validating or refusing
    # their contents, so a temp filename is never treated as business truth.
    return bool(database_names)


def recover_database_operation(root_value: str | os.PathLike[str], operation_id: str, action: str) -> dict[str, Any]:
    if action == "inspect":
        return inspect_database_operation(root_value, operation_id)
    if action == "continue":
        return continue_database_operation(root_value, operation_id)
    if action == "rollback":
        return rollback_database_operation(root_value, operation_id)
    raise ProjectStateError("EARG_ACTION", "database recovery action is invalid", 1)
