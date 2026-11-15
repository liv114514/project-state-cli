from __future__ import annotations

import hashlib
import json
from pathlib import Path

from project_state.state_paths import ensure_state_dir


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_v2(root: Path, *, name: str = "before", config: bytes = b"KEY=alpha\n",
             kind: str = "named",
             config_extra: bytes | None = None, git_data: dict | None = None,
             extra_layers: dict[str, dict] | None = None,
             extra_private_files: dict[str, tuple[str, bytes]] | None = None,
             extra_artifacts: list[dict] | None = None) -> str:
    generation = "a" * 32
    state = ensure_state_dir(root)
    public = state / "snapshots" / name / "generations" / generation
    private = state / "secrets" / name / "generations" / generation
    (public / "files").mkdir(parents=True)
    (private / "files").mkdir(parents=True)
    env_files = {".env": {"keyCount": 1, "keys": {"KEY": {"nonEmpty": True}}}}
    if config_extra is not None:
        env_files[".env.local"] = {"keyCount": 1, "keys": {"EXTRA": {"nonEmpty": True}}}
    layer = {"envFiles": env_files}
    layer_bytes = (json.dumps(layer, ensure_ascii=False, indent=2) + "\n").encode()
    (public / "files" / "config.json").write_bytes(layer_bytes)
    git_bytes = None
    if git_data is not None:
        git_bytes = (json.dumps(git_data, ensure_ascii=False, indent=2) + "\n").encode()
        (public / "files" / "git.json").write_bytes(git_bytes)
    (private / "files" / ".env").write_bytes(config)
    identity = {"schemaVersion": 2, "state": "complete", "generation": generation, "kind": kind, "name": name,
                "createdAt": "2026-11-03T01:02:03.000Z", "toolVersion": "1.4.0-rc.15",
                "host": {"platform": "win32", "arch": "x64", "node": "v22.0.0"},
                "layers": {"config": {"status": "collected", "file": "config.json"}}}
    if git_data is not None:
        identity["layers"]["git"] = {"status": "collected", "file": "git.json"}
    public_artifacts = [{"id": "layer:config", "layer": "config", "kind": "layer-json", "privacy": "public", "required": True,
                         "restore": "record-only", "path": "config.json", "sha256": digest(layer_bytes), "size": len(layer_bytes)}]
    private_artifacts = [{"id": "config:.env", "layer": "config", "kind": "file", "privacy": "private", "required": True,
                          "restore": "restore-file", "path": ".env", "sha256": digest(config), "size": len(config), "target": ".env"}]
    if git_bytes is not None:
        public_artifacts.append({"id": "layer:git", "layer": "git", "kind": "layer-json", "privacy": "public", "required": True,
                                 "restore": "record-only", "path": "git.json", "sha256": digest(git_bytes), "size": len(git_bytes)})
    for layer_name, layer_data in (extra_layers or {}).items():
        layer_bytes = (json.dumps(layer_data, ensure_ascii=False, indent=2) + "\n").encode()
        layer_file = f"{layer_name}.json"
        layer_base = private if layer_name == "database" else public
        layer_base_name = "private" if layer_name == "database" else "public"
        layer_base = layer_base / "files"
        layer_base.mkdir(parents=True, exist_ok=True)
        (layer_base / layer_file).write_bytes(layer_bytes)
        identity["layers"][layer_name] = {"status": "collected", "file": layer_file}
        artifact = {"id": f"layer:{layer_name}", "layer": layer_name, "kind": "layer-json", "privacy": layer_base_name,
                    "required": True, "restore": "record-only", "path": layer_file,
                    "sha256": digest(layer_bytes), "size": len(layer_bytes)}
        (private_artifacts if layer_name == "database" else public_artifacts).append(artifact)
    public_manifest = {**identity, "artifacts": public_artifacts}
    if config_extra is not None:
        (private / "files" / ".env.local").write_bytes(config_extra)
        private_artifacts.append({"id": "config:.env.local", "layer": "config", "kind": "file", "privacy": "private", "required": True,
                                  "restore": "restore-file", "path": ".env.local", "sha256": digest(config_extra), "size": len(config_extra), "target": ".env.local"})
    for target, (layer_name, content) in (extra_private_files or {}).items():
        (private / "files" / target).write_bytes(content)
        private_artifacts.append({"id": f"{layer_name}:{target}", "layer": layer_name, "kind": "file", "privacy": "private", "required": True,
                                  "restore": "restore-file", "path": target, "sha256": digest(content), "size": len(content), "target": target})
    for item in extra_artifacts or []:
        content = item["content"]
        target = item["target"]
        (private / "files" / target).write_bytes(content)
        private_artifacts.append({key: value for key, value in item.items() if key != "content"})
    private_manifest = {**identity, "artifacts": private_artifacts}
    public_bytes = (json.dumps(public_manifest, ensure_ascii=False, indent=2) + "\n").encode()
    (public / "manifest.json").write_bytes(public_bytes)
    (private / "manifest.json").write_bytes((json.dumps(private_manifest, ensure_ascii=False, indent=2) + "\n").encode())
    pointer = {"schemaVersion": 1, "name": name, "generation": generation, "publicManifestSha256": digest(public_bytes)}
    current = public.parents[1] / "current.json"
    current.write_bytes((json.dumps(pointer, indent=2) + "\n").encode())
    return generation
