from __future__ import annotations

"""Per-user Python state namespace, disjoint from Node's project-local state."""

import hashlib
import json
import os
import stat
import sys
import uuid
from pathlib import Path
from typing import Any

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path


_MARKER = "state-root.json"
_INITIALIZATION_PROOF = "state-root.initialization.json"
_RUNTIME = "project-state-python"
_LAYOUT = 1

# Private test seam. Production callers never set this. The subprocess tests
# use it to stop at durable protocol boundaries without timing sleeps.
_INITIALIZATION_TEST_HOOK = None


def project_identity(root: Path) -> str:
    canonical = os.path.normcase(os.path.abspath(os.fspath(root)))
    return hashlib.sha256(canonical.encode("utf-8", errors="strict")).hexdigest()


def _user_state_home() -> Path:
    if os.name == "nt":
        value = os.environ.get("LOCALAPPDATA")
        if not value:
            raise ProjectStateError("ESTATE_HOME", "Windows local application-data directory is unavailable", 2)
        base = Path(value)
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        value = os.environ.get("XDG_STATE_HOME")
        base = Path(value) if value else Path.home() / ".local" / "state"
    if not base.is_absolute():
        raise ProjectStateError("ESTATE_HOME", "user state directory must be an absolute path", 2)
    try:
        assert_plain_path(base, allow_missing=True)
    except ProjectStateError as exc:
        raise ProjectStateError("ESTATE_HOME_UNSAFE", "user state directory contains an unsupported path component", 2) from exc
    return base


def state_dir(root: Path) -> Path:
    """Return the isolated state root for this project without creating it."""
    project = Path(root).absolute()
    identity = project_identity(project)
    default_state = _user_state_home() / _RUNTIME / f"v{_LAYOUT}" / identity
    from project_state.foundation.state_location import resolve_state_root
    state = resolve_state_root(project, default_state, identity)
    if state != default_state:
        return state
    try:
        assert_plain_path(state, allow_missing=True)
    except ProjectStateError as exc:
        raise ProjectStateError("ESTATE_PATH_UNSAFE", "Python state path is linked or otherwise unsupported", 2) from exc
    if state.exists():
        _verify_state_dir(state, identity)
    return state


