"""SQLite operation journal validation and transition rules."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path
from project_state.foundation.state_paths import state_dir
from project_state.foundation.sqlite import SQLITE_NAME_PATTERN as _DB_NAME

_OP = re.compile(r"^[a-f0-9]{32}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")

def _root_id(root: Path) -> str:
    return hashlib.sha256(os.path.normcase(str(root)).encode("utf-8", errors="strict")).hexdigest()


def _operation_dir(root: Path, operation_id: str) -> Path:
    if not _OP.fullmatch(operation_id):
        raise ProjectStateError("EOPERATION_ID", "operation ID is invalid", 1)
    return state_dir(root) / "operations" / operation_id


def _record_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _load_records(root: Path, operation_id: str) -> list[dict[str, Any]]:
    base = _operation_dir(root, operation_id)
    assert_plain_path(base)
    found: list[tuple[int, Path]] = []
    for item in base.iterdir():
        assert_plain_path(item, hardlinks=True)
        match = re.fullmatch(r"db-record-(\d{6})\.json", item.name)
        if match:
            found.append((int(match.group(1)), item))
        elif re.fullmatch(r"db-record-\d{6}\.tmp-[a-f0-9]{16}", item.name):
            category = ("unpublished first database record is present without a committed chain"
                        if not found else
                        "an uncommitted database record exists beside the committed journal chain")
            raise ProjectStateError("EJOURNAL_UNCERTAIN", f"{category}; temporary evidence is not trusted or promoted", 2)
        elif item.name.startswith("db-record-") and ".tmp-" in item.name:
            raise ProjectStateError("EJOURNAL_UNSAFE", "database journal contains an unrecognized temporary record name; preserve the operation", 2)
        elif item.name.startswith("record-"):
            raise ProjectStateError("EJOURNAL_CONFLICT", "operation directory contains another journal type", 2)
        else:
            raise ProjectStateError("EJOURNAL_UNSAFE", "database operation journal contains an unknown entry", 2)
    found.sort()
    if not found or [n for n, _ in found] != list(range(len(found))):
        raise ProjectStateError("EJOURNAL_INVALID", "database operation journal sequence is missing or incomplete", 2)
    records = []
    previous = None
    for sequence, path in found:
        try:
            data = path.read_bytes()
            value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_pairs)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProjectStateError("EJOURNAL_INVALID", "database operation journal record is unreadable", 2) from exc
        if (not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("operationId") != operation_id
                or value.get("sequence") != sequence or value.get("previousRecordSha256") != previous
                or value.get("kind") != "sqlite-create-missing" or value.get("rootIdentity") != _root_id(root)):
            raise ProjectStateError("EJOURNAL_INVALID", "database operation journal identity or hash chain is invalid", 2)
        _validate_record(value, operation_id)
        if sequence == 0 and (value.get("status") != "in-progress" or value.get("phase") != "prepared"
                              or value.get("previousRecordSha256") is not None):
            raise ProjectStateError("EJOURNAL_INVALID", "first database operation record is not the legal prepared state", 2)
        if sequence:
            prior = records[-1]
            if value.get("phase") not in _NEXT.get(prior["phase"], set()):
                raise ProjectStateError("EJOURNAL_INVALID", "database operation journal transition is not monotonic", 2)
            if prior.get("status") in {"rolled-back", "cancelled"}:
                if (value.get("status") != prior.get("status") or value.get("phase") != prior.get("phase")
                        or any(prior.get(key) != value.get(key)
                               for key in prior.keys() | value.keys()
                               if key not in {"sequence", "previousRecordSha256", "resolverClaim"})):
                    raise ProjectStateError("EJOURNAL_INVALID", "terminal database operation evidence is immutable", 2)
            for immutable_proof in ("post", "rollbackExpected", "quarantine", "cancelProof"):
                if prior.get(immutable_proof) is not None and value.get(immutable_proof) != prior.get(immutable_proof):
                    raise ProjectStateError("EJOURNAL_INVALID", f"database {immutable_proof} changed after publication", 2)
        if sequence and any(value.get(k) != records[0].get(k) for k in ("rootIdentity", "source", "target", "stage", "pin", "ownerBinding")):
            raise ProjectStateError("EJOURNAL_INVALID", "database operation changed its immutable plan", 2)
        if sequence and records[-1].get("resolverClaim") is not None and value.get("resolverClaim") != records[-1].get("resolverClaim"):
            old_claim, new_claim = records[-1]["resolverClaim"], value.get("resolverClaim")
            if not isinstance(new_claim, dict) or type(new_claim.get("sequence")) is not int or new_claim["sequence"] <= old_claim["sequence"]:
                raise ProjectStateError("EJOURNAL_INVALID", "database resolver claim did not advance monotonically", 2)
        previous = hashlib.sha256(data).hexdigest()
        records.append(value)
    return records


_NEXT = {
    "prepared": {"prepared", "publish-intent", "cancelled"},
    "publish-intent": {"publish-intent", "published", "completed", "rollback-intent", "cancelled"},
    "published": {"published", "completed", "rollback-intent"},
    "completed": {"completed", "rollback-intent"},
    "rollback-intent": {"rollback-intent", "rolled-back"},
    "rolled-back": set(),
    "cancelled": {"cancelled"},
}


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate database journal field")
        result[key] = value
    return result


def _validate_record(value: dict[str, Any], operation_id: str) -> None:
    required = {"schemaVersion", "operationId", "sequence", "previousRecordSha256", "kind", "rootIdentity",
                "source", "target", "stage", "pin", "phase", "status"}
    optional = {"post", "rollbackExpected", "quarantine", "ownerBinding", "resolverClaim", "cancelProof"}
    if not required <= value.keys() or value.keys() - (required | optional):
        raise ProjectStateError("EJOURNAL_INVALID", "database journal fields do not match schema v1", 2)
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or value["operationId"] != operation_id or type(value["sequence"]) is not int or value["sequence"] < 0
            or (value["previousRecordSha256"] is not None and not _HASH.fullmatch(str(value["previousRecordSha256"])))
            or not _HASH.fullmatch(str(value["rootIdentity"]))
            or value["phase"] not in _NEXT or value["status"] not in {"in-progress", "completed", "rolling-back", "rolled-back", "cancelled"}):
        raise ProjectStateError("EJOURNAL_INVALID", "database journal identity or state is invalid", 2)
    status_phases = {
        "in-progress": {"prepared", "publish-intent", "published"},
        "completed": {"completed"},
        "rolling-back": {"rollback-intent"},
        "rolled-back": {"rolled-back"},
        "cancelled": {"cancelled"},
    }
    if value["phase"] not in status_phases[value["status"]]:
        raise ProjectStateError("EJOURNAL_INVALID", "database operation status and phase combination is invalid", 2)
    source = value["source"]
    if (not isinstance(source, dict) or set(source) != {"name", "generation", "artifactId", "sha256", "size"}
            or not isinstance(source["name"], str) or not isinstance(source["generation"], str)
            or not re.fullmatch(r"[a-f0-9]{32}", source["generation"])
            or not isinstance(source["artifactId"], str) or not _HASH.fullmatch(str(source["sha256"]))
            or type(source["size"]) is not int or source["size"] < 0):
        raise ProjectStateError("EJOURNAL_INVALID", "database source reference is invalid", 2)
    target = value["target"]
    if (not isinstance(target, str) or "/" in target or "\\" in target
            or not _DB_NAME.fullmatch(target)
            or source["artifactId"] != f"database-backup:{target}"):
        raise ProjectStateError("EJOURNAL_INVALID", "database journal target or source binding is invalid", 2)
    stage = value["stage"]
    if (not isinstance(stage, dict) or set(stage) != {"relativePath", "fileId", "size", "sha256"}
            or stage["relativePath"] != f"staging/{operation_id}/private/database.stage"
            or not isinstance(stage["fileId"], str) or not re.fullmatch(r"\d+:\d+", stage["fileId"])
            or type(stage["size"]) is not int or stage["size"] < 0 or not _HASH.fullmatch(str(stage["sha256"]))):
        raise ProjectStateError("EJOURNAL_INVALID", "database stage reference is invalid", 2)
    pin = value["pin"]
    if (not isinstance(pin, dict) or set(pin) != {"relativePath", "fileId", "sha256", "token", "source"}
            or pin["relativePath"] != f"pins/{operation_id}.json"
            or not isinstance(pin["fileId"], str) or not re.fullmatch(r"\d+:\d+", pin["fileId"])
            or not _HASH.fullmatch(str(pin["sha256"])) or not isinstance(pin["token"], str)
            or not re.fullmatch(r"[a-f0-9]{32}", pin["token"])
            or pin["source"] != source):
        raise ProjectStateError("EJOURNAL_INVALID", "database pin reference is invalid", 2)
    quarantine = value.get("quarantine")
    if quarantine is not None and (not isinstance(quarantine, dict) or set(quarantine) != {"relativePath"}
            or quarantine["relativePath"] != f"staging/{operation_id}/private/database.rollback"):
        raise ProjectStateError("EJOURNAL_INVALID", "database rollback quarantine path is invalid", 2)
    for key in ("post", "rollbackExpected"):
        proof = value.get(key)
        if proof is not None and (not isinstance(proof, dict) or set(proof) != {"exists", "size", "sha256", "fileId", "links"}
                or proof["exists"] is not True or type(proof["size"]) is not int or proof["size"] < 0
                or not _HASH.fullmatch(str(proof["sha256"])) or not isinstance(proof["fileId"], str)
                or not re.fullmatch(r"\d+:\d+", proof["fileId"]) or type(proof["links"]) is not int or proof["links"] not in {1, 2}):
            raise ProjectStateError("EJOURNAL_INVALID", f"database {key} proof is invalid", 2)
    if value["status"] == "completed" and (value["phase"] != "completed" or value.get("post") is None):
        raise ProjectStateError("EJOURNAL_INVALID", "completed database operation lacks its final proof", 2)
    if value["status"] == "cancelled":
        proof = value.get("cancelProof")
        valid_proof = (isinstance(proof, dict) and (
            (set(proof) == {"targetAbsent", "stageFileId", "stageSha256", "pinSha256"}
             and proof["targetAbsent"] is True)
            or (set(proof) == {"preparedBeforePublication", "stageFileId", "stageSha256", "pinSha256"}
                and proof["preparedBeforePublication"] is True)))
        if (value["phase"] != "cancelled" or not valid_proof
                or proof["stageFileId"] != stage["fileId"] or proof["stageSha256"] != stage["sha256"]
                or proof["pinSha256"] != pin["sha256"]):
            raise ProjectStateError("EJOURNAL_INVALID", "cancelled database operation lacks its not-published proof", 2)
    if value["status"] == "rolling-back" and (value["phase"] != "rollback-intent" or value.get("rollbackExpected") is None or value.get("quarantine") is None):
        raise ProjectStateError("EJOURNAL_INVALID", "database rollback intent is incomplete", 2)
    if value["status"] == "rolled-back" and (value["phase"] != "rolled-back"
            or value.get("rollbackExpected") is None or value.get("quarantine") is None):
        raise ProjectStateError("EJOURNAL_INVALID", "database rollback terminal state is invalid", 2)
    binding = value.get("ownerBinding")
    if binding is not None:
        binding_fields = {"protocolVersion", "operation", "name", "startedAt", "lockFileId", "ownerTokenSha256"}
        if (not isinstance(binding, dict) or set(binding) != binding_fields
                or type(binding.get("protocolVersion")) is not int or binding["protocolVersion"] != 1
                or binding.get("operation") != "restore"
                or not isinstance(binding.get("name"), str) or not binding["name"]
                or not isinstance(binding.get("startedAt"), str) or not binding["startedAt"]
                or not re.fullmatch(r"\d+:\d+", str(binding.get("lockFileId")))
                or not isinstance(binding.get("ownerTokenSha256"), str) or not _HASH.fullmatch(binding["ownerTokenSha256"])):
            raise ProjectStateError("EJOURNAL_INVALID", "database operation owner binding is invalid", 2)
    pointer = value.get("resolverClaim")
    if pointer is not None and (not isinstance(pointer, dict)
            or set(pointer) != {"claimId", "sequence", "recordSha256", "operationPlanSha256"}
            or not isinstance(pointer.get("claimId"), str) or not re.fullmatch(r"[a-f0-9]{32}", pointer["claimId"])
            or type(pointer.get("sequence")) is not int or pointer["sequence"] < 0
            or not isinstance(pointer.get("recordSha256"), str) or not _HASH.fullmatch(pointer["recordSha256"])
            or not isinstance(pointer.get("operationPlanSha256"), str) or not _HASH.fullmatch(pointer["operationPlanSha256"])):
        raise ProjectStateError("EJOURNAL_INVALID", "database resolver claim pointer is invalid", 2)


