from __future__ import annotations

"""Application composition root for capture, recovery and compatibility use cases."""

import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from project_state import __version__
from project_state.contracts.capabilities import Capability, CapabilityState, CROSS_VOLUME_MESSAGE
from project_state.contracts.errors import ProjectStateError
from project_state.contracts.ports import OperationGatePort, SafetyPointPort
from project_state.contracts.results import (ArtifactReference, Diagnostic, SafetyPointReference,
    SnapshotReference, VerificationResult, RestorePlan)
from project_state.capture import snapshot as capture_snapshot
from project_state.capture.collectors import CONFIG_FILES, LOCK_FILES, RUNTIME_FILES
from project_state.capture.compare import compare
from project_state.capture.doctor import doctor as general_doctor
from project_state.capture.inventory import inspect_inventory, inspect_one
from project_state.foundation.paths import (assert_plain_path, is_reparse_point, project_root,
    validate_snapshot_name)
from project_state.foundation.state_paths import state_dir
from project_state.foundation.storage import validate_pair
from project_state.recovery.operation_gate import RecoveryOperationGate, assert_no_unresolved_operations
from project_state.recovery.planning import (plan_config_restore as plan_config_restore_impl,
    plan_git_restore as plan_git_restore_impl)
from project_state.recovery.config import (apply_config_restore as _apply_config_restore,
    continue_operation, inspect_operation, recover, rollback_operation)
from project_state.recovery.sqlite import (apply_database_restore, plan_database_restore,
    recover_database_operation)


def plan_config_restore(root: str | os.PathLike[str], name: str) -> RestorePlan:
    return plan_config_restore_impl(root, name)


def plan_git_restore(root: str | os.PathLike[str], name: str) -> dict[str, Any]:
    return plan_git_restore_impl(root, name)


def _run_demo(root: Path) -> dict[str, Any]:
    started = time.monotonic()
    target = root / ".env"
    initial = b"DEMO_MODE=alpha\r\nPORT=12716\r\n"
    changed = b"DEMO_MODE=beta\r\nPORT=12717\r\n"
    target.write_bytes(initial)
    saved = create_snapshot(root, "demo-before")
    if saved.get("state") != "verified":
        raise ProjectStateError("EDEMO_FAILED", "synthetic demo snapshot did not verify", 2)
    target.write_bytes(changed)
    compare_code, compare_output = compare(root, "demo-before")
    if compare_code != 0 or "changed" not in compare_output.lower():
        raise ProjectStateError("EDEMO_FAILED", "synthetic demo comparison did not observe the edit", 2)
    preview = plan_config_restore(root, "demo-before")
    if len(preview["targets"]) != 1 or preview["targets"][0]["action"] != "replace":
        raise ProjectStateError("EDEMO_FAILED", "synthetic demo restore preview did not match the fixture", 2)
    applied = apply_config_restore(root, "demo-before")
    if target.read_bytes() != initial:
        raise ProjectStateError("EDEMO_FAILED", "synthetic demo restore bytes did not verify", 2)
    rolled_back = rollback_operation(root, applied["operationId"])
    if not rolled_back.get("verified") or target.read_bytes() != changed:
        raise ProjectStateError("EDEMO_FAILED", "synthetic demo rollback bytes did not verify", 2)
    return {"resultSchemaVersion": 1, "command": "demo", "state": "passed",
            "fixture": "synthetic-config-only", "stages": ["snapshot", "compare", "preview", "restore", "rollback"],
            "applicationHealth": "not-tested", "gitState": "not-exercised",
            "businessValues": "synthetic-and-withheld", "durationMs": round((time.monotonic() - started) * 1000)}


def run_demo() -> dict[str, Any]:
    """Run the synthetic workflow in a disposable child and state home."""
    from project_state.foundation.paths import assert_plain_path
    parent_value = os.environ.get("PROJECT_STATE_DEMO_PARENT")
    parent = Path(parent_value).absolute() if parent_value else Path(tempfile.gettempdir())
    try:
        assert_plain_path(parent)
        if not parent.is_dir():
            raise ProjectStateError("EDEMO_PATH", "temporary demo parent is unavailable", 2)
        with tempfile.TemporaryDirectory(prefix="ps-demo-", dir=parent) as container:
            base = Path(container)
            project = base / "p"
            project.mkdir()
            env = dict(os.environ)
            env["LOCALAPPDATA" if os.name == "nt" else "XDG_STATE_HOME"] = os.fspath(base)
            code = ("import json; from pathlib import Path; "
                    "from project_state.application import _run_demo; "
                    "print(json.dumps(_run_demo(Path.cwd()), separators=(',', ':'))) ")
            result = subprocess.run([sys.executable, "-B", "-c", code], cwd=project, env=env,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45, shell=False)
            if result.returncode != 0:
                raise ProjectStateError("EDEMO_FAILED", "isolated demo workflow failed; caller state was not used", 2)
            value = __import__("json").loads(result.stdout)
            if not isinstance(value, dict) or value.get("command") != "demo" or value.get("state") != "passed":
                raise ProjectStateError("EDEMO_FAILED", "isolated demo worker result did not verify", 2)
            return value
    except ProjectStateError:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise ProjectStateError("EDEMO_FAILED", "isolated demo workspace could not be prepared", 2) from exc


