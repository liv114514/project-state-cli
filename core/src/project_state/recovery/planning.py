from __future__ import annotations

"""Read-only restore planning for the first Python restore migration slice.

This module deliberately does not publish files. A plan is useful only after
the public/private snapshot pair, effective Git filters, current Git state,
target paths, and private source bytes have been checked. Apply remains
disabled until durable journal, safety-point, compensation, and recovery
protocols are implemented.
"""

import hashlib
import os
import re
import stat
from pathlib import Path

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.location import check_restore_location
from project_state.contracts.results import RestorePlan
from project_state.foundation.state_paths import state_dir
from project_state.foundation.git_state import git_probe, git_read, inspect_git, reject_content_filters
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root, validate_snapshot_name
from project_state.foundation.storage import validate_pair

_CONFIG_TARGETS = {".env", ".env.local"}
_MAX_FILE_SIZE = 1024 * 1024
_GIT_OBJECT_ID = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$", re.IGNORECASE)


def _read_verified(path: Path, expected_size: int, expected_sha256: str) -> tuple[int, int]:
    assert_plain_path(path, hardlinks=True)
    before_path = path.lstat()
    if not stat.S_ISREG(before_path.st_mode) or before_path.st_size > _MAX_FILE_SIZE:
        raise ProjectStateError("EUNSAFE_PATH", "configuration artifact is not a supported regular file", 2)
    try:
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            digest = hashlib.sha256()
            count = 0
            while chunk := stream.read(64 * 1024):
                count += len(chunk)
                if count > _MAX_FILE_SIZE:
                    raise ProjectStateError("EARTIFACT_INVALID", "configuration artifact exceeds the supported size", 2)
                digest.update(chunk)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EARTIFACT_UNREADABLE", "configuration artifact cannot be read", 2) from exc
    if ((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_nlink)
            != (before_path.st_dev, before_path.st_ino, before_path.st_size, before_path.st_mtime_ns, before_path.st_nlink)
            or (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_nlink)
            != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
            or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
            != (after_path.st_dev, after_path.st_ino, after_path.st_size, after_path.st_mtime_ns, after_path.st_nlink)
            or count != expected_size or count != after_fd.st_size or digest.hexdigest() != expected_sha256):
        raise ProjectStateError("EARTIFACT_INTEGRITY", "configuration source changed or failed integrity validation", 2)
    return after_fd.st_size, after_fd.st_mtime_ns


def _live_state(root: Path, target: str) -> dict:
    path = root / target
    try:
        assert_plain_path(path.parent)
        before = path.lstat()
    except FileNotFoundError:
        return {"exists": False, "size": 0, "sha256": None, "fileId": None}
    except OSError as exc:
        raise ProjectStateError("ETARGET_UNREADABLE", "configuration target cannot be inspected", 2) from exc
    if is_reparse_point(before) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > _MAX_FILE_SIZE:
        raise ProjectStateError("EUNSAFE_PATH", "configuration target is not a supported single-link regular file", 2)
    try:
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("ESOURCE_CHANGED", "configuration target identity changed while opening", 2)
            digest = hashlib.sha256()
            count = 0
            while chunk := stream.read(64 * 1024):
                count += len(chunk)
                if count > _MAX_FILE_SIZE:
                    raise ProjectStateError("EUNSAFE_PATH", "configuration target exceeds the supported size", 2)
                digest.update(chunk)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("ETARGET_UNREADABLE", "configuration target cannot be read", 2) from exc
    if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink)
            != (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
            or (after_fd.st_dev, after_fd.st_ino, after_fd.st_size, after_fd.st_mtime_ns, after_fd.st_nlink)
            != (after_path.st_dev, after_path.st_ino, after_path.st_size, after_path.st_mtime_ns, after_path.st_nlink)
            or count != before.st_size):
        raise ProjectStateError("ESOURCE_CHANGED", "configuration target changed while being inspected", 2)
    return {"exists": True, "size": count, "sha256": digest.hexdigest(),
            "fileId": f"{after_fd.st_dev}:{after_fd.st_ino}"}


