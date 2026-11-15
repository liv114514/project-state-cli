from __future__ import annotations

"""Config-only restore transaction for the isolated Python migration candidate."""

import hashlib
import ctypes
import errno
import os
import secrets
import stat
import uuid
from pathlib import Path
from typing import Any

from project_state.foundation.state_paths import state_dir
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import (assert_plain_path, is_reparse_point, project_root,
                    require_same_volume, require_windows_path_budget, validate_snapshot_name)
from project_state.recovery.planning import _live_state, _read_verified, plan_config_restore
from project_state.foundation.locking import acquire_lock as _lock, OperationLock as _OperationLock
from project_state.foundation.filesystem import mkdir_checked as _mkdir_checked, write_new as _write_new
from project_state.contracts.ports import SafetyPointPort
from project_state.contracts.results import OperationInspection, SafetyPointReference
from project_state.recovery.operation_gate import assert_no_unresolved_operations
from project_state.foundation.storage import validate_pair
from project_state.recovery.config_journal import append_record, load_records, operation_dir
from project_state.recovery.resolver import owner_binding, begin_recovery, complete_recovery, latest_operation_record_sha
from project_state.recovery.resolver import load_claims


def _require_verified_write_platform() -> None:
    if os.name != "nt":
        raise ProjectStateError(
            "EPLATFORM_UNVERIFIED",
            "config restore and recovery writes are enabled only on verified Windows publication semantics",
            2,
        )


def _file_proof(path: Path, *, allow_linked: bool = False) -> dict[str, Any]:
    try:
        assert_plain_path(path.parent)
        before = path.lstat()
    except FileNotFoundError:
        return {"exists": False, "size": 0, "sha256": None, "fileId": None}
    if (is_reparse_point(before) or not stat.S_ISREG(before.st_mode)
            or before.st_nlink not in ({1, 2} if allow_linked else {1}) or before.st_size > 1_048_576):
        raise ProjectStateError("EUNSAFE_PATH", "restore target is not a supported single-link regular file", 2)
    digest = hashlib.sha256()
    count = 0
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb", buffering=0) as stream:
        opened = os.fstat(stream.fileno())
        if is_reparse_point(opened) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ProjectStateError("ESOURCE_CHANGED", "restore target identity changed while opening", 2)
        while chunk := stream.read(65536):
            count += len(chunk)
            if count > 1_048_576:
                raise ProjectStateError("EUNSAFE_PATH", "restore target exceeds the supported size", 2)
            digest.update(chunk)
        after = os.fstat(stream.fileno())
    final = path.lstat()
    if (is_reparse_point(final)
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_nlink)
            or (after.st_dev, after.st_ino, after.st_size, after.st_nlink)
            != (final.st_dev, final.st_ino, final.st_size, final.st_nlink)
            or count != after.st_size):
        raise ProjectStateError("ESOURCE_CHANGED", "restore target changed while being inspected", 2)
    return {"exists": True, "size": count, "sha256": digest.hexdigest(),
            "fileId": f"{after.st_dev}:{after.st_ino}", "mode": stat.S_IMODE(after.st_mode), "links": after.st_nlink}


def _same(a: dict[str, Any], b: dict[str, Any], *, identity: bool = True) -> bool:
    if a.get("exists") != b.get("exists"):
        return False
    if not a.get("exists"):
        return True
    return (a.get("size") == b.get("size") and a.get("sha256") == b.get("sha256")
            and (not identity or a.get("fileId") == b.get("fileId")))


def _stage_matches(stage: dict[str, Any] | None, proof: dict[str, Any] | None) -> bool:
    return bool(stage and proof and proof.get("exists") is True
                and stage.get("size") == proof.get("size")
                and stage.get("sha256") == proof.get("sha256")
                and stage.get("fileId") == proof.get("fileId"))