class CaptureSafetyPointAdapter(SafetyPointPort):
    """Create one verified capture generation under the recovery-owned lock."""
    def __init__(self, operation_gate: OperationGatePort):
        self._operation_gate = operation_gate

    def create_safety_point(self, project_root: Path, name: str, lock_handle: object) -> SafetyPointReference:
        saved = capture_snapshot.create_snapshot(project_root, name, with_seed=False,
            lock_handle=lock_handle, operation_gate=self._operation_gate)
        pair = validate_pair(project_root, name, saved.get("generation"))
        snapshot = SnapshotReference(name=pair["name"], generation=pair["generation"],
            schema_version=pair["manifest"]["schemaVersion"], state=saved.get("state", "unknown"))
        verification: VerificationResult = {"verified": snapshot.state == "verified"
            and snapshot.name == name and snapshot.schema_version == 2
            and saved.get("generation") == snapshot.generation,
            "objectKind": "snapshot-generation", "identity": snapshot.generation}
        refs = tuple(ArtifactReference(artifact_id=item["id"], layer=item["layer"], kind=item["kind"],
            target=item.get("target"), privacy=item["privacy"], restore_class=item.get("restore", "record-only"),
            size=item["size"], sha256=item["sha256"])
            for item in pair["artifacts"] if item.get("kind") == "file" and item.get("privacy") == "private")
        return SafetyPointReference(name=snapshot.name, generation=snapshot.generation,
            verified=verification["verified"], protected_artifacts=refs)


_OPERATION_GATE = RecoveryOperationGate()
_SAFETY_POINTS = CaptureSafetyPointAdapter(_OPERATION_GATE)


def create_snapshot(root: str | os.PathLike[str], name: str, *, with_seed: bool = False,
                    _lock_handle: object | None = None) -> dict[str, Any]:
    return capture_snapshot.create_snapshot(root, name, with_seed=with_seed,
        lock_handle=_lock_handle, operation_gate=_OPERATION_GATE)


def apply_config_restore(root: str | os.PathLike[str], name: str) -> dict[str, Any]:
    return _apply_config_restore(root, name, safety_points=_SAFETY_POINTS)


def capabilities() -> tuple[Capability, ...]:
    """Static capability facts; these facts do not grant write authorization."""
    return (
        Capability("snapshot", CapabilityState.SUPPORTED,
            ("config: " + ", ".join(CONFIG_FILES),
             "dependencies: package.json, " + ", ".join(LOCK_FILES),
             "runtime pins: " + ", ".join(RUNTIME_FILES),
             "Git and Docker may be skipped", "SQLite seed requires explicit --with-seed",
             "config and database artifacts require private storage", "new snapshot names only"),
            Diagnostic("CONFIG_SNAPSHOT_SUPPORTED",
                "A new-name snapshot can collect supported config files; Git and Docker layers may be skipped, overwrite is refused, and explicit SQLite seed is a separate option.",
                severity="info", object_kind="snapshot", next_step="Review the project and create a new named snapshot.")),
        Capability("config-restore", CapabilityState.SUPPORTED,
            ("Windows verified publication", "one .env/.env.local target", "private verified artifact", "same-volume private state"),
            Diagnostic("CONFIG_RESTORE_SUPPORTED", "Apply supports one .env/.env.local target with a private safety generation and verified rollback. Existing database overwrite, dependency/runtime restore, Git mutation, and non-Windows SQLite creation remain unavailable.",
                severity="info", object_kind="configuration", next_step="Review the preview and explicitly confirm the restore.")),
        Capability("sqlite-restore", CapabilityState.SUPPORTED,
            ("Windows no-replace publication", "root-level .db/.sqlite/.sqlite3", "missing destination only",
             "private verified SQLite backup", "same-volume private state", "existing sidecars refused",
             "Python SQLite engine 3.51.3 or newer"),
            Diagnostic("DATABASE_RESTORE_CONDITIONAL", "SQLite restore requires engine 3.51.3 or newer, a verified private backup, and an absent supported target on the same volume.",
                severity="info", object_kind="database", next_step="Review the database preview and its limitations before confirming.")),
        Capability("git-write-restore", CapabilityState.BLOCKED, ("read-only Git inspection and preview only",),
            Diagnostic("GIT_WRITE_UNSUPPORTED", "Git write restore is unavailable; refs, index and worktree are not changed.",
                object_kind="git", next_step="Review the read-only preview and use a separately reviewed Git workflow.")),
        Capability("cross-volume-restore", CapabilityState.BLOCKED, ("no atomic same-volume publication guarantee",),
            Diagnostic("ECROSS_VOLUME_UNSUPPORTED", CROSS_VOLUME_MESSAGE, object_kind="private-state-location",
                next_step="Preserve the existing state and consult the location guidance.")),
    )


