"""Read-only Git preflight used before any future restore implementation.

This module intentionally does not provide checkout or index-writing methods.
It refuses ambiguous repositories and content filters before invoking status,
which can execute configured clean/process filters.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import project_root, validate_relative
from project_state.foundation.process import run_trusted

_OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$", re.IGNORECASE)
_INDEX_META = re.compile(r"^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$", re.IGNORECASE)
_FILTER_NAME = re.compile(r"^[A-Za-z0-9_.+-]{1,128}$")


def _environment() -> dict[str, str]:
    env = dict(os.environ)
    # Do not allow a caller's repository redirection variables to change which
    # index/config context these read-only probes inspect.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(key, None)
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _git(root: Path, args: list[str], *, max_output: int = 10 * 1024 * 1024) -> dict:
    return run_trusted("git", args, cwd=root, timeout=30, max_output=max_output, env=_environment())


def git_read(root_value: str | os.PathLike[str], args: list[str], *, label: str,
             max_output: int = 10 * 1024 * 1024) -> str:
    """Run a bounded, non-mutating Git query using the restore-safe environment."""
    root = project_root(root_value)
    result = _git(root, args, max_output=max_output)
    if not result["ok"]:
        raise ProjectStateError("EGIT_PROBE", f"Git {label} could not be safely inspected", 2)
    output = result["stdout"]
    if "\ufffd" in output:
        raise ProjectStateError("EGIT_PATH_ENCODING", f"Git {label} output cannot be safely decoded", 2)
    return output


def git_probe(root_value: str | os.PathLike[str], args: list[str], *,
              max_output: int = 10 * 1024 * 1024) -> dict:
    """Return bounded Git command facts for callers with expected nonzero cases."""
    return _git(project_root(root_value), args, max_output=max_output)


def _required(root: Path, args: list[str], label: str, *, max_output: int = 10 * 1024 * 1024) -> str:
    result = _git(root, args, max_output=max_output)
    if not result["ok"]:
        raise ProjectStateError("EGIT_PROBE", f"Git {label} could not be safely inspected", 2)
    value = result["stdout"]
    if "\ufffd" in value:
        raise ProjectStateError("EGIT_PATH_ENCODING", "Git returned a path that cannot be safely decoded", 2)
    return value


def _nul_paths(output: str, label: str) -> list[str]:
    if output and not output.endswith("\0"):
        raise ProjectStateError("EGIT_OUTPUT_INVALID", f"Git {label} output was incomplete", 2)
    return [field for field in output.split("\0") if field]


def parse_index_entries(output: str) -> list[dict[str, str | int]]:
    """Parse `git ls-files --stage -z` without splitting filenames on spaces."""
    rows: list[dict[str, str | int]] = []
    for record in _nul_paths(output, "index"):
        separator = record.find("\t")
        if separator < 0:
            raise ProjectStateError("EGIT_INDEX_INVALID", "Git index output was malformed", 2)
        match = _INDEX_META.fullmatch(record[:separator])
        path = record[separator + 1 :]
        if match is None or not path:
            raise ProjectStateError("EGIT_INDEX_INVALID", "Git index output was malformed", 2)
        mode, oid, stage = match.groups()
        if mode == "160000":
            raise ProjectStateError("EGIT_SUBMODULE_UNSUPPORTED", "Git submodules are not supported for restore", 2)
        if mode == "120000":
            raise ProjectStateError("EGIT_SYMLINK_UNSUPPORTED", "Indexed symbolic links are not supported for restore", 2)
        rows.append({"mode": mode, "objectId": oid.lower(), "stage": int(stage), "path": path})
    return rows


def parse_status(output: str) -> list[dict[str, str]]:
    """Parse porcelain-v1 NUL records, including the extra rename source path."""
    fields = output.split("\0")
    rows: list[dict[str, str]] = []
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if not record:
            continue
        if len(record) < 4 or record[2] != " ":
            raise ProjectStateError("EGIT_STATUS_INVALID", "Git status output was malformed", 2)
        code, path = record[:2], record[3:]
        if not path:
            raise ProjectStateError("EGIT_STATUS_INVALID", "Git status contained an empty path", 2)
        row = {"code": code, "path": path}
        if "R" in code or "C" in code:
            if index >= len(fields) or not fields[index]:
                raise ProjectStateError("EGIT_STATUS_INVALID", "Git rename record lacked its source path", 2)
            row["originalPath"] = fields[index]
            index += 1
        rows.append(row)
    return rows


def _index_file_identity(root: Path) -> tuple[Path, str]:
    path = root / ".git" / "index"
    try:
        info = path.lstat()
    except OSError as exc:
        raise ProjectStateError("EGIT_INDEX_UNAVAILABLE", "Git index could not be safely inspected", 2) from exc
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise ProjectStateError("EGIT_INDEX_UNSAFE", "Git index is not a private regular file", 2)
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise ProjectStateError("EGIT_INDEX_UNAVAILABLE", "Git index could not be safely read", 2) from exc
    return path, digest


def _filter_configured(root: Path, name: str) -> bool:
    if not _FILTER_NAME.fullmatch(name):
        raise ProjectStateError("EGIT_ATTRIBUTES_INVALID", "Git filter attribute name was malformed", 2)
    escaped = re.escape(name)
    result = _git(root, ["config", "--get-regexp", rf"^filter\.{escaped}\.(clean|smudge|process)$"])
    if result["ok"]:
        return True
    if result["code"] == 1 and result["started"] and result["complete"]:
        return False
    raise ProjectStateError("EGIT_FILTER_CONFIG_UNKNOWN", "Git filter configuration could not be safely inspected", 2)


def reject_content_filters(root: Path, commits: list[str], observed_paths: list[str]) -> None:
    """Reject any effective filter before status/checkout can invoke it."""
    paths = list(dict.fromkeys(observed_paths))
    if not paths:
        return
    for commit in [None, *commits]:
        for offset in range(0, len(paths), 96):
            batch = paths[offset : offset + 96]
            args = ["check-attr", "--all", "-z"]
            if commit is not None:
                args.extend(["--source", commit])
            args.extend(["--", *batch])
            fields = _nul_paths(_required(root, args, "effective attributes"), "attributes")
            if len(fields) % 3:
                raise ProjectStateError("EGIT_ATTRIBUTES_INVALID", "Git attribute response was malformed", 2)
            for path, attribute, value in zip(fields[0::3], fields[1::3], fields[2::3]):
                if path not in batch:
                    raise ProjectStateError("EGIT_ATTRIBUTES_INVALID", "Git attribute response contained an unexpected path", 2)
                if attribute != "filter":
                    continue
                if value in {"unset", "unspecified"}:
                    # `check-attr` cannot distinguish state operators from an
                    # explicit filter driver with one of these names.
                    if _filter_configured(root, value):
                        raise ProjectStateError("EGIT_FILTER_UNSUPPORTED", "An ambiguous external Git content filter is configured", 2)
                    continue
                raise ProjectStateError("EGIT_FILTER_UNSUPPORTED", "Git content filters are not supported for restore", 2)


def inspect_git(root_value: str | os.PathLike[str], *, read_only: bool = True,
                extra_paths: list[str] | tuple[str, ...] = ()) -> dict:
    """Return a conservative Git state observation; never writes Git state."""
    root = project_root(root_value)
    prefix = _git(root, ["rev-parse", "--show-prefix"])
    if not prefix["ok"]:
        message = prefix.get("stderr", "")
        if prefix["code"] == 128 and "not a git repository" in message.lower():
            return {"isGit": False, "reasonCode": "NOT_A_GIT_REPOSITORY"}
        raise ProjectStateError("EGIT_PROBE", "Git repository state could not be safely determined", 2)
    if prefix["stdout"].strip():
        raise ProjectStateError("EGIT_SUBDIRECTORY_UNSUPPORTED", "Git inspection must run at the repository root", 2)

    dot_git = root / ".git"
    try:
        git_info = dot_git.lstat()
    except OSError as exc:
        raise ProjectStateError("EGIT_METADATA_UNSUPPORTED", "Linked worktrees or missing Git metadata are unsupported", 2) from exc
    if not stat.S_ISDIR(git_info.st_mode) or stat.S_ISLNK(git_info.st_mode) or git_info.st_nlink != 1:
        raise ProjectStateError("EGIT_METADATA_UNSUPPORTED", "Linked or non-directory Git metadata is unsupported", 2)

    sparse = _git(root, ["config", "--bool", "core.sparseCheckout"])
    if sparse["ok"] and sparse["stdout"].strip().lower() == "true":
        raise ProjectStateError("EGIT_SPARSE_UNSUPPORTED", "Sparse checkout is not supported for restore", 2)
    if not sparse["ok"] and sparse["code"] != 1:
        raise ProjectStateError("EGIT_CONFIG_UNKNOWN", "Git sparse-checkout configuration could not be safely inspected", 2)

    head = _required(root, ["rev-parse", "--verify", "HEAD^{commit}"], "HEAD").strip().lower()
    if not _OBJECT_ID.fullmatch(head):
        raise ProjectStateError("EGIT_HEAD_INVALID", "Git HEAD is not a full commit object id", 2)
    attached = _git(root, ["symbolic-ref", "--quiet", "HEAD"])
    if not attached["ok"] and attached["code"] != 1:
        raise ProjectStateError("EGIT_HEAD_UNKNOWN", "Git HEAD attachment could not be safely determined", 2)
    branch_ref = attached["stdout"].strip() if attached["ok"] else None
    if branch_ref is not None and not branch_ref.startswith("refs/heads/"):
        raise ProjectStateError("EGIT_HEAD_INVALID", "Git HEAD points outside a local branch namespace", 2)

    index_output = _required(root, ["ls-files", "--stage", "-z"], "index entries")
    entries = parse_index_entries(index_output)
    flags = _nul_paths(_required(root, ["ls-files", "-v", "-z"], "index flags"), "index flags")
    for entry in flags:
        if len(entry) < 3 or entry[1] != " ":
            raise ProjectStateError("EGIT_INDEX_INVALID", "Git index flags were malformed", 2)
        tag = entry[0]
        if tag == "S" or tag.islower():
            raise ProjectStateError("EGIT_INDEX_FLAGS_UNSUPPORTED", "Skip-worktree or assume-unchanged index entries are unsupported", 2)

    # Check HEAD, all index stages (including staged additions), and all
    # non-index files including ignored files before running status.
    head_paths = _nul_paths(_required(root, ["ls-tree", "-r", "--name-only", "-z", head], "HEAD paths"), "HEAD paths")
    untracked = _nul_paths(_required(root, ["ls-files", "--others", "-z"], "untracked paths"), "untracked paths")
    checked_extra: list[str] = []
    for value in extra_paths:
        checked_extra.append(validate_relative(value))
    observed = list(dict.fromkeys([*head_paths, *(str(row["path"]) for row in entries), *untracked, *checked_extra]))
    reject_content_filters(root, [head], observed)

    index_path, index_before = _index_file_identity(root)
    status_args = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
                   "status", "--porcelain=v1", "-z", "--untracked-files=all"]
    status_output = _required(root, status_args, "status")
    dirty = parse_status(status_output)
    refs_text = _required(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/"], "refs")
    index_after_path, index_after = _index_file_identity(root)
    if index_path != index_after_path or index_before != index_after:
        raise ProjectStateError("EGIT_INDEX_CHANGED", "Git index changed during inspection; retry after concurrent Git activity", 2)

    final_head = _required(root, ["rev-parse", "--verify", "HEAD^{commit}"], "final HEAD recheck").strip().lower()
    final_attached = _git(root, ["symbolic-ref", "--quiet", "HEAD"])
    final_ref = final_attached["stdout"].strip() if final_attached["ok"] else None
    if not final_attached["ok"] and final_attached["code"] != 1:
        raise ProjectStateError("EGIT_HEAD_UNKNOWN", "Git HEAD attachment changed or could not be rechecked", 2)
    final_refs = _required(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/"], "final refs")
    if (final_head, final_ref, final_refs) != (head, branch_ref, refs_text):
        raise ProjectStateError("EGIT_STATE_CHANGED", "Git HEAD or refs changed during inspection; retry", 2)

    return {"isGit": True, "root": str(root), "head": head, "branchRef": branch_ref,
            "branch": branch_ref.removeprefix("refs/heads/") if branch_ref else None,
            "indexSha256": index_before, "indexEntries": entries, "refsText": refs_text,
            "dirty": dirty, "clean": not dirty, "readOnly": read_only,
            "filterPathsChecked": len(observed)}
