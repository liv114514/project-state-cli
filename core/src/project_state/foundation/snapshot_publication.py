"""Publish one staged snapshot generation under the caller-owned operation lock."""
from __future__ import annotations
import os
import re
from pathlib import Path
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.filesystem import json_bytes as _json_bytes, write_new as _write_new
from project_state.foundation.integrity import sha256 as _digest
from project_state.foundation.locking import OperationLock
from project_state.foundation.paths import assert_plain_path, validate_name
from project_state.foundation.state_paths import state_dir


def publish_snapshot_generation(root: Path, name: str, generation: str,
                                public_manifest_bytes: bytes, lock: OperationLock) -> None:
    """Publish staged files; caller owns lock and retains evidence on failure."""
    validate_name(name)
    if not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{32}", generation):
        raise ProjectStateError("EUNSAFE_PATH", "invalid snapshot generation identity", 2)
    token = lock.token
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{32}", token):
        raise ProjectStateError("ELOCK_UNCERTAIN", "snapshot lock token is invalid", 2)
    state = state_dir(root)
    if lock.path != state / "locks" / "operation.lock":
        raise ProjectStateError("ELOCK_UNCERTAIN", "snapshot received a lock for a different project operation", 2)
    public_name = state / "snapshots" / name
    private_name = state / "secrets" / name
    staging_root = state / "secrets" / f".staging-{token}"
    public_stage = staging_root / "public"
    private_stage = staging_root / "private"
    # Recheck name absence immediately before publication. No overwrite is
    # supported, so an existing object is never replaced.
    for existing in (public_name, private_name, public_name / "current.json"):
        try:
            existing.lstat()
        except FileNotFoundError:
            continue
        raise ProjectStateError("EEXISTS", "snapshot destination changed before publication", 2)
    public_name.mkdir()
    private_name.mkdir()
    public_generations = public_name / "generations"
    private_generations = private_name / "generations"
    public_generations.mkdir()
    private_generations.mkdir()
    public_final = public_generations / generation
    private_final = private_generations / generation
    os.rename(public_stage, public_final)
    os.rename(private_stage, private_final)

    pointer = {"schemaVersion": 1, "name": name, "generation": generation,
               "publicManifestSha256": _digest(public_manifest_bytes)}
    pointer_bytes = _json_bytes(pointer)
    pointer_temp = public_name / f".current-{token}.tmp"
    _write_new(pointer_temp, pointer_bytes, 0o644)
    lock.verify()
    assert_plain_path(public_name)
    current_path = public_name / "current.json"
    try:
        if os.name == "nt":
            # Windows os.rename fails if the destination exists.
            os.rename(pointer_temp, current_path)
        else:
            # POSIX rename replaces an existing destination. link() is
            # exclusive and therefore preserves an external object.
            os.link(pointer_temp, current_path, follow_symlinks=False)
            temp_stat, current_stat = pointer_temp.lstat(), current_path.lstat()
            if ((temp_stat.st_dev, temp_stat.st_ino) != (current_stat.st_dev, current_stat.st_ino)
                    or temp_stat.st_nlink != 2 or current_stat.st_nlink != 2):
                raise OSError("pointer identity changed during publication")
            pointer_temp.unlink()
    except OSError as exc:
        raise ProjectStateError("EPUBLISH", "snapshot artifacts staged but current pointer was not published; preserve the generation", 2) from exc