def _move_noreplace(source: Path, destination: Path) -> None:
    """Atomically retire a path without replacing a racing destination.

    Windows os.rename is no-replace. Linux uses renameat2(RENAME_NOREPLACE),
    and macOS uses renamex_np(RENAME_EXCL). Other POSIX platforms fail closed
    until a no-replace primitive is implemented and tested there.
    """
    if os.name == "nt":
        os.rename(source, destination)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if hasattr(libc, "renameat2"):
        fn = libc.renameat2
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        result = fn(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    elif hasattr(libc, "renamex_np"):
        fn = libc.renamex_np
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        result = fn(os.fsencode(source), os.fsencode(destination), 0x00000004)
    else:
        raise ProjectStateError("EPLATFORM_UNSUPPORTED", "platform lacks a verified no-replace quarantine operation", 2)
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def _root_identity(root: Path) -> str:
    return hashlib.sha256(os.path.normcase(str(root)).encode("utf-8", errors="strict")).hexdigest()


def _stage(root: Path, operation_id: str, label: str, data: bytes, mode: int = 0o600) -> dict[str, Any]:
    base = state_dir(root) / "staging"
    for path in (state_dir(root), base):
        _mkdir_checked(path)
    operation = base / operation_id
    _mkdir_checked(operation)
    private = operation / "private"
    _mkdir_checked(private)
    assert_plain_path(private)
    path = private / f"{label}.stage"
    dev, ino = _write_new(path, data, mode)
    st = path.lstat()
    if (st.st_dev, st.st_ino) != (dev, ino) or st.st_nlink != 1 or st.st_size != len(data):
        raise ProjectStateError("EUNSAFE_PATH", "private restore stage identity is uncertain", 2)
    return {"relativePath": path.relative_to(state_dir(root)).as_posix(),
            "fileId": f"{st.st_dev}:{st.st_ino}", "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "mode": mode}


def _safe_point(root: Path, name: str, pre: dict[str, Any], target: str, lock: _OperationLock,
                safety_points: SafetyPointPort) -> dict[str, str]:
    safe_name = f"safety-{uuid.uuid4().hex}"
    saved = safety_points.create_safety_point(root, safe_name, lock)
    if not isinstance(saved, SafetyPointReference) or not saved.verified or saved.name != safe_name:
        raise ProjectStateError("ESAFETY_POINT", "pre-restore safety snapshot did not verify", 2)
    if not saved.generation or (pre["exists"] and not any(item.target == target and item.privacy == "private" for item in saved.protected_artifacts)):
        raise ProjectStateError("ESAFETY_POINT", "safety-point provider did not bind the selected private target", 2)
    pair = validate_pair(root, safe_name, saved.generation)
    if pre["exists"]:
        artifact = next((a for a in pair["artifacts"] if a.get("layer") == "config" and a.get("target") == target and a.get("kind") == "file"), None)
        if not artifact or artifact["size"] != pre["size"] or artifact["sha256"] != pre["sha256"]:
            raise ProjectStateError("ESAFETY_POINT", "safety snapshot does not bind the current target bytes", 2)
        _read_verified(Path(artifact["absolutePath"]), artifact["size"], artifact["sha256"])
    elif _file_proof(root / target)["exists"]:
        raise ProjectStateError("ESOURCE_CHANGED", "target appeared while creating the safety snapshot", 2)
    return {"name": safe_name, "generation": saved.generation}


def _record(root: Path, op_id: str, state: dict[str, Any]) -> dict[str, Any]:
    base = operation_dir(root, op_id)
    _mkdir_checked(base.parent.parent)
    _mkdir_checked(base.parent)
    records = load_records(root, op_id) if base.exists() else []
    sequence = len(records)
    previous = None
    if records:
        prior_path = operation_dir(root, op_id) / f"record-{sequence - 1:06d}.json"
        previous = hashlib.sha256(prior_path.read_bytes()).hexdigest()
    value = {**state, "schemaVersion": state.get("schemaVersion", 1), "operationId": op_id,
             "sequence": sequence, "previousRecordSha256": previous}
    return append_record(root, op_id, value)


def _latest(root: Path, op_id: str) -> dict[str, Any]:
    return load_records(root, op_id)[-1]


def _target_path(root: Path, state: dict[str, Any]) -> Path:
    target = state.get("target")
    if target not in {".env", ".env.local"}:
        raise ProjectStateError("EJOURNAL_INVALID", "operation target is outside the config allowlist", 2)
    path = root / target
    assert_plain_path(path.parent)
    return path


def _stage_path(root: Path, item: dict[str, Any]) -> Path:
    rel = item.get("relativePath")
    if not isinstance(rel, str) or not rel.startswith("staging/") or ".." in rel.split("/") or "\\" in rel:
        raise ProjectStateError("EJOURNAL_INVALID", "operation stage path is invalid", 2)
    path = state_dir(root) / Path(*rel.split("/"))
    assert_plain_path(path, hardlinks=True)
    st = path.lstat()
    if (f"{st.st_dev}:{st.st_ino}" != item.get("fileId") or st.st_size != item.get("size")
            or not stat.S_ISREG(st.st_mode) or st.st_nlink not in {1, 2}):
        raise ProjectStateError("EJOURNAL_UNCERTAIN", "operation stage identity changed", 2)
    return path


def _move_to_displaced(target: Path, displaced: Path, expected: dict[str, Any]) -> dict[str, Any]:
    require_same_volume(target.parent, displaced.parent)
    try:
        displaced.lstat()
    except FileNotFoundError:
        pass
    else:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "private quarantine path already exists; preserve both objects", 2)
    if _same(expected, _file_proof(target)) is False:
        raise ProjectStateError("ESOURCE_CHANGED", "target changed before the restore boundary; external data was preserved", 2)
    try:
        _move_noreplace(target, displaced)
    except OSError as exc:
        raise ProjectStateError("EPUBLISH", "target could not be moved to private quarantine", 2) from exc
    moved = _file_proof(displaced)
    if not _same(expected, moved):
        # A last-moment external object is returned only when the target is
        # still absent. Otherwise both names are retained for manual recovery.
        try:
            if not _file_proof(target)["exists"]:
                _move_noreplace(displaced, target)
        except OSError:
            pass
        raise ProjectStateError("EOPERATION_UNCERTAIN", "object moved at the restore boundary did not match the authorized identity; preserve target and quarantine", 2)
    return moved


def _displaced_path(root: Path, state: dict[str, Any], suffix: str) -> Path:
    relative = state.get("stage", {}).get("relativePath")
    if not isinstance(relative, str) or "\\" in relative or ".." in relative.split("/"):
        raise ProjectStateError("EJOURNAL_INVALID", "operation stage reference is invalid", 2)
    stage = state_dir(root) / Path(*relative.split("/"))
    assert_plain_path(stage.parent)
    return stage.with_name(f"{stage.stem}.{suffix}")


def _proof_if_present(path: Path) -> dict[str, Any] | None:
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    return _file_proof(path, allow_linked=True)


def _not_applied_cancel_proof(root: Path, state: dict[str, Any]) -> dict[str, Any] | None:
    """Prove a displace-intent never moved the original object.

    Cancellation is deliberately narrower than rollback: only the exact
    recorded prestate at the target, the exact private restore stage, and an
    absent quarantine authorize a terminal no-op cancellation. Ambiguity is
    preserved for manual resolution.
    """
    if (state.get("status") != "in-progress"
            or state.get("phase") not in {"prepared", "displace-intent"}):
        return None
    target = _target_path(root, state)
    current = _file_proof(target, allow_linked=True)
    if not _same(state.get("pre", {}), current):
        return None
    stage_path = _stage_path(root, state["stage"])
    staged = _file_proof(stage_path, allow_linked=True)
    if not _stage_matches(state.get("stage"), staged):
        return None
    displaced = _displaced_path(root, state, "previous")
    if _proof_if_present(displaced) is not None:
        return None
    validate_pair(root, state["safety"]["name"], state["safety"]["generation"])
    stage_declaration = {key: state["stage"][key]
                         for key in ("relativePath", "fileId", "size", "sha256", "mode")}
    return {"target": current, "stage": stage_declaration, "quarantineAbsent": True}


def _complete_interrupted_terminal_claim(root: Path, operation_id: str,
                                         state: dict[str, Any], lock: Any) -> None:
    pointer = state.get("resolverClaim")
    claims = load_claims(root, operation_id, "config", state) if state.get("ownerBinding") is not None else []
    if not claims or not isinstance(pointer, dict):
        return
    latest, _ = claims[-1]
    if latest.get("status") == "active":
        successor = begin_recovery(root, operation_id, "config", state, lock,
                                   "rollback" if state.get("status") in {"cancelled", "rolled-back"} else "continue")
        complete_recovery(root, operation_id, "config", state, lock, successor,
                          latest_operation_record_sha(root, operation_id, "config", state))
        lock.verify()


def _rollback_classification(root: Path, state: dict[str, Any], current: dict[str, Any]) -> str:
    target = _target_path(root, state)
    quarantine = _displaced_path(root, state, "rollback-post")
    moved = _proof_if_present(quarantine)
    stage = None
    if state.get("rollbackStage") is not None:
        stage_candidate = state_dir(root) / Path(*state["rollbackStage"]["relativePath"].split("/"))
        if _proof_if_present(stage_candidate) is not None:
            stage_path = _stage_path(root, state["rollbackStage"])
            stage = _file_proof(stage_path, allow_linked=True)
    expected = state.get("rollbackExpected")
    rollback_post = state.get("rollbackPost")
    phase = state.get("phase")
    if state.get("status") == "rolled-back":
        return "rolled-back" if rollback_post is not None and _same(rollback_post, current) else "uncertain"
    if phase == "rollback-displace-intent":
        if _same(expected or {}, current) and moved is None:
            return "rollback-awaiting-displacement"
        if not current["exists"] and expected is not None and moved is not None and _same(expected, moved):
            return "rollback-awaiting-publication"
        return "uncertain"
    if phase == "rollback-publish-intent":
        if state.get("pre", {}).get("exists"):
            if not current["exists"] and moved is not None and expected is not None and _same(expected, moved) and _stage_matches(state.get("rollbackStage"), stage):
                return "rollback-awaiting-publication"
            if (_stage_matches(state.get("rollbackStage"), current)
                    and (stage is None or _stage_matches(state.get("rollbackStage"), stage))):
                return "rollback-published-awaiting-verification"
            return "uncertain"
        if not state.get("pre", {}).get("exists") and not current["exists"] and moved is not None and expected is not None and _same(expected, moved):
            return "rollback-published-awaiting-verification"
        return "uncertain"
    if phase == "rollback-published":
        if rollback_post is not None and _same(rollback_post, current):
            return "rollback-published-awaiting-verification"
        return "uncertain"
    return "uncertain"


def _finish_rollback(root: Path, operation_id: str, state: dict[str, Any]) -> dict[str, Any]:
    target = _target_path(root, state)
    quarantine = _displaced_path(root, state, "rollback-post")
    current = _file_proof(target, allow_linked=True)
    moved = _proof_if_present(quarantine)
    expected = state.get("rollbackExpected")
    if moved is None or expected is None or not _same(expected, moved):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback quarantine does not match the recorded published target", 2)
    rollback_stage = state.get("rollbackStage")
    if state["pre"].get("exists"):
        if rollback_stage is None:
            raise ProjectStateError("EJOURNAL_INVALID", "rollback safety bytes are missing from the operation record", 2)
        if not current["exists"]:
            stage_path = _stage_path(root, rollback_stage)
            staged = _file_proof(stage_path)
            if not _stage_matches(rollback_stage, staged):
                raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback stage no longer matches the journal", 2)
            try:
                require_same_volume(stage_path.parent, target.parent)
                if os.name == "nt":
                    os.rename(stage_path, target)
                else:
                    os.link(stage_path, target, follow_symlinks=False)
            except FileExistsError as exc:
                raise ProjectStateError("ESOURCE_CHANGED", "an external target appeared during rollback and was preserved", 2) from exc
            current = _file_proof(target, allow_linked=os.name != "nt")
        if not _stage_matches(rollback_stage, current):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback target does not match the private safety stage", 2)
        if os.name != "nt":
            stage_path = state_dir(root) / Path(*rollback_stage["relativePath"].split("/"))
            if stage_path.exists():
                _stage_path(root, rollback_stage)
                os.unlink(stage_path)
        current = _file_proof(target)
    elif current["exists"]:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "target reappeared during rollback; preserve it and the quarantine", 2)
    final = {**state, "phase": "rolled-back", "status": "rolled-back", "rollbackPost": current}
    _record(root, operation_id, final)
    if state["pre"].get("exists") and not _same(state["pre"], _file_proof(target), identity=False):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback final bytes failed verification", 2)
    return {"operationId": operation_id, "status": "rolled-back", "target": state["target"],
            "safety": state["safety"], "verified": True}


