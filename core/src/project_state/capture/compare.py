from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path

from project_state.contracts.errors import ProjectStateError
from project_state.capture.collectors import collect_deps, collect_git, collect_runtime
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root
from project_state.foundation.storage import validate_pair


def _live_file(root: Path, target: str) -> bytes | None:
    path = root / target
    try:
        assert_plain_path(path.parent)
        st = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ProjectStateError("EARTIFACT_UNREADABLE", "configuration target cannot be inspected", 1) from exc
    if is_reparse_point(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink > 1 or st.st_size > 1024 * 1024:
        raise ProjectStateError("EUNSAFE_PATH", "configuration target is not a regular file", 1)
    before = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
    try:
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != before[:2]:
                raise ProjectStateError("EUNSAFE_PATH", "configuration target identity changed while opening", 1)
            data = stream.read(1024 * 1024 + 1)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except OSError as exc:
        raise ProjectStateError("EARTIFACT_UNREADABLE", "configuration target cannot be read", 1) from exc
    if len(data) > 1024 * 1024 or before != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns) or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink) != (after_path.st_dev, after_path.st_ino, after_path.st_size, after_path.st_mtime_ns, after_path.st_nlink) or after_path.st_nlink > 1 or len(data) != st.st_size:
        raise ProjectStateError("ESOURCE_CHANGED", "configuration target changed during comparison", 1)
    return data


