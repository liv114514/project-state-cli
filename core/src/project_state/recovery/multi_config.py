"""Version 2 journal and recovery protocol for the fixed config allowlist.

Only Windows write semantics are enabled. Each file replacement is individually
atomic; the batch is recoverable after interruption but is not atomically
visible to concurrent application readers.
"""
from __future__ import annotations

import hashlib
import re
import stat
from pathlib import Path
from typing import Any

from project_state.contracts.errors import ProjectStateError
from project_state.foundation.state_paths import state_dir
from project_state.foundation.storage import validate_pair
from project_state.recovery.config_journal import load_records

_HASH = re.compile(r"^[a-f0-9]{64}$")
_FILE_ID = re.compile(r"^\d+:\d+$")
_TARGETS = (".env", ".env.local")
_APPLY = ("prepared", "displace-intent", "displaced", "publish-intent", "published", "verified")
_ROLLBACK = ("rollback-intent", "rollback-displaced", "rollback-publish-intent", "rolled-back")
_PHASES = set(_APPLY) | set(_ROLLBACK) | {"rollback-not-applied"}


def _valid_proof(value: Any) -> bool:
    if not isinstance(value, dict) or type(value.get("exists")) is not bool:
        return False
    if not value["exists"]:
        return value.get("size") == 0 and value.get("sha256") is None and value.get("fileId") is None
    return (type(value.get("size")) is int and 0 <= value["size"] <= 1_048_576
            and isinstance(value.get("sha256"), str) and _HASH.fullmatch(value["sha256"]) is not None
            and isinstance(value.get("fileId"), str) and _FILE_ID.fullmatch(value["fileId"]) is not None
            and type(value.get("mode", 0o600)) is int and type(value.get("links", 1)) is int
            and value.get("links", 1) in {1, 2}
            and value.keys() <= {"exists", "size", "sha256", "fileId", "mode", "links"})


def _valid_stage(value: Any, operation_id: str, index: int) -> bool:
    rel = f"staging/{operation_id}/private/restore-{index}.stage"
    return (isinstance(value, dict) and set(value) == {"relativePath", "fileId", "size", "sha256", "mode"}
            and value.get("relativePath") == rel and isinstance(value.get("fileId"), str)
            and _FILE_ID.fullmatch(value["fileId"]) is not None and type(value.get("size")) is int
            and 0 <= value["size"] <= 1_048_576 and isinstance(value.get("sha256"), str)
            and _HASH.fullmatch(value["sha256"]) is not None and type(value.get("mode")) is int)