def _continue_rollback(root: Path, operation_id: str, state: dict[str, Any]) -> dict[str, Any]:
    classification = inspect_operation(root, operation_id)["classification"]
    target = _target_path(root, state)
    quarantine = _displaced_path(root, state, "rollback-post")
    if classification == "rolled-back":
        return {"operationId": operation_id, "status": "rolled-back", "target": state["target"], "verified": True}
    current = _file_proof(target, allow_linked=True)
    if classification == "rollback-awaiting-displacement":
        expected = state.get("rollbackExpected")
        moved = _move_to_displaced(target, quarantine, expected)
        if not _same(expected, moved):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback moved an object with an unexpected identity", 2)
        state = {**state, "phase": "rollback-publish-intent"}
        _record(root, operation_id, state)
    elif classification not in {"rollback-awaiting-publication", "rollback-published-awaiting-verification"}:
        raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback state is not safely resumable; preserve files and journal", 2)
    elif classification == "rollback-awaiting-publication" and state.get("phase") != "rollback-publish-intent":
        state = {**state, "phase": "rollback-publish-intent"}
        _record(root, operation_id, state)
    return _finish_rollback(root, operation_id, state)


def _publish_stage(root: Path, state: dict[str, Any], *, mode: int = 0o600) -> dict[str, Any]:
    target = _target_path(root, state)
    stage = _stage_path(root, state["stage"])
    require_same_volume(stage.parent, target.parent)
    if _file_proof(target)["exists"]:
        current = _file_proof(target)
        if _same(state["pre"], current):
            displaced = _displaced_path(root, state, "previous")
            if displaced.exists():
                raise ProjectStateError("EOPERATION_UNCERTAIN", "private quarantine path is already occupied", 2)
            _move_to_displaced(target, displaced, state["pre"])
        else:
            raise ProjectStateError("ESOURCE_CHANGED", "target changed before publication; external data was preserved", 2)
    try:
        if os.name == "nt":
            # Windows rename fails when target exists and preserves the staged
            # file identity. POSIX rename would replace a racing object, so it
            # continues to use exclusive link publication there.
            os.rename(stage, target)
        else:
            os.link(stage, target, follow_symlinks=False)
    except FileExistsError as exc:
        raise ProjectStateError("ESOURCE_CHANGED", "an external target appeared before publication and was preserved", 2) from exc
    proof = _file_proof(target, allow_linked=os.name != "nt")
    if (proof["fileId"] != state["stage"]["fileId"] or proof["size"] != state["stage"]["size"]
            or proof["sha256"] != state["stage"]["sha256"]):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "published target does not match the staged object identity", 2)
    return proof


