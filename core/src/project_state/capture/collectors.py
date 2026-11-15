"""Read-only collectors for supported, allowlisted project files.

These collectors only observe inputs. They do not publish a snapshot, create
private state, or execute project scripts. Raw bytes are carried privately in
CapturedFile and are intentionally hidden from repr/JSON diagnostics.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.git_state import inspect_git
from project_state.foundation.paths import assert_plain_path, project_root
from project_state.foundation.process import run_trusted

CONFIG_FILES = (".env", ".env.local")
RUNTIME_FILES = (".nvmrc", ".node-version")
LOCK_FILES = ("package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml")
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
SOURCE_ALLOWLIST = frozenset((*CONFIG_FILES, *RUNTIME_FILES, "package.json", *LOCK_FILES))
_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
_JS_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


@dataclass(frozen=True)
class CapturedFile:
    """One stable, allowlisted source observation for a future private artifact."""

    source_name: str
    layer: str
    target: str
    size: int
    sha256: str
    content: bytes = field(repr=False)


@dataclass(frozen=True)
class LayerResult:
    status: str
    data: dict | None = None
    files: tuple[CapturedFile, ...] = ()
    reason: str | None = None


def _capture(root: Path, name: str, layer: str) -> CapturedFile | None:
    if name not in SOURCE_ALLOWLIST:
        raise ProjectStateError("EUNSAFE_PATH", "collector source is outside the fixed allowlist", 1)
    path = root / name
    try:
        assert_plain_path(path, allow_missing=True, hardlinks=True)
        before = path.lstat()
    except FileNotFoundError:
        return None
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("ESOURCE_UNREADABLE", "supported project file cannot be inspected", 1) from exc
    if not stat.S_ISREG(before.st_mode) or before.st_nlink > 1:
        raise ProjectStateError("EUNSAFE_PATH", "supported project file is not a single-link regular file", 1)

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb", closefd=True) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink > 1:
                raise ProjectStateError("ESOURCE_CHANGED", "supported project file identity changed while opening", 1)
            content = stream.read()
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("ESOURCE_UNREADABLE", "supported project file could not be read safely", 1) from exc
    # Windows may report ctime differently for a path stat and its open file
    # handle. Compare path-to-path using stable shared fields, and compare the
    # complete timestamps between two observations of the same descriptor.
    path_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink)
    path_after = (after_path.st_dev, after_path.st_ino, after_path.st_size, after_path.st_mtime_ns, after_path.st_nlink)
    fd_before = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns, opened.st_nlink)
    fd_after = (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_ctime_ns, after_fd.st_nlink)
    if path_before != path_after or fd_before != fd_after or path_before[:4] != fd_after[:4] or after_path.st_nlink > 1:
        raise ProjectStateError("ESOURCE_CHANGED", "supported project file changed while being captured", 1)
    return CapturedFile(name, layer, name, len(content), hashlib.sha256(content).hexdigest(), content)


def _skip(reason: str) -> LayerResult:
    return LayerResult("skipped", reason=reason)


def collect_git(root_value: str | os.PathLike[str]) -> LayerResult:
    """Capture the schema-v2 Git summary using the guarded read-only probe.

    Probe failures are explicitly skipped with a stable, non-sensitive code;
    they are never represented as a clean repository. Git paths can appear in
    the same bounded status sample as the Node implementation, but file bytes,
    index contents, and refs are not copied into this public layer.
    """
    root = project_root(root_value)
    try:
        state = inspect_git(root, read_only=True)
    except ProjectStateError as exc:
        return _skip(f"Git state could not be safely captured ({exc.code}); Git layer omitted")
    if not state.get("isGit"):
        return _skip("Not a Git repository (Git work tree was not detected)")
    dirty = state["dirty"]
    sample = [f"{row['code']} {row['path']}" for row in dirty[:50]]
    return LayerResult("collected", {
        "commit": state["head"],
        "branch": state["branch"],
        "detached": state["branchRef"] is None,
        "dirty": bool(dirty),
        "dirtyCount": len(dirty),
        "statusSample": sample,
    })


def collect_docker(root_value: str | os.PathLike[str]) -> LayerResult:
    """Read a bounded Docker Compose service summary without reading compose files."""
    root = project_root(root_value)
    if not any((root / name).exists() for name in COMPOSE_FILES):
        return _skip("No docker-compose file found in project root")
    result = run_trusted("docker", ["compose", "ps", "--format", "json"],
                         cwd=root, timeout=20, max_output=10 * 1024 * 1024)
    if not result["ok"]:
        code = result.get("code")
        return _skip(f"Docker Compose service query failed ({code}); Docker layer omitted")
    services: list[dict[str, str]] = []
    for line in result["stdout"].splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            # Compose v2 emits one JSON object per line; malformed output is
            # treated as non-authoritative data, matching the legacy reader.
            continue
        if not isinstance(row, dict):
            continue
        name = row.get("Name") or row.get("Service")
        state = row.get("State") or row.get("Status")
        services.append({"name": name if isinstance(name, str) else "?",
                         "state": state if isinstance(state, str) else "?"})
    return LayerResult("collected", {"services": services})


def parse_env(content: bytes) -> dict[str, dict[str, bool]]:
    """Mirror the rc.15 key/non-empty projection; never return values."""
    text = content.decode("utf-8", errors="replace")
    keys: dict[str, dict[str, bool]] = {}
    # Match the source runtime's CRLF/LF splitting; str.splitlines() also
    # treats Unicode separators and lone CR as line boundaries.
    for raw in re.split(r"\r?\n", text):
        line = raw.strip(_JS_TRIM)
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        equals = line.find("=")
        if equals <= 0:
            continue
        key = line[:equals].strip()
        if not _ENV_KEY.fullmatch(key):
            continue
        value = line[equals + 1:].strip(_JS_TRIM)
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            value = value[1:-1]
        keys[key] = {"nonEmpty": len(value) > 0}
    return keys


def collect_config(root_value: str | os.PathLike[str]) -> LayerResult:
    root = project_root(root_value)
    data: dict[str, dict] = {}
    files: list[CapturedFile] = []
    try:
        for name in CONFIG_FILES:
            captured = _capture(root, name, "config")
            if captured is None:
                continue
            keys = parse_env(captured.content)
            data[name] = {"keyCount": len(keys), "keys": keys}
            files.append(captured)
    except ProjectStateError:
        return _skip("a supported configuration file could not be captured safely; configuration layer omitted")
    return LayerResult("collected", {"envFiles": data}, tuple(files)) if data else _skip("No .env / .env.local found in project root")


def _json_object(content: bytes) -> dict | None:
    def reject_nonstandard_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON constant: {value}")

    try:
        # Node JSON.parse does not strip a UTF-8 BOM or accept NaN/Infinity.
        value = json.loads(content.decode("utf-8"), parse_constant=reject_nonstandard_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def collect_deps(root_value: str | os.PathLike[str]) -> LayerResult:
    root = project_root(root_value)
    try:
        package_file = _capture(root, "package.json", "deps")
    except ProjectStateError:
        return _skip("package.json could not be captured safely; dependency layer omitted")
    if package_file is None:
        return _skip("No readable package.json in project root (npm project not detected)")
    package = _json_object(package_file.content)
    if package is None:
        return _skip("No readable package.json in project root (npm project not detected)")
    package_data = {"name": package.get("name") if isinstance(package.get("name"), str) else None,
                    "version": package.get("version") if isinstance(package.get("version"), str) else None}
    files: list[CapturedFile] = [package_file]
    lock_file = None
    lock_fingerprint = None
    note = None
    lock_capture = None
    for name in LOCK_FILES:
        try:
            candidate = _capture(root, name, "deps")
        except ProjectStateError:
            note = f"{name} is unsafe or unreadable; candidate skipped"
            continue
        if candidate is not None:
            lock_file = name
            lock_capture = candidate
            lock_fingerprint = candidate.sha256[:12]
            files.append(candidate)
            break

    resolved = None
    if lock_file == "package-lock.json" and lock_capture is not None:
        lock = _json_object(lock_capture.content)
        packages = lock.get("packages") if lock else None
        root_entry = packages.get("") if isinstance(packages, dict) else None
        if isinstance(root_entry, dict):
            declared: dict = {}
            for section in ("dependencies", "devDependencies"):
                values = root_entry.get(section)
                if isinstance(values, dict):
                    declared.update(values)
            resolved = {}
            for name in declared:
                entry = packages.get(f"node_modules/{name}") if isinstance(name, str) else None
                version = entry.get("version") if isinstance(entry, dict) else None
                resolved[str(name)] = version if isinstance(version, str) and version else "missing-in-lock"
        else:
            note = "package-lock.json has no root packages entry; fingerprint only"
    elif lock_file:
        note = f"{lock_file} stored as full-file fingerprint only (no version diff in v1)"
    else:
        note = note or "No lockfile found; nothing to pin"
    return LayerResult("collected", {"packageJson": package_data, "lockFile": lock_file,
                                      "lockFingerprint": lock_fingerprint, "resolved": resolved, "note": note}, tuple(files))


def collect_runtime(root_value: str | os.PathLike[str]) -> LayerResult:
    root = project_root(root_value)
    node_result = run_trusted("node", ["--version"], cwd=root, timeout=10, max_output=65536)
    npm_result = run_trusted("npm", ["--version"], cwd=root, timeout=15, max_output=65536)
    node_version = node_result["stdout"].strip() if node_result["ok"] and node_result["stdout"].strip() else "unavailable"
    npm_version = npm_result["stdout"].strip() if npm_result["ok"] and npm_result["stdout"].strip() else None
    python_version = f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    pins: list[dict[str, str]] = []
    files: list[CapturedFile] = []
    try:
        for name in RUNTIME_FILES:
            captured = _capture(root, name, "runtime")
            if captured is not None:
                pins.append({"name": name})
                files.append(captured)
    except ProjectStateError:
        return _skip("a supported runtime pin could not be captured safely; runtime layer omitted")
    return LayerResult("collected", {"node": node_version, "npm": npm_version,
                                      "python": python_version, "versionPins": pins}, tuple(files))
