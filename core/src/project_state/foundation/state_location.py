from __future__ import annotations

"""Explicit state-root registration layered over the legacy state-root layout.

The stable per-user state slot is the transaction record. The selected data
root is always published on the project's volume; no cross-volume rename or
copy/delete is used.
"""

import hashlib
import json
import os
import stat
import uuid
from pathlib import Path
from typing import Any

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.location_acl import assert_private_windows_acl
from project_state.foundation.paths import (assert_plain_path, project_root,
    require_same_volume, require_windows_path_budget, volume_identity)

_LOCATION_RUNTIME = "project-state-python-location"
_LOCATION_SCHEMA = 1
_CONTROL_OWNER = ".state-location-owner.json"
_CONTROL_LOCK_SUFFIX = ".state-location.lock"
_LOCATION_PROOF = "state-location.json"
_STAGE_PREFIX = ".project-state-location-stage-"
_CONTROL_STAGE_PREFIX = ".project-state-location-control-"
_MARKER = "state-root.json"
_INIT_PROOF = "state-root.initialization.json"
_RUNTIME = "project-state-python"
_LAYOUT = 1

# Test-only synchronization seams. The CLI never reads an environment variable
# to disable ACL or identity checks.
_LOCATION_TEST_HOOK = None
_PRIVATE_ACL_TEST_HOOK = None


def _check_private_acl(path: Path) -> None:
    hook = _PRIVATE_ACL_TEST_HOOK
    if hook is not None:
        hook(path)
        return
    assert_private_windows_acl(path)


def _checkpoint(name: str, path: Path) -> None:
    hook = _LOCATION_TEST_HOOK
    if hook is not None:
        hook(name, path)


def _canonical(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(os.fspath(left))) == os.path.normcase(os.path.abspath(os.fspath(right)))


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate JSON key")
        out[key] = value
    return out


def _json_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"


def _identity(path: Path) -> dict[str, int]:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or not info.st_ino:
        raise ProjectStateError("ELOCATION_IDENTITY", "state location directory identity is unavailable; preserve it", 2)
    return {"device": int(info.st_dev), "inode": int(info.st_ino)}


def _read_json(path: Path, *, max_bytes: int = 16384) -> tuple[dict[str, Any], bytes, os.stat_result]:
    try:
        assert_plain_path(path, hardlinks=True)
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > max_bytes:
            raise ProjectStateError("ELOCATION_RECORD", "state location record has an unsupported file identity; preserve it", 2)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink) != (
                    before.st_dev, before.st_ino, before.st_size, before.st_nlink):
                raise ProjectStateError("ELOCATION_IDENTITY", "state location record changed while opening; preserve it", 2)
            raw = bytearray()
            while len(raw) <= max_bytes:
                chunk = os.read(fd, min(4096, max_bytes + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            after_fd = os.fstat(fd)
        finally:
            os.close(fd)
        after = path.lstat()
        if (len(raw) > max_bytes or len(raw) != before.st_size
                or (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_nlink)
                != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
                or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_nlink)
                != (after.st_dev, after.st_ino, after.st_size, after.st_nlink)):
            raise ProjectStateError("ELOCATION_IDENTITY", "state location record changed while reading; preserve it", 2)
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs)
        if not isinstance(value, dict):
            raise ValueError("record is not an object")
        return value, bytes(raw), after
    except ProjectStateError as exc:
        if exc.code.startswith("ELOCATION"):
            raise
        raise ProjectStateError("ELOCATION_RECORD", "state location record is missing, linked, or unreadable; preserve it", 2) from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        raise ProjectStateError("ELOCATION_RECORD", "state location record is missing, damaged, or unreadable; preserve it", 2) from exc


def _write_exclusive(path: Path, payload: bytes) -> os.stat_result:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ProjectStateError("ELOCATION_IDENTITY", "new state location record has an unsafe identity", 2)
        view = memoryview(payload)
        offset = 0
        while offset < len(view):
            count = os.write(fd, view[offset:])
            if count <= 0:
                raise OSError("no progress writing location record")
            offset += count
        os.fsync(fd)
        final = os.fstat(fd)
        path_info = path.lstat()
        if ((final.st_dev, final.st_ino, final.st_size, final.st_nlink)
                != (path_info.st_dev, path_info.st_ino, len(payload), 1)):
            raise ProjectStateError("ELOCATION_IDENTITY", "new location record identity changed", 2)
        return final
    finally:
        os.close(fd)