def ensure_state_dir(root: Path) -> Path:
    """Publish a complete state-root identity without exposing a partial leaf.

    The legacy state-root.json format is kept byte-for-byte compatible. New
    roots also receive a sibling initialization proof inside the unpublished
    container; older readers ignore that additional file.
    """
    project = Path(root).absolute()
    identity = project_identity(project)
    state = state_dir(project)
    if state.exists():
        _verify_state_dir(state, identity)
        return state
    if os.name != "nt":
        raise ProjectStateError(
            "EUNSUPPORTED",
            "state-root publication is enabled only on the verified Windows no-replace path; no state was changed",
            2,
        )
    try:
        from project_state.foundation.state_location import assert_no_location_stage_residue
        assert_no_location_stage_residue(state.parent, identity)
        state.parent.mkdir(parents=True, exist_ok=True)
        assert_plain_path(state.parent)
    except (OSError, ProjectStateError) as exc:
        raise ProjectStateError("ESTATE_CREATE", "Python state directory could not be safely prepared", 2) from exc
    # A markerless pre-existing leaf is ambiguous, even when it looks empty.
    try:
        state.lstat()
    except FileNotFoundError:
        pass
    else:
        _verify_state_dir(state, identity)
        return state

    # Never reuse an old initializer directory: it can be an interrupted or
    # foreign operation. A fresh unpredictable sibling is exclusively ours.
    initialization_id = uuid.uuid4().hex
    stage = state.parent / f".project-state-init-{initialization_id}"
    try:
        os.mkdir(stage, 0o700)
        assert_plain_path(stage)
        stage_stat = stage.lstat()
        if not stat.S_ISDIR(stage_stat.st_mode) or stage_stat.st_ino == 0:
            raise ProjectStateError("ESTATE_IDENTITY", "state initialization directory identity is unavailable", 2)
        _init_checkpoint("container-created", stage)

        marker = stage / _MARKER
        marker_payload = json.dumps({"runtime": _RUNTIME, "layoutVersion": _LAYOUT,
                                     "projectIdentity": identity}, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8") + b"\n"
        marker_identity = _write_exclusive(marker, marker_payload, stage, (stage_stat.st_dev, stage_stat.st_ino), "marker")
        proof_payload = json.dumps({
            "schemaVersion": 1,
            "runtime": _RUNTIME,
            "layoutVersion": _LAYOUT,
            "projectIdentity": identity,
            "initializationId": initialization_id,
            "directoryIdentity": {"device": int(stage_stat.st_dev), "inode": int(stage_stat.st_ino)},
            "markerIdentity": {"device": marker_identity[0], "inode": marker_identity[1]},
            "markerSha256": hashlib.sha256(marker_payload).hexdigest(),
        }, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
        _write_exclusive(stage / _INITIALIZATION_PROOF, proof_payload, stage,
                         (stage_stat.st_dev, stage_stat.st_ino), "proof")
        _sync_directory(stage)
        _verify_state_dir(stage, identity, require_initialization_proof=True)
        _init_checkpoint("before-publish", stage)
        _assert_creation_container(stage, (stage_stat.st_dev, stage_stat.st_ino))
        _verify_state_dir(stage, identity, require_initialization_proof=True)
        try:
            # On Windows os.rename maps to a same-volume rename that fails if
            # the destination exists. Do not replace or merge a raced-in leaf.
            os.rename(stage, state)
        except FileExistsError:
            _verify_state_dir(state, identity)
            return state
        _init_checkpoint("after-publish", state)
        _verify_state_dir(state, identity, require_initialization_proof=True)
        return state
    except ProjectStateError:
        raise
    except OSError as exc:
        # Preserve any residue. Its presence alone is never authority to adopt
        # or delete it; a retry uses a different unpredictable container.
        raise ProjectStateError("ESTATE_CREATE", "Python state identity could not be safely published; preserve initialization residue", 2) from exc


def _init_checkpoint(stage: str, path: Path) -> None:
    hook = _INITIALIZATION_TEST_HOOK
    if hook is not None:
        hook(stage, path)


def _assert_creation_container(path: Path, expected: tuple[int, int]) -> None:
    assert_plain_path(path)
    current = path.lstat()
    if (not stat.S_ISDIR(current.st_mode) or current.st_ino == 0
            or (current.st_dev, current.st_ino) != expected):
        raise ProjectStateError("ESTATE_IDENTITY", "state initialization directory identity changed; preserve it", 2)


def _write_exclusive(path: Path, payload: bytes, directory: Path,
                     directory_identity: tuple[int, int], label: str) -> tuple[int, int]:
    _assert_creation_container(directory, directory_identity)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o600)
    try:
        before = os.fstat(fd)
        _init_checkpoint(f"{label}-created", directory)
        _assert_creation_container(directory, directory_identity)
        split = max(1, len(payload) // 2)
        first = os.write(fd, payload[:split])
        if first != split:
            raise OSError("state identity write made no progress")
        _init_checkpoint(f"{label}-partial", directory)
        _assert_creation_container(directory, directory_identity)
        offset = first
        while offset < len(payload):
            count = os.write(fd, payload[offset:])
            if count <= 0:
                raise OSError("state identity write made no progress")
            offset += count
        os.fsync(fd)
        _init_checkpoint(f"{label}-flushed", directory)
        _assert_creation_container(directory, directory_identity)
        after = os.fstat(fd)
        path_stat = path.lstat()
        if ((before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
                or (after.st_dev, after.st_ino) != (path_stat.st_dev, path_stat.st_ino)
                or not stat.S_ISREG(after.st_mode) or after.st_nlink != 1
                or after.st_size != len(payload)):
            raise ProjectStateError("ESTATE_IDENTITY", "Python state marker identity changed", 2)
        return int(after.st_dev), int(after.st_ino)
    finally:
        os.close(fd)


def _sync_directory(path: Path) -> None:
    # Windows does not expose a portable Python directory fsync. Every file
    # is flushed before the same-volume directory rename; power loss remains
    # outside this protocol's guarantee.
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _verify_state_dir(state: Path, identity: str, *, require_initialization_proof: bool = False) -> None:
    try:
        assert_plain_path(state)
        state_before = state.lstat()
        if not stat.S_ISDIR(state_before.st_mode):
            raise ProjectStateError("ESTATE_IDENTITY", "Python state root is not a plain directory", 2)
        marker = state / _MARKER
        try:
            marker.lstat()
        except FileNotFoundError as exc:
            raise ProjectStateError("ESTATE_IDENTITY", "Python state identity is missing; preserve the directory and inspect it manually", 2) from exc
        assert_plain_path(marker, hardlinks=True)
        marker_before = marker.lstat()
        if not stat.S_ISREG(marker_before.st_mode) or marker_before.st_nlink != 1 or marker_before.st_size > 4096:
            raise ProjectStateError("ESTATE_IDENTITY", "Python state identity record is unsupported", 2)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(marker, flags)
        try:
            opened = os.fstat(descriptor)
            if ((opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink)
                    != (marker_before.st_dev, marker_before.st_ino, marker_before.st_size, marker_before.st_nlink)
                    or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1):
                raise ProjectStateError("ESTATE_IDENTITY", "Python state identity changed while opening", 2)
            raw = bytearray()
            while len(raw) <= 4096:
                chunk = os.read(descriptor, 4097 - len(raw))
                if not chunk:
                    break
                raw.extend(chunk)
            after_fd = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        marker_after = marker.lstat()
        state_after = state.lstat()
        if (len(raw) > 4096 or len(raw) != marker_before.st_size
                or (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_nlink)
                != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
                or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_nlink)
                != (marker_after.st_dev, marker_after.st_ino, marker_after.st_size, marker_after.st_nlink)
                or (state_before.st_dev, state_before.st_ino) != (state_after.st_dev, state_after.st_ino)):
            raise ProjectStateError("ESTATE_IDENTITY", "Python state identity changed while reading", 2)
        value: Any = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_unique_pairs)
    except ProjectStateError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProjectStateError("ESTATE_IDENTITY", "Python state identity is missing, damaged, or unreadable; preserve it", 2) from exc
    if (not isinstance(value, dict) or set(value) != {"runtime", "layoutVersion", "projectIdentity"}
            or value.get("runtime") != _RUNTIME or type(value.get("layoutVersion")) is not int
            or value.get("layoutVersion") != _LAYOUT or value.get("projectIdentity") != identity):
        raise ProjectStateError("ESTATE_IDENTITY", "Python state identity does not match this project", 2)

    proof = state / _INITIALIZATION_PROOF
    try:
        proof.lstat()
    except FileNotFoundError:
        if require_initialization_proof:
            raise ProjectStateError("ESTATE_IDENTITY", "new state root lacks its initialization proof", 2)
        return  # backward-compatible legacy root
    try:
        assert_plain_path(proof, hardlinks=True)
        proof_before = proof.lstat()
        if not stat.S_ISREG(proof_before.st_mode) or proof_before.st_nlink != 1 or proof_before.st_size > 4096:
            raise ProjectStateError("ESTATE_IDENTITY", "state initialization proof is unsupported", 2)
        fd = os.open(proof, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            proof_opened = os.fstat(fd)
            if (proof_opened.st_dev, proof_opened.st_ino, proof_opened.st_size, proof_opened.st_nlink) != (
                    proof_before.st_dev, proof_before.st_ino, proof_before.st_size, proof_before.st_nlink):
                raise ProjectStateError("ESTATE_IDENTITY", "state initialization proof changed while opening", 2)
            proof_raw = bytearray()
            while len(proof_raw) <= 4096:
                chunk = os.read(fd, 4097 - len(proof_raw))
                if not chunk:
                    break
                proof_raw.extend(chunk)
            proof_after_fd = os.fstat(fd)
        finally:
            os.close(fd)
        proof_after = proof.lstat()
        current_dir = state.lstat()
        proof_value: Any = json.loads(bytes(proof_raw).decode("utf-8"), object_pairs_hook=_unique_pairs)
        expected = {"schemaVersion", "runtime", "layoutVersion", "projectIdentity",
                    "initializationId", "directoryIdentity", "markerIdentity", "markerSha256"}
        dir_identity = proof_value.get("directoryIdentity") if isinstance(proof_value, dict) else None
        marker_identity = proof_value.get("markerIdentity") if isinstance(proof_value, dict) else None
        if (len(proof_raw) != proof_before.st_size
                or (proof_opened.st_dev, proof_opened.st_ino, proof_opened.st_size, proof_opened.st_mtime_ns, proof_opened.st_nlink)
                != (proof_after_fd.st_dev, proof_after_fd.st_ino, proof_after_fd.st_size, proof_after_fd.st_mtime_ns, proof_after_fd.st_nlink)
                or (proof_after_fd.st_dev, proof_after_fd.st_ino, proof_after_fd.st_size, proof_after_fd.st_nlink)
                != (proof_after.st_dev, proof_after.st_ino, proof_after.st_size, proof_after.st_nlink)
                or (state_before.st_dev, state_before.st_ino) != (current_dir.st_dev, current_dir.st_ino)
                or not isinstance(proof_value, dict) or set(proof_value) != expected
                or type(proof_value.get("schemaVersion")) is not int or proof_value.get("schemaVersion") != 1
                or proof_value.get("runtime") != _RUNTIME
                or type(proof_value.get("layoutVersion")) is not int or proof_value.get("layoutVersion") != _LAYOUT
                or proof_value.get("projectIdentity") != identity
                or not isinstance(proof_value.get("initializationId"), str)
                or len(proof_value["initializationId"]) != 32
                or any(c not in "0123456789abcdef" for c in proof_value["initializationId"])
                or not isinstance(dir_identity, dict) or set(dir_identity) != {"device", "inode"}
                or type(dir_identity.get("device")) is not int or type(dir_identity.get("inode")) is not int
                or (dir_identity["device"], dir_identity["inode"]) != (int(current_dir.st_dev), int(current_dir.st_ino))
                or not isinstance(marker_identity, dict) or set(marker_identity) != {"device", "inode"}
                or type(marker_identity.get("device")) is not int or type(marker_identity.get("inode")) is not int
                or (marker_identity["device"], marker_identity["inode"]) != (int(marker_after.st_dev), int(marker_after.st_ino))
                or proof_value.get("markerSha256") != hashlib.sha256(bytes(raw)).hexdigest()):
            raise ProjectStateError("ESTATE_IDENTITY", "state initialization proof does not match the published root", 2)
    except ProjectStateError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        raise ProjectStateError("ESTATE_IDENTITY", "state initialization proof is damaged or unreadable; preserve it", 2) from exc


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result
