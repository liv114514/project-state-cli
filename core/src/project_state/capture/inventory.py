from __future__ import annotations

import os
import re
import stat
from pathlib import Path
from typing import Any

from project_state.foundation.state_paths import state_dir
from project_state import __version__
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root, validate_snapshot_name
from project_state.foundation.storage import validate_pair


_ERROR_STATES = {
    "ESCHEMA_UNSUPPORTED": ("unknown", "SNAPSHOT_SCHEMA_UNSUPPORTED"),
    "EARTIFACT_INTEGRITY": ("invalid", "SNAPSHOT_INTEGRITY_FAILED"),
    "EMANIFEST_INVALID": ("invalid", "SNAPSHOT_METADATA_INVALID"),
    "ELEGACY_RESTORE": ("diagnostic-only", "LEGACY_V1_DIAGNOSTIC_ONLY"),
    "EUNSAFE_PATH": ("unknown", "SNAPSHOT_PATH_UNSAFE"),
    "EINVENTORY_UNREADABLE": ("unknown", "SNAPSHOT_ACCESS_DENIED"),
    "EARTIFACT_UNDECLARED": ("invalid", "SNAPSHOT_INTEGRITY_FAILED"),
    "EARTIFACT_UNREADABLE": ("unknown", "SNAPSHOT_READ_FAILED"),
}


def _snapshot_record(root: Path, name: str) -> dict[str, Any]:
    try:
        validate_snapshot_name(name)
    except ProjectStateError:
        return {"name": "invalid", "state": "invalid", "reasonCode": "SNAPSHOT_NAME_INVALID"}

    snapshot_dir = state_dir(root) / "snapshots" / name
    try:
        snapshot_stat = snapshot_dir.lstat()
    except FileNotFoundError:
        return {"name": name, "state": "missing", "reasonCode": "SNAPSHOT_NOT_FOUND",
                "checks": [{"id": "snapshot.presence", "state": "issue", "required": True,
                            "reasonCode": "SNAPSHOT_NOT_FOUND"}]}
    except OSError:
        return {"name": name, "state": "unknown", "reasonCode": "SNAPSHOT_ACCESS_DENIED"}
    if is_reparse_point(snapshot_stat) or not stat.S_ISDIR(snapshot_stat.st_mode):
        return {"name": name, "state": "unknown", "reasonCode": "SNAPSHOT_PATH_TYPE_INVALID"}
    try:
        assert_plain_path(snapshot_dir)
    except ProjectStateError:
        return {"name": name, "state": "unknown", "reasonCode": "SNAPSHOT_PATH_UNSAFE"}
    pointer = snapshot_dir / "current.json"
    try:
        pointer.lstat()
    except FileNotFoundError:
        try:
            legacy = inspect_snapshot_legacy(root, name)
            if legacy is not None:
                return legacy
        except ProjectStateError:
            pass
        return {"name": name, "state": "invalid", "reasonCode": "SNAPSHOT_POINTER_MISSING",
                "checks": [{"id": "snapshot.inspection", "state": "issue", "required": True,
                            "reasonCode": "SNAPSHOT_POINTER_MISSING"}]}
    except OSError:
        return {"name": name, "state": "unknown", "reasonCode": "SNAPSHOT_ACCESS_DENIED"}

    # `validate_pair` verifies the pointer, manifests, every artifact digest,
    # and the exact generation file set in one pass. Do not first inspect and
    # then repeat the same bounded reads and hashes.
    try:
        pair = validate_pair(root, name)
    except ProjectStateError as exc:
        state, reason = _ERROR_STATES.get(exc.code, ("unknown", "SNAPSHOT_INSPECTION_UNAVAILABLE"))
        return {"name": name, "state": state, "reasonCode": reason,
                "checks": [{"id": "snapshot.inspection", "state": "issue" if state in {"invalid", "incomplete"} else "unknown",
                            "required": True, "reasonCode": reason}]}
    else:
        artifacts = pair["artifacts"]
        layers = []
        for key, value in pair["manifest"]["layers"].items():
            subset = [a for a in artifacts if a["layer"] == key]
            layers.append({"id": key, "status": value["status"], "artifactCount": len(subset),
                           "supportedArtifactCount": sum(a["restore"] in {"restore-file", "sqlite-create-missing"} for a in subset),
                           "recordOnlyArtifactCount": sum(a["restore"] == "record-only" for a in subset),
                           "privateArtifactCount": sum(a["privacy"] == "private" for a in subset)})
        public_artifacts = []
        for index, a in enumerate(artifacts):
            restore_class = "supported" if a["restore"] in {"restore-file", "sqlite-create-missing"} else "record-only"
            artifact_id = f"layer:{a['layer']}" if a["kind"] == "layer-json" and a["layer"] in {"git", "deps", "runtime", "config", "docker", "database"} else f"artifact-{index + 1}"
            public_artifacts.append({"id": artifact_id, "layer": a["layer"], "kind": a["kind"],
                "required": a["required"], "privacy": a["privacy"], "restoreClass": restore_class,
                "target": a.get("target"), "integrity": "not-applicable" if a["kind"] == "absent" else "verified"})
        required = sum(a["required"] for a in artifacts)
        layer_rows = [{"id": key, **value} for key, value in pair["manifest"]["layers"].items()]
        schema_version = pair["manifest"]["schemaVersion"]
        return {"name": name, "generation": pair["generation"], "createdAt": pair["manifest"]["createdAt"],
                "kind": pair["manifest"]["kind"], "schemaVersion": schema_version, "state": "verified",
                "checks": [{"id": "snapshot.metadata", "state": "ok", "required": True, "reasonCode": "SNAPSHOT_METADATA_VALIDATED"},
                           {"id": "snapshot.artifacts", "state": "ok", "required": True, "reasonCode": "REQUIRED_ARTIFACTS_VERIFIED"}],
                "integrity": {"state": "verified", "requiredArtifacts": required, "requiredVerified": required,
                              "missingArtifacts": 0, "totalArtifacts": len(artifacts)},
                "inputCompleteness": "partial" if any(x["status"] == "skipped" for x in layer_rows) else "complete",
                "layers": [{k: calculated[k] for k in ("id", "status", "artifactCount", "supportedArtifactCount", "recordOnlyArtifactCount", "privateArtifactCount")} for calculated in layers],
                "artifacts": public_artifacts,
                "environment": {"restorePrerequisites": "not-checked", "applicationHealth": "not-tested"},
                "nextStep": {"action": "preserve-and-review", "command": None, "args": [],
                             "cwd": "current-working-directory", "confirmation": "none",
                             "effects": "none", "revalidates": True},
                "limitations": ["Stored input integrity does not establish restore prerequisites.",
                                "Supported config restore is limited to one file or the allowlisted .env/.env.local pair; SQLite creation is Windows-only at a missing target. Other layers are record-only or unavailable.",
                                "Application health and runtime behavior were not tested.",
                                "Database row contents are not included in this inspection result."]}


