from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from datetime import datetime
from pathlib import Path
from typing import Any

from project_state.foundation.state_paths import state_dir
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.integrity import read_json, sha256
from project_state.foundation.paths import assert_plain_path, is_reparse_point, project_root, validate_generation, validate_relative, validate_snapshot_name

_HASH = re.compile(r"^[a-f0-9]{64}$")
_LAYERS = {"git", "deps", "runtime", "config", "docker", "database", "rollback"}
_SNAPSHOT_LAYERS = _LAYERS - {"rollback"}
_KINDS = {"named", "auto", "hook"}
_RESTORE = {"record-only", "restore-file", "sqlite-create-missing"}
_ARTIFACT_KINDS = {"layer-json", "file", "absent", "sqlite-schema", "sqlite-dump", "sqlite-backup"}
_TARGETS = {
    "config": {".env", ".env.local"},
    "runtime": {".nvmrc", ".node-version"},
    "deps": {"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"},
}


def _object(value: Any) -> bool:
    return isinstance(value, dict)


def _exact(obj: Any, required: set[str], optional: set[str] = frozenset()) -> bool:
    return _object(obj) and required <= obj.keys() and obj.keys() <= (required | optional)


def _assert_target(layer: str, target: Any) -> None:
    if not isinstance(target, str):
        raise ProjectStateError("EMANIFEST_INVALID", "artifact target is invalid", 1)
    if layer in _TARGETS and target in _TARGETS[layer]:
        return
    if layer == "database" and "/" not in target and re.fullmatch(r"(?!con(?:\.|$)|prn(?:\.|$)|aux(?:\.|$)|nul(?:\.|$)|com[1-9](?:\.|$)|lpt[1-9](?:\.|$))[^.].*\.(db|sqlite|sqlite3)", target, re.I):
        return
    if layer == "rollback" and (target in set().union(*_TARGETS.values()) or ("/" not in target and re.search(r"\.(db|sqlite|sqlite3)$", target, re.I))):
        return
    raise ProjectStateError("EUNSAFE_PATH", "artifact target is outside the supported allowlist", 1)