def validate_record_v2(value: dict[str, Any]) -> None:
    required = {"schemaVersion", "transactionKind", "operationId", "sequence", "previousRecordSha256",
                "rootIdentity", "status", "phase", "source", "safety", "ownerBinding", "resources"}
    optional = {"resolverClaim"}
    if not required <= value.keys() or not value.keys() <= required | optional:
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal fields do not match schema v2", 2)
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 2
            or value["transactionKind"] != "config-batch"
            or not re.fullmatch(r"[a-f0-9]{32}", str(value["operationId"]))
            or type(value["sequence"]) is not int or value["sequence"] < 0
            or (value["previousRecordSha256"] is not None
                and (not isinstance(value["previousRecordSha256"], str)
                     or not _HASH.fullmatch(value["previousRecordSha256"])))
            or not isinstance(value["rootIdentity"], str) or not _HASH.fullmatch(value["rootIdentity"])):
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal identity is invalid", 2)
    status_phase = {"in-progress": {"prepared", "applying"}, "completed": {"verified"},
                    "rolling-back": {"rolling-back"}, "rolled-back": {"rolled-back"}}
    if value["status"] not in status_phase or value["phase"] not in status_phase[value["status"]]:
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal status/phase is invalid", 2)
    for field in ("source", "safety"):
        ref = value[field]
        if (not isinstance(ref, dict) or set(ref) != {"name", "generation"}
                or not isinstance(ref["name"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", ref["name"])
                or not isinstance(ref["generation"], str) or not re.fullmatch(r"[a-f0-9]{32}", ref["generation"])):
            raise ProjectStateError("EJOURNAL_INVALID", f"batch {field} reference is invalid", 2)
    binding = value["ownerBinding"]
    binding_fields = {"protocolVersion", "operation", "name", "startedAt", "lockFileId", "ownerTokenSha256"}
    if (not isinstance(binding, dict) or set(binding) != binding_fields
            or type(binding.get("protocolVersion")) is not int or binding.get("protocolVersion") != 1
            or binding.get("operation") != "restore" or not isinstance(binding.get("name"), str)
            or not isinstance(binding.get("startedAt"), str) or not isinstance(binding.get("lockFileId"), str)
            or not _FILE_ID.fullmatch(binding["lockFileId"])
            or not isinstance(binding.get("ownerTokenSha256"), str) or not _HASH.fullmatch(binding["ownerTokenSha256"])):
        raise ProjectStateError("EJOURNAL_INVALID", "batch owner binding is invalid", 2)
    resources = value["resources"]
    if not isinstance(resources, list) or len(resources) < 2 or len(resources) > len(_TARGETS):
        raise ProjectStateError("EJOURNAL_INVALID", "batch must contain multiple allowlisted config targets", 2)
    targets = [item.get("target") if isinstance(item, dict) else None for item in resources]
    if targets != [target for target in _TARGETS if target in targets]:
        raise ProjectStateError("EJOURNAL_INVALID", "batch resources are duplicated or out of allowlist order", 2)
    resource_fields = {"target", "pre", "stage", "desired", "phase", "post", "displaced",
                       "rollbackExpected", "rollbackRetired", "rollbackPost"}
    for index, item in enumerate(resources):
        if not isinstance(item, dict) or set(item) != resource_fields:
            raise ProjectStateError("EJOURNAL_INVALID", "batch resource fields are invalid", 2)
        desired = item["desired"]
        if (item["target"] not in _TARGETS or not _valid_proof(item["pre"])
                or not _valid_stage(item["stage"], value["operationId"], index)
                or not isinstance(desired, dict) or set(desired) != {"size", "sha256"}
                or type(desired["size"]) is not int or not 0 <= desired["size"] <= 1_048_576
                or not isinstance(desired["sha256"], str) or not _HASH.fullmatch(desired["sha256"])
                or item["stage"]["size"] != desired["size"] or item["stage"]["sha256"] != desired["sha256"]
                or item["phase"] not in _PHASES
                or any(item[key] is not None and not _valid_proof(item[key])
                       for key in ("post", "displaced", "rollbackExpected", "rollbackRetired", "rollbackPost"))):
            raise ProjectStateError("EJOURNAL_INVALID", "batch resource proof or phase is invalid", 2)
        stage = item["stage"]
        post = item["post"]
        displaced = item["displaced"]
        rollback_expected = item["rollbackExpected"]
        rollback_retired = item["rollbackRetired"]
        rollback_post = item["rollbackPost"]
        if post is not None and (post.get("fileId") != stage["fileId"] or post.get("size") != desired["size"]
                                 or post.get("sha256") != desired["sha256"]):
            raise ProjectStateError("EJOURNAL_INVALID", "batch post proof is not bound to its staged object", 2)
        if displaced is not None and (not item["pre"]["exists"]
                                      or displaced.get("fileId") != item["pre"].get("fileId")
                                      or displaced.get("size") != item["pre"].get("size")
                                      or displaced.get("sha256") != item["pre"].get("sha256")):
            raise ProjectStateError("EJOURNAL_INVALID", "batch displaced proof is not bound to its prestate", 2)
        if rollback_expected is not None and (rollback_expected.get("fileId") != stage["fileId"]
                                              or rollback_expected.get("size") != desired["size"]
                                              or rollback_expected.get("sha256") != desired["sha256"]):
            raise ProjectStateError("EJOURNAL_INVALID", "batch rollback intent is not bound to the published object", 2)
        if rollback_retired is not None and (rollback_retired.get("fileId") != stage["fileId"]
                                             or rollback_retired.get("size") != desired["size"]
                                             or rollback_retired.get("sha256") != desired["sha256"]):
            raise ProjectStateError("EJOURNAL_INVALID", "batch retired publication proof is invalid", 2)
        if rollback_post is not None:
            matches_pre = (rollback_post.get("exists") == item["pre"].get("exists")
                           and rollback_post.get("size") == item["pre"].get("size")
                           and rollback_post.get("sha256") == item["pre"].get("sha256")
                           and rollback_post.get("fileId") == item["pre"].get("fileId"))
            matches_stage = (rollback_post.get("exists") is True
                             and rollback_post.get("fileId") == stage["fileId"]
                             and rollback_post.get("size") == desired["size"]
                             and rollback_post.get("sha256") == desired["sha256"])
            if not (matches_pre or matches_stage):
                raise ProjectStateError("EJOURNAL_INVALID", "batch rollback proof is not bound to prestate or publication", 2)
        if item["phase"] in {"published", "verified"} and post is None:
            raise ProjectStateError("EJOURNAL_INVALID", "published batch phase lacks its publication proof", 2)
        if item["phase"] == "rolled-back" and rollback_post != item["pre"]:
            # Present proofs carry mode/link observations too, so compare their
            # durable identity subset instead of requiring those observations.
            proof = rollback_post or {}
            pre = item["pre"]
            if any(proof.get(key) != pre.get(key) for key in ("exists", "size", "sha256", "fileId")):
                raise ProjectStateError("EJOURNAL_INVALID", "rolled-back batch lacks its exact prestate proof", 2)
    claim = value.get("resolverClaim")
    if claim is not None and (not isinstance(claim, dict)
            or set(claim) != {"claimId", "sequence", "recordSha256", "operationPlanSha256"}
            or not isinstance(claim.get("claimId"), str) or not re.fullmatch(r"[a-f0-9]{32}", claim["claimId"])
            or type(claim.get("sequence")) is not int or claim["sequence"] < 0
            or any(not isinstance(claim.get(key), str) or not _HASH.fullmatch(claim[key])
                   for key in ("recordSha256", "operationPlanSha256"))):
        raise ProjectStateError("EJOURNAL_INVALID", "batch resolver claim pointer is invalid", 2)
    if value["status"] == "completed" and any(item["phase"] != "verified" or item["post"] is None for item in resources):
        raise ProjectStateError("EJOURNAL_INVALID", "completed batch lacks final resource proofs", 2)
    if value["status"] == "rolled-back" and any(item["phase"] != "rolled-back" for item in resources):
        raise ProjectStateError("EJOURNAL_INVALID", "rolled-back batch lacks per-target resolution", 2)


def validate_transition_v2(previous: dict[str, Any], current: dict[str, Any]) -> None:
    if previous.get("schemaVersion") != 2 or current.get("schemaVersion") != 2:
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal schema changed within an operation", 2)
    immutable = ("transactionKind", "operationId", "rootIdentity", "source", "safety", "ownerBinding")
    if any(previous.get(key) != current.get(key) for key in immutable):
        raise ProjectStateError("EJOURNAL_INVALID", "batch immutable operation plan changed", 2)
    old_resources, new_resources = previous["resources"], current["resources"]
    if len(old_resources) != len(new_resources):
        raise ProjectStateError("EJOURNAL_INVALID", "batch resource set changed", 2)
    progress_fields = {"phase", "post", "displaced", "rollbackExpected", "rollbackRetired", "rollbackPost"}
    changed = 0
    for old, new in zip(old_resources, new_resources, strict=True):
        for key in set(old) | set(new):
            if key not in progress_fields and old.get(key) != new.get(key):
                raise ProjectStateError("EJOURNAL_INVALID", "batch resource plan changed", 2)
        if old != new:
            changed += 1
            for key in ("post", "displaced", "rollbackExpected", "rollbackRetired", "rollbackPost"):
                if old.get(key) is not None and old.get(key) != new.get(key):
                    raise ProjectStateError("EJOURNAL_INVALID", "batch identity proof changed after publication", 2)
            if new["phase"] not in _PHASES:
                raise ProjectStateError("EJOURNAL_INVALID", "batch resource phase is unknown", 2)
            if old["phase"] in _APPLY and new["phase"] in _APPLY:
                allowed = _APPLY[_APPLY.index(old["phase"]) + 1] if old["phase"] != _APPLY[-1] else old["phase"]
                if new["phase"] != allowed:
                    raise ProjectStateError("EJOURNAL_INVALID", "batch apply progress is not monotonic", 2)
            elif old["phase"] == "prepared" and new["phase"] == "rollback-not-applied":
                pass
            elif old["phase"] in _APPLY and new["phase"] in {"rollback-intent", "rollback-not-applied"}:
                pass
            elif old["phase"] == "rollback-intent" and new["phase"] == "rollback-not-applied":
                pass
            elif old["phase"] in _ROLLBACK and new["phase"] in _ROLLBACK:
                allowed = _ROLLBACK[_ROLLBACK.index(old["phase"]) + 1] if old["phase"] != _ROLLBACK[-1] else old["phase"]
                if new["phase"] != allowed:
                    raise ProjectStateError("EJOURNAL_INVALID", "batch rollback progress is not monotonic", 2)
            elif old["phase"] == "rollback-not-applied" and new["phase"] == "rolled-back":
                pass
            else:
                raise ProjectStateError("EJOURNAL_INVALID", "batch resource transition is not authorized", 2)
    if changed > 1:
        raise ProjectStateError("EJOURNAL_INVALID", "one journal record may advance only one target", 2)
    old_status, old_phase = previous["status"], previous["phase"]
    new_status, new_phase = current["status"], current["phase"]
    legal = ((old_status == new_status and old_phase == new_phase)
             or (old_status == "in-progress" and new_status == "in-progress" and new_phase == "applying")
             or (old_status == "in-progress" and new_status == "completed" and new_phase == "verified"
                 and all(x["phase"] == "verified" for x in new_resources))
             or (old_status in {"in-progress", "completed"} and new_status == "rolling-back"
                 and new_phase == "rolling-back")
             or (old_status == "rolling-back" and new_status == "rolling-back" and new_phase == "rolling-back")
             or (old_status == "rolling-back" and new_status == "rolled-back" and new_phase == "rolled-back"
                 and all(x["phase"] == "rolled-back" for x in new_resources)))
    if not legal:
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal status transition is not authorized", 2)
    old_claim, new_claim = previous.get("resolverClaim"), current.get("resolverClaim")
    if old_claim is not None and old_claim != new_claim:
        if not isinstance(new_claim, dict) or new_claim.get("sequence", -1) <= old_claim.get("sequence", -1):
            raise ProjectStateError("EJOURNAL_INVALID", "batch resolver claim did not advance", 2)


def _record(root: Path, operation_id: str, state: dict[str, Any]) -> dict[str, Any]:
    from project_state.recovery.config import _record as record
    record(root, operation_id, state)
    return load_records(root, operation_id)[-1]


def _stage_candidate(root: Path, resource: dict[str, Any]) -> Path:
    from project_state.foundation.paths import assert_plain_path
    rel = resource["stage"].get("relativePath")
    if not isinstance(rel, str) or "\\" in rel or ".." in rel.split("/"):
        raise ProjectStateError("EJOURNAL_INVALID", "batch stage path is invalid", 2)
    path = state_dir(root) / Path(*rel.split("/"))
    assert_plain_path(path.parent)
    return path


def _stage_path(root: Path, resource: dict[str, Any]) -> Path:
    from project_state.recovery.config import _stage_path
    return _stage_path(root, resource["stage"])


def _quarantine(root: Path, resource: dict[str, Any], suffix: str) -> Path:
    stage = _stage_candidate(root, resource)
    return stage.with_name(f"{stage.stem}.{suffix}")


def _match_target(root: Path, resource: dict[str, Any]) -> dict[str, Any]:
    from project_state.recovery.config import _file_proof
    return _file_proof(root / resource["target"], allow_linked=True)


def _matches_stage(resource: dict[str, Any], proof: dict[str, Any]) -> bool:
    return (proof.get("exists") is True and proof.get("fileId") == resource["stage"]["fileId"]
            and proof.get("size") == resource["desired"]["size"]
            and proof.get("sha256") == resource["desired"]["sha256"])


def _safety_for_all(root: Path, name: str, preview: dict[str, Any], resources: list[dict[str, Any]], lock: Any,
                    safety_points: Any) -> dict[str, str]:
    from project_state.recovery.config import _safe_point, _file_proof, _same
    # A single generation is created before any target changes and must protect
    # every present target in the allowlist batch.
    first = resources[0]
    safety = _safe_point(root, name, first["pre"], first["target"], lock, safety_points)
    pair = validate_pair(root, safety["name"], safety["generation"])
    for resource in resources:
        pre = resource["pre"]
        target = resource["target"]
        if pre["exists"]:
            artifact = next((a for a in pair["artifacts"] if a.get("layer") == "config"
                             and a.get("kind") == "file" and a.get("target") == target), None)
            if not artifact or artifact.get("size") != pre["size"] or artifact.get("sha256") != pre["sha256"]:
                raise ProjectStateError("ESAFETY_POINT", "one batch target is absent from the verified safety generation", 2)
            from project_state.recovery.planning import _read_verified
            proof = _read_verified(Path(artifact["absolutePath"]), artifact["size"], artifact["sha256"])
            if proof[0] != pre["size"] or artifact["sha256"] != pre["sha256"]:
                raise ProjectStateError("ESAFETY_POINT", "safety artifact changed after pair validation", 2)
        elif _file_proof(root / target)["exists"]:
            raise ProjectStateError("ESOURCE_CHANGED", "a previously missing target appeared during safety capture", 2)
    refreshed = __import__("project_state.recovery.planning", fromlist=["plan_config_restore"]).plan_config_restore(root, name)
    if refreshed["generation"] != preview["generation"] or [x["target"] for x in refreshed["targets"]] != [x["target"] for x in preview["targets"]]:
        raise ProjectStateError("ESOURCE_CHANGED", "snapshot generation or target selection changed before batch publication", 2)
    for resource in resources:
        if not _same(resource["pre"], _file_proof(root / resource["target"])):
            raise ProjectStateError("ESOURCE_CHANGED", "a batch target changed while the safety generation was created", 2)
    return safety


def apply_config_batch_locked(root: Path, name: str, preview: dict[str, Any], safety_points: Any, lock: Any) -> dict[str, Any]:
    from project_state.recovery.config import (_root_identity, _stage, _file_proof, _same,
                                                _move_to_displaced, _move_noreplace)
    from project_state.foundation.storage import validate_pair
    if safety_points is None or len(preview["targets"]) != 2:
        raise ProjectStateError("ERESTORE_SELECTION", "batch restore requires both allowlisted config targets and a safety provider", 2)
    targets = [item["target"] for item in preview["targets"]]
    if targets != list(_TARGETS):
        raise ProjectStateError("ERESTORE_SELECTION", "batch restore is limited to .env and .env.local", 2)
    pair = validate_pair(root, name, preview["generation"])
    artifacts = {a.get("target"): a for a in pair["artifacts"]
                 if a.get("layer") == "config" and a.get("kind") == "file"}
    if set(artifacts) != set(_TARGETS):
        raise ProjectStateError("ERESTORE_INPUT", "validated snapshot does not contain both config targets", 2)
    resources: list[dict[str, Any]] = []
    payloads: list[bytes] = []
    for index, target in enumerate(_TARGETS):
        artifact = artifacts[target]
        data = Path(artifact["absolutePath"]).read_bytes()
        if len(data) != artifact["size"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
            raise ProjectStateError("EARTIFACT_INTEGRITY", "a batch config artifact changed before staging", 2)
        pre = _file_proof(root / target)
        payloads.append(data)
        resources.append({"target": target, "pre": pre,
                          "desired": {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()},
                          "stage": None, "phase": "prepared", "post": None, "displaced": None,
                          "rollbackExpected": None, "rollbackRetired": None, "rollbackPost": None})
    safety = _safety_for_all(root, name, preview, resources, lock, safety_points)
    operation_id = __import__("uuid").uuid4().hex
    for index, resource in enumerate(resources):
        resource["stage"] = _stage(root, operation_id, f"restore-{index}", payloads[index])
    state = {"schemaVersion": 2, "transactionKind": "config-batch", "status": "in-progress", "phase": "prepared",
             "rootIdentity": _root_identity(root), "source": {"name": name, "generation": preview["generation"]},
             "safety": safety, "ownerBinding": __import__("project_state.recovery.resolver", fromlist=["owner_binding"]).owner_binding(lock),
             "resources": resources}
    _record(root, operation_id, state)
    return continue_batch_locked(root, operation_id, state, lock, initial=True)


def _advance(root: Path, operation_id: str, state: dict[str, Any], index: int, **updates: Any) -> dict[str, Any]:
    resources = [dict(item) for item in state["resources"]]
    resources[index].update(updates)
    if state["status"] == "rolling-back":
        status, phase = "rolling-back", "rolling-back"
    else:
        status, phase = "in-progress", "applying"
    return _record(root, operation_id, {**state, "resources": resources, "status": status, "phase": phase})


def _apply_one(root: Path, operation_id: str, state: dict[str, Any], index: int) -> dict[str, Any]:
    from project_state.recovery.config import _file_proof, _same, _move_to_displaced, _move_noreplace
    resource = state["resources"][index]
    target = root / resource["target"]
    stage = _stage_candidate(root, resource)
    current = _file_proof(target, allow_linked=True)
    stage_now = _file_proof(_stage_path(root, resource), allow_linked=True) if stage.exists() else None
    displaced = _quarantine(root, resource, "previous")
    old = resource["phase"]
    if _matches_stage(resource, current):
        if old not in {"published", "verified"}:
            state = _advance(root, operation_id, state, index, phase="published", post=current)
        current_state = state["resources"][index]
        if not _matches_stage(current_state, _file_proof(target, allow_linked=True)):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "published batch target changed before verification", 2)
        if current_state["phase"] != "verified":
            state = _advance(root, operation_id, state, index, phase="verified", post=current)
        return state
    if current.get("exists") and not _same(resource["pre"], current):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "batch target is neither its authorized prestate nor published object; preserve all evidence", 2)
    displaced_now = None
    try:
        displaced_now = _file_proof(displaced, allow_linked=True)
    except FileNotFoundError:
        pass
    if resource["pre"]["exists"]:
        if displaced_now.get("exists") and not _same(resource["pre"], displaced_now):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch quarantine identity differs from its recorded prestate", 2)
        if current.get("exists"):
            if old in {"prepared", "displace-intent"}:
                if old == "prepared":
                    state = _advance(root, operation_id, state, index, phase="displace-intent")
                _move_to_displaced(target, displaced, resource["pre"])
                displaced_now = _file_proof(displaced, allow_linked=True)
                state = _advance(root, operation_id, state, index, phase="displaced", displaced=displaced_now)
        elif not displaced_now.get("exists") or not _same(resource["pre"], displaced_now):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch target is missing without its authorized prestate quarantine", 2)
        elif state["resources"][index]["phase"] == "displace-intent":
            state = _advance(root, operation_id, state, index, phase="displaced", displaced=displaced_now)
    else:
        if current.get("exists") or displaced.exists():
            raise ProjectStateError("EOPERATION_UNCERTAIN", "originally absent batch target or quarantine is occupied", 2)
        if old == "prepared":
            state = _advance(root, operation_id, state, index, phase="displace-intent")
        if state["resources"][index]["phase"] == "displace-intent":
            state = _advance(root, operation_id, state, index, phase="displaced")
    current_resource = state["resources"][index]
    if current_resource["phase"] in {"displaced", "publish-intent"}:
        if not stage_now or not _matches_stage(resource, stage_now):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch private stage is missing or changed", 2)
        if current_resource["phase"] == "displaced":
            state = _advance(root, operation_id, state, index, phase="publish-intent")
        if target.exists():
            raise ProjectStateError("ESOURCE_CHANGED", "external object appeared at a batch target; it was preserved", 2)
        _move_noreplace(stage, target)
        published = _file_proof(target, allow_linked=True)
        if not _matches_stage(resource, published):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch publication identity differs from its staged object", 2)
        state = _advance(root, operation_id, state, index, phase="published", post=published)
    current_resource = state["resources"][index]
    if current_resource["phase"] == "published":
        final = _file_proof(target, allow_linked=True)
        if not _matches_stage(current_resource, final):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch target failed final identity and digest verification", 2)
        state = _advance(root, operation_id, state, index, phase="verified", post=final)
    return state


def continue_batch_locked(root: Path, operation_id: str, state: dict[str, Any], lock: Any,
                          *, initial: bool = False) -> dict[str, Any]:
    from project_state.recovery.config import _root_identity
    if state.get("rootIdentity") != _root_identity(root):
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal belongs to another project", 2)
    if state["status"] == "rolled-back":
        return inspect_batch(root, operation_id, [state])
    if state["status"] == "rolling-back":
        return _continue_batch_rollback(root, operation_id, state, lock)
    if state["status"] == "completed":
        inspected = inspect_batch(root, operation_id, [state])
        if inspected["classification"] != "completed":
            raise ProjectStateError("EOPERATION_UNCERTAIN", "completed batch no longer matches every published identity", 2)
        _complete_batch_claim(root, operation_id, state, lock, "continue")
        return inspected
    if not initial:
        from project_state.recovery.resolver import begin_recovery
        pointer = begin_recovery(root, operation_id, "config", state, lock, "continue")
        state = _record(root, operation_id, {**state, "resolverClaim": pointer, "phase": "applying"})
    elif state["phase"] == "prepared":
        state = _record(root, operation_id, {**state, "phase": "applying"})
    for index in range(len(state["resources"])):
        state = _apply_one(root, operation_id, state, index)
    for resource in state["resources"]:
        final = _match_target(root, resource)
        if not _matches_stage(resource, final):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "not all batch targets match their staged proofs", 2)
    terminal = _record(root, operation_id, {**state, "status": "completed", "phase": "verified"})
    if not initial:
        from project_state.recovery.resolver import complete_recovery, latest_operation_record_sha
        complete_recovery(root, operation_id, "config", terminal, lock, terminal["resolverClaim"],
                          latest_operation_record_sha(root, operation_id, "config", terminal))
    lock.verify()
    return {"operationId": operation_id, "transactionKind": "config-batch", "status": "verified",
            "snapshot": terminal["source"]["name"], "generation": terminal["source"]["generation"],
            "safety": terminal["safety"], "targets": [x["target"] for x in terminal["resources"]],
            "verified": True}