def _artifact_bytes(artifact: dict | None) -> bytes | None:
    if artifact is None:
        return None
    if isinstance(artifact.get("content"), bytes):
        data = artifact["content"]
        if (len(data) != artifact.get("size") or
                hashlib.sha256(data).hexdigest() != artifact.get("sha256")):
            raise ProjectStateError("EARTIFACT_INTEGRITY", "captured comparison artifact failed integrity validation", 1)
        return data
    path = Path(artifact["absolutePath"])
    try:
        assert_plain_path(path, hardlinks=True)
        before = path.lstat()
        if before.st_size > 1024 * 1024:
            raise ProjectStateError("EARTIFACT_INVALID", "configuration artifact exceeds the supported comparison size", 1)
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("EUNSAFE_PATH", "configuration artifact identity changed while opening", 1)
            data = stream.read(1024 * 1024 + 1)
            after_fd = os.fstat(stream.fileno())
        after = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EARTIFACT_UNREADABLE", "validated configuration artifact cannot be read", 1) from exc
    if len(data) > 1024 * 1024 or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns) or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_nlink) or after.st_nlink > 1 or len(data) != artifact["size"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
        raise ProjectStateError("EARTIFACT_INTEGRITY", "configuration artifact changed during comparison", 1)
    return data


def _layer_state(snapshot: dict, name: str) -> tuple[dict | None, str | None]:
    meta = snapshot.get("manifest", {}).get("layers", {}).get(name)
    if not isinstance(meta, dict):
        return None, "layer observation is absent"
    if meta.get("status") == "skipped":
        reason = meta.get("reason")
        return None, reason if isinstance(reason, str) else "layer collection was skipped"
    value = snapshot.get("layers", {}).get(name)
    return (value, None) if isinstance(value, dict) else (None, "validated layer data is unavailable")


def _live_layer(root: Path, name: str) -> dict:
    collector = {"deps": collect_deps, "runtime": collect_runtime}[name]
    result = collector(root)
    if result.status != "collected" or result.data is None:
        return {"manifest": {"layers": {name: {"status": "skipped", "reason": result.reason or "collection skipped"}}},
                "layers": {}, "artifacts": []}
    artifacts = [{"layer": item.layer, "kind": "file", "privacy": "private",
                  "restore": "restore-file", "target": item.target,
                  "size": item.size, "sha256": item.sha256, "content": item.content}
                 for item in result.files]
    return {"manifest": {"layers": {name: {"status": "collected"}}},
            "layers": {name: result.data}, "artifacts": artifacts}


def _dependency_projection(artifacts: list[dict]) -> dict | None:
    matches = [item for item in artifacts if item.get("layer") == "deps" and item.get("target") == "package.json"
               and item.get("kind") == "file" and item.get("privacy") == "private"
               and item.get("restore") == "restore-file"]
    if len(matches) != 1:
        return None
    try:
        raw = _artifact_bytes(matches[0])
        package = json_load_strict(raw)
        if not isinstance(package, dict):
            return None
        projection = {}
        for group in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"):
            if group not in package:
                continue
            values = package[group]
            if not isinstance(values, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in values.items()):
                return None
            projection[group] = dict(sorted(values.items()))
        encoded = json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return {"sha256": hashlib.sha256(encoded).hexdigest()}
    except (OSError, ValueError, UnicodeError, ProjectStateError, RecursionError):
        return None


def _dependency_pairing_state(snapshot: dict, layer: dict) -> str:
    lock_name = layer.get("lockFile")
    if lock_name is None:
        return "not-applicable"
    if lock_name != "package-lock.json":
        return "unknown"
    def artifact(target: str) -> dict | None:
        found = [item for item in snapshot.get("artifacts", []) if item.get("layer") == "deps"
                 and item.get("target") == target and item.get("kind") == "file"
                 and item.get("privacy") == "private" and item.get("restore") == "restore-file"]
        return found[0] if len(found) == 1 else None
    try:
        package_artifact, lock_artifact = artifact("package.json"), artifact("package-lock.json")
        if package_artifact is None or lock_artifact is None:
            return "unknown"
        package = json_load_strict(_artifact_bytes(package_artifact))
        lock = json_load_strict(_artifact_bytes(lock_artifact))
        root = lock.get("packages", {}).get("") if isinstance(lock, dict) and isinstance(lock.get("packages"), dict) else None
        if not isinstance(package, dict) or not isinstance(root, dict):
            return "unknown"
        for group in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            declared = package.get(group, {})
            resolved = root.get(group, {})
            if not isinstance(declared, dict) or not isinstance(resolved, dict):
                return "unknown"
            if declared != resolved:
                return "mismatch"
        return "consistent"
    except (OSError, ValueError, UnicodeError, ProjectStateError, AttributeError, TypeError, RecursionError):
        return "unknown"


def json_load_strict(raw: bytes):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def _runtime_pin_state(snapshot: dict, name: str) -> str | None:
    layer, _ = _layer_state(snapshot, "runtime")
    if layer is None:
        return None
    pins = layer.get("versionPins")
    if not isinstance(pins, list):
        return None
    declared = [item for item in pins if isinstance(item, dict) and item.get("name") == name]
    artifacts = [item for item in snapshot.get("artifacts", []) if item.get("layer") == "runtime"
                 and item.get("target") == name and item.get("kind") == "file"
                 and item.get("privacy") == "private" and item.get("restore") == "restore-file"]
    if not declared and not artifacts:
        return "absent"
    if len(declared) != 1 or len(artifacts) != 1:
        return None
    try:
        return hashlib.sha256(_artifact_bytes(artifacts[0])).hexdigest()
    except (OSError, ProjectStateError, TypeError):
        return None


def _diff_deps(a: dict, b: dict, artifacts_a: list[dict], artifacts_b: list[dict]) -> tuple[list[str], int]:
    lines: list[str] = []
    count = 0
    left, right = a, b
    if left.get("lockFile") != right.get("lockFile"):
        lines.append(f"~ lockfile: {left.get('lockFile') or '(none)'} -> {right.get('lockFile') or '(none)'}")
        count += 1
    elif left.get("lockFingerprint") != right.get("lockFingerprint"):
        lines.append("~ lockfile fingerprint changed")
        count += 1
    elif left.get("lockFile"):
        lines.append(f"= lockfile: {left['lockFile']} (same fingerprint)")
    resolved_a, resolved_b = left.get("resolved"), right.get("resolved")
    if isinstance(resolved_a, dict) and isinstance(resolved_b, dict):
        resolved_changes = sum(resolved_a.get(package) != resolved_b.get(package)
                               for package in set(resolved_a) | set(resolved_b))
        if resolved_changes:
            lines.append(f"~ {resolved_changes} resolved package version(s) changed (names and values withheld)")
            count += resolved_changes
        else:
            lines.append("= resolved package versions match")
    else:
        lines.append("? resolved dependency versions not compared (validated metadata unavailable)")
    projection_a = _dependency_projection(artifacts_a)
    projection_b = _dependency_projection(artifacts_b)
    if projection_a is None or projection_b is None:
        lines.append("? package.json dependency declarations not compared (validated private file unavailable)")
    elif projection_a["sha256"] != projection_b["sha256"]:
        lines.append("~ package.json dependency declarations changed (values withheld)")
        count += 1
    else:
        lines.append("= package.json dependency declarations match (values withheld)")
    pair_a = _dependency_pairing_state({"artifacts": artifacts_a}, left)
    pair_b = _dependency_pairing_state({"artifacts": artifacts_b}, right)
    if pair_a == "mismatch":
        lines.append("! package.json and package-lock.json declarations disagree in A (values withheld)")
        count += 1
    if pair_b == "mismatch":
        lines.append("! package.json and package-lock.json declarations disagree in B (values withheld)")
        count += 1
    if "unknown" in {pair_a, pair_b}:
        lines.append("? package.json/lockfile pairing not compared (unsupported format or validated private input unavailable)")
    elif pair_a == pair_b == "consistent":
        lines.append("= package.json and package-lock.json declarations match in both snapshots")
    return lines, count


def _diff_runtime(a: dict, b: dict, snap_a: dict, snap_b: dict) -> tuple[list[str], int]:
    lines: list[str] = []
    count = 0
    for key in ("node", "npm", "python"):
        left, right = a.get(key), b.get(key)
        if left != right:
            lines.append(f"~ {key} version changed")
            count += 1
        elif left:
            lines.append(f"= {key} version matches")
    pins_a, pins_b = a.get("versionPins"), b.get("versionPins")
    if not isinstance(pins_a, list) or not isinstance(pins_b, list):
        lines.append("? runtime pin files not compared (validated metadata unavailable)")
        return lines, count
    names_a = {item.get("name") for item in pins_a if isinstance(item, dict) and isinstance(item.get("name"), str)}
    names_b = {item.get("name") for item in pins_b if isinstance(item, dict) and isinstance(item.get("name"), str)}
    # Include validated artifacts as well, so contradictory metadata is unknown rather than hidden.
    for snap, names in ((snap_a, names_a), (snap_b, names_b)):
        for artifact in snap.get("artifacts", []):
            if artifact.get("layer") == "runtime" and artifact.get("target") in {".nvmrc", ".node-version"}:
                names.add(artifact["target"])
    for name in sorted(names_a | names_b):
        before, after = _runtime_pin_state(snap_a, name), _runtime_pin_state(snap_b, name)
        if before is None or after is None:
            lines.append(f"? runtime pin {name} contents not compared (validated private file evidence unavailable)")
        elif before == "absent" and after != "absent":
            lines.append(f"+ runtime pin {name} present in B only (contents withheld)")
            count += 1
        elif before != "absent" and after == "absent":
            lines.append(f"- runtime pin {name} present in A only (contents withheld)")
            count += 1
        elif before != after:
            lines.append(f"~ runtime pin {name} changed (contents withheld)")
            count += 1
        else:
            lines.append(f"= runtime pin {name} contents match (contents withheld)")
    return lines, count


def _database_state(snapshot: dict) -> tuple[dict[str, dict] | None, str | None]:
    layer, reason = _layer_state(snapshot, "database")
    if layer is None:
        return None, reason or "validated database metadata is unavailable"
    rows = layer.get("databases")
    if not isinstance(rows, list):
        return None, "validated database metadata is malformed"
    result: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("file"), str):
            return None, "validated database metadata is malformed"
        key = row["file"].casefold()
        if key in result:
            return None, "database metadata contains a case-colliding name"
        result[key] = row
    return result, None