def apply_config_restore(root_value: str | os.PathLike[str], name: str, *,
                         safety_points: SafetyPointPort | None = None) -> dict[str, Any]:
    _require_verified_write_platform()
    if safety_points is None:
        raise ProjectStateError("EAPPLICATION_PORT", "config restore requires the application safety-point provider", 2)
    root = project_root(root_value)
    validate_snapshot_name(name)
    operation_placeholder = "0" * 32
    generation_placeholder = "0" * 32
    safety_name = "safety-" + operation_placeholder
    state = state_dir(root)
    path_budget = [state / "locks" / "operation.lock",
                   state / "staging" / operation_placeholder / "private" / "restore.stage",
                   state / "staging" / operation_placeholder / "private" / "restore.rollback-post",
                   state / "operations" / operation_placeholder / "record-999999.json",
                   state / "operations" / operation_placeholder / "record-999999.tmp-0123456789abcdef",
                   state / "resolvers" / operation_placeholder / "claim-999999.tmp-0123456789abcdef"]
    for index in range(2):
        stage = state / "staging" / operation_placeholder / "private" / f"restore-{index}.stage"
        path_budget.extend((stage, stage.with_name(f"restore-{index}.previous"),
                            stage.with_name(f"restore-{index}.rollback-post")))
    for target in (".env", ".env.local"):
        path_budget.append(root / target)
        path_budget.extend((state / "snapshots" / safety_name / "generations" / generation_placeholder
                            / "files" / "config.json",
                            state / "secrets" / safety_name / "generations" / generation_placeholder
                            / "files" / target))
    require_windows_path_budget(path_budget)
    require_same_volume(root, state)
    lock = _lock(root, "transaction")
    try:
        assert_no_unresolved_operations(root)
        preview = plan_config_restore(root, name)
        selected = [item for item in preview["targets"] if item["action"] != "unchanged"]
        if not selected:
            return {"status": "unchanged", "snapshot": name, "generation": preview["generation"], "targets": []}
        preview = {**preview, "targets": selected}
        if len(selected) > 1:
            from project_state.recovery.multi_config import apply_config_batch_locked
            return apply_config_batch_locked(root, name, preview, safety_points, lock)
        target = preview["targets"][0]["target"]
        source_pair = validate_pair(root, name, preview["generation"])
        source = next((a for a in source_pair["artifacts"] if a.get("layer") == "config" and a.get("target") == target and a.get("kind") == "file"), None)
        if source is None:
            raise ProjectStateError("ERESTORE_INPUT", "validated snapshot has no matching config artifact", 2)
        source_bytes = Path(source["absolutePath"]).read_bytes()
        if len(source_bytes) != source["size"] or hashlib.sha256(source_bytes).hexdigest() != source["sha256"]:
            raise ProjectStateError("EARTIFACT_INTEGRITY", "validated restore bytes changed before staging", 2)
        pre = _file_proof(root / target)
        safety = _safe_point(root, name, pre, target, lock, safety_points)
        # Re-read and compare the complete current identity after safety capture.
        if not _same(pre, _file_proof(root / target)):
            raise ProjectStateError("ESOURCE_CHANGED", "target changed while the safety snapshot was created", 2)
        operation_id = uuid.uuid4().hex
        stage = _stage(root, operation_id, "restore", source_bytes)
        state = {"rootIdentity": _root_identity(root), "status": "in-progress", "phase": "prepared",
                 "source": {"name": name, "generation": preview["generation"]}, "safety": safety,
                 "target": target, "pre": pre, "stage": stage, "post": None,
                 "ownerBinding": owner_binding(lock)}
        _record(root, operation_id, state)
        target_path = root / target
        displaced = _displaced_path(root, state, "previous")
        state = {**state, "phase": "displace-intent"}
        _record(root, operation_id, state)
        if pre["exists"]:
            _move_to_displaced(target_path, displaced, pre)
        state = {**state, "phase": "publish-intent"}
        _record(root, operation_id, state)
        post = _publish_stage(root, state)
        state = {**state, "phase": "published", "status": "in-progress", "post": post}
        _record(root, operation_id, state)
        stage_path = state_dir(root) / Path(*state["stage"]["relativePath"].split("/"))
        if _file_proof(target_path, allow_linked=os.name != "nt")["fileId"] != state["stage"]["fileId"]:
            raise ProjectStateError("EOPERATION_UNCERTAIN", "published target no longer matches its private stage", 2)
        if stage_path.exists():
            _stage_path(root, state["stage"])
            os.unlink(stage_path)
        state = {**state, "phase": "verified", "status": "completed"}
        _record(root, operation_id, state)
        verified = _file_proof(target_path)
        if not _same(post, verified):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "restored target changed before final verification", 2)
        lock.verify()
        return {"operationId": operation_id, "snapshot": name, "generation": preview["generation"],
                "safety": safety, "target": target, "status": "verified", "pre": pre, "post": post}
    finally:
        lock.release()


