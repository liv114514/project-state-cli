from __future__ import annotations

import hashlib
import json
import os
import subprocess
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from project_state.collectors import collect_config, collect_deps, collect_docker, collect_git, collect_runtime, parse_env
from tests._support import temporary_directory, state_dir, ensure_state_dir


def _git_test_env(root: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["GIT_CONFIG_GLOBAL"] = str(root / "empty-global-config")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def _init_git_repository(root: Path) -> dict[str, str]:
    hooks = root / "empty-hooks"
    hooks.mkdir()
    env = _git_test_env(root)
    subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=root, env=env, check=True)
    (root / "tracked.txt").write_text("initial\n", encoding="utf-8")
    subprocess.run(["git", "add", "--", "tracked.txt"], cwd=root, env=env, check=True)
    subprocess.run(["git", "-c", "user.name=Project State Test", "-c",
                    "user.email=project-state-test@example.invalid", "-c", f"core.hooksPath={hooks}",
                    "commit", "--quiet", "-m", "synthetic baseline"], cwd=root, env=env, check=True)
    return env


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_config_metadata_is_redacted_and_raw_bytes_are_private_capture(self):
        raw = b"# fixture\r\nexport API_KEY='fictional-secret-value'\r\nEMPTY=\r\nAPI_KEY=fictional-overwrite\r\n"
        (self.root / ".env").write_bytes(raw)
        result = collect_config(self.root)
        self.assertEqual(result.status, "collected")
        self.assertEqual(result.data, {"envFiles": {".env": {"keyCount": 2, "keys": {
            "API_KEY": {"nonEmpty": True}, "EMPTY": {"nonEmpty": False}}}}})
        self.assertEqual(result.files[0].content, raw)
        self.assertEqual(result.files[0].sha256, hashlib.sha256(raw).hexdigest())
        self.assertNotIn("fictional-secret-value", repr(result))
        self.assertNotIn("fictional-overwrite", json.dumps(result.data))

    def test_windows_path_and_handle_ctime_representation_difference_is_not_false_change(self):
        (self.root / ".env").write_bytes(b"KEY=fictional\n")
        real_fstat = os.fstat
        def handle_stat(fd):
            value = real_fstat(fd)
            fields = {key: getattr(value, key) for key in (
                "st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size",
                "st_atime", "st_mtime", "st_ctime", "st_atime_ns", "st_mtime_ns", "st_ctime_ns") if hasattr(value, key)}
            fields["st_ctime_ns"] += 1_000_000
            return SimpleNamespace(**fields)
        with patch("project_state.collectors.os.fstat", side_effect=handle_stat):
            result = collect_config(self.root)
        self.assertEqual(result.status, "collected")
        self.assertEqual(result.files[0].content, b"KEY=fictional\n")

    def test_env_parser_keeps_duplicate_last_value_and_ignores_invalid_keys(self):
        parsed = parse_env(b"A=first\nA=\"\"\nBAD-NAME=hidden\nnot-an-assignment\n")
        self.assertEqual(parsed, {"A": {"nonEmpty": False}})
        self.assertEqual(parse_env("\ufeffBOM_KEY=value\n".encode("utf-8")), {"BOM_KEY": {"nonEmpty": True}})
        unicode_separator = parse_env("FIRST=one\u2028SECOND=two".encode("utf-8"))
        self.assertEqual(unicode_separator, {"FIRST": {"nonEmpty": True}})

    def test_unsafe_config_source_degrades_without_following_link(self):
        outside = self.root / "fictional-outside-env"
        outside.write_bytes(b"TOKEN=outside-secret\n")
        source = self.root / ".env"
        try:
            source.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("host does not permit synthetic symlink creation")
        result = collect_config(self.root)
        self.assertEqual(result.status, "skipped")
        self.assertEqual(result.files, ())
        self.assertNotIn("outside-secret", repr(result))

    def test_dependency_summary_uses_same_captured_lock_bytes(self):
        package = {"name": "fictional-app", "version": "1.2.3"}
        lock = {"packages": {"": {"dependencies": {"alpha": "^1"}, "devDependencies": {"@scope/beta": "^2"}},
                              "node_modules/alpha": {"version": "1.4.0"}}}
        (self.root / "package.json").write_text(json.dumps(package), encoding="utf-8")
        raw_lock = json.dumps(lock, sort_keys=True).encode("utf-8")
        (self.root / "package-lock.json").write_bytes(raw_lock)
        result = collect_deps(self.root)
        self.assertEqual(result.status, "collected")
        self.assertEqual(result.data["packageJson"], {"name": "fictional-app", "version": "1.2.3"})
        self.assertEqual(result.data["lockFile"], "package-lock.json")
        self.assertEqual(result.data["lockFingerprint"], hashlib.sha256(raw_lock).hexdigest()[:12])
        self.assertEqual(result.data["resolved"], {"alpha": "1.4.0", "@scope/beta": "missing-in-lock"})
        self.assertEqual([item.content for item in result.files], [(self.root / "package.json").read_bytes(), raw_lock])
        self.assertNotIn("fictional-app", repr(result.files))

    def test_invalid_package_json_is_skipped_and_runtime_pin_values_stay_private(self):
        (self.root / "package.json").write_bytes(b"{broken")
        deps = collect_deps(self.root)
        self.assertEqual(deps.status, "skipped")
        (self.root / ".nvmrc").write_bytes(b"fictional-runtime-pin\r\n")
        with patch("project_state.collectors.run_trusted", side_effect=[
            {"ok": False, "stdout": "", "code": "ENOENT"},
            {"ok": False, "stdout": "", "code": "ENOENT"},
        ]):
            runtime = collect_runtime(self.root)
        self.assertEqual(runtime.status, "collected")
        self.assertEqual(runtime.data["node"], "unavailable")
        self.assertEqual(runtime.data["versionPins"], [{"name": ".nvmrc"}])
        self.assertEqual(runtime.files[0].content, b"fictional-runtime-pin\r\n")
        self.assertNotIn("fictional-runtime-pin", repr(runtime))

    def test_dependency_json_does_not_accept_bom_or_nonstandard_numbers(self):
        for raw in (b"\xef\xbb\xbf{}", b'{"name":NaN}'):
            with self.subTest(raw=raw):
                (self.root / "package.json").write_bytes(raw)
                self.assertEqual(collect_deps(self.root).status, "skipped")

    def test_git_collector_captures_clean_attached_and_detached_schema(self):
        env = _init_git_repository(self.root)
        with patch.dict(os.environ, env):
            clean = collect_git(self.root)
        self.assertEqual(clean.status, "collected")
        self.assertRegex(clean.data["commit"], r"^[a-f0-9]{40,64}$")
        self.assertEqual(clean.data["branch"], "main")
        self.assertFalse(clean.data["detached"])
        self.assertFalse(clean.data["dirty"])
        self.assertEqual(clean.data["dirtyCount"], 0)
        self.assertEqual(clean.data["statusSample"], [])

        subprocess.run(["git", "checkout", "--detach", "HEAD"], cwd=self.root, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with patch.dict(os.environ, env):
            detached = collect_git(self.root)
        self.assertEqual(detached.status, "collected")
        self.assertIsNone(detached.data["branch"])
        self.assertTrue(detached.data["detached"])

    def test_git_collector_counts_changes_without_copying_file_contents(self):
        env = _init_git_repository(self.root)
        (self.root / "fictional tracked file.txt").write_text("before\n", encoding="utf-8")
        subprocess.run(["git", "add", "--", "fictional tracked file.txt"], cwd=self.root, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "-c", "user.name=Project State Test", "-c",
                        "user.email=project-state-test@example.invalid", "commit", "-m", "add fixture"],
                       cwd=self.root, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (self.root / "fictional tracked file.txt").write_text("after\n", encoding="utf-8")
        (self.root / "fictional untracked.txt").write_text("synthetic-only\n", encoding="utf-8")
        with patch.dict(os.environ, env):
            result = collect_git(self.root)
        self.assertEqual(result.status, "collected")
        self.assertTrue(result.data["dirty"])
        self.assertEqual(result.data["dirtyCount"], 2)
        self.assertEqual(len(result.data["statusSample"]), 2)
        self.assertTrue(any("fictional tracked file.txt" in row for row in result.data["statusSample"]))
        self.assertTrue(any("fictional untracked.txt" in row for row in result.data["statusSample"]))
        self.assertNotIn("synthetic-only", repr(result.data))

    def test_git_probe_failure_is_skipped_not_misreported_as_clean(self):
        with patch("project_state.collectors.inspect_git", side_effect=__import__(
                "project_state.errors", fromlist=["ProjectStateError"]).ProjectStateError(
                    "EGIT_PROBE", "synthetic probe failure", 2)):
            result = collect_git(self.root)
        self.assertEqual(result.status, "skipped")
        self.assertIsNone(result.data)
        self.assertIn("EGIT_PROBE", result.reason)

    def test_docker_collector_skips_without_compose_and_parses_bounded_service_fields(self):
        skipped = collect_docker(self.root)
        self.assertEqual(skipped.status, "skipped")
        self.assertIn("No docker-compose", skipped.reason)
        (self.root / "compose.yaml").write_text("services: fictional\n", encoding="utf-8")
        with patch("project_state.collectors.run_trusted", return_value={
                "ok": True, "stdout": '{"Name":"demo-web","State":"running"}\nnot-json\n{"Service":"worker","Status":"exited"}\n',
        }) as runner:
            result = collect_docker(self.root)
        self.assertEqual(result.status, "collected")
        self.assertEqual(result.data, {"services": [{"name": "demo-web", "state": "running"},
                                                      {"name": "worker", "state": "exited"}]})
        runner.assert_called_once_with("docker", ["compose", "ps", "--format", "json"],
                                       cwd=self.root, timeout=20, max_output=10 * 1024 * 1024)

    def test_docker_query_failure_is_a_redacted_skip(self):
        (self.root / "docker-compose.yml").write_text("synthetic: true\n", encoding="utf-8")
        with patch("project_state.collectors.run_trusted", return_value={
                "ok": False, "code": "ETIMEDOUT", "stderr": "fictional private daemon detail",
        }):
            result = collect_docker(self.root)
        self.assertEqual(result.status, "skipped")
        self.assertIn("ETIMEDOUT", result.reason)
        self.assertNotIn("fictional private daemon detail", result.reason)

    def test_snapshot_publishes_collected_git_layer_in_schema_v2(self):
        from project_state.collectors import LayerResult
        from project_state.snapshot import create_snapshot
        from project_state.storage import validate_pair

        env = _init_git_repository(self.root)
        with patch.dict(os.environ, env), patch(
                "project_state.snapshot.collect_runtime",
                return_value=LayerResult("skipped", reason="test-controlled runtime collector")):
            saved = create_snapshot(self.root, "git-captured")
        self.assertEqual(saved["layerStatus"]["git"]["status"], "collected")
        verified = validate_pair(self.root, "git-captured", saved["generation"])
        git_artifact = next(item for item in verified["artifacts"] if item["id"] == "layer:git")
        layer_path = (state_dir(self.root) / "snapshots/git-captured/generations"
                      / saved["generation"] / "files" / git_artifact["path"])
        data = json.loads(layer_path.read_bytes())
        expected_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, env=env,
                                                text=True).strip()
        self.assertEqual(data["commit"], expected_head)
        self.assertFalse(data["dirty"])
        self.assertEqual(data["dirtyCount"], 0)


if __name__ == "__main__":
    unittest.main()
