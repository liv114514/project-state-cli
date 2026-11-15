from __future__ import annotations

import os
import json
import sqlite3
import stat
from pathlib import Path
import re

from project_state.foundation.state_paths import state_dir
from project_state import __version__
from project_state.contracts.errors import ProjectStateError
from project_state.capture.collectors import collect_config, collect_deps
from project_state.foundation.git_state import inspect_git
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root, validate_snapshot_name
from project_state.foundation.process import run_trusted
from project_state.foundation.storage import validate_pair
from project_state.foundation.sqlite_runtime import sqlite_runtime_status


_DIRECT_DEP_NAME = re.compile(r"^(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+$")
_MAX_INSTALLED_PACKAGE_JSON = 1_048_576


def _read_installed_package_version(path: Path) -> str:
    """Read a bounded, stable, plain installed package metadata file."""
    assert_plain_path(path, allow_missing=True, hardlinks=True)
    before = path.lstat()
    if (is_reparse_point(before) or not stat.S_ISREG(before.st_mode) or before.st_nlink > 1
            or before.st_size > _MAX_INSTALLED_PACKAGE_JSON):
        raise ProjectStateError("EUNSAFE_PATH", "installed package metadata is not a supported plain file")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        path_identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_nlink)
        handle_identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_nlink)
        if path_identity(before) != path_identity(opened):
            raise ProjectStateError("ESOURCE_CHANGED", "installed package metadata changed while opening")
        content = bytearray()
        while len(content) <= _MAX_INSTALLED_PACKAGE_JSON:
            chunk = os.read(descriptor, min(65536, _MAX_INSTALLED_PACKAGE_JSON + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        after_fd = os.fstat(descriptor)
        after_path = path.lstat()
        if (len(content) > _MAX_INSTALLED_PACKAGE_JSON or handle_identity(opened) != handle_identity(after_fd)
                or path_identity(before) != path_identity(after_path)
                or path_identity(after_path) != path_identity(after_fd) or is_reparse_point(after_path)):
            raise ProjectStateError("ESOURCE_CHANGED", "installed package metadata changed while reading")
    finally:
        os.close(descriptor)
    value = json.loads(bytes(content).decode("utf-8"))
    version = value.get("version") if isinstance(value, dict) else None
    if not isinstance(version, str):
        raise ValueError("installed package version missing")
    return version


def _probe(command: str, root: Path) -> dict:
    result = run_trusted(command, ["--version"], cwd=root, timeout=15, max_output=65536)
    version = result["stdout"].strip().splitlines()[0] if result["ok"] and result["stdout"].strip() else None
    return {"available": bool(result["ok"]), "version": version,
            "reason": None if result["ok"] else result.get("code", "EPROBE")}


def _snapshot_config_reference(root: Path) -> tuple[dict | None, str | None, list[str], str | None]:
    """Return newest fully validated schema-v2 config metadata and legacy names.

    This reads only validated manifests/layer metadata and lstat presence for
    legacy directories; it never reads or follows historical database copies.
    """
    base = state_dir(root) / "snapshots"
    try:
        assert_plain_path(base, allow_missing=True)
        if not base.exists():
            return None, None, [], None
        names = sorted(item.name for item in base.iterdir())
    except (OSError, ProjectStateError):
        return None, None, [], "SNAPSHOT_INVENTORY_UNREADABLE"

    best: tuple[str, str, dict] | None = None
    legacy: list[str] = []
    legacy_error: str | None = None
    for name in names:
        try:
            validate_snapshot_name(name)
        except ProjectStateError:
            continue
        snapshot_dir = base / name
        try:
            st = snapshot_dir.lstat()
            if is_reparse_point(st) or not stat.S_ISDIR(st.st_mode):
                continue
            files_dir = snapshot_dir / "files"
            try:
                files_st = files_dir.lstat()
            except FileNotFoundError:
                files_st = None
            if files_st is not None and (is_reparse_point(files_st) or not stat.S_ISDIR(files_st.st_mode)):
                continue
            legacy_dir = files_dir / "db-original"
            try:
                legacy_st = legacy_dir.lstat()
                if is_reparse_point(legacy_st) or stat.S_ISDIR(legacy_st.st_mode):
                    legacy.append(name)
            except FileNotFoundError:
                pass
            except OSError:
                legacy_error = "LEGACY_SCAN_UNAVAILABLE"
        except OSError:
            legacy_error = "LEGACY_SCAN_UNAVAILABLE"
            continue
        try:
            checked = validate_pair(root, name)
            manifest = checked["manifest"]
            config = checked["layers"].get("config")
            if (manifest.get("schemaVersion") != 2 or not isinstance(config, dict)
                    or config.get("status") == "skipped" or config.get("__skipped")
                    or not isinstance(config.get("envFiles"), dict)):
                continue
            created = manifest.get("createdAt")
            if not isinstance(created, str):
                continue
            candidate = (created, name, config)
            if best is None or candidate[0] > best[0] or (candidate[0] == best[0] and candidate[1] < best[1]):
                best = candidate
        except (ProjectStateError, OSError, ValueError):
            # Damaged/unsupported snapshots are not repaired or used as a baseline.
            continue
    return (best[2], best[1], legacy, legacy_error) if best else (None, None, legacy, legacy_error)


def _config_key_changes(current: dict | None, baseline: dict) -> list[str]:
    now = current.get("envFiles", {}) if isinstance(current, dict) else {}
    before = baseline.get("envFiles", {})
    before_names = sorted(before)
    now_names = sorted(now)
    changes = [f"-{name}" for name in before_names if name not in now]
    changes.extend(f"+{name}" for name in now_names if name not in before)
    for filename in sorted(set(before_names) | set(now_names)):
        old_keys = (before.get(filename) or {}).get("keys", {})
        new_keys = (now.get(filename) or {}).get("keys", {})
        if not isinstance(old_keys, dict) or not isinstance(new_keys, dict):
            continue
        changes.extend(f"+{filename}:{key}" for key in sorted(new_keys.keys() - old_keys.keys()))
        changes.extend(f"-{filename}:{key}" for key in sorted(old_keys.keys() - new_keys.keys()))
    return changes


def _dependency_check(root: Path) -> dict:
    layer = collect_deps(root)
    if layer.status != "collected" or not layer.data:
        return {"id": "deps sync", "state": "unknown", "reasonCode": "DEPENDENCY_REFERENCE_UNAVAILABLE",
                "detail": layer.reason or "No dependency lock metadata is available for a read-only sync comparison."}
    resolved = layer.data.get("resolved")
    if not isinstance(resolved, dict):
        return {"id": "deps sync", "state": "unknown", "reasonCode": "DEPENDENCY_VERSIONS_UNRESOLVED",
                "detail": layer.data.get("note") or "The selected lockfile does not expose supported resolved versions."}
    drift: list[str] = []
    unavailable = 0
    node_modules = root / "node_modules"
    for name, locked in sorted(resolved.items()):
        segments = name.split("/") if isinstance(name, str) else []
        valid_segments = bool(segments) and all(segment not in {"", ".", ".."} for segment in segments)
        if (not isinstance(name, str) or not _DIRECT_DEP_NAME.fullmatch(name) or not valid_segments
                or name.startswith("@") and len(segments) != 2 or not isinstance(locked, str)):
            return {"id": "deps sync", "state": "unknown", "reasonCode": "DEPENDENCY_METADATA_UNSUPPORTED",
                    "detail": "A dependency name or locked version is outside the supported read-only comparison format."}
        package_path = node_modules.joinpath(*name.split("/"), "package.json")
        try:
            installed = _read_installed_package_version(package_path)
            if locked == "missing-in-lock" or installed != locked:
                drift.append(f"{name}: version differs from lockfile")
        except FileNotFoundError:
            unavailable += 1
            if len(drift) < 5:
                drift.append(f"{name}: missing from node_modules")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ProjectStateError, ValueError):
            return {"id": "deps sync", "state": "unknown", "reasonCode": "INSTALLED_DEPENDENCY_UNREADABLE",
                    "detail": "An installed package could not be safely read; no sync conclusion was made."}
    if len(drift) > 5:
        drift.append(f"and {len(drift) - 5} additional mismatch(es)")
    if drift:
        return {"id": "deps sync", "state": "issue", "reasonCode": "DEPENDENCY_DRIFT",
                "detail": "; ".join(drift),
                "next": "Review the lockfile and installed packages; this diagnostic does not run an installer."}
    return {"id": "deps sync", "state": "ok", "reasonCode": "DEPENDENCIES_MATCH_LOCKFILE",
            "detail": f"{len(resolved)} direct dependency version(s) match the supported lockfile."}


def doctor(root_value: str | os.PathLike[str]) -> dict:
    root = project_root(root_value)
    probes = {name: _probe(name, root) for name in ("git", "node", "npm", "sqlite3", "docker")}
    checks = []
    git = probes["git"]
    if not git["available"]:
        checks.append({"id": "git", "state": "unknown", "reasonCode": git["reason"], "detail": "Git CLI unavailable or could not be probed."})
    else:
        try:
            state = inspect_git(root, read_only=True)
            if not state["isGit"]:
                checks.append({"id": "git repository", "state": "issue", "reasonCode": "NOT_A_GIT_REPOSITORY",
                               "detail": "Current directory is not a Git work tree."})
            elif state["clean"]:
                checks.append({"id": "git worktree", "state": "ok", "reasonCode": "GIT_WORKTREE_CLEAN",
                               "detail": "Git worktree and index were inspected read-only and are clean."})
            else:
                checks.append({"id": "git worktree", "state": "issue", "reasonCode": "GIT_WORKTREE_DIRTY",
                               "detail": f"Git reports {len(state['dirty'])} changed path(s); no path names or contents were included in the report."})
        except ProjectStateError as exc:
            checks.append({"id": "git worktree", "state": "unknown", "reasonCode": exc.code,
                           "detail": "Git state could not be safely inspected; no restore readiness is claimed."})
    for key, label, code, detail in (
        ("node", "node", "NODE_AVAILABLE", "Node CLI is available for Node project workflows."),
        ("npm", "npm", "NPM_AVAILABLE", "npm CLI is available for dependency management."),
        ("sqlite3", "sqlite CLI", "SQLITE_CLI_AVAILABLE", "SQLite command-line tool is available."),
        ("docker", "docker", "DOCKER_AVAILABLE", "Docker CLI is available."),
    ):
        item = probes[key]
        checks.append({"id": label, "state": "ok" if item["available"] else "unknown",
                       "reasonCode": code if item["available"] else item["reason"],
                       "detail": detail if item["available"] else f"{label} was unavailable for this probe."})
    sqlite_status = sqlite_runtime_status()
    sqlite_ready = bool(sqlite_status["supported"])
    checks.append({"id": "Python SQLite", "state": "ok" if sqlite_ready else "issue",
                   "reasonCode": "PYTHON_SQLITE_AVAILABLE" if sqlite_ready else "SQLITE_RUNTIME_UNSUPPORTED",
                   "detail": (f"Python sqlite3 module {sqlite3.sqlite_version} meets the online-backup safety minimum."
                              if sqlite_ready else
                              f"Python sqlite3 module {sqlite3.sqlite_version} is below the online-backup safety minimum {'.'.join(map(str, sqlite_status['minimum']))}; explicit database backup or restore is refused." )})
    checks.append(_dependency_check(root))

    config = collect_config(root)
    current_config = config.data if config.status == "collected" else None
    baseline, baseline_name, legacy_names, legacy_error = _snapshot_config_reference(root)
    if legacy_names:
        checks.append({"id": "legacy backups", "state": "issue", "reasonCode": "LEGACY_DATABASE_COPY_PRESENT",
                       "detail": f"{len(legacy_names)} historical snapshot(s) contain a legacy database-copy path; presence only was checked. Treat it as private data and review it manually."})
    if legacy_error:
        checks.append({"id": "legacy scan", "state": "unknown", "reasonCode": legacy_error,
                       "detail": "Historical database-copy paths could not all be inspected; no file contents were read."})
    if baseline is None:
        checks.append({"id": "env keys", "state": "unknown", "reasonCode": "CONFIG_BASELINE_UNAVAILABLE",
                       "detail": "No fully validated schema-v2 snapshot with collected configuration metadata was found."})
    else:
        changes = _config_key_changes(current_config, baseline)
        if changes:
            checks.append({"id": "env keys", "state": "issue", "reasonCode": "CONFIG_KEYS_CHANGED",
                           "detail": f"{len(changes)} configuration file/key name change(s) since snapshot {baseline_name}: " + ", ".join(changes[:5])})
        else:
            checks.append({"id": "env keys", "state": "ok", "reasonCode": "CONFIG_KEYS_MATCH",
                           "detail": f"Configuration file/key names match snapshot {baseline_name}; values were not compared."})

    issues = sum(check["state"] == "issue" for check in checks)
    unknowns = sum(check["state"] == "unknown" for check in checks)
    return {"resultSchemaVersion": 1, "toolVersion": __version__, "command": "doctor",
            "mode": "general", "projectDirectory": "verified", "checks": checks,
            "summary": {"state": "issue" if issues else "unknown" if unknowns else "ok",
                        "issueCount": issues, "unknownCount": unknowns},
            "tools": {"git": probes["git"], "node": probes["node"], "npm": probes["npm"],
                      "sqliteCli": probes["sqlite3"], "docker": probes["docker"],
                      "pythonSqlite": {"available": True, "version": sqlite3.sqlite_version,
                                       "minimum": ".".join(map(str, sqlite_status["minimum"])),
                                       "supported": sqlite_ready}},
            "readOnly": True, "applicationHealth": "not-tested",
            "limitations": ["Configuration diagnosis compares file/key names only; values and schema compatibility are not checked.",
                            "Dependency diagnosis compares direct versions only and never runs an installer.",
                            "Tool availability does not authorize or prove a restore; application health is not tested."]}