def inspect_operation(root_value: str | os.PathLike[str], operation_id: str) -> OperationInspection:
    root = project_root(root_value)
    records = load_records(root, operation_id)
    state = records[-1]
    if state.get("transactionKind") == "config-batch":
        from project_state.recovery.multi_config import inspect_batch
        return inspect_batch(root, operation_id, records)
    if state.get("rootIdentity") != _root_identity(root) or state.get("operationId") != operation_id:
        raise ProjectStateError("EJOURNAL_INVALID", "operation journal belongs to a different project root", 2)
    target = _target_path(root, state)
    claims = load_claims(root, operation_id, "config", state) if state.get("ownerBinding") is not None else []
    current = _file_proof(target, allow_linked=True)
    stage_candidate = state_dir(root) / Path(*state["stage"]["relativePath"].split("/"))
    try:
        stage_candidate.lstat()
        stage = _stage_path(root, state["stage"])
    except FileNotFoundError:
        stage = None
        if state.get("status") not in {"completed", "rolled-back", "rolling-back", "cancelled"} and current.get("fileId") != state.get("stage", {}).get("fileId"):
            raise ProjectStateError("EJOURNAL_UNCERTAIN", "operation stage is missing without a matching published target", 2)
    staged = _file_proof(stage, allow_linked=True) if stage else None
    phase = state.get("phase")
    if state.get("status") == "cancelled":
        classification = "cancelled-not-applied"
    elif state.get("status") in {"rolling-back", "rolled-back"}:
        classification = _rollback_classification(root, state, current)
    elif state.get("status") == "completed":
        classification = "completed" if _same(state.get("post") or {}, current) else "uncertain"
    elif _same(state.get("pre") or {}, current):
        classification = "not-applied-or-prestate"
    elif current.get("fileId") == state["stage"].get("fileId") and current.get("sha256") == state["stage"].get("sha256"):
        classification = "published-awaiting-verification"
    elif not current["exists"] and (not state["pre"].get("exists") or _same(state["pre"], _file_proof(_displaced_path(root, state, "previous")))):
        classification = "displaced-awaiting-publication"
    elif current.get("links", 1) > 1:
        classification = "uncertain"
    else:
        classification = "uncertain"
    if (state.get("status") == "in-progress" and state.get("phase") in {"prepared", "displace-intent"}
            and _not_applied_cancel_proof(root, state) is not None):
        classification = "not-applied-awaiting-cancel"
    return {"resultSchemaVersion": 1, "operationId": operation_id, "status": state["status"],
            "phase": phase, "classification": classification, "target": state["target"],
            "source": state["source"], "safety": state["safety"],
            "current": {"exists": current["exists"], "size": current["size"]},
            "stageIntegrity": ("verified-by-target" if stage is None and current.get("fileId") == state["stage"].get("fileId") else
                                "not-needed" if stage is None else
                                "verified" if _stage_matches(state["stage"], staged) else "uncertain"),
            "recoveryActions": (["--continue", "--rollback"]
                                if classification == "not-applied-awaiting-cancel" and phase == "prepared" else
                                ["--rollback"] if classification == "not-applied-awaiting-cancel" else
                                ["--rollback"] if classification == "completed" else
                                ["--continue"] if state.get("ownerBinding") is not None and classification in {
                                    "not-applied-or-prestate", "displaced-awaiting-publication",
                                    "published-awaiting-verification"} else []),
            "resolver": ("legacy-unbound" if state.get("ownerBinding") is None else
                         "completed" if claims and claims[-1][0].get("status") == "completed" else
                         "active-or-not-started"),
            "businessValues": "withheld"}