def plan_config_restore(root_value: str | os.PathLike[str], name: str) -> RestorePlan:
    """Build a non-mutating config-only preview from one validated v2 pair."""
    root = project_root(root_value)
    # Config publication and rollback use atomic renames between the project
    # target and private stage/quarantine. Reject unsupported volume layouts
    # during preview, before a safety point, operation journal, or pin exists.
    check_restore_location(root, state_dir(root))
    validate_snapshot_name(name)
    pair = validate_pair(root, name)
    if pair["manifest"]["layers"].get("config", {}).get("status") != "collected":
        raise ProjectStateError("ERESTORE_INPUT", "snapshot has no collected config layer", 2)
    artifacts = [a for a in pair["artifacts"] if a["layer"] == "config" and a["kind"] == "file"]
    if not artifacts:
        raise ProjectStateError("ERESTORE_INPUT", "snapshot config layer contains no restorable files", 2)
    git = inspect_git(root, extra_paths=[a.get("target", "") for a in artifacts])
    if git["isGit"] and not git["clean"]:
        raise ProjectStateError("EGIT_DIRTY", "restore preview is refused while the Git worktree or index is dirty", 2)
    planned: list[dict] = []
    seen: set[str] = set()
    for artifact in artifacts:
        target = artifact.get("target")
        if target not in _CONFIG_TARGETS or target.casefold() in seen:
            raise ProjectStateError("EUNSAFE_PATH", "snapshot contains an unsupported or duplicate config target", 2)
        seen.add(target.casefold())
        source = Path(artifact["absolutePath"])
        _read_verified(source, artifact["size"], artifact["sha256"])
        live = _live_state(root, target)
        same = live["exists"] and live["size"] == artifact["size"] and live["sha256"] == artifact["sha256"]
        planned.append({"target": target, "action": "unchanged" if same else ("replace" if live["exists"] else "create"),
                        "current": {"exists": live["exists"], "size": live["size"]},
                        "snapshot": {"size": artifact["size"], "integrity": "verified"}})
    return {"resultSchemaVersion": 1, "command": "restore", "mode": "preview-only",
            "snapshot": name, "generation": pair["generation"], "selectedLayers": ["config"],
            "targets": planned, "git": {"state": "clean" if git["isGit"] else "not-a-repository",
                                          "head": git.get("head"), "branchRef": git.get("branchRef")},
            "businessWrites": 0, "safetyPointCreated": False,
            "nextStep": "after reviewing the plan, --yes applies only the listed supported config targets as a recoverable batch; no state was changed by this preview"}