def _diff_database(left_snapshot: dict, right_snapshot: dict) -> tuple[list[str], int]:
    """Compare only validated schema-v2 database metadata, never row contents."""
    left, left_reason = _database_state(left_snapshot)
    right, right_reason = _database_state(right_snapshot)
    if left is None or right is None:
        return ([f"? database not compared ({left_reason or 'snapshot A collected'}; "
                 f"{right_reason or 'snapshot B collected'})",
                 "? database row contents not compared"], 0)
    lines: list[str] = []
    differences = 0
    for key in sorted(set(left) | set(right)):
        before, after = left.get(key), right.get(key)
        display = (before or after)["file"]
        if before is None:
            lines.append(f"+ database {display}: present in B only (contents not compared)")
            differences += 1
            continue
        if after is None:
            lines.append(f"- database {display}: present in A only (contents not compared)")
            differences += 1
            continue
        changed = 0
        if before.get("mode") != after.get("mode"):
            lines.append(f"~ database {display}: capture mode changed")
            differences += 1
            changed += 1
        if before.get("schemaFingerprint") != after.get("schemaFingerprint"):
            lines.append(f"~ database {display}: recorded schema changed")
            differences += 1
            changed += 1
        if before.get("tables") != after.get("tables"):
            lines.append(f"~ database {display}: recorded table list changed")
            differences += 1
            changed += 1
        if before.get("totalRows") != after.get("totalRows"):
            lines.append(f"~ database {display}: recorded row count changed")
            differences += 1
            changed += 1
        if not changed:
            lines.append(f"= database {display}: recorded schema/table/row-count metadata match")
        lines.append(f"? database {display}: row contents not compared")
    if not left and not right:
        lines.append("= no recorded databases in either snapshot")
    return lines, differences