def describe_error(error: ProjectStateError) -> Diagnostic:
    """Attach a safe object category and next action without authorizing writes."""
    code = error.code
    if code.startswith("EARG"):
        kind, next_step = "command arguments", "Review the command help and retry with supported arguments."
    elif code == "ECROSS_VOLUME_UNSUPPORTED":
        kind, next_step = "private state location", "Preserve the existing state and consult the location guidance."
    elif code.startswith("ELOCATION"):
        kind = "private state location"
        next_step = ("Preserve the pending intent and retry state-location init with the same exact path after confirming no initializer is active."
                     if code == "ELOCATION_PENDING" else
                     "Preserve all roots, registration and initialization evidence; do not delete or switch paths to bypass the diagnostic.")
    elif code.startswith(("ELOCK", "EOWNER", "EJOURNAL", "ERESOLVER", "ERECOVERY", "EOPERATION", "ESAFETY")):
        kind, next_step = "operation state", "Preserve journals, locks and safety points; inspect the operation before retrying."
    elif code.startswith(("EARTIFACT", "EMANIFEST", "ESCHEMA", "ELEGACY", "ESNAPSHOT", "EINVENTORY")) or code == "EEXISTS":
        kind, next_step = "snapshot data", "Preserve the existing snapshot and review its status before retrying."
    elif code.startswith("EGIT"):
        kind, next_step = "Git state", "Review the Git state and the supported read-only preview before retrying."
    elif code.startswith("EDATABASE"):
        kind, next_step = "database", "Preserve the database and sidecars; review the database restore preconditions."
    elif code.startswith(("EUNSAFE", "EWINDOWS_PATH", "EVOLUME", "ETARGET")):
        kind, next_step = "filesystem object", "Preserve the affected object and review the supported path and location requirements."
    else:
        kind, next_step = "requested operation", "Preserve the current state and review the supported command and limitations."
    return Diagnostic(code, str(error), object_kind=kind, next_step=next_step)


def doctor(root: str | os.PathLike[str]) -> dict[str, Any]:
    return general_doctor(root)