def inspect_batch(root: Path, operation_id: str, records: list[dict[str, Any]]) -> dict[str, Any]:
    from project_state.recovery.config import _root_identity, _same, _file_proof
    state = records[-1]
    if state.get("rootIdentity") != _root_identity(root) or state.get("operationId") != operation_id:
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal belongs to another project", 2)
    from project_state.recovery.resolver import load_claims
    load_claims(root, operation_id, "config", state)
    all_post = True
    all_pre = True
    resources = []
    for resource in state["resources"]:
        current = _file_proof(root / resource["target"], allow_linked=True)
        stage_path = _stage_candidate(root, resource)
        stage = None
        if stage_path.exists():
            stage = _file_proof(_stage_path(root, resource), allow_linked=True)
            if not _matches_stage(resource, stage):
                raise ProjectStateError("EJOURNAL_UNCERTAIN", "batch private stage identity changed", 2)
        quarantine = _quarantine(root, resource, "previous")
        previous = _file_proof(quarantine, allow_linked=True) if quarantine.exists() else None
        rollback_quarantine = _quarantine(root, resource, "rollback-post")
        rollback_retired = _file_proof(rollback_quarantine, allow_linked=True) if rollback_quarantine.exists() else None
        if rollback_retired is not None and not _matches_stage(resource, rollback_retired):
            raise ProjectStateError("EJOURNAL_UNCERTAIN", "rollback quarantine no longer matches the operation publication", 2)
        if resource.get("rollbackRetired") is not None and (rollback_retired is None
                or not _matches_stage(resource, rollback_retired)):
            raise ProjectStateError("EJOURNAL_UNCERTAIN", "journaled rollback quarantine is missing or changed", 2)
        pre_matches = _same(resource["pre"], current)
        if resource["pre"]["exists"] and not pre_matches:
            pre_matches = bool(previous and _same(resource["pre"], previous) and not current["exists"])
        post_matches = _matches_stage(resource, current)
        all_pre &= pre_matches
        all_post &= post_matches
        if state["status"] == "in-progress":
            if post_matches:
                classification = "published"
            elif not current["exists"] and previous and _same(resource["pre"], previous) and stage:
                classification = "displaced"
            elif pre_matches and stage:
                classification = "not-applied"
            else:
                classification = "uncertain"
        elif state["status"] == "completed":
            classification = "completed" if post_matches else "uncertain"
        elif state["status"] == "rolled-back":
            classification = "rolled-back" if pre_matches else "uncertain"
        else:
            classification = "rollback-in-progress" if (post_matches or pre_matches or previous) else "uncertain"
        resources.append({"target": resource["target"], "classification": classification,
                          "current": {"exists": current["exists"], "size": current["size"]}})
    overall = ("completed" if state["status"] == "completed" and all_post else
               "rolled-back" if state["status"] == "rolled-back" and all_pre else
               "not-applied" if state["status"] == "in-progress"
               and all(item["classification"] == "not-applied" for item in resources) else
               "uncertain" if any(item["classification"] == "uncertain" for item in resources) else
               "interrupted")
    return {"resultSchemaVersion": 1, "transactionKind": "config-batch", "operationId": operation_id,
            "status": state["status"], "phase": state["phase"], "classification": overall,
            "source": state["source"], "safety": state["safety"], "resources": resources,
            "recoveryActions": ["--continue", "--rollback"] if overall in {"interrupted", "not-applied"} else [],
            "businessValues": "withheld"}