def _sync_directory(path: Path) -> None:
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _control_path(root: Path) -> Path:
    from project_state.foundation.state_paths import _user_state_home, _RUNTIME, _LAYOUT, project_identity
    return _user_state_home() / _RUNTIME / f"v{_LAYOUT}" / project_identity(root)


def _require_location_write_paths_supported(project: Path, target: Path,
                                            project_id: str, control: Path) -> None:
    """Budget every deterministic and UUID-derived path before location writes.

    The console entry point is not certified for Win32 extended paths. Check
    both publication stages and every file they may create before making the
    private control parent, lock, control record, or selected data directory.
    """
    control_parent = control.parent
    control_stage = control_parent / (
        f"{_CONTROL_STAGE_PREFIX}{project_id}-{'0' * 32}"
    )
    data_stage = target.parent / f"{_STAGE_PREFIX}{'0' * 32}"
    lock = control_parent / f".{project_id}{_CONTROL_LOCK_SUFFIX}"
    paths = [
        project,
        control_parent,
        control,
        lock,
        control / _CONTROL_OWNER,
        control / _MARKER,
        control / f".{_MARKER}.tmp-{'0' * 32}",
        control_stage,
        control_stage / _CONTROL_OWNER,
        control_stage / _MARKER,
        target.parent,
        target,
        target / _MARKER,
        target / _INIT_PROOF,
        target / _LOCATION_PROOF,
        data_stage,
        data_stage / ".state-location-stage-owner.json",
        data_stage / _MARKER,
        data_stage / _INIT_PROOF,
        data_stage / _LOCATION_PROOF,
    ]
    require_windows_path_budget(paths)


