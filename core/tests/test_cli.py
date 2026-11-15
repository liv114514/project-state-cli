from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from project_state.cli import main
from project_state import __version__
from tests.snapshot_fixture import build_v2
from tests._support import temporary_directory, state_dir, ensure_state_dir, _test_base
from project_state.process import run_trusted


class CliTests(unittest.TestCase):
    def invoke(self, args, cwd):
        old = Path.cwd()
        out, err = io.StringIO(), io.StringIO()
        try:
            import os
            os.chdir(cwd)
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(args)
        finally:
            os.chdir(old)
        return code, out.getvalue(), err.getvalue()

    def test_help_and_version(self):
        code, out, _ = self.invoke(["--version"], Path.cwd())
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), __version__)
        help_code, help_text, _ = self.invoke(["help"], Path.cwd())
        self.assertEqual(help_code, 0)
        self.assertNotIn("MIGRATION-MATRIX.md", help_text)
        self.assertIn("Git restore provides a validated read-only preview only", help_text)

    def test_general_doctor_json_is_versioned_and_read_only(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
            code, output, error = self.invoke(["doctor", "--json"], root)
            self.assertIn(code, (0, 1), error)
            result = json.loads(output)
            self.assertEqual(result["resultSchemaVersion"], 1)
            self.assertEqual(result["command"], "doctor")
            self.assertEqual(result["mode"], "general")
            self.assertIn("git", result["tools"])
            self.assertEqual(before, sorted(p.relative_to(root).as_posix() for p in root.rglob("*")))

    def test_support_module_import_has_no_filesystem_or_environment_side_effects(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join((str(Path(__file__).resolve().parents[1] / "src"),
                                                   str(Path(__file__).resolve().parents[1])))
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["LOCALAPPDATA" if os.name == "nt" else "XDG_STATE_HOME"] = str(root / "sentinel-state")
            before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            script = "import os,runpy; before=dict(os.environ); runpy.run_module('tests._support'); assert os.environ == before"
            result = subprocess.run([sys.executable, "-B", "-c", script], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before, sorted(path.relative_to(root).as_posix() for path in root.rglob("*")))

    def test_unknown_duplicate_and_conflicting_flags_are_rejected(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            self.assertEqual(self.invoke(["list", "--mystery"], root)[0], 1)
            self.assertEqual(self.invoke(["list", "--json", "--json"], root)[0], 1)
            self.assertEqual(self.invoke(["show", "one", "two"], root)[0], 1)

    def test_list_and_show_json_are_read_only(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
            code, out, _ = self.invoke(["list", "--json"], root)
            self.assertEqual(code, 0)
            self.assertEqual(out.strip(), '{"resultSchemaVersion":2,"toolVersion":"' + __version__ + '","command":"list","inventory":{"state":"missing","snapshotCount":0,"diagnosticCount":0,"unrecognizedEntryCount":0},"snapshots":[],"diagnostics":[],"legacy":{"privateDatabasePathCount":0,"diagnosticCount":0}}')
            self.assertEqual(before, sorted(p.relative_to(root).as_posix() for p in root.rglob("*")))
            build_v2(root)
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            code, out, _ = self.invoke(["show", "before", "--json"], root)
            self.assertEqual(code, 0)
            self.assertIn('"state":"verified"', out)
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_managed_snapshot_is_listed_shown_and_previewed_without_writes(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            name = "auto-20261104-010203"
            build_v2(root, name=name, kind="auto")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                            for p in root.rglob("*"))
            list_code, list_out, list_err = self.invoke(["list", "--json"], root)
            self.assertEqual(list_code, 0, list_err)
            self.assertEqual(json.loads(list_out)["snapshots"][0]["name"], name)
            show_code, show_out, show_err = self.invoke(["show", name, "--json"], root)
            self.assertEqual(show_code, 0, show_err)
            self.assertEqual(json.loads(show_out)["snapshot"]["state"], "verified")
            restore_code, restore_out, restore_err = self.invoke(["restore", name, "--only", "config", "--json"], root)
            self.assertEqual(restore_code, 0, restore_err)
            self.assertEqual(json.loads(restore_out)["snapshot"], name)
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                           for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_unimplemented_mutations_fail_closed_without_writes(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            commands = (["prune", "--dry-run"], ["hook", "status"])
            for args in commands:
                with self.subTest(command=args[0]):
                    before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
                    code, _, err = self.invoke(list(args), root)
                    self.assertEqual(code, 2)
                    self.assertIn("not enabled", err)
                    after = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
                    self.assertEqual(before, after)

    def test_restore_config_preview_is_read_only_and_redacted(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            secret_a = b"TOKEN=fictional-alpha\r\nPORT=12716\r\n"
            (root / ".env").write_bytes(secret_a)
            build_v2(root, config=b"TOKEN=fictional-beta\r\nPORT=12717\r\n")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                            for p in root.rglob("*"))
            code, out, err = self.invoke(["restore", "before", "--only", "config", "--json"], root)
            self.assertEqual(code, 0, err)
            result = json.loads(out)
            self.assertEqual(result["mode"], "preview-only")
            self.assertEqual(result["selectedLayers"], ["config"])
            self.assertEqual([(x["target"], x["action"]) for x in result["targets"]], [(".env", "replace")])
            self.assertEqual(result["businessWrites"], 0)
            self.assertFalse(result["safetyPointCreated"])
            self.assertNotIn("fictional", out)
            self.assertNotIn(hashlib.sha256(secret_a).hexdigest(), out)
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                           for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_restore_apply_requires_confirmation_and_supports_verified_rollback(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional\n")
            build_v2(root)
            self.assertEqual(self.invoke(["restore", "before"], root)[0], 2)
            self.assertEqual(self.invoke(["restore", "before", "--only", "database"], root)[0], 1)
            self.assertEqual(self.invoke(["restore", "before", "--only", "config", "--only", "config"], root)[0], 1)
            self.assertEqual(self.invoke(["restore", "before", "--only", "config", "--unknown"], root)[0], 1)
            (root / ".env").write_bytes(b"KEY=beta\n")
            code, _, err = self.invoke(["restore", "before", "--only", "config"], root)
            self.assertEqual(code, 0, err)
            self.assertEqual((root / ".env").read_bytes(), b"KEY=beta\n")
            code, out, err = self.invoke(["restore", "before", "--only", "config", "--yes"], root)
            self.assertEqual(code, 0, err)
            self.assertEqual((root / ".env").read_bytes(), b"KEY=alpha\n")
            operation = out.split("Operation: ", 1)[1].split(";", 1)[0]
            code, out, err = self.invoke(["recover", operation, "--rollback", "--yes"], root)
            self.assertEqual(code, 0, err)
            self.assertEqual((root / ".env").read_bytes(), b"KEY=beta\n")
            self.assertIn('"verified":true', out)

    @unittest.skipUnless(os.name == "nt", "Windows MAX_PATH boundary is platform-specific")
    def test_restore_refuses_before_safety_publication_when_derived_path_exceeds_budget(self):
        with temporary_directory() as tmp:
            root = Path(tmp).absolute()
            original_home = os.environ["LOCALAPPDATA"]
            state_home = Path(original_home) / "long-state-home-12345678"
            state_home.mkdir()
            os.environ["LOCALAPPDATA"] = str(state_home)
            self.addCleanup(lambda: os.environ.__setitem__("LOCALAPPDATA", original_home))
            placeholder = "0" * 32
            safety_path = state_dir(root) / "secrets" / ("safety-" + placeholder) / "generations" / placeholder / "files" / ".env"
            source_path = state_dir(root) / "secrets" / "before" / "generations" / placeholder / "files" / ".env"
            safety_path = state_dir(root) / "secrets" / ("safety-" + placeholder) / "generations" / placeholder / "files" / ".env"
            self.assertLess(len(str(source_path)), 260)
            self.assertGreaterEqual(len(str(safety_path)), 260)

            (root / ".env").write_bytes(b"TOKEN=fictional-A\r\n")
            code, _, err = self.invoke(["snapshot", "before"], root)
            self.assertEqual(code, 0, err)
            (root / ".env").write_bytes(b"TOKEN=fictional-B\r\n")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                            for p in root.rglob("*"))
            state_root = state_dir(root)
            state_before = sorted((p.relative_to(state_root).as_posix(), p.read_bytes() if p.is_file() else None)
                                  for p in state_root.rglob('*'))
            self.assertFalse((state_root / 'operations').exists())
            code, _, err = self.invoke(["restore", "before", "--only", "config", "--yes"], root)
            self.assertEqual(code, 2)
            self.assertIn("EWINDOWS_PATH_LIMIT", err)
            self.assertEqual((root / ".env").read_bytes(), b"TOKEN=fictional-B\r\n")
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                           for p in root.rglob("*"))
            self.assertEqual(before, after)
            state_after = sorted((p.relative_to(state_root).as_posix(), p.read_bytes() if p.is_file() else None)
                                 for p in state_root.rglob('*'))
            self.assertEqual(state_before, state_after)
            self.assertFalse((state_root / 'operations').exists())
            self.assertFalse(any("safety-" in relative for relative, _ in after))

    @unittest.skipUnless(os.name == "nt", "Windows MAX_PATH boundary is platform-specific")
    def test_snapshot_refuses_before_storage_creation_when_derived_path_exceeds_budget(self):
        with temporary_directory() as tmp:
            root = Path(tmp).absolute()
            original_home = os.environ["LOCALAPPDATA"]
            state_home = Path(original_home) / ("long-state-home-" + "x" * 40)
            state_home.mkdir()
            os.environ["LOCALAPPDATA"] = str(state_home)
            self.addCleanup(lambda: os.environ.__setitem__("LOCALAPPDATA", original_home))
            placeholder = "0" * 32
            derived = state_dir(root) / "secrets" / "longname" / "generations" / placeholder / "files" / ".env"
            derived = state_dir(root) / "secrets" / "longname" / "generations" / placeholder / "files" / ".env"
            self.assertGreaterEqual(len(str(derived)), 260)
            (root / ".env").write_bytes(b"TOKEN=fictional\r\n")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                            for p in root.rglob("*"))
            code, _, err = self.invoke(["snapshot", "longname"], root)
            self.assertEqual(code, 2)
            self.assertIn("EWINDOWS_PATH_LIMIT", err)
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None)
                           for p in root.rglob("*"))
            self.assertEqual(before, after)
            self.assertFalse((state_dir(root)).exists())

    def test_restore_preview_refuses_dirty_git_without_changing_index_or_refs(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            env_file = root / ".env"
            env_file.write_bytes(b"TOKEN=fictional-alpha\n")
            build_v2(root, config=b"TOKEN=fictional-beta\n")
            init = subprocess.run(["git", "init", "--quiet"], cwd=root, capture_output=True, check=False)
            if init.returncode != 0:
                self.skipTest("Git init is unavailable in this test environment")
            subprocess.run(["git", "add", "--", ".env"], cwd=root, capture_output=True, check=True)
            subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                            "commit", "--quiet", "-m", "baseline"], cwd=root, capture_output=True, check=True)
            env_file.write_bytes(b"TOKEN=external-dirty-state\n")
            index_before = (root / ".git" / "index").read_bytes()
            refs_before = subprocess.run(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"],
                                         cwd=root, capture_output=True, check=True).stdout
            code, _, err = self.invoke(["restore", "before", "--only", "config", "--json"], root)
            self.assertEqual(code, 2)
            self.assertIn("EGIT_DIRTY", err)
            self.assertEqual(env_file.read_bytes(), b"TOKEN=external-dirty-state\n")
            self.assertEqual((root / ".git" / "index").read_bytes(), index_before)
            refs_after = subprocess.run(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"],
                                        cwd=root, capture_output=True, check=True).stdout
            self.assertEqual(refs_after, refs_before)

    def test_snapshot_publishes_private_partial_v2_generation_and_refuses_overwrite(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional-secret\r\nPORT=12716\r\n")
            (root / "package.json").write_text('{"name":"fixture","version":"1.0.0"}\n', encoding="utf-8")
            code, out, err = self.invoke(["snapshot", "trial"], root)
            self.assertEqual(code, 0, err)
            self.assertIn("PARTIAL", out)
            self.assertNotIn("fictional-secret", out)
            from project_state.storage import validate_pair
            pair = validate_pair(root, "trial")
            self.assertEqual(pair["manifest"]["schemaVersion"], 2)
            self.assertEqual(pair["manifest"]["state"], "complete")
            self.assertEqual(pair["layers"]["config"]["envFiles"][".env"]["keyCount"], 2)
            public_bytes = b"".join(path.read_bytes() for path in (state_dir(root) / "snapshots").rglob("*") if path.is_file())
            lock_bytes = b"".join(path.read_bytes() for path in (state_dir(root) / "locks").rglob("*") if path.is_file())
            self.assertNotIn(b"fictional-secret", public_bytes + lock_bytes)
            self.assertNotIn(str(root).encode(), lock_bytes)
            self.assertEqual(Path(next(item["absolutePath"] for item in pair["artifacts"] if item["privacy"] == "private" and item.get("target") == ".env")).read_bytes(),
                             b"TOKEN=fictional-secret\r\nPORT=12716\r\n")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            code, _, err = self.invoke(["snapshot", "trial"], root)
            self.assertEqual(code, 1)
            self.assertIn("EEXISTS", err)
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_snapshot_seed_request_without_database_fails_before_creating_state(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            code, _, err = self.invoke(["snapshot", "trial", "--with-seed"], root)
            self.assertEqual(code, 2)
            self.assertIn("EDATABASE_NOT_FOUND", err)
            self.assertFalse((state_dir(root)).exists())

    def test_demo_runs_real_synthetic_config_restore_outside_caller_directory(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            # Use a parent owned by this fixture. The demo subprocess receives
            # its own isolated state home and does not mutate caller env vars.
            demo_parent = _test_base()
            with mock.patch.dict(os.environ, {"PROJECT_STATE_DEMO_PARENT": str(demo_parent)}):
                code, output, error = self.invoke(["demo"], root)
            self.assertEqual(code, 0, error)
            result = json.loads(output)
            self.assertEqual(result["state"], "passed")
            self.assertEqual(result["fixture"], "synthetic-config-only")
            self.assertEqual(result["gitState"], "not-exercised")
            self.assertEqual(sorted(path.relative_to(root).as_posix() for path in root.rglob("*")), before)
            self.assertNotIn(str(root), output)
            code, _, error = self.invoke(["demo", "unexpected"], root)
            self.assertEqual(code, 1)
            self.assertIn("EARG_SYNTAX", error)

    def test_python_and_legacy_node_use_separate_state_roots(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node executable is unavailable; Python runtime does not require Node")
        configured_reference = os.environ.get("PROJECT_STATE_LEGACY_REFERENCE_CLI")
        legacy_cli = (Path(configured_reference).absolute() if configured_reference else
                      Path(__file__).resolve().parents[2] / "legacy-reference" / "bin" / "project-state.js")
        if not legacy_cli.is_file():
            self.skipTest("legacy reference CLI is not present in this migration workspace")
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional\r\nPORT=12716\r\n")
            self.assertEqual(self.invoke(["snapshot", "frompython"], root)[0], 0)
            proc = run_trusted("node", [str(legacy_cli), "show", "frompython", "--json"],
                               cwd=root, timeout=30, max_output=65536)
            self.assertTrue(proc["started"])
            self.assertEqual(proc["exitCode"], 1)
            result = json.loads(proc["stdout"])
            self.assertEqual(result["snapshot"]["state"], "missing")
            self.assertEqual(result["snapshot"]["reasonCode"], "SNAPSHOT_NOT_FOUND")
            self.assertFalse((root / '.project-state').exists())
            self.assertEqual(json.loads(self.invoke(['show', 'frompython', '--json'], root)[1])['snapshot']['state'], 'verified')
            (root / ".env").write_bytes(b"TOKEN=fictional\r\nPORT=12717\r\n")
            code, out, _ = self.invoke(["compare", "frompython"], root)
            self.assertEqual(code, 0)
            self.assertIn("changed", out.lower())
            self.assertNotIn("fictional", out)

            (root / ".env").write_bytes(b"TOKEN=fictional-node\r\nPORT=12716\r\n")
            old_created = run_trusted("node", [str(legacy_cli), "snapshot", "fromnode"],
                                      cwd=root, timeout=30, max_output=65536)
            self.assertTrue(old_created["ok"], old_created["stderr"])
            code, out, err = self.invoke(["show", "fromnode", "--json"], root)
            self.assertNotEqual(code, 0, err)
            self.assertEqual(json.loads(out)["snapshot"]["state"], "missing")
            verified_node = run_trusted("node", [str(legacy_cli), "show", "fromnode", "--json"], cwd=root, timeout=30, max_output=65536)
            self.assertTrue(verified_node["ok"], verified_node["stderr"])
            self.assertEqual(json.loads(verified_node['stdout'])['snapshot']['state'], 'verified')

    def test_explicit_seed_publishes_private_consistent_wal_backup(self):
        import sqlite3
        with temporary_directory() as tmp:
            root = Path(tmp)
            db_path = root / "app.sqlite"
            writer = sqlite3.connect(db_path, isolation_level=None)
            try:
                self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, text_value TEXT, nullable TEXT, blob_value BLOB)")
                writer.execute("INSERT INTO sample(text_value, nullable, blob_value) VALUES (?, ?, ?)",
                               ("fictional-你好", None, sqlite3.Binary(bytes([0, 255]))) )
                writer.execute("BEGIN IMMEDIATE")
                writer.execute("INSERT INTO sample(text_value, nullable, blob_value) VALUES (?, ?, ?)",
                               ("uncommitted-marker", None, sqlite3.Binary(b"not committed")))
                wal = Path(str(db_path) + "-wal")
                self.assertTrue(wal.exists())
                self.assertGreater(wal.stat().st_size, 32)
                code, out, err = self.invoke(["snapshot", "seeded", "--with-seed"], root)
                self.assertEqual(code, 0, err)
                self.assertIn("database", out)
                from project_state.storage import validate_pair
                pair = validate_pair(root, "seeded")
                self.assertTrue(pair["layers"]["database"]["withSeed"])
                self.assertEqual(pair["layers"]["database"]["databases"][0]["totalRows"], 1)
                db_artifact = next(item for item in pair["artifacts"] if item["kind"] == "sqlite-backup")
                backup_path = Path(db_artifact["absolutePath"])
                self.assertTrue(backup_path.is_relative_to(state_dir(root) / "secrets"))
                self.assertEqual(backup_path.stat().st_size, db_artifact["size"])
                check = sqlite3.connect(f"file:{backup_path.as_posix()}?mode=ro", uri=True)
                try:
                    self.assertEqual(check.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                    self.assertEqual(check.execute("SELECT text_value, nullable, hex(blob_value) FROM sample").fetchone(),
                                     ("fictional-你好", None, "00FF"))
                    self.assertEqual(check.execute("SELECT count(*) FROM sample WHERE text_value='uncommitted-marker'").fetchone()[0], 0)
                finally:
                    check.close()
                public_bytes = b"".join(path.read_bytes() for path in (state_dir(root) / "snapshots").rglob("*") if path.is_file())
                self.assertNotIn("fictional-你好".encode(), public_bytes)
                self.assertNotIn(b"uncommitted-marker", public_bytes)
                node = shutil.which("node")
                legacy_cli = Path(__file__).resolve().parents[2] / "legacy-reference" / "bin" / "project-state.js"
                if node and legacy_cli.is_file():
                    proc = run_trusted("node", [str(legacy_cli), "show", "seeded", "--json"],
                                       cwd=root, timeout=30, max_output=65536)
                    self.assertTrue(proc["ok"], proc["stderr"])
                    legacy_result = json.loads(proc["stdout"])
                    self.assertEqual(legacy_result["snapshot"]["state"], "verified")
            finally:
                if writer.in_transaction:
                    writer.rollback()
                writer.close()

    def test_existing_database_is_not_captured_without_explicit_seed(self):
        import sqlite3
        with temporary_directory() as tmp:
            root = Path(tmp)
            db = sqlite3.connect(root / "app.db")
            try:
                db.execute("CREATE TABLE sample (id INTEGER)")
                db.commit()
            finally:
                db.close()
            code, _, err = self.invoke(["snapshot", "metadata-only"], root)
            self.assertEqual(code, 0, err)
            from project_state.storage import validate_pair
            pair = validate_pair(root, "metadata-only")
            self.assertEqual(pair["manifest"]["layers"]["database"]["status"], "skipped")
            self.assertFalse(any(item["layer"] == "database" for item in pair["artifacts"]))

    def test_seed_failure_never_publishes_current_pointer(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / "broken.sqlite").write_bytes(b"not sqlite")
            code, _, err = self.invoke(["snapshot", "broken", "--with-seed"], root)
            self.assertEqual(code, 2)
            self.assertIn("EDATABASE_BACKUP", err)
            self.assertFalse((state_dir(root) / "snapshots" / "broken" / "current.json").exists())

    def test_snapshot_pointer_publish_failure_preserves_unverified_private_generation(self):
        from unittest import mock
        import project_state.snapshot as snapshot_module
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional\n")
            real_rename = os.rename
            def fail_pointer(source, destination, *args, **kwargs):
                if Path(destination).name == "current.json":
                    raise PermissionError("synthetic pointer publish failure")
                return real_rename(source, destination, *args, **kwargs)
            with mock.patch.object(snapshot_module.os, "rename", side_effect=fail_pointer):
                code, _, err = self.invoke(["snapshot", "interrupted"], root)
            self.assertEqual(code, 2)
            self.assertIn("EPUBLISH", err)
            self.assertFalse((state_dir(root) / "snapshots" / "interrupted" / "current.json").exists())
            private_generations = state_dir(root) / "secrets" / "interrupted" / "generations"
            self.assertTrue(private_generations.is_dir())
            files = [path for path in private_generations.rglob(".env") if path.parent.name == "files"]
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].read_bytes(), b"TOKEN=fictional\n")
            code, _, err = self.invoke(["snapshot", "interrupted"], root)
            self.assertEqual(code, 1)
            self.assertIn("EEXISTS", err)

    def test_list_enotdir_is_nonzero_and_does_not_repair(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            state = ensure_state_dir(root)
            (state / "snapshots").write_text("blocker")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            code, out, _ = self.invoke(["list", "--json"], root)
            self.assertEqual(code, 2)
            self.assertIn('"state":"unreadable"', out)
            after = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_task_doctor_distinguishes_supported_snapshot_from_privacy_unknown(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("TOKEN=fictional\n")
            before = sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*"))
            code, out, _ = self.invoke(["doctor", "--task", "config-snapshot", "--json"], root)
            self.assertEqual(code, 2)
            self.assertIn('"resultSchemaVersion":1', out)
            self.assertIn('"state":"unknown"', out)
            self.assertNotIn("fictional", out)
            self.assertNotIn('"command":"snapshot"', out)
            self.assertIn('"reasonCode":"CONFIG_SNAPSHOT_SUPPORTED"', out)
            self.assertIn('"reasonCode":"PRIVATE_STORAGE_NOT_VERIFIED"', out)
            self.assertEqual(before, sorted((p.relative_to(root).as_posix(), p.read_bytes() if p.is_file() else None) for p in root.rglob("*")))

    def test_task_doctor_reports_no_config_as_not_applicable_blocker(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            code, out, _ = self.invoke(["doctor", "--task", "config-snapshot", "--json"], root)
            self.assertEqual(code, 1)
            result = json.loads(out)
            self.assertEqual(result["summary"]["state"], "blocked")
            implementation = next(item for item in result["checks"] if item["id"] == "python.snapshot-implementation")
            self.assertEqual(implementation["reasonCode"], "CONFIG_SNAPSHOT_UNAVAILABLE")
            self.assertEqual(implementation["state"], "issue")

    def test_general_doctor_is_supported_and_read_only(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
            code, out, err = self.invoke(["doctor"], root)
            self.assertIn(code, {0, 1}, err)
            self.assertIn("read-only tool check", out)
            self.assertIn("NOT_A_GIT_REPOSITORY", out)
            after = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_general_doctor_reads_real_git_cleanliness_without_index_writes(self):
        if shutil.which("git") is None:
            self.skipTest("Git is unavailable")
        with temporary_directory() as tmp:
            root = Path(tmp)
            env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, check=True)
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Synthetic Test")
            git("config", "user.email", "synthetic@example.invalid")
            target = root / "tracked.txt"
            target.write_bytes(b"base\n")
            git("add", "tracked.txt")
            git("commit", "-qm", "base")
            index = root / ".git" / "index"
            before_index = index.read_bytes()
            clean, output, _ = self.invoke(["doctor"], root)
            self.assertEqual(clean, 0)
            self.assertIn("GIT_WORKTREE_CLEAN", output)
            self.assertEqual(index.read_bytes(), before_index)
            target.write_bytes(b"dirty\n")
            dirty, output, _ = self.invoke(["doctor"], root)
            self.assertEqual(dirty, 1)
            self.assertIn("GIT_WORKTREE_DIRTY", output)
            self.assertNotIn("tracked.txt", output)
            self.assertEqual(index.read_bytes(), before_index)

    def test_general_doctor_reports_config_keys_dependency_drift_and_legacy_path_without_values(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root)
            (root / ".env").write_bytes(b"NEW_KEY=synthetic-secret-value\n")
            (root / "package.json").write_text(json.dumps({"dependencies": {"demo-package": "^1.0.0"}}), encoding="utf-8")
            lock = {"name": "synthetic", "lockfileVersion": 3, "packages": {
                "": {"dependencies": {"demo-package": "^1.0.0"}},
                "node_modules/demo-package": {"version": "1.0.0"},
            }}
            (root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
            installed = root / "node_modules" / "demo-package"
            installed.mkdir(parents=True)
            (installed / "package.json").write_text(json.dumps({"version": "2.0.0"}), encoding="utf-8")
            legacy = state_dir(root) / "snapshots" / "legacy-copy" / "files" / "db-original"
            legacy.mkdir(parents=True)
            (legacy / "database.sqlite").write_bytes(b"synthetic-database-bytes")

            before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            code, output, err = self.invoke(["doctor"], root)
            self.assertIn(code, {0, 1}, err)
            self.assertIn("CONFIG_KEYS_CHANGED", output)
            self.assertIn("DEPENDENCY_DRIFT", output)
            self.assertIn("LEGACY_DATABASE_COPY_PRESENT", output)
            self.assertNotIn("synthetic-secret-value", output)
            self.assertNotIn("synthetic-database-bytes", output)
            after = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            self.assertEqual(before, after)

    def test_general_doctor_uses_valid_config_baseline_and_never_installs_dependencies(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root)
            (root / ".env").write_bytes(b"KEY=different-value\n")
            package = {"dependencies": {"demo-package": "^1.0.0"}}
            lock = {"lockfileVersion": 3, "packages": {"": {"dependencies": {"demo-package": "^1.0.0"}},
                                                            "node_modules/demo-package": {"version": "1.0.0"}}}
            (root / "package.json").write_text(json.dumps(package), encoding="utf-8")
            (root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
            installed = root / "node_modules" / "demo-package"
            installed.mkdir(parents=True)
            (installed / "package.json").write_text(json.dumps({"version": "1.0.0"}), encoding="utf-8")
            code, output, err = self.invoke(["doctor"], root)
            self.assertIn(code, {0, 1}, err)
            self.assertIn("CONFIG_KEYS_MATCH", output)
            self.assertIn("DEPENDENCIES_MATCH_LOCKFILE", output)
            self.assertNotIn("different-value", output)
            self.assertFalse((root / "node_modules" / ".package-lock.json").exists())

    def test_general_doctor_bounds_installed_package_metadata_reads(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(json.dumps({"dependencies": {"demo-package": "^1.0.0"}}), encoding="utf-8")
            lock = {"lockfileVersion": 3, "packages": {"": {"dependencies": {"demo-package": "^1.0.0"}},
                                                            "node_modules/demo-package": {"version": "1.0.0"}}}
            (root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
            installed = root / "node_modules" / "demo-package"
            installed.mkdir(parents=True)
            (installed / "package.json").write_bytes(b" " * 1_048_577)
            code, output, err = self.invoke(["doctor"], root)
            self.assertIn(code, {0, 1}, err)
            self.assertIn("INSTALLED_DEPENDENCY_UNREADABLE", output)
            self.assertNotIn("DEPENDENCIES_MATCH_LOCKFILE", output)

    def test_general_doctor_rejects_traversal_dependency_name_before_path_join(self):
        with temporary_directory() as tmp:
            sandbox = Path(tmp)
            root = sandbox / "project"
            root.mkdir()
            (root / "package.json").write_text(json.dumps({"dependencies": {"..": "1.0.0"}}), encoding="utf-8")
            lock = {"lockfileVersion": 3, "packages": {"": {"dependencies": {"..": "1.0.0"}},
                                                            "node_modules/..": {"version": "1.0.0"}}}
            (root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
            (root / "package.json").write_text(json.dumps({"version": "1.0.0", "dependencies": {"..": "1.0.0"}}), encoding="utf-8")
            outside = root.parent / "package.json"
            outside.write_text("synthetic-outside-sentinel", encoding="utf-8")
            before = outside.read_bytes()
            code, output, err = self.invoke(["doctor"], root)
            self.assertIn(code, {0, 1}, err)
            self.assertIn("DEPENDENCY_METADATA_UNSUPPORTED", output)
            self.assertEqual(outside.read_bytes(), before)

    def test_general_doctor_json_is_versioned_and_read_only(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
            code, output, err = self.invoke(["doctor", "--json"], root)
            self.assertIn(code, {0, 1}, err)
            result = json.loads(output)
            self.assertEqual(result["resultSchemaVersion"], 1)
            self.assertEqual(result["command"], "doctor")
            self.assertEqual(result["mode"], "general")
            after = sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))
            self.assertEqual(before, after)

    def test_restore_task_reports_one_target_preview_ready_but_not_write_authorized(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root)
            code, output, _ = self.invoke(["doctor", "--task", "config-restore", "--snapshot", "before", "--json"], root)
            self.assertEqual(code, 0)
            result = json.loads(output)
            self.assertEqual(result["summary"]["state"], "ready")
            self.assertIn('"reasonCode":"CONFIG_RESTORE_PREVIEW_READY"', output)
            self.assertIn('"reasonCode":"PRIVATE_STORAGE_ACCESS_CONTROLS_NOT_CHECKED"', output)
            self.assertIn("apply still requires explicit confirmation", output)
            self.assertEqual(self.invoke(["doctor", "--task", "config-restore"], root)[0], 1)
            self.assertEqual(self.invoke(["doctor", "--snapshot", "before"], root)[0], 1)

    def test_restore_task_refuses_dirty_git_before_claiming_preview_ready(self):
        if shutil.which("git") is None:
            self.skipTest("Git is unavailable")
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root)
            env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, check=True)
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Synthetic Test")
            git("config", "user.email", "synthetic@example.invalid")
            (root / "tracked.txt").write_text("base\n")
            git("add", "tracked.txt")
            git("commit", "-qm", "base")
            (root / "tracked.txt").write_text("dirty\n")
            code, output, _ = self.invoke(["doctor", "--task", "config-restore", "--snapshot", "before", "--json"], root)
            self.assertEqual(code, 1)
            result = json.loads(output)
            self.assertEqual(result["summary"]["state"], "blocked")
            self.assertIn('"reasonCode":"EGIT_DIRTY"', output)
            self.assertNotIn('"state":"ready"', output)

    def test_restore_task_accepts_allowlisted_two_file_config_batch_preview(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root, config_extra=b"EXTRA=bravo\n")
            code, output, _ = self.invoke(["doctor", "--task", "config-restore", "--snapshot", "before", "--json"], root)
            self.assertEqual(code, 0)
            result = json.loads(output)
            self.assertEqual(result["summary"]["state"], "ready")
            self.assertIn('"reasonCode":"CONFIG_RESTORE_PREVIEW_READY"', output)
            self.assertIn("per-file", output)
            self.assertFalse((state_dir(root) / "operations").exists())


if __name__ == "__main__":
    unittest.main()
