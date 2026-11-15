from __future__ import annotations

"""Conservative schema-v2 snapshot publication for new names only.

This is intentionally not an overwrite or recovery implementation. A stale
operation lock is retained and refused; no age/PID based takeover is attempted.
"""

import hashlib
import json
import os
import platform
import re
import secrets
import stat
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from project_state.foundation.state_paths import ensure_state_dir, state_dir
from project_state import __version__
from project_state.capture.collectors import LayerResult, collect_config, collect_deps, collect_docker, collect_git, collect_runtime
from project_state.capture.database import discover_database_sources, online_backup
from project_state.foundation.sqlite_runtime import require_safe_sqlite
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path, project_root, require_windows_path_budget, validate_name
from project_state.foundation.filesystem import json_bytes as _json_bytes, mkdir_checked as _mkdir_checked, write_new as _write_new
from project_state.foundation.locking import OperationLock as _OperationLock, acquire_lock as _lock
from project_state.foundation.snapshot_publication import publish_snapshot_generation
from project_state.contracts.ports import OperationGatePort




def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()






def _collect(root: Path, *, with_seed: bool) -> dict[str, LayerResult]:
    if with_seed:
        # An explicit seed request is mandatory. Reject an unsafe bundled
        # SQLite engine before creating a state root, lock, or generation.
        require_safe_sqlite()
    results = {
        "config": collect_config(root),
        "deps": collect_deps(root),
        "runtime": collect_runtime(root),
    }
    results["git"] = collect_git(root)
    results["docker"] = collect_docker(root)
    if with_seed:
        sources = discover_database_sources(root)
        if not sources:
            raise ProjectStateError("EDATABASE_NOT_FOUND", "--with-seed requires at least one supported root-level SQLite database", 2)
        results["database"] = LayerResult("seed-requested", data={"sources": sources})
    else:
        results["database"] = LayerResult("skipped", reason="SQLite data was not requested; use --with-seed to require a private online backup")
    return results