def _validate_control_owner(control: Path, project_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    control_id = _identity(control)
    owner, _, _ = _read_json(control / _CONTROL_OWNER)
    expected_owner = {"schemaVersion", "runtime", "projectIdentity", "operationId", "controlName",
                      "lockFile", "controlIdentity", "lockIdentity"}
    if (not isinstance(owner.get("controlName"), str) or owner["controlName"] != project_id
            or owner.get("lockFile") != f".{project_id}{_CONTROL_LOCK_SUFFIX}"):
        raise ProjectStateError("ELOCATION_IDENTITY", "state location lock binding does not match this project", 2)
    try:
        lock_info = (control.parent / owner["lockFile"]).lstat()
    except OSError as exc:
        raise ProjectStateError("ELOCATION_IDENTITY", "state location lock is missing or unreadable; preserve it", 2) from exc
    lock_id = {"device": int(lock_info.st_dev), "inode": int(lock_info.st_ino)}
    if (set(owner) != expected_owner or type(owner.get("schemaVersion")) is not int
            or owner.get("schemaVersion") != _LOCATION_SCHEMA or owner.get("runtime") != _LOCATION_RUNTIME
            or owner.get("projectIdentity") != project_id
            or not isinstance(owner.get("operationId"), str) or len(owner["operationId"]) != 32
            or any(ch not in "0123456789abcdef" for ch in owner["operationId"])
            or owner.get("controlIdentity") != control_id or owner.get("lockIdentity") != lock_id
            or not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1 or lock_info.st_size != 1):
        raise ProjectStateError("ELOCATION_IDENTITY", "state location ownership proof does not match; preserve all files", 2)
    marker, raw, marker_stat = _read_json(control / _MARKER)
    expected_marker = {"schemaVersion", "runtime", "layoutVersion", "projectIdentity", "operationId",
                       "status", "selectedRoot", "volumeIdentity", "controlIdentity", "lockIdentity",
                       "dataIdentity", "locationProofSha256"}
    if (set(marker) != expected_marker or type(marker.get("schemaVersion")) is not int
            or marker.get("schemaVersion") != _LOCATION_SCHEMA or marker.get("runtime") != _LOCATION_RUNTIME
            or type(marker.get("layoutVersion")) is not int or marker["layoutVersion"] != _LAYOUT
            or marker.get("projectIdentity") != project_id or marker.get("operationId") != owner["operationId"]
            or marker.get("status") not in {"pending", "data-published", "active"}
            or not isinstance(marker.get("selectedRoot"), str) or not Path(marker["selectedRoot"]).is_absolute()
            or not isinstance(marker.get("volumeIdentity"), str)
            or marker.get("controlIdentity") != control_id or marker.get("lockIdentity") != lock_id
            or (marker["status"] in {"data-published", "active"} and (not isinstance(marker.get("dataIdentity"), dict)
                or not isinstance(marker.get("locationProofSha256"), str)))
            or (marker["status"] == "pending" and (marker.get("dataIdentity") is not None
                or marker.get("locationProofSha256") is not None))):
        raise ProjectStateError("ELOCATION_RECORD", "state location record is invalid; preserve it and do not fall back", 2)
    marker["_raw"] = raw
    marker["_stat"] = marker_stat
    return owner, marker


def _verify_data_root(root: Path, project_id: str, record: dict[str, Any]) -> Path:
    from project_state.foundation.state_paths import _verify_state_dir
    data_root = Path(record["selectedRoot"])
    if not _same_path(data_root, _canonical(data_root)):
        raise ProjectStateError("ELOCATION_PATH", "selected state root is not canonical; preserve the existing state", 2)
    assert_plain_path(data_root)
    _check_private_acl(data_root)
    require_same_volume(root, data_root)
    _verify_state_dir(data_root, project_id, require_initialization_proof=True)
    proof, raw, _ = _read_json(data_root / _LOCATION_PROOF)
    expected = {"schemaVersion", "runtime", "projectIdentity", "operationId", "selectedRootSha256",
                "volumeIdentity", "rootIdentity"}
    root_id = _identity(data_root)
    if (set(proof) != expected or type(proof.get("schemaVersion")) is not int
            or proof["schemaVersion"] != _LOCATION_SCHEMA or proof.get("runtime") != _LOCATION_RUNTIME
            or proof.get("projectIdentity") != project_id or proof.get("operationId") != record["operationId"]
            or proof.get("selectedRootSha256") != hashlib.sha256(os.fspath(data_root).encode("utf-8")).hexdigest()
            or proof.get("volumeIdentity") != record["volumeIdentity"] or proof.get("rootIdentity") != root_id
            or record.get("dataIdentity") != root_id
            or record.get("locationProofSha256") != hashlib.sha256(raw).hexdigest()
            or volume_identity(data_root) != record["volumeIdentity"]):
        raise ProjectStateError("ELOCATION_IDENTITY", "selected state root proof changed; preserve data and resolve manually", 2)
    return data_root


def resolve_state_root(root: Path, default_root: Path, project_id: str) -> Path:
    """Resolve all application paths through the same read-only location gate."""
    try:
        default_root.lstat()
    except FileNotFoundError:
        assert_no_location_stage_residue(default_root.parent, project_id)
        return default_root
    except OSError as exc:
        raise ProjectStateError("ELOCATION_RECORD", "state location cannot be inspected; preserve it", 2) from exc
    marker_path = default_root / _MARKER
    try:
        marker, _, _ = _read_json(marker_path)
    except ProjectStateError:
        # Preserve the original legacy diagnostic for markerless or damaged roots.
        from project_state.foundation.state_paths import _verify_state_dir
        _verify_state_dir(default_root, project_id)
        raise AssertionError("legacy state root verifier unexpectedly accepted without returning")
    if marker.get("runtime") != _LOCATION_RUNTIME:
        from project_state.foundation.state_paths import _verify_state_dir
        _verify_state_dir(default_root, project_id)
        return default_root
    owner, record = _validate_control_owner(default_root, project_id)
    if record["status"] != "active":
        raise ProjectStateError("ELOCATION_PENDING", "state location initialization is incomplete; rerun state-location init with the same path to inspect and resume it", 2)
    selected = _verify_data_root(root, project_id, record)
    return selected


def _check_candidate(root: Path, candidate: Path, *, allow_own_residue_for_resume: bool = False) -> tuple[Path, str]:
    from project_state.foundation.state_paths import _verify_state_dir, project_identity
    project = project_root(root)
    project_id = project_identity(project)
    target = _canonical(candidate if candidate.is_absolute() else project / candidate)
    if _same_path(target, project) or _same_path(target, project / ".git") or _same_path(target, project / ".project-state"):
        raise ProjectStateError("ELOCATION_PATH", "selected state root must be outside the project and Git worktree", 2)
    try:
        target.relative_to(project)
    except ValueError:
        pass
    else:
        raise ProjectStateError("ELOCATION_PATH", "selected state root must be outside the project and Git worktree", 2)
    parent = target.parent
    assert_plain_path(parent)
    if not parent.is_dir():
        raise ProjectStateError("ELOCATION_PATH", "selected state parent must be an existing plain directory", 2)
    _check_private_acl(parent)
    require_same_volume(project, parent)
    default_root = _control_path(project)
    try:
        default_root.lstat()
    except FileNotFoundError:
        if not allow_own_residue_for_resume:
            assert_no_location_stage_residue(default_root.parent, project_id)
        try:
            target.lstat()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise ProjectStateError("ELOCATION_PATH", "selected state target cannot be inspected", 2) from exc
        else:
            raise ProjectStateError("ELOCATION_EXISTS", "selected state target already exists; it will not be adopted or overwritten", 2)
    else:
        try:
            _verify_state_dir(default_root, project_identity(project))
        except ProjectStateError:
            # A current location transaction is handled by its exact resume path.
            try:
                _, control = _validate_control_owner(default_root, project_identity(project))
            except ProjectStateError:
                raise ProjectStateError("ELOCATION_EXISTING", "project already has state or an unresolved location record; switching is refused", 2)
            if not _same_path(Path(control["selectedRoot"]), target):
                raise ProjectStateError("ELOCATION_CONFLICT", "a pending or active location exists for a different path", 2)
            if control["status"] == "active":
                if not target.exists():
                    raise ProjectStateError("ELOCATION_IDENTITY", "active selected state root is missing; preserve the registration", 2)
                _verify_data_root(project, project_identity(project), control)
            elif target.exists():
                # During a pending operation, an existing target is accepted
                # only if its proof is bound to this exact operation.
                proof, _, _ = _read_json(target / _LOCATION_PROOF)
                if proof.get("operationId") != control["operationId"]:
                    raise ProjectStateError("ELOCATION_CONFLICT", "selected target exists without the pending operation proof", 2)
        else:
            raise ProjectStateError("ELOCATION_EXISTING", "project already has a legacy state root; automatic migration is not supported", 2)
    return target, project_id


def inspect_state_location(root: Path) -> dict[str, Any]:
    from project_state.foundation.state_paths import project_identity
    project = project_root(root)
    default_root = _control_path(project)
    try:
        default_root.lstat()
    except FileNotFoundError:
        assert_no_location_stage_residue(default_root.parent, project_identity(project))
        return {"resultSchemaVersion": 1, "mode": "default", "stateExists": False,
                "projectIdentity": project_identity(project)}
    try:
        marker, _, _ = _read_json(default_root / _MARKER)
    except ProjectStateError:
        from project_state.foundation.state_paths import _verify_state_dir
        _verify_state_dir(default_root, project_identity(project))
        return {"resultSchemaVersion": 1, "mode": "default", "stateExists": True,
                "projectIdentity": project_identity(project), "stateRoot": os.fspath(default_root)}
    if marker.get("runtime") != _LOCATION_RUNTIME:
        from project_state.foundation.state_paths import _verify_state_dir
        _verify_state_dir(default_root, project_identity(project))
        return {"resultSchemaVersion": 1, "mode": "default", "stateExists": True,
                "projectIdentity": project_identity(project), "stateRoot": os.fspath(default_root)}
    _, record = _validate_control_owner(default_root, project_identity(project))
    if record["status"] == "active":
        selected = _verify_data_root(project, project_identity(project), record)
        return {"resultSchemaVersion": 1, "mode": "explicit", "stateExists": True,
                "projectIdentity": project_identity(project), "stateRoot": os.fspath(selected),
                "volumeIdentity": record["volumeIdentity"]}
    return {"resultSchemaVersion": 1, "mode": "pending", "stateExists": False,
            "projectIdentity": project_identity(project), "operationId": record["operationId"],
            "phase": record["status"]}


def check_state_location(root: Path, candidate: Path) -> dict[str, Any]:
    target, project_id = _check_candidate(root, candidate)
    return {"resultSchemaVersion": 1, "mode": "candidate", "projectIdentity": project_id,
            "stateRoot": os.fspath(target), "sameVolume": True,
            "privacy": "parent ACL verified read-only", "stateChanged": False}


def _acquire_location_lock(control: Path, owner: dict[str, Any]) -> int:
    import msvcrt
    path = control.parent / owner["lockFile"]
    before = path.lstat()
    expected = owner["lockIdentity"]
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != 1
            or {"device": int(before.st_dev), "inode": int(before.st_ino)} != expected):
        raise ProjectStateError("ELOCATION_IDENTITY", "location lock identity changed; preserve it", 2)
    fd = os.open(path, os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    opened = os.fstat(fd)
    current = path.lstat()
    if (opened.st_dev, opened.st_ino, opened.st_nlink, opened.st_size) != (
            before.st_dev, before.st_ino, 1, 1) or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
        os.close(fd)
        raise ProjectStateError("ELOCATION_IDENTITY", "location lock changed while opening; preserve it", 2)
    try:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError as exc:
        os.close(fd)
        raise ProjectStateError("ELOCATION_BUSY", "another state-location initializer currently owns the OS lock", 2) from exc
    return fd


def _release_location_lock(fd: int) -> None:
    import msvcrt
    try:
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)