def _continue_batch_rollback(root: Path, operation_id: str, state: dict[str, Any], lock: Any) -> dict[str, Any]:
    from project_state.recovery.config import _file_proof, _same, _move_to_displaced, _move_noreplace
    for index in reversed(range(len(state["resources"]))):
        resource = state["resources"][index]
        target = root / resource["target"]
        current = _file_proof(target, allow_linked=True)
        if resource["phase"] == "rolled-back":
            if not _same(resource["pre"], current):
                raise ProjectStateError("EOPERATION_UNCERTAIN", "rolled-back config target changed externally", 2)
            continue
        previous = _quarantine(root, resource, "previous")
        rollback_post = _quarantine(root, resource, "rollback-post")
        moved = _file_proof(rollback_post, allow_linked=True) if rollback_post.exists() else None
        if _same(resource["pre"], current):
            # Not applied, or the original object has already been returned.
            if resource["pre"]["exists"] and previous.exists():
                raise ProjectStateError("EOPERATION_UNCERTAIN", "original target and prestate quarantine both exist", 2)
            if moved is not None and not _matches_stage(resource, moved):
                raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback quarantine is not the operation publication", 2)
            phase = resource["phase"]
            if phase in _APPLY or phase == "rollback-intent":
                updates = {"phase": "rollback-not-applied", "rollbackPost": current}
                if moved is not None:
                    updates["rollbackRetired"] = moved
                state = _advance(root, operation_id, state, index, **updates)
            if state["resources"][index]["phase"] == "rollback-displaced":
                state = _advance(root, operation_id, state, index, phase="rollback-publish-intent")
            if state["resources"][index]["phase"] in {"rollback-not-applied", "rollback-publish-intent"}:
                state = _advance(root, operation_id, state, index, phase="rolled-back")
            continue
        if current["exists"] and not _matches_stage(resource, current):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "external object occupies a batch target; rollback preserved it", 2)
        if moved is None and current["exists"]:
            if resource["phase"] != "rollback-intent":
                state = _advance(root, operation_id, state, index, phase="rollback-intent", rollbackExpected=current)
            _move_to_displaced(target, rollback_post, current)
            moved = _file_proof(rollback_post, allow_linked=True)
            state = _advance(root, operation_id, state, index, phase="rollback-displaced", rollbackRetired=moved)
        elif moved is not None:
            if not _matches_stage(resource, moved) or current["exists"]:
                raise ProjectStateError("EOPERATION_UNCERTAIN", "rollback quarantine is not the operation publication", 2)
            if resource["phase"] == "rollback-intent":
                state = _advance(root, operation_id, state, index, phase="rollback-displaced", rollbackRetired=moved)
        if resource["pre"]["exists"]:
            prior = _file_proof(previous, allow_linked=True) if previous.exists() else None
            if not prior or not _same(resource["pre"], prior):
                raise ProjectStateError("EOPERATION_UNCERTAIN", "prestate safety quarantine is missing or changed", 2)
            if not target.exists():
                if state["resources"][index]["phase"] == "rollback-displaced":
                    state = _advance(root, operation_id, state, index, phase="rollback-publish-intent")
                _move_noreplace(previous, target)
        final = _file_proof(target, allow_linked=True)
        if not _same(resource["pre"], final):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch rollback did not restore the exact prestate", 2)
        if state["resources"][index]["phase"] not in {"rollback-publish-intent", "rolled-back"}:
            state = _advance(root, operation_id, state, index, phase="rollback-publish-intent")
        state = _advance(root, operation_id, state, index, phase="rolled-back", rollbackPost=final)
    if any(x["phase"] != "rolled-back" for x in state["resources"]):
        raise ProjectStateError("EOPERATION_UNCERTAIN", "batch rollback is incomplete", 2)
    terminal = _record(root, operation_id, {**state, "status": "rolled-back", "phase": "rolled-back"})
    pointer = terminal.get("resolverClaim")
    if pointer:
        from project_state.recovery.resolver import complete_recovery, latest_operation_record_sha
        complete_recovery(root, operation_id, "config", terminal, lock, pointer,
                          latest_operation_record_sha(root, operation_id, "config", terminal))
    lock.verify()
    return {"operationId": operation_id, "transactionKind": "config-batch", "status": "rolled-back",
            "verified": True, "targets": [x["target"] for x in terminal["resources"]], "safety": terminal["safety"]}