def continue_operation(root_value: str | os.PathLike[str], operation_id: str) -> dict[str, Any]:
    _require_verified_write_platform()
    root = project_root(root_value)
    lock = _lock(root, "transaction")
    try:
        state = _latest(root, operation_id)
        if state.get("transactionKind") == "config-batch":
            from project_state.recovery.multi_config import continue_batch_locked
            return continue_batch_locked(root, operation_id, state, lock)
        inspected = inspect_operation(root, operation_id)
        classification = inspected["classification"]
        if state.get("status") in {"completed", "rolled-back", "cancelled"} and classification in {"completed", "rolled-back", "cancelled-not-applied"}:
            _complete_interrupted_terminal_claim(root, operation_id, state, lock)
            return inspected
        if classification == "not-applied-awaiting-cancel" and state.get("phase") != "prepared":
            raise ProjectStateError("EOPERATION_NOT_APPLIED", "restore was not applied; use --rollback to record a safe cancellation without changing the target", 2)
        if classification == "uncertain":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "live target and private stages do not prove a safe continuation; preserve all evidence", 2)
        pointer = begin_recovery(root, operation_id, "config", state, lock, "continue")
        state = {**state, "resolverClaim": pointer}
        _record(root, operation_id, state)
        if state.get("status") == "rolling-back":
            result = _continue_rollback(root, operation_id, state)
            terminal = _latest(root, operation_id)
            if terminal.get("status") == "rolled-back":
                complete_recovery(root, operation_id, "config", terminal, lock, pointer,
                                  latest_operation_record_sha(root, operation_id, "config", terminal))
            lock.verify()
            return result
        if state.get("status") == "rolled-back" and classification == "rolled-back":
            return inspected
        if state.get("status") == "completed" and classification == "completed":
            return inspected
        target = _target_path(root, state)
        current = _file_proof(target, allow_linked=True)
        if current.get("fileId") == state["stage"].get("fileId"):
            post = current
            state = {**state, "phase": "published", "status": "in-progress", "post": post}
            _record(root, operation_id, state)
            stage_path = state_dir(root) / Path(*state["stage"]["relativePath"].split("/"))
            if _file_proof(target, allow_linked=True)["fileId"] != state["stage"]["fileId"]:
                raise ProjectStateError("EOPERATION_UNCERTAIN", "published target no longer matches its private stage", 2)
            if stage_path.exists():
                _stage_path(root, state["stage"])
                os.unlink(stage_path)
        else:
            if state.get("status") == "in-progress" and state.get("phase") == "prepared":
                # Record the legal transition before either displacing a target
                # or publishing into a target that was originally absent.
                _record(root, operation_id, {**state, "phase": "displace-intent"})
                state = _latest(root, operation_id)
            if current["exists"]:
                displaced = _displaced_path(root, state, "previous")
                if not displaced.exists():
                    if not _same(state["pre"], current):
                        raise ProjectStateError("EOPERATION_UNCERTAIN", "current target is not the recorded prestate", 2)
                    _record(root, operation_id, {**state, "phase": "displace-intent"})
                    _move_to_displaced(target, displaced, state["pre"])
                elif not _same(state["pre"], _file_proof(displaced)):
                    raise ProjectStateError("EOPERATION_UNCERTAIN", "private quarantine does not match the recorded prestate", 2)
            elif state["pre"].get("exists"):
                displaced = _displaced_path(root, state, "previous")
                if not displaced.exists() or not _same(state["pre"], _file_proof(displaced)):
                    raise ProjectStateError("EOPERATION_UNCERTAIN", "missing target has no identity-matched prestate quarantine", 2)
            _record(root, operation_id, {**state, "phase": "publish-intent"})
            post = _publish_stage(root, state)
            state = {**state, "phase": "published", "status": "in-progress", "post": post}
            _record(root, operation_id, state)
            stage_path = state_dir(root) / Path(*state["stage"]["relativePath"].split("/"))
            if stage_path.exists():
                _stage_path(root, state["stage"])
                os.unlink(stage_path)
        completed = {**state, "phase": "verified", "status": "completed", "post": post}
        _record(root, operation_id, completed)
        if not _same(post, _file_proof(target)):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "continued restore failed final identity verification", 2)
        complete_recovery(root, operation_id, "config", completed, lock, pointer,
                          latest_operation_record_sha(root, operation_id, "config", completed))
        lock.verify()
        return {"operationId": operation_id, "status": "verified", "target": state["target"],
                "safety": state["safety"], "classification": "completed"}
    finally:
        lock.release()