def task_doctor(root_value: str | os.PathLike[str], task: str, snapshot: str | None = None) -> dict:
    """Conservative read-only task diagnosis; it never authorizes writes."""
    root = project_root(root_value)
    if task not in {"config-snapshot", "config-restore"}:
        raise ProjectStateError("EARG_TASK", "unsupported doctor task", 1)
    capability_by_name = {item.name: item for item in capabilities()}
    checks = [{"id": "project.context", "state": "ok", "required": True,
               "reasonCode": "CURRENT_DIRECTORY_VERIFIED",
               "message": "The exact current directory is a real directory; no parent discovery was used."}]
    if task == "config-snapshot":
        found = []
        unsafe = False
        for name in (".env", ".env.local"):
            path = root / name
            try:
                st = path.lstat()
            except FileNotFoundError:
                continue
            except OSError:
                unsafe = True
                continue
            if is_reparse_point(st) or not stat.S_ISREG(st.st_mode) or st.st_nlink > 1:
                unsafe = True
            else:
                found.append(name)
        checks.append({"id": "config.applicability", "state": "issue" if unsafe else "ok" if found else "not-applicable",
                       "required": True, "reasonCode": "CONFIG_FILE_UNSAFE" if unsafe else "SUPPORTED_CONFIG_PRESENT" if found else "NO_APPLICABLE_CONFIG",
                       "message": "A supported configuration path is unsafe or unreadable." if unsafe else "A supported configuration file is present; contents were not read." if found else "No supported configuration file is present."})
        checks.append({"id": "python.snapshot-implementation", "state": "issue" if unsafe or not found else "ok", "required": True,
                       "reasonCode": "CONFIG_SNAPSHOT_UNAVAILABLE" if unsafe or not found else "CONFIG_SNAPSHOT_SUPPORTED",
                       "message": "A supported config file is unsafe, or no supported config file exists." if unsafe or not found else
                       capability_by_name["snapshot"].diagnostic.message})
        checks.append({"id": "privacy.boundary", "state": "unknown", "required": True,
                       "reasonCode": "PRIVATE_STORAGE_NOT_VERIFIED",
                       "message": "This read-only check does not verify the caller's filesystem access controls or Git exclusion for the private state directory."})
    else:
        if not isinstance(snapshot, str):
            raise ProjectStateError("EARG_SNAPSHOT", "config-restore requires --snapshot <name>", 1)
        try:
            validate_snapshot_name(snapshot)
            plan = plan_config_restore(root, snapshot)
            if 1 <= len(plan["targets"]) <= 2:
                state, reason = "ok", "CONFIG_RESTORE_PREVIEW_READY"
                message = "The snapshot and supported config target set passed the current read-only restore preflight. Review every target; apply still requires explicit confirmation and creates one safety point. A two-file apply is recoverable per file, not atomically visible as a pair."
            else:
                state, reason = "issue", "CONFIG_RESTORE_TARGET_COUNT_UNSUPPORTED"
                message = "The snapshot is valid, but this candidate applies only an allowlisted .env/.env.local target set."
        except ProjectStateError as exc:
            pair = None
            state = "issue" if exc.code in {"EMANIFEST_INVALID", "ESCHEMA_UNSUPPORTED", "ELEGACY_RESTORE", "EARTIFACT_INTEGRITY", "EUNSAFE_PATH", "EGIT_DIRTY", "ERESTORE_INPUT", "ERESTORE_SELECTION", "ECROSS_VOLUME_UNSUPPORTED"} else "unknown"
            reason = exc.code
            message = ("The read-only restore preflight did not complete; preserve the snapshot and do not apply it." if state == "unknown" else
                       capability_by_name["cross-volume-restore"].diagnostic.message if exc.code == "ECROSS_VOLUME_UNSUPPORTED" else
                       "The current snapshot or project state does not meet the supported single-config restore preconditions.")
        checks.append({"id": "snapshot.integrity", "state": state, "required": True, "reasonCode": reason, "message": message})
        implementation_state = "ok" if state == "ok" else ("issue" if state == "issue" else "unknown")
        checks.append({"id": "python.restore-implementation", "state": implementation_state, "required": True,
                       "reasonCode": "CONFIG_RESTORE_SUPPORTED" if implementation_state == "ok" else "PYTHON_RESTORE_LIMITED" if implementation_state == "issue" else "RESTORE_PREFLIGHT_UNKNOWN",
                       "message": capability_by_name["config-restore"].diagnostic.message})
        checks.append({"id": "privacy.boundary", "state": "unknown", "required": False,
                       "reasonCode": "PRIVATE_STORAGE_ACCESS_CONTROLS_NOT_CHECKED",
                       "message": "Filesystem access controls for private plaintext are not checked by this read-only diagnostic; this result is not write authorization."})
    required = [item for item in checks if item["required"]]
    issues = sum(item["state"] == "issue" for item in required)
    unknowns = sum(item["state"] == "unknown" for item in required)
    summary = {"state": "blocked" if issues else "unknown" if unknowns else "ready",
               "requiredIssueCount": issues, "requiredUnknownCount": unknowns}
    return {"resultSchemaVersion": 1, "toolVersion": __version__, "command": "doctor", "task": task,
            "projectContext": {"scope": "current-working-directory", "pathDisclosure": "omitted", "gitRepository": "unknown"},
            "checks": checks, "summary": summary,
            "nextStep": {"action": "review-required-checks", "command": None, "args": [],
                         "cwd": "current-working-directory", "confirmation": "none", "effects": "none", "revalidates": True},
            "limitations": ["Readiness is a point-in-time observation, not write authorization.",
                            "This probe does not authorize writes; snapshot/restore still require the documented command and explicit confirmation. Restore supports one config file or the allowlisted .env/.env.local pair, with per-file recovery rather than atomic pair visibility.",
                            "Application health is not tested."]}