def _validate_layer(layer: str, data: Any) -> None:
    if not _object(data):
        raise ProjectStateError("EMANIFEST_INVALID", f"invalid {layer} layer data", 1)
    nullable_string = lambda v: v is None or isinstance(v, str)
    if layer == "git":
        ok = (_exact(data, {"commit", "branch", "detached", "dirty", "dirtyCount", "statusSample"})
              and isinstance(data["commit"], str) and re.fullmatch(r"[a-f0-9]{40,64}", data["commit"])
              and nullable_string(data["branch"]) and type(data["detached"]) is bool and type(data["dirty"]) is bool
              and type(data["dirtyCount"]) is int and data["dirtyCount"] >= 0
              and isinstance(data["statusSample"], list) and len(data["statusSample"]) <= 50
              and all(isinstance(x, str) for x in data["statusSample"])
              and data["dirty"] == (data["dirtyCount"] > 0) and data["dirtyCount"] >= len(data["statusSample"])
              and data["detached"] == (data["branch"] is None))
    elif layer == "deps":
        p = data.get("packageJson")
        resolved = data.get("resolved")
        ok = (_exact(data, {"packageJson", "lockFile", "lockFingerprint", "resolved", "note"})
              and _exact(p, {"name", "version"}) and nullable_string(p["name"]) and nullable_string(p["version"])
              and (data["lockFile"] is None or data["lockFile"] in _TARGETS["deps"])
              and nullable_string(data["lockFingerprint"])
              and (data["lockFingerprint"] is None or re.fullmatch(r"[a-f0-9]{12}", data["lockFingerprint"]))
              and (resolved is None or (_object(resolved) and all(isinstance(x, str) for x in resolved.values())))
              and nullable_string(data["note"])
              and ((data["lockFile"] is None) == (data["lockFingerprint"] is None)))
    elif layer == "runtime":
        pins = data.get("versionPins") if _exact(data, {"node", "npm", "python", "versionPins"}) else None
        ok = (isinstance(data.get("node"), str) and nullable_string(data.get("npm")) and nullable_string(data.get("python"))
              and isinstance(pins, list) and all(_exact(p, {"name"}) and p["name"] in _TARGETS["runtime"] for p in pins)
              and len({p["name"] for p in pins}) == len(pins))
    elif layer == "config":
        env = data.get("envFiles") if _exact(data, {"envFiles"}) else None
        ok = isinstance(env, dict)
        if ok:
            for name, item in env.items():
                if name not in _TARGETS["config"] or not _exact(item, {"keyCount", "keys"}) or not isinstance(item["keys"], dict) or type(item["keyCount"]) is not int or item["keyCount"] != len(item["keys"]):
                    ok = False; break
                if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", key) or not _exact(value, {"nonEmpty"}) or type(value["nonEmpty"]) is not bool for key, value in item["keys"].items()):
                    ok = False; break
    elif layer == "docker":
        services = data.get("services") if _exact(data, {"services"}) else None
        ok = isinstance(services, list) and all(_exact(s, {"name", "state"}) and isinstance(s["name"], str) and isinstance(s["state"], str) for s in services)
    elif layer == "database":
        dbs = data.get("databases") if _exact(data, {"databases", "engine", "withSeed", "comparison"}) else None
        ok = (isinstance(dbs, list) and data["engine"] == "sqlite3 online backup API" and type(data["withSeed"]) is bool
              and data["comparison"] == "schema and row counts recorded; row contents not compared")
        seen: set[str] = set()
        if ok:
            for db in dbs:
                fields = {"file", "mode", "restore", "artifactId", "schemaFingerprint", "tables", "totalRows", "integrity", "rowContentsCompared"}
                if not _exact(db, fields) or not isinstance(db["file"], str) or not isinstance(db["restore"], str) or not isinstance(db["artifactId"], str) or not _HASH.fullmatch(str(db["schemaFingerprint"])) or not isinstance(db["tables"], list) or not all(isinstance(x, str) for x in db["tables"]) or type(db["totalRows"]) is not int or db["totalRows"] < 0 or db["integrity"] != "ok" or db["rowContentsCompared"] is not False:
                    ok = False; break
                _assert_target("database", db["file"])
                backup = db["mode"] == "backup" and db["restore"] == "sqlite-create-missing" and db["artifactId"] == f"database-backup:{db['file']}" and data["withSeed"]
                schema = db["mode"] == "schema" and db["restore"] == "record-only" and db["artifactId"] == f"database-schema:{db['file']}" and not data["withSeed"]
                key = db["file"].casefold()
                if key in seen or not (backup or schema):
                    ok = False; break
                seen.add(key)
    elif layer == "rollback":
        ok = bool(data)
    else:
        ok = False
    if not ok:
        raise ProjectStateError("EMANIFEST_INVALID", f"invalid {layer} layer fields", 1)