def rollback_batch_locked(root: Path, operation_id: str, state: dict[str, Any], lock: Any) -> dict[str, Any]:
    from project_state.recovery.config import _root_identity
    from project_state.recovery.resolver import begin_recovery
    if state.get("rootIdentity") != _root_identity(root):
        raise ProjectStateError("EJOURNAL_INVALID", "batch journal belongs to another project", 2)
    if state["status"] == "rolled-back":
        _complete_batch_claim(root, operation_id, state, lock, "rollback")
        return inspect_batch(root, operation_id, [state])
    if state["status"] != "rolling-back":
        inspected = inspect_batch(root, operation_id, load_records(root, operation_id))
        if any(item["classification"] == "uncertain" for item in inspected["resources"]):
            raise ProjectStateError("EOPERATION_UNCERTAIN", "batch state cannot be safely rolled back; preserve journal, stages, and safety generation", 2)
        pointer = begin_recovery(root, operation_id, "config", state, lock, "rollback")
        state = _record(root, operation_id, {**state, "status": "rolling-back", "phase": "rolling-back",
                                             "resolverClaim": pointer})
    else:
        # A prior resolver may have terminated while rolling back. The new
        # process must acquire a fresh claim bound to its own lock and append
        # it to the existing claim chain before continuing the journal.
        pointer = begin_recovery(root, operation_id, "config", state, lock, "rollback")
        state = _record(root, operation_id, {**state, "resolverClaim": pointer})
    return _continue_batch_rollback(root, operation_id, state, lock)


def _complete_batch_claim(root: Path, operation_id: str, state: dict[str, Any], lock: Any, action: str) -> None:
    from project_state.recovery.resolver import (load_claims, begin_recovery, complete_recovery,
                                                 latest_operation_record_sha)
    claims = load_claims(root, operation_id, "config", state)
    if not claims or claims[-1][0]["status"] != "active":
        return
    pointer = begin_recovery(root, operation_id, "config", state, lock, action)
    complete_recovery(root, operation_id, "config", state, lock, pointer,
                      latest_operation_record_sha(root, operation_id, "config", state))
    lock.verify()