def _control_record(control: Path, project_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    return _validate_control_owner(control, project_id)


def _write_control(control: Path, record: dict[str, Any], owner: dict[str, Any]) -> None:
    control_id = owner["controlIdentity"]
    if _identity(control) != control_id:
        raise ProjectStateError("ELOCATION_IDENTITY", "location control directory changed before update; preserve it", 2)
    marker_path = control / _MARKER
    current, current_raw, current_stat = _read_json(marker_path)
    if current.get("operationId") != owner["operationId"]:
        raise ProjectStateError("ELOCATION_IDENTITY", "location operation token changed before update; preserve it", 2)
    temp = control / f".{_MARKER}.tmp-{uuid.uuid4().hex}"
    temp_info = _write_exclusive(temp, _json_bytes(record))
    _checkpoint(f"control-{record['status']}-temp-written", temp)
    temp_value, temp_raw, temp_after = _read_json(temp)
    if (temp_value != record or temp_raw != _json_bytes(record)
            or (temp_info.st_dev, temp_info.st_ino, temp_info.st_size)
            != (temp_after.st_dev, temp_after.st_ino, temp_after.st_size)):
        raise ProjectStateError("ELOCATION_IDENTITY", "prepared location record changed before commit; preserve it", 2)
    if _identity(control) != control_id:
        raise ProjectStateError("ELOCATION_IDENTITY", "location control directory changed before publication", 2)
    latest, latest_raw, latest_stat = _read_json(marker_path)
    if (latest.get("operationId") != owner["operationId"] or latest_raw != current_raw
            or (latest_stat.st_dev, latest_stat.st_ino) != (current_stat.st_dev, current_stat.st_ino)):
        raise ProjectStateError("ELOCATION_CONFLICT", "location record changed concurrently; preserve all evidence", 2)
    os.replace(temp, marker_path)
    _sync_directory(control)
    _checkpoint(f"control-{record['status']}-published", marker_path)
    after, _, _ = _read_json(marker_path)
    if after != record:
        raise ProjectStateError("ELOCATION_IDENTITY", "published location record failed verification", 2)


def _write_data_stage(stage: Path, target: Path, project_id: str, operation_id: str, volume: str) -> None:
    from project_state.foundation.state_paths import _verify_state_dir
    stage.mkdir()
    stage_id = _identity(stage)
    _checkpoint("data-stage-created", stage)
    owner = {"schemaVersion": 1, "runtime": _LOCATION_RUNTIME, "projectIdentity": project_id,
             "operationId": operation_id, "stageIdentity": stage_id}
    _write_exclusive(stage / ".state-location-stage-owner.json", _json_bytes(owner))
    _checkpoint("data-stage-owner-published", stage)
    marker_payload = _json_bytes({"runtime": _RUNTIME, "layoutVersion": _LAYOUT,
                                  "projectIdentity": project_id})
    marker_info = _write_exclusive(stage / _MARKER, marker_payload)
    init_payload = _json_bytes({"schemaVersion": 1, "runtime": _RUNTIME, "layoutVersion": _LAYOUT,
        "projectIdentity": project_id, "initializationId": operation_id,
        "directoryIdentity": stage_id, "markerIdentity": {"device": int(marker_info.st_dev), "inode": int(marker_info.st_ino)},
        "markerSha256": hashlib.sha256(marker_payload).hexdigest()})
    _write_exclusive(stage / _INIT_PROOF, init_payload)
    location_proof = {"schemaVersion": 1, "runtime": _LOCATION_RUNTIME, "projectIdentity": project_id,
        "operationId": operation_id, "selectedRootSha256": hashlib.sha256(os.fspath(target).encode("utf-8")).hexdigest(),
        "volumeIdentity": volume, "rootIdentity": stage_id}
    _write_exclusive(stage / _LOCATION_PROOF, _json_bytes(location_proof))
    _sync_directory(stage)
    _verify_state_dir(stage, project_id, require_initialization_proof=True)
    _checkpoint("data-stage-verified", stage)


def _verify_owned_stage(stage: Path, target: Path, project_id: str, operation_id: str, volume: str) -> None:
    from project_state.foundation.state_paths import _verify_state_dir
    owner, _, _ = _read_json(stage / ".state-location-stage-owner.json")
    if (set(owner) != {"schemaVersion", "runtime", "projectIdentity", "operationId", "stageIdentity"}
            or owner.get("schemaVersion") != 1 or owner.get("runtime") != _LOCATION_RUNTIME
            or owner.get("projectIdentity") != project_id or owner.get("operationId") != operation_id
            or owner.get("stageIdentity") != _identity(stage)):
        raise ProjectStateError("ELOCATION_STAGE", "staged location has no matching ownership proof; preserve it", 2)
    expected_names = {".state-location-stage-owner.json", _MARKER, _INIT_PROOF, _LOCATION_PROOF}
    if any(child.name not in expected_names for child in stage.iterdir()):
        raise ProjectStateError("ELOCATION_STAGE", "staged location contains unknown files; preserve it", 2)
    marker_path = stage / _MARKER
    try:
        marker_path.lstat()
    except FileNotFoundError:
        if any((stage / name).exists() for name in (_INIT_PROOF, _LOCATION_PROOF)):
            raise ProjectStateError("ELOCATION_STAGE", "staged proof exists without its marker; preserve it", 2)
        marker_payload = _json_bytes({"runtime": _RUNTIME, "layoutVersion": _LAYOUT,
                                      "projectIdentity": project_id})
        marker_info = _write_exclusive(marker_path, marker_payload)
    else:
        marker_value, marker_raw, marker_info = _read_json(marker_path)
        marker_payload = _json_bytes({"runtime": _RUNTIME, "layoutVersion": _LAYOUT,
                                      "projectIdentity": project_id})
        if marker_raw != marker_payload or marker_value != {"runtime": _RUNTIME,
                "layoutVersion": _LAYOUT, "projectIdentity": project_id}:
            raise ProjectStateError("ELOCATION_STAGE", "staged marker differs from the operation; preserve it", 2)
    init_path = stage / _INIT_PROOF
    try:
        init_path.lstat()
    except FileNotFoundError:
        _write_exclusive(init_path, _json_bytes({"schemaVersion": 1, "runtime": _RUNTIME,
            "layoutVersion": _LAYOUT, "projectIdentity": project_id, "initializationId": operation_id,
            "directoryIdentity": _identity(stage),
            "markerIdentity": {"device": int(marker_info.st_dev), "inode": int(marker_info.st_ino)},
            "markerSha256": hashlib.sha256(marker_payload).hexdigest()}))
    proof_path = stage / _LOCATION_PROOF
    try:
        proof_path.lstat()
    except FileNotFoundError:
        _write_exclusive(proof_path, _json_bytes({"schemaVersion": 1, "runtime": _LOCATION_RUNTIME,
            "projectIdentity": project_id, "operationId": operation_id,
            "selectedRootSha256": hashlib.sha256(os.fspath(target).encode("utf-8")).hexdigest(),
            "volumeIdentity": volume, "rootIdentity": _identity(stage)}))
    _sync_directory(stage)
    _verify_state_dir(stage, project_id, require_initialization_proof=True)
    proof, proof_raw, _ = _read_json(proof_path)
    expected = {"schemaVersion", "runtime", "projectIdentity", "operationId", "selectedRootSha256", "volumeIdentity", "rootIdentity"}
    if (set(proof) != expected or proof.get("schemaVersion") != 1 or proof.get("runtime") != _LOCATION_RUNTIME
            or proof.get("projectIdentity") != project_id or proof.get("operationId") != operation_id
            or proof.get("selectedRootSha256") != hashlib.sha256(os.fspath(target).encode("utf-8")).hexdigest()
            or proof.get("volumeIdentity") != volume or proof.get("rootIdentity") != _identity(stage)):
        raise ProjectStateError("ELOCATION_STAGE", "staged location proof differs from the pending operation; preserve it", 2)


def _new_control(project: Path, control: Path, project_id: str, selected_root: Path,
                 volume: str) -> tuple[dict[str, Any], dict[str, Any]]:
    _require_location_write_paths_supported(project, selected_root, project_id, control)
    parent = control.parent
    parent.mkdir(parents=True, exist_ok=True)
    assert_plain_path(parent)
    try:
        control.lstat()
    except FileNotFoundError:
        pass
    else:
        return _control_record(control, project_id)
    stage_prefix = f"{_CONTROL_STAGE_PREFIX}{project_id}-"
    residues = [p for p in parent.iterdir() if p.name.startswith(stage_prefix)]
    if residues:
        if len(residues) != 1 or not residues[0].is_dir():
            raise ProjectStateError("ELOCATION_RESIDUE", "multiple or non-directory location stages exist; preserve them", 2)
        stage = residues[0]
        staged_owner, staged_record = _control_record(stage, project_id)
        if (not _same_path(Path(staged_record["selectedRoot"]), selected_root)
                or staged_record["volumeIdentity"] != volume or staged_record["status"] != "pending"):
            raise ProjectStateError("ELOCATION_RESIDUE", "staged location intent belongs to another request; preserve it", 2)
        fd = _acquire_location_lock(stage, staged_owner)
        try:
            try:
                os.rename(stage, control)
            except FileExistsError:
                pass
            except FileNotFoundError:
                # A competing process may have published the same proven stage.
                pass
            _sync_directory(parent)
        finally:
            _release_location_lock(fd)
        return _control_record(control, project_id)
    lock_path = parent / f".{control.name}{_CONTROL_LOCK_SUFFIX}"
    if lock_path.exists():
        lock_info = lock_path.lstat()
        provisional = {"lockFile": lock_path.name,
                       "lockIdentity": {"device": int(lock_info.st_dev), "inode": int(lock_info.st_ino)}}
        fd = _acquire_location_lock(control, provisional)
        _release_location_lock(fd)
        raise ProjectStateError("ELOCATION_RESIDUE", "a location lock remains without its control intent; preserve it for manual inspection", 2)
    token = uuid.uuid4().hex
    lock_info = _write_exclusive(lock_path, b"\0")
    lock_id = {"device": int(lock_info.st_dev), "inode": int(lock_info.st_ino)}
    provisional = {"lockFile": lock_path.name, "lockIdentity": lock_id}
    fd = _acquire_location_lock(control, provisional)
    try:
        stage = parent / f"{_CONTROL_STAGE_PREFIX}{project_id}-{token}"
        stage.mkdir()
        control_id = _identity(stage)
        owner = {"schemaVersion": 1, "runtime": _LOCATION_RUNTIME, "projectIdentity": project_id,
                 "operationId": token, "controlName": project_id, "lockFile": lock_path.name,
                 "controlIdentity": control_id, "lockIdentity": lock_id}
        _write_exclusive(stage / _CONTROL_OWNER, _json_bytes(owner))
        record = {"schemaVersion": 1, "runtime": _LOCATION_RUNTIME, "layoutVersion": _LAYOUT,
            "projectIdentity": project_id, "operationId": token, "status": "pending",
            "selectedRoot": os.fspath(selected_root), "volumeIdentity": volume,
            "controlIdentity": control_id, "lockIdentity": lock_id,
            "dataIdentity": None, "locationProofSha256": None}
        _write_exclusive(stage / _MARKER, _json_bytes(record))
        _sync_directory(stage)
        _checkpoint("control-stage-ready", stage)
        try:
            os.rename(stage, control)
        except FileExistsError:
            return _control_record(control, project_id)
        except FileNotFoundError:
            return _control_record(control, project_id)
        _sync_directory(parent)
        _checkpoint("control-pending-published", control)
    finally:
        _release_location_lock(fd)
    return _control_record(control, project_id)


def assert_no_location_stage_residue(parent: Path, project_id: str) -> None:
    """Block this project's default root on its own unpublished location evidence."""
    try:
        parent.lstat()
    except FileNotFoundError:
        return
    try:
        stage_prefix = f"{_CONTROL_STAGE_PREFIX}{project_id}-"
        lock_name = f".{project_id}{_CONTROL_LOCK_SUFFIX}"
        residues = [p for p in parent.iterdir()
                    if p.name.startswith(stage_prefix) or p.name == lock_name]
    except OSError as exc:
        raise ProjectStateError("ELOCATION_RECORD", "state location staging area cannot be inspected; preserve it", 2) from exc
    if residues:
        raise ProjectStateError("ELOCATION_RESIDUE", "unpublished state-location evidence exists; preserve it for manual inspection", 2)


def initialize_state_location(root: Path, candidate: Path) -> dict[str, Any]:
    """Create or resume a token-bound explicit location for a new project."""
    if os.name != "nt":
        raise ProjectStateError("EUNSUPPORTED", "explicit state-location publication is enabled only on the verified Windows path", 2)
    import msvcrt  # Windows-only publication/locking path.
    from project_state.foundation.state_paths import _verify_state_dir, project_identity
    project = project_root(root)
    target, project_id = _check_candidate(project, candidate, allow_own_residue_for_resume=True)
    control = _control_path(project)
    volume = volume_identity(project)
    try:
        control.lstat()
    except FileNotFoundError:
        owner, record = _new_control(project, control, project_id, target, volume)
    else:
        owner, record = _control_record(control, project_id)
        if not _same_path(Path(record["selectedRoot"]), target):
            raise ProjectStateError("ELOCATION_CONFLICT", "pending or active location is bound to another exact path", 2)
        if record["status"] == "active":
            _verify_data_root(project, project_id, record)
            return {"mode": "explicit", "stateRoot": record["selectedRoot"], "status": "already-active",
                    "operationId": record["operationId"]}

    # Pending/resumable transactions may create or publish both stage roots.
    # Recheck their complete derived path set before taking the OS lock or
    # writing anything on a resumed attempt as well.
    _require_location_write_paths_supported(project, target, project_id, control)

    fd = _acquire_location_lock(control, owner)
    try:
        owner_after, current = _control_record(control, project_id)
        if owner_after != owner or current["operationId"] != record["operationId"]:
            raise ProjectStateError("ELOCATION_CONFLICT", "location owner changed during takeover; preserve evidence", 2)
        if not _same_path(Path(current["selectedRoot"]), target) or current["volumeIdentity"] != volume:
            raise ProjectStateError("ELOCATION_CONFLICT", "location request no longer matches its durable intent", 2)
        if current["status"] == "active":
            _verify_data_root(project, project_id, current)
            return {"mode": "explicit", "stateRoot": os.fspath(target), "status": "already-active",
                    "operationId": current["operationId"]}
        if current["status"] == "pending":
            stage = target.parent / f"{_STAGE_PREFIX}{current['operationId']}"
            if target.exists():
                # A complete target is accepted only if the exact operation's proof is present.
                proof, raw, _ = _read_json(target / _LOCATION_PROOF)
                if (proof.get("operationId") != current["operationId"]
                        or proof.get("projectIdentity") != project_id
                        or proof.get("rootIdentity") != _identity(target)
                        or proof.get("selectedRootSha256") != hashlib.sha256(os.fspath(target).encode("utf-8")).hexdigest()
                        or proof.get("volumeIdentity") != volume):
                    raise ProjectStateError("ELOCATION_CONFLICT", "published target is not proven to belong to this operation; preserve both roots", 2)
            else:
                if stage.exists():
                    _verify_owned_stage(stage, target, project_id, current["operationId"], volume)
                else:
                    _write_data_stage(stage, target, project_id, current["operationId"], volume)
                _checkpoint("before-data-publish", stage)
                try:
                    os.rename(stage, target)
                except FileExistsError as exc:
                    raise ProjectStateError("ELOCATION_CONFLICT", "selected target appeared during publication; preserve both objects", 2) from exc
                _sync_directory(target.parent)
                _checkpoint("data-root-published", target)
            _verify_state_dir(target, project_id, require_initialization_proof=True)
            proof, proof_raw, _ = _read_json(target / _LOCATION_PROOF)
            data_id = _identity(target)
            probe_record = {k: v for k, v in current.items() if not k.startswith("_")}
            probe_record["dataIdentity"] = data_id
            probe_record["locationProofSha256"] = hashlib.sha256(proof_raw).hexdigest()
            _verify_data_root(project, project_id, probe_record)
            current_record = {k: v for k, v in current.items() if not k.startswith("_")}
            current_record["status"] = "data-published"
            current_record["dataIdentity"] = data_id
            current_record["locationProofSha256"] = hashlib.sha256(proof_raw).hexdigest()
            _write_control(control, current_record, owner)
            current = _control_record(control, project_id)[1]
        if current["status"] == "data-published":
            _verify_data_root(project, project_id, current)
            active = {k: v for k, v in current.items() if not k.startswith("_")}
            active["status"] = "active"
            _write_control(control, active, owner)
        active_record = _control_record(control, project_id)[1]
        _verify_data_root(project, project_id, active_record)
        _checkpoint("location-active", control)
        return {"mode": "explicit", "stateRoot": os.fspath(target), "status": "initialized",
                "operationId": active_record["operationId"]}
    finally:
        _release_location_lock(fd)