def rollback_operation(root_value: str | os.PathLike[str], operation_id: str) -> dict[str, Any]:
    _require_verified_write_platform()
    root = project_root(root_value)
    lock = _lock(root, "transaction")
    try:
        state = _latest(root, operation_id)
        if state.get("transactionKind") == "config-batch":
            from project_state.recovery.multi_config import rollback_batch_locked
            return rollback_batch_locked(root, operation_id, state, lock)
        classification = inspect_operation(root, operation_id)["classification"]
        if state.get("status") == "cancelled" and classification == "cancelled-not-applied":
            _complete_interrupted_terminal_claim(root, operation_id, state, lock)
            return {"operationId": operation_id, "status": "cancelled", "target": state["target"],
                    "verified": True, "restoreApplied": False}
        if state.get("status") == "rolled-back" and classification == "rolled-back":
            _complete_interrupted_terminal_claim(root, operation_id, state, lock)
            return {"operationId": operation_id, "status": "rolled-back", "target": state["target"]}
        cancel_proof = _not_applied_cancel_proof(root, state) if classification == "not-applied-awaiting-cancel" else None
        if cancel_proof is not None:
            pointer = begin_recovery(root, operation_id, "config", state, lock, "rollback")
            claimed = {**state, "resolverClaim": pointer}
            _record(root, operation_id, claimed)
            confirmed = _not_applied_cancel_proof(root, claimed)
            if confirmed is None:
                raise ProjectStateError("EOPERATION_UNCERTAIN", "target, stage, or quarantine changed before cancellation; preserve the operation evidence", 2)
            terminal = {**claimed, "phase": "cancelled", "status": "cancelled", "cancelProof": confirmed}
            _record(root, operation_id, terminal)
            complete_recovery(root, operation_id, "config", terminal, lock, pointer,
                              latest_operation_record_sha(root, operation_id, "config", terminal))
            lock.verify()
            return {"operationId": operation_id, "status": "cancelled", "target": state["target"],
                    "verified": True, "restoreApplied": False, "safety": state["safety"]}
        if classification == "published-awaiting-verification":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "restore publication is not verified; use --continue before rollback", 2)
        if state.get("status") != "rolling-back" and classification != "completed":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback requires an identity-verified completed restore; preserve the safety point and journal", 2)
        pointer = begin_recovery(root, operation_id, "config", state, lock, "rollback")
        state = {**state, "resolverClaim": pointer}
        _record(root, operation_id, state)
        if state.get("status") == "rolling-back":
            result = _continue_rollback(root, operation_id, state)
            terminal = _latest(root, operation_id)
            if terminal.get("status") == "rolled-back":
                complete_recovery(root, operation_id, "config", terminal, lock, pointer,
                                  latest_operation_record_sha(root, operation_id, "config", terminal))
            lock.verify()
            return result
        if classification != "completed":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback requires an identity-verified published target; preserve the safety point and journal", 2)
        target = _target_path(root, state)
        current = _file_proof(target, allow_linked=True)
        if not current["exists"] or current.get("fileId") != state.get("post", {}).get("fileId") and state.get("post"):
            raise ProjectStateError("ESOURCE_CHANGED", "target changed after restore; external bytes were preserved", 2)
        if current["sha256"] != state["stage"]["sha256"] or current["size"] != state["stage"]["size"]:
            raise ProjectStateError("ESOURCE_CHANGED", "target content changed after restore; external bytes were preserved", 2)
        safety_pair = validate_pair(root, state["safety"]["name"], state["safety"]["generation"])
        original = None
        if state["pre"]["exists"]:
            artifact = next((a for a in safety_pair["artifacts"] if a.get("layer") == "config" and a.get("target") == state["target"] and a.get("kind") == "file"), None)
            if artifact is None or artifact["size"] != state["pre"]["size"] or artifact["sha256"] != state["pre"]["sha256"]:
                raise ProjectStateError("ESAFETY_POINT", "referenced safety artifact does not match the operation prestate", 2)
            _read_verified(Path(artifact["absolutePath"]), artifact["size"], artifact["sha256"])
            original = Path(artifact["absolutePath"]).read_bytes()
        rollback_stage = _stage(root, operation_id, "rollback", original or b"") if original is not None else None
        intent = {**state, "phase": "rollback-displace-intent", "status": "rolling-back",
                  "rollbackStage": rollback_stage, "rollbackExpected": current}
        _record(root, operation_id, intent)
        result = _continue_rollback(root, operation_id, intent)
        terminal = _latest(root, operation_id)
        if terminal.get("status") == "rolled-back":
            complete_recovery(root, operation_id, "config", terminal, lock, pointer,
                              latest_operation_record_sha(root, operation_id, "config", terminal))
        lock.verify()
        return result
    finally:
        lock.release()


def recover(root_value: str | os.PathLike[str], operation_id: str, action: str) -> dict[str, Any]:
    from project_state.recovery.sqlite import has_database_operation, recover_database_operation
    if has_database_operation(root_value, operation_id):
        return recover_database_operation(root_value, operation_id, action)
    if action == "inspect":
        return inspect_operation(root_value, operation_id)
    if action == "continue":
        return continue_operation(root_value, operation_id)
    if action == "rollback":
        return rollback_operation(root_value, operation_id)
    raise ProjectStateError("EARG_CONFLICT", "recover action must be inspect, continue, or rollback", 1)