def inspect_snapshot_legacy(root: Path, name: str) -> dict[str, Any] | None:
    """Return only a v1 diagnostic record; v1 contents are never restore input."""
    path = state_dir(root) / "snapshots" / name / "manifest.json"
    from project_state.foundation.integrity import read_json
    manifest, _ = read_json(path)
    if manifest.get("schemaVersion") != 1 or manifest.get("name") != name:
        return None
    return {"name": name, "generation": None, "createdAt": manifest.get("createdAt"),
            "kind": manifest.get("kind", "unknown"), "schemaVersion": 1, "state": "diagnostic-only",
            "checks": [{"id": "snapshot.metadata", "state": "not-applicable", "required": True,
                        "reasonCode": "LEGACY_V1_DIAGNOSTIC_ONLY"}],
            "integrity": {"state": "not-checked", "requiredArtifacts": None, "requiredVerified": None,
                          "missingArtifacts": None, "totalArtifacts": None},
            "inputCompleteness": "unknown", "layers": [], "artifacts": [],
            "environment": {"restorePrerequisites": "not-checked", "applicationHealth": "not-tested"},
            "nextStep": {"action": "preserve-and-review", "command": None, "args": [],
                         "cwd": "current-working-directory", "confirmation": "none", "effects": "none", "revalidates": True},
            "limitations": ["Schema v1 is diagnostic-only and its artifacts were not validated.",
                            "Restore is not implemented in this Python migration candidate.",
                            "Application health and runtime behavior were not tested."]}


def inspect_inventory(root_value: str | os.PathLike[str]) -> dict[str, Any]:
    root = project_root(root_value)
    base = state_dir(root) / "snapshots"
    try:
        assert_plain_path(base, allow_missing=True)
        names = os.listdir(base)
    except FileNotFoundError:
        names = []
        state = "missing"
    except ProjectStateError as exc:
        return {"resultSchemaVersion": 2, "toolVersion": __version__, "command": "list",
                "inventory": {"state": "unreadable", "snapshotCount": 0, "diagnosticCount": 1,
                              "unrecognizedEntryCount": 0, "reasonCode": exc.code},
                "snapshots": [], "diagnostics": [{"reasonCode": exc.code}],
                "legacy": {"privateDatabasePathCount": 0, "diagnosticCount": 0}}
    except OSError:
        return {"resultSchemaVersion": 2, "toolVersion": __version__, "command": "list",
                "inventory": {"state": "unreadable", "snapshotCount": 0, "diagnosticCount": 1,
                              "unrecognizedEntryCount": 0, "reasonCode": "SNAPSHOT_INVENTORY_UNREADABLE"},
                "snapshots": [], "diagnostics": [{"reasonCode": "SNAPSHOT_INVENTORY_UNREADABLE"}],
                "legacy": {"privateDatabasePathCount": 0, "diagnosticCount": 0}}
    else:
        state = "available" if names else "empty"
    recognized = [n for n in names if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", n)]
    unrecognized = len(names) - len(recognized)
    snapshots = [_snapshot_record(root, name) for name in recognized]
    snapshots.sort(key=lambda row: (row.get("createdAt") or "", row["name"], row.get("generation") or ""), reverse=True)
    diagnostics = [{"name": row["name"], "state": row["state"], "reasonCode": row.get("reasonCode", "SNAPSHOT_INSPECTION_UNAVAILABLE")}
                   for row in snapshots if row["state"] not in {"verified", "diagnostic-only"}]
    if unrecognized:
        diagnostics.append({"reasonCode": "UNRECOGNIZED_INVENTORY_ENTRIES", "count": unrecognized})
    if state != "missing" and diagnostics:
        state = "incomplete"
    return {"resultSchemaVersion": 2, "toolVersion": __version__, "command": "list",
            "inventory": {"state": state, "snapshotCount": len(snapshots), "diagnosticCount": len(diagnostics),
                          "unrecognizedEntryCount": unrecognized},
            "snapshots": snapshots, "diagnostics": diagnostics,
            "legacy": {"privateDatabasePathCount": 0, "diagnosticCount": 0}}


def inspect_one(root_value: str | os.PathLike[str], name: str) -> dict[str, Any]:
    try:
        validate_snapshot_name(name)
    except ProjectStateError:
        return {"name": "invalid", "state": "invalid", "reasonCode": "SNAPSHOT_NAME_INVALID"}
    return _snapshot_record(project_root(root_value), name)
