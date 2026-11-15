"""Config journal schema and state transitions owned by recovery."""
from __future__ import annotations
import re
from pathlib import Path
from typing import Any
from project_state.contracts.errors import ProjectStateError
from project_state.foundation import journal as storage

_OP_ID = re.compile(r"^[a-f0-9]{32}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_FILE_ID = re.compile(r"^\d+:\d+$")

def _valid_proof(value: Any) -> bool:
    if not isinstance(value, dict) or type(value.get("exists")) is not bool:
        return False
    if not value["exists"]:
        return (value.get("size") == 0 and value.get("sha256") is None and value.get("fileId") is None
                and set(value) <= {"exists", "size", "sha256", "fileId"})
    return (type(value.get("size")) is int and 0 <= value["size"] <= 1_048_576
            and isinstance(value.get("sha256"), str) and _HASH.fullmatch(value["sha256"]) is not None
            and isinstance(value.get("fileId"), str) and _FILE_ID.fullmatch(value["fileId"]) is not None
            and type(value.get("mode", 0o600)) is int
            and type(value.get("links", 1)) is int and value.get("links", 1) in {1, 2}
            and set(value) <= {"exists", "size", "sha256", "fileId", "mode", "links"})


def _valid_stage(value: Any) -> bool:
    return (isinstance(value, dict) and set(value) == {"relativePath", "fileId", "size", "sha256", "mode"}
            and isinstance(value["relativePath"], str) and "\\" not in value["relativePath"]
            and not value["relativePath"].startswith("/") and ".." not in value["relativePath"].split("/")
            and isinstance(value["fileId"], str) and _FILE_ID.fullmatch(value["fileId"]) is not None
            and type(value["size"]) is int and 0 <= value["size"] <= 1_048_576
            and isinstance(value["sha256"], str) and _HASH.fullmatch(value["sha256"]) is not None
            and type(value["mode"]) is int)


def _validate_record(value: Any) -> None:
    if isinstance(value, dict) and value.get("schemaVersion") == 2:
        from project_state.recovery.multi_config import validate_record_v2
        validate_record_v2(value)
        return
    required = {"schemaVersion", "operationId", "sequence", "previousRecordSha256", "rootIdentity",
                "status", "phase", "source", "safety", "target", "pre", "stage", "post"}
    optional = {"rollbackStage", "rollbackExpected", "rollbackPost", "ownerBinding", "resolverClaim", "cancelProof"}
    if not isinstance(value, dict) or not required <= value.keys() or not value.keys() <= required | optional:
        raise ProjectStateError("EJOURNAL_INVALID", "operation record fields do not match schema v1", 2)
    if "ownerBinding" in value:
        binding = value["ownerBinding"]
        fields = {"protocolVersion", "operation", "name", "startedAt", "lockFileId", "ownerTokenSha256"}
        if (not isinstance(binding, dict) or set(binding) != fields
                or type(binding.get("protocolVersion")) is not int or binding["protocolVersion"] != 1
                or binding.get("operation") != "restore"
                or not isinstance(binding.get("name"), str) or not binding["name"]
                or not isinstance(binding.get("startedAt"), str) or not binding["startedAt"]
                or not isinstance(binding.get("lockFileId"), str) or not _FILE_ID.fullmatch(binding["lockFileId"])
                or not isinstance(binding.get("ownerTokenSha256"), str) or not _HASH.fullmatch(binding["ownerTokenSha256"])):
            raise ProjectStateError("EJOURNAL_INVALID", "operation owner binding is invalid", 2)
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or not isinstance(value["operationId"], str) or not _OP_ID.fullmatch(value["operationId"])
            or type(value["sequence"]) is not int or value["sequence"] < 0
            or (value["previousRecordSha256"] is not None and (not isinstance(value["previousRecordSha256"], str) or not _HASH.fullmatch(value["previousRecordSha256"])))
            or not isinstance(value["rootIdentity"], str) or not _HASH.fullmatch(value["rootIdentity"])
            or not isinstance(value["status"], str) or not isinstance(value["phase"], str) or not isinstance(value["target"], str)
            or value["status"] not in {"in-progress", "completed", "rolling-back", "rolled-back", "cancelled"}
            or value["phase"] not in {"prepared", "displace-intent", "displaced", "publish-intent", "published", "verified", "rollback-displace-intent", "rollback-publish-intent", "rollback-published", "rolled-back", "cancelled"}
            or value["target"] not in {".env", ".env.local"}):
        raise ProjectStateError("EJOURNAL_INVALID", "operation record contains an invalid identity or state", 2)
    status_phases = {
        "in-progress": {"prepared", "displace-intent", "publish-intent", "published"},
        "completed": {"verified"},
        "rolling-back": {"rollback-displace-intent", "rollback-publish-intent", "rollback-published"},
        "rolled-back": {"rolled-back"},
        "cancelled": {"cancelled"},
    }
    if value["phase"] not in status_phases[value["status"]]:
        raise ProjectStateError("EJOURNAL_INVALID", "operation status and phase combination is invalid", 2)
    for key in ("source", "safety"):
        item = value[key]
        if (not isinstance(item, dict) or set(item) != {"name", "generation"}
                or not isinstance(item["name"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", item["name"])
                or not isinstance(item["generation"], str) or not re.fullmatch(r"[a-f0-9]{32}", item["generation"])):
            raise ProjectStateError("EJOURNAL_INVALID", f"operation {key} reference is invalid", 2)
    if not _valid_proof(value["pre"]) or (value["post"] is not None and not _valid_proof(value["post"])):
        raise ProjectStateError("EJOURNAL_INVALID", "operation file proof is invalid", 2)
    if not _valid_stage(value["stage"]):
        raise ProjectStateError("EJOURNAL_INVALID", "operation stage declaration is invalid", 2)
    for key in ("stage", "rollbackStage"):
        stage = value.get(key)
        if stage is not None:
            expected = f"staging/{value['operationId']}/private/"
            if not stage["relativePath"].startswith(expected) or stage["relativePath"][len(expected):] not in {"restore.stage", "rollback.stage"}:
                raise ProjectStateError("EJOURNAL_INVALID", f"operation {key} path is not bound to its operation ID", 2)
    if ("rollbackStage" in value and value["rollbackStage"] is not None
            and not _valid_stage(value["rollbackStage"])):
        raise ProjectStateError("EJOURNAL_INVALID", "rollback stage declaration is invalid", 2)
    if value.get("rollbackStage") is None and value.get("status") in {"rolling-back", "rolled-back"}:
        if value.get("pre", {}).get("exists") is not False:
            raise ProjectStateError("EJOURNAL_INVALID", "rollback without a stage is only valid for a previously missing target", 2)
    for key in ("rollbackExpected", "rollbackPost"):
        if key in value and not _valid_proof(value[key]):
            raise ProjectStateError("EJOURNAL_INVALID", f"operation {key} proof is invalid", 2)
    if value["status"] == "completed" and (value["phase"] != "verified" or value["post"] is None):
        raise ProjectStateError("EJOURNAL_INVALID", "completed operation lacks verified publication proof", 2)
    if value["status"] == "rolling-back" and (not value.get("rollbackExpected") or value["phase"] not in {
            "rollback-displace-intent", "rollback-publish-intent", "rollback-published"}):
        raise ProjectStateError("EJOURNAL_INVALID", "rollback operation lacks its publication proof or phase", 2)
    if value["status"] == "rolled-back" and (value["phase"] != "rolled-back" or "rollbackPost" not in value):
        raise ProjectStateError("EJOURNAL_INVALID", "rolled-back operation lacks its final proof", 2)
    if value["status"] == "cancelled":
        proof = value.get("cancelProof")
        if (value["phase"] != "cancelled" or not isinstance(proof, dict)
                or set(proof) != {"target", "stage", "quarantineAbsent"}
                or not _valid_proof(proof["target"]) or not _valid_stage(proof["stage"])
                or proof["target"] != value["pre"]
                or proof["stage"]["fileId"] != value["stage"]["fileId"]
                or proof["stage"]["sha256"] != value["stage"]["sha256"]
                or proof["quarantineAbsent"] is not True):
            raise ProjectStateError("EJOURNAL_INVALID", "cancelled operation lacks its not-applied proof", 2)


def _validate_transition(previous: dict[str, Any], current: dict[str, Any]) -> None:
    if previous.get("schemaVersion") == 2 or current.get("schemaVersion") == 2:
        from project_state.recovery.multi_config import validate_transition_v2
        validate_transition_v2(previous, current)
        return
    immutable = ("rootIdentity", "source", "safety", "target", "pre", "stage", "ownerBinding")
    if any(previous.get(key) != current.get(key) for key in immutable):
        raise ProjectStateError("EJOURNAL_INVALID", "operation journal changed immutable plan fields", 2)
    old_claim, new_claim = previous.get("resolverClaim"), current.get("resolverClaim")
    if old_claim is not None and new_claim != old_claim:
        if (not isinstance(new_claim, dict) or type(new_claim.get("sequence")) is not int
                or new_claim["sequence"] <= old_claim["sequence"]):
            raise ProjectStateError("EJOURNAL_INVALID", "operation journal resolver claim did not advance monotonically", 2)
    if new_claim is not None and (not isinstance(new_claim, dict)
            or set(new_claim) != {"claimId", "sequence", "recordSha256", "operationPlanSha256"}
            or not isinstance(new_claim.get("claimId"), str) or not _OP_ID.fullmatch(new_claim["claimId"])
            or type(new_claim.get("sequence")) is not int or new_claim["sequence"] < 0
            or any(not isinstance(new_claim.get(k), str) or not _HASH.fullmatch(new_claim[k])
                   for k in ("recordSha256", "operationPlanSha256"))):
        raise ProjectStateError("EJOURNAL_INVALID", "operation resolver claim pointer is invalid", 2)
    old, new = (previous["status"], previous["phase"]), (current["status"], current["phase"])
    same = old == new
    forward = {
        ("in-progress", "prepared"): {("in-progress", "displace-intent"), ("cancelled", "cancelled")},
        ("in-progress", "displace-intent"): {("in-progress", "publish-intent"), ("cancelled", "cancelled")},
        ("in-progress", "publish-intent"): {("in-progress", "published")},
        ("in-progress", "published"): {("completed", "verified")},
        ("completed", "verified"): {("rolling-back", "rollback-displace-intent")},
        ("rolling-back", "rollback-displace-intent"): {("rolling-back", "rollback-publish-intent")},
        ("rolling-back", "rollback-publish-intent"): {
            ("rolling-back", "rollback-published"), ("rolled-back", "rolled-back")},
        ("rolling-back", "rollback-published"): {("rolled-back", "rolled-back")},
    }
    if not (same or new in forward.get(old, set())):
        raise ProjectStateError("EJOURNAL_INVALID", "operation journal contains a non-monotonic state transition", 2)
    if old[0] == "rolling-back" and new[0] == "rolling-back":
        for key in ("rollbackExpected", "rollbackStage"):
            if previous.get(key) != current.get(key):
                raise ProjectStateError("EJOURNAL_INVALID", "rollback ownership proof changed after intent", 2)
    if previous.get("post") is not None and current.get("post") != previous.get("post"):
        raise ProjectStateError("EJOURNAL_INVALID", "published proof changed after it was recorded", 2)
    if previous.get("rollbackPost") is not None and current.get("rollbackPost") != previous.get("rollbackPost"):
        raise ProjectStateError("EJOURNAL_INVALID", "rollback proof changed after it was recorded", 2)
    if old[0] == "rolling-back" and current.get("rollbackPost") is not None and new[1] != "rolled-back":
        raise ProjectStateError("EJOURNAL_INVALID", "rollback final proof appeared before the terminal phase", 2)
    if old[0] == "rolled-back":
        raise ProjectStateError("EJOURNAL_INVALID", "operation journal contains records after rollback completion", 2)
    if old[0] == "cancelled":
        if new != old or any(previous.get(key) != current.get(key)
                             for key in previous.keys() | current.keys()
                             if key not in {"sequence", "previousRecordSha256", "resolverClaim"}):
            raise ProjectStateError("EJOURNAL_INVALID", "cancelled operation evidence is immutable", 2)



def validate_initial(value: dict[str, Any]) -> None:
    if (value.get("status") != "in-progress" or value.get("phase") != "prepared"
            or value.get("previousRecordSha256") is not None):
        raise ProjectStateError("EJOURNAL_INVALID", "first operation record is not the legal prepared state", 2)


def append_record(root: Path, operation_id: str, value: dict[str, Any]) -> dict[str, Any]:
    return storage.append_record(root, operation_id, value, validate_record=_validate_record, validate_transition=_validate_transition, validate_initial=validate_initial)


def load_records(root: Path, operation_id: str) -> list[dict[str, Any]]:
    return storage.load_records(root, operation_id, validate_record=_validate_record, validate_transition=_validate_transition, validate_initial=validate_initial)


def read_record(path: Path) -> dict[str, Any]:
    return storage.read_record(path, validate_record=_validate_record)


operation_dir = storage.operation_dir