def _git_data(snapshot: dict) -> tuple[dict | None, str | None]:
    """Return a validated Git summary, or a reason that it is unavailable."""
    layer = snapshot["manifest"].get("layers", {}).get("git")
    if not isinstance(layer, dict):
        return None, "snapshot has no Git observation"
    if layer.get("status") == "skipped":
        reason = layer.get("reason")
        return None, reason if isinstance(reason, str) else "snapshot Git observation was skipped"
    value = snapshot["layers"].get("git")
    if not isinstance(value, dict):
        return None, "validated Git layer is unavailable"
    return value, None


def _diff_git(left: dict | None, right: dict | None) -> tuple[list[str], int]:
    if left is None or right is None:
        return ["? Git commit, branch, and worktree summary not compared (validated observation unavailable)"], 0
    lines: list[str] = []
    differences = 0
    left_commit, right_commit = left["commit"], right["commit"]
    if left_commit != right_commit:
        differences += 1
        lines.append(f"~ Git commit: {left_commit[:7]} -> {right_commit[:7]}")
    else:
        lines.append("= Git commit: same")
    left_branch = left["branch"] or "detached"
    right_branch = right["branch"] or "detached"
    if left_branch != right_branch or left["detached"] != right["detached"]:
        differences += 1
        lines.append(f"~ Git attachment: {left_branch} -> {right_branch}")
    else:
        lines.append(f"= Git attachment: {left_branch}")
    if left["dirty"] != right["dirty"] or left["dirtyCount"] != right["dirtyCount"]:
        differences += 1
        lines.append(f"~ Git worktree: {left['dirtyCount']} changed path(s) -> {right['dirtyCount']} changed path(s)")
    else:
        lines.append(f"= Git worktree: {left['dirtyCount']} changed path(s) on both sides")
    return lines, differences


