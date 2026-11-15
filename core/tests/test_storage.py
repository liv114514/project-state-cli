from __future__ import annotations

import json
import contextlib
import io
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from project_state.errors import ProjectStateError
from project_state.inventory import inspect_one
from project_state.storage import inspect_snapshot, validate_pair
from tests.snapshot_fixture import build_v2
from tests._support import temporary_directory, state_dir, ensure_state_dir


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)
        self.generation = build_v2(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_v2_pair_verifies_public_and_private_bytes(self):
        checked = validate_pair(self.root, "before")
        self.assertEqual(checked["generation"], self.generation)
        self.assertEqual([a["privacy"] for a in checked["artifacts"]], ["public", "private"])

    def test_managed_auto_and_hook_names_are_readable_but_not_user_creation_names(self):
        from project_state.paths import validate_name, validate_snapshot_name
        for kind, name in (("auto", "auto-20261104-010203-2"), ("hook", "hook-20261104-010203")):
            with self.subTest(kind=kind):
                other = Path(self.temp.name) / kind
                other.mkdir()
                generation = build_v2(other, name=name, kind=kind)
                self.assertEqual(validate_snapshot_name(name), name)
                with self.assertRaises(ProjectStateError):
                    validate_name(name)
                checked = validate_pair(other, name)
                self.assertEqual(checked["generation"], generation)
                self.assertEqual(inspect_one(other, name)["state"], "verified")

    def test_malformed_reserved_snapshot_names_remain_rejected(self):
        from project_state.paths import validate_snapshot_name
        for name in ("auto-manual", "hook-20261104-010203-extra", "auto-20261104-010203-x"):
            with self.subTest(name=name), self.assertRaises(ProjectStateError):
                validate_snapshot_name(name)

    def test_managed_prefix_with_named_kind_is_rejected(self):
        other = Path(self.temp.name) / "kind-mismatch"
        other.mkdir()
        name = "auto-20261104-010203"
        build_v2(other, name=name, kind="named")
        with self.assertRaises(ProjectStateError):
            validate_pair(other, name)

    def test_damaged_private_bytes_are_rejected(self):
        target = state_dir(self.root) / "secrets/before/generations" / self.generation / "files/.env"
        target.write_bytes(b"KEY=outside\n")
        with self.assertRaisesRegex(ProjectStateError, "artifact"):
            validate_pair(self.root, "before")

    def test_private_artifact_identifier_is_not_disclosed_on_digest_failure(self):
        from project_state.cli import main
        private = state_dir(self.root) / "secrets/before/generations" / self.generation
        manifest = private / "manifest.json"
        metadata = json.loads(manifest.read_text(encoding="utf-8"))
        metadata["artifacts"][0]["id"] = "fictional-private-canary"
        manifest.write_text(json.dumps(metadata), encoding="utf-8")
        target = private / "files/.env"
        target.write_bytes(b"KEY=bravo\n")  # Same size, different bytes.
        before = (manifest.read_bytes(), target.read_bytes())
        output, errors = io.StringIO(), io.StringIO()
        old_cwd = Path.cwd()
        try:
            os.chdir(self.root)
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                code = main(["restore", "before", "--only", "config"])
        finally:
            os.chdir(old_cwd)
        self.assertEqual(code, 1)
        self.assertIn("EARTIFACT_INTEGRITY", errors.getvalue())
        self.assertNotIn("fictional-private-canary", output.getvalue() + errors.getvalue())
        self.assertEqual((manifest.read_bytes(), target.read_bytes()), before)
        self.assertFalse((state_dir(self.root) / "operations").exists())

    def test_unlisted_files_are_rejected(self):
        base = state_dir(self.root) / "snapshots/before/generations" / self.generation
        (base / "extra.txt").write_text("extra")
        with self.assertRaises(ProjectStateError) as caught:
            validate_pair(self.root, "before")
        self.assertEqual(caught.exception.code, "EARTIFACT_UNDECLARED")

    def test_unknown_manifest_field_is_rejected(self):
        manifest = state_dir(self.root) / "snapshots/before/generations" / self.generation / "manifest.json"
        value = json.loads(manifest.read_text())
        value["futurePayload"] = "must not be silently accepted"
        manifest.write_text(json.dumps(value, indent=2) + "\n")
        with self.assertRaises(ProjectStateError):
            validate_pair(self.root, "before")

    def test_duplicate_json_fields_are_rejected(self):
        pointer = state_dir(self.root) / "snapshots/before/current.json"
        pointer.write_text('{"schemaVersion":1,"schemaVersion":1,"name":"before","generation":"' + self.generation + '","publicManifestSha256":"' + "0" * 64 + '"}')
        with self.assertRaises(ProjectStateError) as caught:
            validate_pair(self.root, "before")
        self.assertEqual(caught.exception.code, "EMANIFEST_INVALID")

    def test_boolean_schema_version_is_not_accepted_as_integer(self):
        pointer = state_dir(self.root) / "snapshots/before/current.json"
        value = json.loads(pointer.read_text())
        value["schemaVersion"] = True
        pointer.write_text(json.dumps(value))
        with self.assertRaises(ProjectStateError) as caught:
            validate_pair(self.root, "before")
        self.assertEqual(caught.exception.code, "EMANIFEST_INVALID")

    def test_show_validates_artifacts_once_and_reports_limited_python_restore_scope(self):
        from project_state.inventory import _snapshot_record
        with patch("project_state.inventory.validate_pair", wraps=validate_pair) as validator:
            row = _snapshot_record(self.root, "before")
        self.assertEqual(validator.call_count, 1)
        self.assertEqual(row["state"], "verified")
        self.assertEqual(row["nextStep"]["action"], "preserve-and-review")
        self.assertIsNone(row["nextStep"]["command"])
        self.assertIn("Supported config restore is limited to one file or the allowlisted .env/.env.local pair", " ".join(row["limitations"]))

    def test_v1_is_diagnostic_only(self):
        snapshot = state_dir(self.root) / "snapshots" / "old-v1"
        snapshot.mkdir(parents=True)
        (snapshot / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "name": "old-v1", "kind": "named",
            "createdAt": "2025-01-01T00:00:00.000Z", "artifacts": [{"path": "ignored"}]
        }))
        from project_state.inventory import inspect_one
        row = inspect_one(self.root, "old-v1")
        self.assertEqual(row["state"], "diagnostic-only")
        self.assertEqual(row["integrity"]["state"], "not-checked")
        self.assertIsNone(row["nextStep"]["command"])

    def test_artifact_path_traversal_is_rejected(self):
        manifest = state_dir(self.root) / "secrets/before/generations" / self.generation / "manifest.json"
        value = json.loads(manifest.read_text())
        value["artifacts"][0]["path"] = "../../../../.env"
        manifest.write_text(json.dumps(value, indent=2) + "\n")
        with self.assertRaises(ProjectStateError):
            validate_pair(self.root, "before")

    def test_diagnostic_reports_corrupt_generation_invalid(self):
        (state_dir(self.root) / "secrets/before/generations" / self.generation / "files/.env").write_bytes(b"bad")
        result = inspect_snapshot(self.root, "before")
        self.assertEqual(result["state"], "invalid")

    def test_rc15_node_test_fixture_cross_reads_as_v2(self):
        import shutil
        fixture_root = Path(__file__).parent / "fixtures" / "node-v2"
        with temporary_directory() as tmp:
            project = Path(tmp)
            destination = ensure_state_dir(project)
            # Explicit, test-only cross-root import of the checked-in synthetic
            # fixture. Runtime code never searches or adopts the Node state root.
            shutil.copytree(fixture_root / ".project-state" / "snapshots",
                            destination / "snapshots")
            shutil.copytree(fixture_root / ".project-state" / "secrets",
                            destination / "secrets")
            row = inspect_one(project, "legacy-generated")
            self.assertEqual(row["state"], "verified")
            self.assertEqual(row["schemaVersion"], 2)
            self.assertNotIn("fictional-value", repr(row))

    def test_inventory_file_instead_of_directory_is_not_called_empty(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            blocker = ensure_state_dir(root) / "snapshots"
            blocker.write_text("not a directory")
            row = inspect_snapshot(root, "before")
            self.assertEqual(row["state"], "unreadable")
            self.assertNotEqual(row["reasonCode"], "SNAPSHOT_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