def _validate_manifest(manifest: Any, name: str, generation: str, privacy: str) -> None:
    fields = {"schemaVersion", "state", "generation", "kind", "name", "createdAt", "toolVersion", "host", "layers", "artifacts"}
    if not _object(manifest):
        raise ProjectStateError("EMANIFEST_INVALID", "manifest must be a JSON object", 1)
    schema = manifest.get("schemaVersion")
    if type(schema) is int and schema == 1:
        raise ProjectStateError("ELEGACY_RESTORE", "schema v1 is diagnostic-only; restore is not supported", 1)
    if type(schema) is not int or schema != 2:
        raise ProjectStateError("ESCHEMA_UNSUPPORTED", "snapshot schema version is not supported", 1)
    if manifest.keys() != fields:
        raise ProjectStateError("EMANIFEST_INVALID", "manifest fields do not match schema v2", 1)
    if manifest["state"] != "complete" or manifest["name"] != name or manifest["generation"] != generation or not isinstance(manifest["kind"], str) or manifest["kind"] not in _KINDS:
        raise ProjectStateError("EMANIFEST_INVALID", "manifest identity or completion state is invalid", 1)
    managed_name = bool(re.fullmatch(r"auto-\d{8}-\d{6}(?:-\d+)?", name) if manifest["kind"] == "auto"
                        else re.fullmatch(r"hook-\d{8}-\d{6}(?:-\d+)?", name) if manifest["kind"] == "hook"
                        else not name.lower().startswith(("auto-", "hook-")))
    if not managed_name:
        raise ProjectStateError("EMANIFEST_INVALID", "snapshot kind does not match its reserved name", 1)
    created = manifest["createdAt"]
    if not isinstance(created, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z", created):
        raise ProjectStateError("EMANIFEST_INVALID", "manifest timestamp is invalid", 1)
    try:
        datetime.fromisoformat(created.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ProjectStateError("EMANIFEST_INVALID", "manifest timestamp is invalid", 1) from exc
    host = manifest["host"]
    if not isinstance(manifest["toolVersion"], str) or not _exact(host, {"platform", "arch", "node"}) or not all(isinstance(host[k], str) for k in host):
        raise ProjectStateError("EMANIFEST_INVALID", "manifest host metadata is invalid", 1)
    layers = manifest["layers"]
    artifacts = manifest["artifacts"]
    if not isinstance(layers, dict) or not isinstance(artifacts, list):
        raise ProjectStateError("EMANIFEST_INVALID", "manifest layers or artifacts are invalid", 1)
    for layer_name, layer in layers.items():
        if not isinstance(layer_name, str) or layer_name not in _SNAPSHOT_LAYERS or not isinstance(layer, dict) or not isinstance(layer.get("status"), str) or layer.get("status") not in {"collected", "skipped"}:
            raise ProjectStateError("EMANIFEST_INVALID", "manifest layer status is invalid", 1)
        if layer["status"] == "collected":
            if not _exact(layer, {"status", "file"}) or layer["file"] != f"{layer_name}.json":
                raise ProjectStateError("EMANIFEST_INVALID", "collected layer metadata is invalid", 1)
        elif not _exact(layer, {"status", "reason"}) or not isinstance(layer["reason"], str):
            raise ProjectStateError("EMANIFEST_INVALID", "skipped layer metadata is invalid", 1)

    ids: set[str] = set()
    paths: set[str] = set()
    for a in artifacts:
        allowed = {"id", "layer", "kind", "privacy", "required", "restore", "path", "sha256", "size", "target"}
        if not isinstance(a, dict) or not {"id", "layer", "kind", "privacy", "required", "restore", "path", "sha256", "size"} <= a.keys() or a.keys() - allowed:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact fields do not match schema v2", 1)
        if not isinstance(a["id"], str) or not a["id"] or a["id"] in ids:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact id is missing or duplicated", 1)
        ids.add(a["id"])
        layer, kind, secret, restore = a["layer"], a["kind"], a["privacy"], a["restore"]
        if not isinstance(layer, str) or layer not in _LAYERS or not isinstance(kind, str) or kind not in _ARTIFACT_KINDS or not isinstance(secret, str) or secret not in {"public", "private"} or type(a["required"]) is not bool or not isinstance(restore, str) or restore not in _RESTORE:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact classification is invalid", 1)
        valid = ((kind == "layer-json" and layer in _SNAPSHOT_LAYERS and secret == ("private" if layer == "database" else "public") and restore == "record-only" and a["path"] == f"{layer}.json")
                 or (kind == "absent" and manifest["kind"] == "auto" and layer == "rollback" and secret == "private" and restore == "record-only")
                 or (kind == "file" and layer in {"runtime", "deps", "config", "rollback"} and secret == "private" and restore == "restore-file")
                 or (kind in {"sqlite-schema", "sqlite-dump"} and layer == "database" and secret == "private" and restore == "record-only")
                 or (kind == "sqlite-backup" and layer == "database" and secret == "private" and restore == "sqlite-create-missing"))
        if not valid:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact kind and policy combination is unsupported", 1)
        if kind == "absent":
            if a["path"] is not None or a["sha256"] is not None or a["size"] != 0 or "target" not in a:
                raise ProjectStateError("EMANIFEST_INVALID", "absent artifact is malformed", 1)
            _assert_target("rollback", a["target"])
            continue
        relative = validate_relative(a["path"])
        location = (secret, relative.casefold())
        if location in paths:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact path is duplicated or case-aliased", 1)
        paths.add(location)
        if not isinstance(a["sha256"], str) or not _HASH.fullmatch(a["sha256"]) or type(a["size"]) is not int or a["size"] < 0:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact size or digest is invalid", 1)
        if kind == "layer-json":
            if "target" in a or (secret != "public" and layer != "database"):
                raise ProjectStateError("EMANIFEST_INVALID", "layer artifact privacy or target is invalid", 1)
        else:
            if secret != "private" or not isinstance(a.get("target"), str):
                raise ProjectStateError("EMANIFEST_INVALID", "raw artifact must be private and target-bound", 1)
            _assert_target(layer, a["target"])
        if secret != privacy:
            raise ProjectStateError("EMANIFEST_INVALID", "artifact appears in the wrong privacy manifest", 1)


def _hash_file(path: Path, expected_size: int) -> str:
    assert_plain_path(path, hardlinks=True)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ProjectStateError("EUNSAFE_PATH", "artifact is not a regular file", 1)
    digest = hashlib.sha256()
    count = 0
    try:
        with path.open("rb", buffering=0) as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise ProjectStateError("EUNSAFE_PATH", "artifact identity changed while opening", 1)
            while chunk := stream.read(1024 * 1024):
                count += len(chunk)
                if count > expected_size:
                    raise ProjectStateError("EARTIFACT_INTEGRITY", "artifact size exceeds its declaration", 1)
                digest.update(chunk)
            after_fd = os.fstat(stream.fileno())
        after_path = path.lstat()
    except ProjectStateError:
        raise
    except OSError as exc:
        raise ProjectStateError("EARTIFACT_UNREADABLE", "artifact cannot be verified", 1) from exc
    if count != expected_size or (before.st_dev, before.st_ino) != (after_fd.st_dev, after_fd.st_ino) or (after_fd.st_dev, after_fd.st_ino) != (after_path.st_dev, after_path.st_ino) or before.st_size != after_fd.st_size or before.st_mtime_ns != after_fd.st_mtime_ns:
        raise ProjectStateError("EARTIFACT_INTEGRITY", "artifact changed during verification", 1)
    return digest.hexdigest()


def snapshot_paths(root: Path, name: str, generation: str | None = None) -> tuple[Path, Path, Path]:
    validate_snapshot_name(name)
    public = state_dir(root) / "snapshots" / name
    private = state_dir(root) / "secrets" / name
    if generation is None:
        pointer, _ = read_json(public / "current.json", max_bytes=64_000)
        generation = validate_generation(pointer.get("generation"))
    else:
        validate_generation(generation)
    return public / "generations" / generation, private / "generations" / generation, public / "current.json"


def _walk_generation(base: Path) -> set[str]:
    assert_plain_path(base)
    result: set[str] = set()
    for current, dirs, files in os.walk(base, topdown=True, followlinks=False):
        cur = Path(current)
        for name in list(dirs):
            child = cur / name
            assert_plain_path(child)
            st = child.lstat()
            if not stat.S_ISDIR(st.st_mode):
                raise ProjectStateError("EUNSAFE_PATH", "generation contains a non-directory component", 1)
            if not any(child.iterdir()):
                raise ProjectStateError("EARTIFACT_UNDECLARED", "generation contains an empty undeclared directory", 1)
        for name in files:
            child = cur / name
            assert_plain_path(child, hardlinks=True)
            st = child.lstat()
            if not stat.S_ISREG(st.st_mode):
                raise ProjectStateError("EUNSAFE_PATH", "generation contains an unsupported entry", 1)
            result.add(child.relative_to(base).as_posix())
    return result


def validate_pair(root_value: str | os.PathLike[str], name: str, generation: str | None = None) -> dict[str, Any]:
    root = project_root(root_value)
    public_dir, private_dir, pointer_path = snapshot_paths(root, name, generation)
    assert_plain_path(pointer_path, hardlinks=True)
    pointer, pointer_bytes = read_json(pointer_path, max_bytes=64_000)
    if not _exact(pointer, {"schemaVersion", "name", "generation", "publicManifestSha256"}) or type(pointer["schemaVersion"]) is not int or pointer["schemaVersion"] != 1 or pointer["name"] != name:
        raise ProjectStateError("EMANIFEST_INVALID", "current pointer identity is invalid", 1)
    gen = validate_generation(pointer["generation"])
    if generation is not None and gen != generation:
        raise ProjectStateError("EMANIFEST_INVALID", "requested generation is not current", 1)
    assert_plain_path(public_dir)
    assert_plain_path(private_dir)
    pub, pub_bytes = read_json(public_dir / "manifest.json")
    priv, priv_bytes = read_json(private_dir / "manifest.json")
    _validate_manifest(pub, name, gen, "public")
    _validate_manifest(priv, name, gen, "private")
    for key in ("schemaVersion", "state", "generation", "kind", "name", "createdAt", "toolVersion", "host", "layers"):
        if pub[key] != priv[key]:
            raise ProjectStateError("EMANIFEST_INVALID", f"public/private manifests disagree on {key}", 1)
    if not isinstance(pointer["publicManifestSha256"], str) or sha256(pub_bytes) != pointer["publicManifestSha256"]:
        raise ProjectStateError("EARTIFACT_INTEGRITY", "current pointer digest does not match the public manifest", 1)
    all_artifacts = pub["artifacts"] + priv["artifacts"]
    ids = [a["id"] for a in all_artifacts]
    if len(ids) != len(set(ids)):
        raise ProjectStateError("EMANIFEST_INVALID", "artifact identity is duplicated across manifests", 1)
    parsed_layers: dict[str, Any] = {}
    resolved = []
    for manifest, base in ((pub, public_dir), (priv, private_dir)):
        expected = {"manifest.json"}
        for artifact in manifest["artifacts"]:
            if artifact["kind"] == "absent":
                resolved.append({**artifact, "absolutePath": None})
                continue
            relative = artifact["path"]
            target = base / "files" / Path(*relative.split("/"))
            expected.add("files/" + relative)
            assert_plain_path(target, hardlinks=True)
            if _hash_file(target, artifact["size"]) != artifact["sha256"]:
                raise ProjectStateError("EARTIFACT_INTEGRITY", "artifact digest mismatch", 1)
            if artifact["kind"] == "layer-json":
                value, _ = read_json(target)
                _validate_layer(artifact["layer"], value)
                parsed_layers[artifact["layer"]] = value
            resolved.append({**artifact, "absolutePath": str(target)})
        if _walk_generation(base) != expected:
            raise ProjectStateError("EARTIFACT_UNDECLARED", "generation files do not exactly match its artifact manifest", 1)
    for layer, metadata in pub["layers"].items():
        if metadata["status"] == "collected" and not any(a["layer"] == layer and a["kind"] == "layer-json" and a["path"] == f"{layer}.json" for a in all_artifacts):
            raise ProjectStateError("EMANIFEST_INVALID", f"collected layer is missing: {layer}", 1)
    by_layer_target = {(a["layer"], a.get("target")) for a in all_artifacts}
    for name_item in parsed_layers.get("runtime", {}).get("versionPins", []):
        if ("runtime", name_item["name"]) not in by_layer_target:
            raise ProjectStateError("EMANIFEST_INVALID", "runtime pin metadata is missing its private artifact", 1)
    for name_item in parsed_layers.get("config", {}).get("envFiles", {}):
        if ("config", name_item) not in by_layer_target:
            raise ProjectStateError("EMANIFEST_INVALID", "config metadata is missing its private artifact", 1)
    for db in parsed_layers.get("database", {}).get("databases", []):
        if ("database", db["file"]) not in by_layer_target:
            raise ProjectStateError("EMANIFEST_INVALID", "database metadata is missing its private artifact", 1)
    return {"root": root, "name": name, "generation": gen, "pointer": pointer,
            "pointerBytes": pointer_bytes, "manifest": pub, "privateManifest": priv,
            "layers": parsed_layers, "artifacts": resolved}


def inspect_snapshot(root_value: str | os.PathLike[str], name: str) -> dict[str, Any]:
    root = project_root(root_value)
    validate_snapshot_name(name)
    state_root = state_dir(root)
    snapshots_dir = state_root / "snapshots"
    snap_dir = snapshots_dir / name
    for parent in (state_root, snapshots_dir):
        try:
            st = parent.lstat()
        except FileNotFoundError:
            return {"name": name, "state": "missing", "reasonCode": "SNAPSHOT_NOT_FOUND"}
        except OSError:
            return {"name": name, "state": "unreadable", "reasonCode": "SNAPSHOT_INVENTORY_UNREADABLE"}
        if is_reparse_point(st) or not stat.S_ISDIR(st.st_mode):
            return {"name": name, "state": "unreadable", "reasonCode": "SNAPSHOT_INVENTORY_UNREADABLE"}
    try:
        snap_stat = snap_dir.lstat()
    except FileNotFoundError:
        return {"name": name, "state": "missing", "reasonCode": "SNAPSHOT_NOT_FOUND"}
    except OSError:
        return {"name": name, "state": "unreadable", "reasonCode": "SNAPSHOT_INVENTORY_UNREADABLE"}
    if is_reparse_point(snap_stat) or not stat.S_ISDIR(snap_stat.st_mode):
        return {"name": name, "state": "unreadable", "reasonCode": "SNAPSHOT_INVENTORY_UNREADABLE"}
    try:
        assert_plain_path(snap_dir)
    except ProjectStateError as exc:
        return {"name": name, "state": "unreadable", "reasonCode": exc.code}
    current = snap_dir / "current.json"
    if not current.exists():
        legacy = snap_dir / "manifest.json"
        if legacy.exists():
            try:
                manifest, _ = read_json(legacy)
                if manifest.get("schemaVersion") == 1 and manifest.get("name") == name:
                    return {"name": name, "generation": None, "createdAt": manifest.get("createdAt"),
                            "kind": manifest.get("kind", "unknown"), "schemaVersion": 1,
                            "state": "diagnostic-only", "integrity": "not-checked",
                            "restoreAvailable": False, "applicationHealth": "not-tested"}
            except ProjectStateError:
                pass
        return {"name": name, "state": "invalid", "reasonCode": "SNAPSHOT_POINTER_MISSING"}
    try:
        checked = validate_pair(root, name)
    except ProjectStateError as exc:
        return {"name": name, "state": "invalid" if exc.code in {"EMANIFEST_INVALID", "ESCHEMA_UNSUPPORTED", "EUNSAFE_PATH", "EARTIFACT_INTEGRITY", "EARTIFACT_UNDECLARED"} else "unreadable",
                "reasonCode": exc.code}
    manifest = checked["manifest"]
    return {"name": name, "generation": checked["generation"], "createdAt": manifest["createdAt"],
            "kind": manifest["kind"], "schemaVersion": 2, "state": "verified",
            "integrity": "verified", "layerStatus": manifest["layers"],
            "artifactCount": len(checked["artifacts"]), "restoreAvailable": True,
            "applicationHealth": "not-tested"}