def compare(root_value: str | os.PathLike[str], name_a: str, name_b: str | None = None) -> tuple[int, str]:
    root = project_root(root_value)
    a = validate_pair(root, name_a)
    b = validate_pair(root, name_b) if name_b else None
    lines: list[str] = []
    differences = 0
    left_git, left_git_reason = _git_data(a)
    if b:
        right_git, right_git_reason = _git_data(b)
    else:
        current_git = collect_git(root)
        if current_git.status == "collected":
            right_git, right_git_reason = current_git.data, None
        else:
            right_git, right_git_reason = None, current_git.reason or "live Git observation was skipped"
    git_lines, git_differences = _diff_git(left_git, right_git)
    differences += git_differences
    lines.append("[git]")
    if left_git is None and left_git_reason:
        lines.append(f"? snapshot A Git observation unavailable ({left_git_reason})")
    if right_git is None and right_git_reason:
        lines.append(f"? comparison Git observation unavailable ({right_git_reason})")
    lines.extend(git_lines)
    for target in (".env", ".env.local"):
        left_row = next((item for item in a["artifacts"] if item["layer"] == "config" and item.get("target") == target and item["kind"] == "file"), None)
        right_row = next((item for item in b["artifacts"] if item["layer"] == "config" and item.get("target") == target and item["kind"] == "file"), None) if b else None
        left = _artifact_bytes(left_row)
        if b:
            right = _artifact_bytes(right_row)
        else:
            right = _live_file(root, target)
        if left is None and right is None:
            lines.append(f"= config {target}: absent on both sides")
        elif left is None or right is None:
            differences += 1
            lines.append(f"~ config {target}: present on one side only (values withheld)")
        elif hashlib.sha256(left).digest() == hashlib.sha256(right).digest():
            lines.append(f"= config {target}: bytes match (values withheld)")
        else:
            differences += 1
            lines.append(f"~ config {target}: contents changed (values and private digests withheld)")
    live_deps = _live_layer(root, "deps") if b is None else None
    live_runtime = _live_layer(root, "runtime") if b is None else None
    for layer_name, live_value, comparator in (
        ("deps", live_deps, _diff_deps),
        ("runtime", live_runtime, _diff_runtime),
    ):
        left_data, left_reason = _layer_state(a, layer_name)
        right_snapshot = b if b is not None else live_value
        right_data, right_reason = _layer_state(right_snapshot, layer_name)
        lines.append(f"[{layer_name}]")
        if left_data is None or right_data is None:
            lines.append(f"? {layer_name} not compared ({'snapshot A: ' + left_reason if left_data is None else 'snapshot A collected'}; {'snapshot B: ' + right_reason if right_data is None else 'snapshot B collected'})")
            continue
        if layer_name == "deps":
            layer_lines, layer_differences = comparator(
                left_data, right_data, a.get("artifacts", []), right_snapshot.get("artifacts", []))
        else:
            layer_lines, layer_differences = comparator(left_data, right_data, a, right_snapshot)
        lines.extend(f"  {item}" for item in layer_lines)
        differences += layer_differences
    lines.append("[database]")
    if b is None:
        # The candidate deliberately avoids opening live SQLite databases as a
        # side effect of compare; only two fully validated saved observations
        # are compared here.
        lines.append("  ? live database schema and row counts not compared (no live database read was requested)")
        lines.append("  ? database row contents not compared")
    else:
        database_lines, database_differences = _diff_database(a, b)
        lines.extend(f"  {item}" for item in database_lines)
        differences += database_differences
    lines.append("[docker]")
    lines.append("  ? Docker Compose service comparison is not implemented in this migration slice")
    lines.append(f"Comparison completed: {differences} supported difference(s) across Git, configuration, dependency metadata, and runtime pins.")
    return 0, "\n".join(lines)
