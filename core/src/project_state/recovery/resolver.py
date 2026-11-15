from __future__ import annotations

"""Durable resolver claims for interrupted config and SQLite restores.

The OS operation lock proves current mutual exclusion. This append-only journal
binds each recovery attempt to the original operation plan and to the owner of
the currently held OS lock. A successor may append only after acquiring that
same lock; it never deletes or rewrites an older claim.
"""

import hashlib
import json
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.paths import assert_plain_path
from project_state.foundation.claims import (owner_binding, validate_owner as _validate_owner,
    read_claim as _read_claim, publish_claim)
from project_state.foundation.state_paths import state_dir

_OP_ID = re.compile(r"^[a-f0-9]{32}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_RECORD = re.compile(r"^claim-(\d{6})\.json$")
_TEMP = re.compile(r"^claim-(\d{6})\.tmp-([a-f0-9]{16})$")
_LOCK_ID = re.compile(r"^\d+:\d+$")


def _json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _plan_fields(kind: str, state: dict[str, Any]) -> dict[str, Any]:
    if kind == "config":
        if state.get("transactionKind") == "config-batch":
            resources = state.get("resources")
            if not isinstance(resources, list):
                raise ProjectStateError("EJOURNAL_INVALID", "batch restore plan has no resource list", 2)
            return {"rootIdentity": state["rootIdentity"], "operationId": state["operationId"],
                    "ownerBinding": state["ownerBinding"], "source": state["source"],
                    "safety": state["safety"], "transactionKind": state["transactionKind"],
                    "resources": [{key: item[key] for key in ("target", "pre", "stage", "desired")}
                                  for item in resources]}
        names = ("rootIdentity", "operationId", "ownerBinding", "source", "safety", "target", "pre", "stage")
    elif kind == "database":
        names = ("rootIdentity", "operationId", "ownerBinding", "kind", "source", "target", "stage", "pin")
    else:
        raise ProjectStateError("ERECOVERY_KIND", "operation recovery kind is unsupported", 2)
    try:
        return {name: state[name] for name in names}
    except KeyError as exc:
        raise ProjectStateError("EJOURNAL_INVALID", "operation plan is incomplete for recovery", 2) from exc


def plan_digest(kind: str, state: dict[str, Any]) -> str:
    return _sha(_json_bytes(_plan_fields(kind, state)))


def _claims_dir(root: Path, operation_id: str) -> Path:
    if not isinstance(operation_id, str) or not _OP_ID.fullmatch(operation_id):
        raise ProjectStateError("EOPERATION_ID", "operation ID is invalid", 1)
    return state_dir(root) / "resolvers" / operation_id


def _validate_claim(record: dict[str, Any], *, operation_id: str, kind: str,
                    root_identity: str, operation_plan_sha256: str,
                    owner_binding_sha256: str, sequence: int, previous_sha256: str | None) -> None:
    required = {"schemaVersion", "operationId", "operationKind", "sequence", "previousRecordSha256",
                "rootIdentity", "operationPlanSha256", "ownerBindingSha256", "claimId",
                "resolverTokenSha256", "resolverLockFileId", "action", "status", "startedAt"}
    optional = {"completedOperationRecordSha256"}
    if not required <= record.keys() or not record.keys() <= required | optional:
        raise ProjectStateError("ERESOLVER_INVALID", "resolver claim fields do not match schema v1", 2)
    if (type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1
            or record["operationId"] != operation_id or record["operationKind"] != kind
            or type(record["sequence"]) is not int or record["sequence"] != sequence
            or record["previousRecordSha256"] != previous_sha256
            or record["rootIdentity"] != root_identity
            or record["operationPlanSha256"] != operation_plan_sha256
            or record["ownerBindingSha256"] != owner_binding_sha256
            or not isinstance(record["claimId"], str) or not re.fullmatch(r"[a-f0-9]{32}", record["claimId"])
            or not isinstance(record["resolverTokenSha256"], str) or not _HASH.fullmatch(record["resolverTokenSha256"])
            or not isinstance(record["resolverLockFileId"], str) or not _LOCK_ID.fullmatch(record["resolverLockFileId"])
            or record["action"] not in {"continue", "rollback"}
            or record["status"] not in {"active", "completed"}
            or not isinstance(record["startedAt"], str) or not record["startedAt"]):
        raise ProjectStateError("ERESOLVER_INVALID", "resolver claim identity or sequence is invalid", 2)
    if record["status"] == "completed":
        if not isinstance(record.get("completedOperationRecordSha256"), str) or not _HASH.fullmatch(record["completedOperationRecordSha256"]):
            raise ProjectStateError("ERESOLVER_INVALID", "completed resolver claim lacks its operation record proof", 2)
    elif "completedOperationRecordSha256" in record:
        raise ProjectStateError("ERESOLVER_INVALID", "active resolver claim contains a completion proof", 2)


def load_claims(root: Path, operation_id: str, kind: str,
                state: dict[str, Any]) -> list[tuple[dict[str, Any], str]]:
    directory = _claims_dir(root, operation_id)
    try:
        directory_stat = directory.lstat()
    except FileNotFoundError:
        return []
    assert_plain_path(directory)
    if not stat.S_ISDIR(directory_stat.st_mode):
        raise ProjectStateError("ERESOLVER_UNSAFE", "resolver journal is not a plain directory", 2)
    binding = state.get("ownerBinding")
    if binding is None:
        raise ProjectStateError("ERECOVERY_LEGACY", "pending operation has no resolver owner binding; use its originating a35 package to inspect, continue or roll back, and preserve this state", 2)
    _validate_owner(binding)
    plan = _plan_fields(kind, state)
    plan_sha = _sha(_json_bytes(plan))
    owner_sha = _sha(_json_bytes(binding))
    found: list[tuple[int, Path]] = []
    for entry in directory.iterdir():
        assert_plain_path(entry, hardlinks=True)
        match = _RECORD.fullmatch(entry.name)
        if match:
            found.append((int(match.group(1)), entry))
        elif _TEMP.fullmatch(entry.name):
            # An unpublished temp is never authority. Preserve it; a successor
            # claim may publish the next no-replace record after validation.
            continue
        else:
            raise ProjectStateError("ERESOLVER_UNSAFE", "resolver journal contains an unrecognized entry", 2)
    found.sort()
    if [number for number, _ in found] != list(range(len(found))):
        raise ProjectStateError("ERESOLVER_INVALID", "resolver journal sequence is incomplete", 2)
    records: list[tuple[dict[str, Any], str]] = []
    previous_sha: str | None = None
    previous: dict[str, Any] | None = None
    for number, path in found:
        record, digest = _read_claim(path)
        _validate_claim(record, operation_id=operation_id, kind=kind,
                        root_identity=state.get("rootIdentity", ""), operation_plan_sha256=plan_sha,
                        owner_binding_sha256=owner_sha, sequence=number, previous_sha256=previous_sha)
        if previous is None:
            if record["status"] != "active":
                raise ProjectStateError("ERESOLVER_INVALID", "resolver journal must begin with an active claim", 2)
        elif previous["status"] == "completed":
            if record["status"] != "active" or record["claimId"] == previous["claimId"]:
                raise ProjectStateError("ERESOLVER_INVALID", "resolver successor claim is not a new active resolver", 2)
        elif record["claimId"] == previous["claimId"]:
            if (record["status"] != "completed"
                    or any(record.get(key) != previous.get(key) for key in
                           ("resolverTokenSha256", "resolverLockFileId", "action", "startedAt"))):
                raise ProjectStateError("ERESOLVER_INVALID", "resolver completion does not extend its active claim", 2)
        elif record["status"] != "active":
            raise ProjectStateError("ERESOLVER_INVALID", "resolver takeover must append a new active claim", 2)
        records.append((record, digest))
        previous_sha, previous = digest, record
    pointer = state.get("resolverClaim")
    if pointer is not None:
        if (not isinstance(pointer, dict) or set(pointer) != {"claimId", "sequence", "recordSha256", "operationPlanSha256"}
                or type(pointer.get("sequence")) is not int or pointer["sequence"] < 0
                or pointer["sequence"] >= len(records)):
            raise ProjectStateError("ERESOLVER_INVALID", "operation journal resolver pointer is invalid", 2)
        linked, linked_sha = records[pointer["sequence"]]
        if (pointer.get("claimId") != linked.get("claimId") or pointer.get("recordSha256") != linked_sha
                or pointer.get("operationPlanSha256") != plan_sha):
            raise ProjectStateError("ERESOLVER_INVALID", "operation journal does not bind its resolver claim", 2)
    return records


def _append_claim(root: Path, operation_id: str, kind: str, state: dict[str, Any],
                  record: dict[str, Any]) -> tuple[dict[str, Any], str]:
    directory = _claims_dir(root, operation_id)
    parent = directory.parent
    parent.mkdir(parents=True, exist_ok=True)
    assert_plain_path(parent)
    try:
        directory.mkdir()
    except FileExistsError:
        assert_plain_path(directory)
        if not directory.is_dir():
            raise ProjectStateError("ERESOLVER_UNSAFE", "resolver journal path is not a directory", 2)
    records = load_claims(root, operation_id, kind, state)
    sequence = len(records)
    previous = records[-1][1] if records else None
    value = {**record, "schemaVersion": 1, "operationId": operation_id,
             "operationKind": kind, "sequence": sequence, "previousRecordSha256": previous,
             "rootIdentity": state["rootIdentity"],
             "operationPlanSha256": plan_digest(kind, state),
             "ownerBindingSha256": _sha(_json_bytes(state["ownerBinding"]))}
    _validate_claim(value, operation_id=operation_id, kind=kind,
                    root_identity=state["rootIdentity"], operation_plan_sha256=value["operationPlanSha256"],
                    owner_binding_sha256=value["ownerBindingSha256"], sequence=sequence,
                    previous_sha256=previous)
    data = _json_bytes(value)
    return value, publish_claim(directory, sequence, data)


def begin_recovery(root: Path, operation_id: str, kind: str, state: dict[str, Any],
                   lock: Any, action: str) -> dict[str, Any]:
    if action not in {"continue", "rollback"}:
        raise ProjectStateError("ERECOVERY_ACTION", "resolver action is invalid", 1)
    binding = state.get("ownerBinding")
    if binding is None:
        raise ProjectStateError("ERECOVERY_LEGACY", "pending operation lacks durable owner binding; use its originating a35 package to inspect, continue or roll back", 2)
    _validate_owner(binding)
    lock.verify()
    records = load_claims(root, operation_id, kind, state)
    previous = records[-1][0] if records else None
    owner = getattr(lock, "owner", {})
    token = getattr(lock, "token", None)
    identity = getattr(lock, "identity", None)
    if (not isinstance(token, str) or not isinstance(identity, tuple) or len(identity) != 2
            or owner.get("token") != token or owner.get("rootIdentity") != state.get("rootIdentity")):
        raise ProjectStateError("ERESOLVER_OWNER", "current resolver does not own the verified operation lock", 2)
    claim_id = secrets.token_hex(16)
    record, digest = _append_claim(root, operation_id, kind, state, {
        "claimId": claim_id,
        "resolverTokenSha256": _sha(token.encode("ascii")),
        "resolverLockFileId": f"{identity[0]}:{identity[1]}",
        "action": action,
        "status": "active",
        "startedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    })
    return {"claimId": claim_id, "sequence": record["sequence"], "recordSha256": digest,
            "operationPlanSha256": record["operationPlanSha256"]}


def complete_recovery(root: Path, operation_id: str, kind: str, state: dict[str, Any],
                      lock: Any, pointer: dict[str, Any], operation_record_sha256: str) -> dict[str, Any]:
    if not isinstance(operation_record_sha256, str) or not _HASH.fullmatch(operation_record_sha256):
        raise ProjectStateError("ERESOLVER_INVALID", "terminal operation record proof is invalid", 2)
    lock.verify()
    records = load_claims(root, operation_id, kind, state)
    if not records:
        raise ProjectStateError("ERESOLVER_INVALID", "resolver completion has no claim history", 2)
    latest, _ = records[-1]
    token = getattr(lock, "token", None)
    identity = getattr(lock, "identity", None)
    if (latest.get("status") != "active" or latest.get("claimId") != pointer.get("claimId")
            or latest.get("sequence") != pointer.get("sequence")
            or latest.get("resolverTokenSha256") != _sha(token.encode("ascii"))
            or latest.get("resolverLockFileId") != f"{identity[0]}:{identity[1]}"
            or pointer.get("recordSha256") != records[-1][1]):
        raise ProjectStateError("ERESOLVER_OWNER", "resolver completion does not match the current active claim", 2)
    record, digest = _append_claim(root, operation_id, kind, state, {
        "claimId": latest["claimId"],
        "resolverTokenSha256": latest["resolverTokenSha256"],
        "resolverLockFileId": latest["resolverLockFileId"],
        "action": latest["action"],
        "status": "completed",
        "startedAt": latest["startedAt"],
        "completedOperationRecordSha256": operation_record_sha256,
    })
    return {"claimId": record["claimId"], "sequence": record["sequence"], "recordSha256": digest,
            "status": "completed"}


def latest_operation_record_sha(root: Path, operation_id: str, kind: str, state: dict[str, Any]) -> str:
    # The in-memory `state` passed by older call sites may have a stale sequence.
    # Revalidate the complete append-only chain and bind only its actual terminal
    # record; never trust a filename maximum or a caller-provided sequence.
    try:
        if kind == "config":
            from project_state.recovery.config_journal import load_records
            records = load_records(root, operation_id)
        elif kind == "database":
            from project_state.recovery.sqlite_journal import _load_records
            records = _load_records(root, operation_id)
        else:
            raise ProjectStateError("ERESOLVER_INVALID", "operation kind is invalid", 2)
        latest = records[-1]
        if (latest.get("operationId") != operation_id
                or latest.get("status") != state.get("status")
                or latest.get("phase") != state.get("phase")
                or latest.get("rootIdentity") != state.get("rootIdentity")):
            raise ProjectStateError("ERESOLVER_INVALID", "terminal operation record does not match the requested completion", 2)
        sequence = latest.get("sequence")
        if type(sequence) is not int or sequence != len(records) - 1:
            raise ProjectStateError("ERESOLVER_INVALID", "terminal operation sequence is invalid", 2)
        prefix = "record" if kind == "config" else "db-record"
        path = state_dir(root) / "operations" / operation_id / f"{prefix}-{sequence:06d}.json"
        data = path.read_bytes()
        if _sha(data) != _sha(_json_bytes(latest)):
            # JSON re-encoding is canonical for current journals; the file hash
            # remains authoritative and must agree with the validated value.
            raise ProjectStateError("ERESOLVER_INVALID", "terminal operation bytes changed after validation", 2)
        return _sha(data)
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EJOURNAL_UNREADABLE", "terminal operation record cannot be verified", 2) from exc