def plan_git_restore(root_value: str | os.PathLike[str], name: str) -> dict:
    """Validate and preview the Git target without changing refs, index, or files.

    Git apply remains deliberately disabled until its multi-file publication and
    interrupted-operation protocol can prove ownership of every changed path.
    """
    root = project_root(root_value)
    validate_snapshot_name(name)
    pair = validate_pair(root, name)
    if pair["manifest"]["layers"].get("git", {}).get("status") != "collected":
        raise ProjectStateError("ERESTORE_INPUT", "snapshot has no collected Git layer", 2)
    data = pair["layers"].get("git")
    if not isinstance(data, dict) or data.get("dirty") is not False:
        raise ProjectStateError("EGIT_DIRTY_SNAPSHOT", "snapshot does not describe a clean Git state; Git restore is unsupported", 2)
    commit = data.get("commit")
    if not isinstance(commit, str) or not _GIT_OBJECT_ID.fullmatch(commit):
        raise ProjectStateError("ERESTORE_INPUT", "snapshot Git commit identity is invalid", 2)
    git = inspect_git(root, read_only=True)
    if not git.get("isGit"):
        raise ProjectStateError("EGIT_REQUIRED", "Git restore preview requires an ordinary Git repository", 2)
    if not git["clean"]:
        raise ProjectStateError("EGIT_DIRTY", "Git restore preview is refused while index or worktree changes exist", 2)
    resolved = git_read(root, ["rev-parse", "--verify", f"{commit}^{{commit}}"], label="snapshot commit").strip().lower()
    if resolved != commit.lower():
        raise ProjectStateError("EGIT_OBJECT_MISSING", "snapshot Git commit is unavailable in this repository", 2)
    tree_records = git_read(root, ["ls-tree", "-r", "-z", "--full-tree", commit], label="snapshot tree").split("\0")
    target_paths: list[str] = []
    for record in tree_records:
        if not record:
            continue
        metadata, separator, path = record.partition("\t")
        fields = metadata.split(" ")
        if not separator or len(fields) != 3 or not path:
            raise ProjectStateError("EGIT_TREE_INVALID", "snapshot Git tree output is malformed", 2)
        mode, object_type, object_id = fields
        if mode in {"120000", "160000"}:
            raise ProjectStateError("EGIT_TREE_UNSUPPORTED", "snapshot contains a symbolic link or submodule; Git restore is unsupported", 2)
        if mode not in {"100644", "100755"} or object_type != "blob" or not _GIT_OBJECT_ID.fullmatch(object_id):
            raise ProjectStateError("EGIT_TREE_UNSUPPORTED", "snapshot contains an unsupported Git tree entry", 2)
        target_paths.append(path)
    _reject_ignored_collisions(root, target_paths)
    reject_content_filters(root, [git["head"], commit], target_paths)
    changed = git_read(root, ["--no-pager", "diff", "--name-only", "-z", "--no-renames",
                             "--no-ext-diff", "--no-textconv", git["head"], commit],
                       label="target differences").split("\0")
    changed_paths = [path for path in changed if path]
    attached = data.get("detached") is False and isinstance(data.get("branch"), str)
    branch_ref = None
    if attached:
        branch = data["branch"]
        branch_check = git_probe(root, ["check-ref-format", "--branch", branch])
        if branch.startswith("-") or not branch_check["ok"]:
            raise ProjectStateError("ERESTORE_INPUT", "snapshot branch name is invalid", 2)
        ref = git_probe(root, ["show-ref", "--verify", "--hash", f"refs/heads/{branch}"])
        if not ref["ok"] and not (ref.get("started") and ref.get("complete") and ref.get("code") == 1):
            raise ProjectStateError("EGIT_REF_UNKNOWN", "snapshot branch reference could not be safely inspected", 2)
        if ref["ok"] and ref["stdout"].strip().lower() == commit.lower():
            branch_ref = f"refs/heads/{branch}"
    target_attachment = branch_ref
    already_at_target = git["head"].lower() == commit.lower() and git.get("branchRef") == target_attachment
    return {"resultSchemaVersion": 1, "command": "restore", "mode": "preview-only",
            "snapshot": name, "generation": pair["generation"], "selectedLayers": ["git"],
            "target": {"commit": commit.lower(), "branchRef": target_attachment,
                       "headMode": "attached" if target_attachment else "detached"},
            "current": {"commit": git["head"], "branchRef": git.get("branchRef"),
                        "indexSha256": git["indexSha256"], "refsSha256": hashlib.sha256(git["refsText"].encode("utf-8")).hexdigest()},
            "changedPathCount": len(changed_paths), "alreadyAtTarget": already_at_target,
            "application": "not-supported-yet", "businessWrites": 0,
            "nextStep": "Git mutation is not enabled in this Python candidate; no checkout, index update, or ref change was performed"}


def _reject_ignored_collisions(root: Path, target_paths: list[str]) -> None:
    """Refuse target paths that could displace ignored files or traverse links.

    A clean `git status` intentionally omits ignored files. Git checkout may
    nevertheless remove or replace an ignored file when a target tree needs
    that path. This preview therefore checks ignored paths explicitly and
    refuses collisions before it reports a usable plan.
    """
    ignored_output = git_read(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
                              label="ignored paths")
    if ignored_output and not ignored_output.endswith("\0"):
        raise ProjectStateError("EGIT_OUTPUT_INVALID", "Git ignored-path output was incomplete", 2)
    ignored = [value for value in ignored_output.split("\0") if value]
    for target in target_paths:
        parts = target.split("/")
        cursor = root
        for part in parts:
            cursor = cursor / part
            try:
                observed = cursor.lstat()
            except FileNotFoundError:
                break
            except OSError as exc:
                raise ProjectStateError("EGIT_TARGET_UNKNOWN", "Git restore target paths could not be safely inspected", 2) from exc
            if is_reparse_point(observed):
                raise ProjectStateError("EGIT_TARGET_UNSAFE", "Git restore target traverses a link or reparse point", 2)
            if cursor != root.joinpath(*parts) and not stat.S_ISDIR(observed.st_mode):
                raise ProjectStateError("EGIT_TARGET_COLLISION", "Git restore target conflicts with an existing file", 2)
        for path in ignored:
            if path == target or path.startswith(target + "/") or target.startswith(path + "/"):
                raise ProjectStateError("EGIT_IGNORED_COLLISION", "Git restore target conflicts with ignored project data; move it manually and preview again", 2)