def create_snapshot(root_value: str | os.PathLike[str], name: str, *, with_seed: bool = False,
                    lock_handle: _OperationLock | None = None,
                    operation_gate: OperationGatePort | None = None) -> dict:
    """Publish one partial-capable v2 snapshot at a previously unused name.

    Raw allowlisted project files are staged under the private secrets tree.
    Public/private generation directories become visible before current.json;
    the pointer is the publication commit marker. Existing names are refused.
    """
    root = project_root(root_value)
    validate_name(name)
    if operation_gate is None:
        raise ProjectStateError("EAPPLICATION_PORT", "snapshot writes require the application operation gate", 2)
    # Collect and validate all source data before creating project-state.
    layers = _collect(root, with_seed=with_seed)
    state = state_dir(root)
    snapshots = state / "snapshots"
    secrets_root = state / "secrets"
    generation = "0" * 32
    token = "0" * 32
    public_stage = secrets_root / f".staging-{token}" / "public"
    private_stage = secrets_root / f".staging-{token}" / "private"
    public_final = snapshots / name / "generations" / generation
    private_final = secrets_root / name / "generations" / generation
    path_budget = [
        public_stage / "manifest.json", private_stage / "manifest.json",
        public_final / "manifest.json", private_final / "manifest.json",
        snapshots / name / "current.json", snapshots / name / f".current-{token}.tmp",
    ]
    for layer_name, result in layers.items():
        if layer_name == "database" and with_seed and result.status == "collected" and result.data:
            for filename in result.data.get("sources", []):
                path_budget.extend((private_stage / "files" / filename, private_final / "files" / filename))
            path_budget.extend((private_stage / "files" / "database.json", private_final / "files" / "database.json"))
            continue
        if result.status != "collected" or result.data is None:
            continue
        path_budget.extend((public_stage / "files" / f"{layer_name}.json",
                            public_final / "files" / f"{layer_name}.json"))
        for source in result.files:
            path_budget.extend((private_stage / "files" / source.target,
                                private_final / "files" / source.target))
    require_windows_path_budget(path_budget)
    for directory in (state, snapshots, secrets_root):
        try:
            assert_plain_path(directory)
            if not directory.is_dir():
                raise ProjectStateError("EUNSAFE_PATH", "snapshot storage ancestor is not a directory", 1)
        except ProjectStateError as exc:
            if directory == state and not state.exists():
                continue
            if exc.code == "EINVENTORY_UNREADABLE" and not directory.exists():
                continue
            raise
    for existing in (snapshots / name, secrets_root / name):
        try:
            assert_plain_path(existing)
            existing.lstat()
        except FileNotFoundError:
            continue
        except ProjectStateError as exc:
            if exc.code == "EINVENTORY_UNREADABLE" and not existing.exists():
                continue
            raise
        raise ProjectStateError("EEXISTS", "snapshot name or private generation already exists; choose a new name", 1)
    owns_lock = lock_handle is None
    lock = lock_handle or _lock(root, name)
    expected_lock_path = state_dir(root) / "locks" / "operation.lock"
    if lock.path != expected_lock_path:
        if owns_lock:
            lock.release()
        raise ProjectStateError("ELOCK_UNCERTAIN", "snapshot received a lock for a different project operation", 2)
    token = lock.token
    try:
        operation_gate.assert_no_unresolved(root)
        _mkdir_checked(snapshots)
        _mkdir_checked(secrets_root)
        public_name = snapshots / name
        private_name = secrets_root / name
        for existing in (public_name, private_name):
            try:
                existing.lstat()
            except FileNotFoundError:
                continue
            raise ProjectStateError("EEXISTS", "snapshot name or private generation already exists; choose a new name", 1)

        generation = uuid.uuid4().hex
        staging_root = secrets_root / f".staging-{token}"
        public_stage = staging_root / "public"
        private_stage = staging_root / "private"
        staging_root.mkdir()
        staging_identity = staging_root.lstat()
        public_files = public_stage / "files"
        private_files = private_stage / "files"
        public_stage.mkdir()
        private_stage.mkdir()

        public_artifacts: list[dict] = []
        private_artifacts: list[dict] = []
        layer_status: dict[str, dict] = {}
        for layer_name, result in layers.items():
            if layer_name == "database" and with_seed:
                database_rows: list[dict] = []
                _mkdir_checked(private_files)
                for source_name in result.data["sources"]:
                    destination = f"{staging_root.name}/private/files/{source_name}"
                    lock.verify()
                    backup = online_backup(root, source_name, destination)
                    lock.verify()
                    artifact_id = f"database-backup:{source_name}"
                    database_rows.append({"file": source_name, "mode": "backup", "restore": "sqlite-create-missing",
                                          "artifactId": artifact_id, "schemaFingerprint": backup["schemaFingerprint"],
                                          "tables": backup["tables"], "totalRows": backup["totalRows"],
                                          "integrity": backup["integrity"], "rowContentsCompared": False})
                    private_artifacts.append({"id": artifact_id, "layer": "database", "kind": "sqlite-backup",
                                              "privacy": "private", "required": True,
                                              "restore": "sqlite-create-missing", "path": source_name,
                                              "sha256": backup["sha256"], "size": backup["size"], "target": source_name})
                data = {"databases": database_rows, "engine": "sqlite3 online backup API", "withSeed": True,
                        "comparison": "schema and row counts recorded; row contents not compared"}
                layer_data = _json_bytes(data)
                _write_new(private_files / "database.json", layer_data)
                private_artifacts.append({"id": "layer:database", "layer": "database", "kind": "layer-json",
                                          "privacy": "private", "required": True, "restore": "record-only",
                                          "path": "database.json", "sha256": _digest(layer_data), "size": len(layer_data)})
                layer_status[layer_name] = {"status": "collected", "file": "database.json"}
                continue
            if result.status != "collected" or result.data is None:
                layer_status[layer_name] = {"status": "skipped", "reason": result.reason or "collector unavailable"}
                continue
            layer_data = _json_bytes(result.data)
            _mkdir_checked(public_files)
            _write_new(public_files / f"{layer_name}.json", layer_data, 0o644)
            public_artifacts.append({"id": f"layer:{layer_name}", "layer": layer_name, "kind": "layer-json",
                                    "privacy": "public", "required": True, "restore": "record-only",
                                    "path": f"{layer_name}.json", "sha256": _digest(layer_data), "size": len(layer_data)})
            layer_status[layer_name] = {"status": "collected", "file": f"{layer_name}.json"}
            for source in result.files:
                if source.layer != layer_name or source.target != source.source_name:
                    raise ProjectStateError("EUNSAFE_PATH", "collector returned a mismatched source identity", 2)
                _mkdir_checked(private_files)
                _write_new(private_files / source.target, source.content)
                private_artifacts.append({"id": f"{layer_name}:{source.target}", "layer": layer_name, "kind": "file",
                                          "privacy": "private", "required": True, "restore": "restore-file",
                                          "path": source.target, "sha256": source.sha256, "size": source.size,
                                          "target": source.target})

        runtime = layers["runtime"].data if layers["runtime"].status == "collected" else None
        node_version = runtime["node"] if runtime else "unavailable"
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        identity = {"schemaVersion": 2, "state": "complete", "generation": generation, "kind": "named", "name": name,
                    "createdAt": created_at, "toolVersion": __version__,
                    "host": {"platform": sys.platform, "arch": platform.machine() or "unknown", "node": node_version},
                    "layers": layer_status}
        public_manifest = {**identity, "artifacts": public_artifacts}
        private_manifest = {**identity, "artifacts": private_artifacts}
        public_manifest_bytes = _json_bytes(public_manifest)
        private_manifest_bytes = _json_bytes(private_manifest)
        _write_new(public_stage / "manifest.json", public_manifest_bytes, 0o644)
        _write_new(private_stage / "manifest.json", private_manifest_bytes)

        publish_snapshot_generation(root, name, generation, public_manifest_bytes, lock)
        from project_state.foundation.storage import validate_pair
        verified = validate_pair(root, name, generation)
        current_stage = staging_root.lstat()
        if ((current_stage.st_dev, current_stage.st_ino) == (staging_identity.st_dev, staging_identity.st_ino)
                and current_stage.st_nlink == 1 and not any(staging_root.iterdir())):
            staging_root.rmdir()
        return {"name": name, "generation": generation, "kind": "named", "state": "verified",
                "layerStatus": verified["manifest"]["layers"], "artifactCount": len(verified["artifacts"]),
                "partial": any(item["status"] == "skipped" for item in layer_status.values()),
                "applicationHealth": "not-tested"}
    finally:
        # The lock file remains as an owner record; the OS lock is released.
        # A process crash releases the OS lock without age/PID based deletion.
        if owns_lock:
            lock.release()
