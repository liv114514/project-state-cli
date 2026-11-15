from __future__ import annotations

import unittest
from pathlib import Path
import hashlib
import sqlite3

from project_state.compare import compare
from project_state.errors import ProjectStateError
from project_state.snapshot import create_snapshot
from tests._support import temporary_directory
from tests.snapshot_fixture import build_v2


class CompareTests(unittest.TestCase):
    def _database_fixture(self, root: Path, name: str, *, schema: str = "create table marker(value text)",
                          tables: list[str] | None = None, rows: int = 1) -> None:
        db_path = root / f"{name}-synthetic.sqlite"
        connection = sqlite3.connect(db_path)
        try:
            connection.execute(schema)
            for index in range(rows):
                connection.execute("insert into marker(value) values (?)", (f"synthetic-{index}",))
            connection.commit()
        finally:
            connection.close()
        database = {"databases": [{"file": "synthetic.sqlite", "mode": "backup",
                    "restore": "sqlite-create-missing", "artifactId": "database-backup:synthetic.sqlite",
                    "schemaFingerprint": hashlib.sha256((schema + "\\n").encode()).hexdigest(),
                    "tables": tables or ["marker"], "totalRows": rows, "integrity": "ok",
                    "rowContentsCompared": False}], "engine": "sqlite3 online backup API", "withSeed": True,
                    "comparison": "schema and row counts recorded; row contents not compared"}
        data = db_path.read_bytes()
        build_v2(root, name=name, extra_layers={"database": database}, extra_artifacts=[{
            "id": "database-backup:synthetic.sqlite", "layer": "database", "kind": "sqlite-backup",
            "privacy": "private", "required": True, "restore": "sqlite-create-missing",
            "path": "synthetic.sqlite", "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data), "target": "synthetic.sqlite", "content": data,
        }])

    def test_database_metadata_match_is_not_claimed_as_row_equality(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            self._database_fixture(root, "left")
            self._database_fixture(root, "right")
            _, output = compare(root, "left", "right")
            self.assertIn("recorded schema/table/row-count metadata match", output)
            self.assertIn("row contents not compared", output)

    def test_database_schema_and_recorded_row_count_changes_are_reported(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            self._database_fixture(root, "left", rows=1)
            self._database_fixture(root, "right", schema="create table marker(value text, extra integer)",
                                   tables=["marker"], rows=2)
            _, output = compare(root, "left", "right")
            self.assertIn("recorded schema changed", output)
            self.assertIn("recorded row count changed", output)
            self.assertIn("row contents not compared", output)

    def test_database_addition_removal_and_live_observation_are_explicit(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            self._database_fixture(root, "left")
            empty = {"databases": [], "engine": "sqlite3 online backup API", "withSeed": True,
                     "comparison": "schema and row counts recorded; row contents not compared"}
            build_v2(root, name="right", extra_layers={"database": empty})
            _, output = compare(root, "left", "right")
            self.assertIn("present in A only", output)
            _, live_output = compare(root, "left")
            self.assertIn("live database schema and row counts not compared", live_output)

    def test_live_config_change_is_detected_without_values_or_digest(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root, config=b"PORT=43121\nTOKEN=fictional-sentinel\n")
            (root / ".env").write_bytes(b"PORT=43122\nTOKEN=fictional-sentinel\n")
            code, output = compare(root, "before")
            self.assertEqual(code, 0)
            self.assertIn("contents changed", output)
            self.assertNotIn("fictional-sentinel", output)
            self.assertNotIn("PORT=43121", output)

    def test_snapshot_to_snapshot_compares_private_bytes(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root, name="before", config=b"PORT=43121\n")
            build_v2(root, name="after", config=b"PORT=43122\n")
            _, output = compare(root, "before", "after")
            self.assertIn("contents changed", output)

    def test_live_symlink_is_not_read(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root)
            external = root.parent / (root.name + "-outside")
            external.write_bytes(b"synthetic but external")
            try:
                (root / ".env").symlink_to(external)
            except (OSError, NotImplementedError):
                self.skipTest("host did not permit creating a synthetic symlink")
            try:
                with self.assertRaises(ProjectStateError):
                    compare(root, "before")
            finally:
                external.unlink(missing_ok=True)

    def test_snapshot_compare_detects_dependency_and_runtime_changes_without_private_values(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            untrusted_name = "sample-dep\n\x1b[31m"
            before_deps = {"packageJson": {"name": "demo", "version": "1.0.0"}, "lockFile": "package-lock.json",
                           "lockFingerprint": "a" * 12, "resolved": {untrusted_name: "1.0.0"}, "note": None}
            after_deps = {"packageJson": {"name": "demo", "version": "1.0.0"}, "lockFile": "package-lock.json",
                          "lockFingerprint": "b" * 12, "resolved": {untrusted_name: "2.0.0"}, "note": None}
            before_runtime = {"node": "v22.0.0", "npm": "10.0.0", "python": "Python 3.12.10", "versionPins": [{"name": ".nvmrc"}]}
            after_runtime = {"node": "v22.0.0", "npm": "10.0.0", "python": "Python 3.12.10", "versionPins": [{"name": ".nvmrc"}]}
            build_v2(root, name="before", extra_layers={"deps": before_deps, "runtime": before_runtime},
                     extra_private_files={"package.json": ("deps", b'{"dependencies":{"sample-dep":"^1.0.0"}}'),
                                          ".nvmrc": ("runtime", b"20\n")})
            build_v2(root, name="after", extra_layers={"deps": after_deps, "runtime": after_runtime},
                     extra_private_files={"package.json": ("deps", b'{"dependencies":{"sample-dep":"^2.0.0"}}'),
                                          ".nvmrc": ("runtime", b"22\n")})
            _, output = compare(root, "before", "after")
            self.assertIn("[deps]", output)
            self.assertIn("1 resolved package version(s) changed", output)
            self.assertIn("dependency declarations changed (values withheld)", output)
            self.assertIn("lockfile fingerprint changed", output)
            self.assertIn("runtime pin .nvmrc changed (contents withheld)", output)
            self.assertNotIn("^1.0.0", output)
            self.assertNotIn("^2.0.0", output)
            self.assertNotIn("20\\n", output)
            self.assertNotIn("22\\n", output)
            self.assertNotIn("\x1b", output)
            self.assertNotIn("sample-dep", output)

    def test_matching_dependency_declarations_are_not_reported_as_different(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            deps = {"packageJson": {"name": "demo", "version": "1.0.0"}, "lockFile": None,
                    "lockFingerprint": None, "resolved": None, "note": "No lockfile found; nothing to pin"}
            build_v2(root, name="left", extra_layers={"deps": deps},
                     extra_private_files={"package.json": ("deps", b'{"dependencies":{"sample-dep":"^1.0.0"}}')})
            build_v2(root, name="right", extra_layers={"deps": deps},
                     extra_private_files={"package.json": ("deps", b'{ "dependencies" : { "sample-dep" : "^1.0.0" } }')})
            _, output = compare(root, "left", "right")
            self.assertIn("dependency declarations match (values withheld)", output)
            self.assertNotIn("dependency declarations changed", output)

    def test_live_dependency_change_is_detected_from_validated_private_capture(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text('{"name":"demo","version":"1.0.0","dependencies":{"fictional-pkg":"^1.0.0"}}', encoding="utf-8")
            create_snapshot(root, "before")
            (root / "package.json").write_text('{"name":"demo","version":"1.0.0","dependencies":{"fictional-pkg":"^2.0.0"}}', encoding="utf-8")
            _, output = compare(root, "before")
            self.assertIn("package.json dependency declarations changed (values withheld)", output)
            self.assertNotIn("^1.0.0", output)
            self.assertNotIn("^2.0.0", output)

    def test_live_runtime_pin_change_is_detected_without_printing_pin_contents(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            runtime = {"node": "unavailable", "npm": None, "python": "Python 3.12.10",
                       "versionPins": [{"name": ".nvmrc"}]}
            build_v2(root, extra_layers={"runtime": runtime},
                     extra_private_files={".nvmrc": ("runtime", b"20\n")})
            (root / ".nvmrc").write_bytes(b"22\n")
            _, output = compare(root, "before")
            self.assertIn("runtime pin .nvmrc changed (contents withheld)", output)
            self.assertNotIn("runtime pin .nvmrc: 20", output)
            self.assertNotIn("runtime pin .nvmrc: 22", output)

    def test_package_json_and_lockfile_disagreement_is_reported_without_values(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            deps = {"packageJson": {"name": "demo", "version": "1.0.0"}, "lockFile": "package-lock.json",
                    "lockFingerprint": "a" * 12, "resolved": {}, "note": None}
            private = {
                "package.json": ("deps", b'{"dependencies":{"fictional-pkg":"^1.0.0"}}'),
                "package-lock.json": ("deps", b'{"packages":{"":{"dependencies":{"fictional-pkg":"^2.0.0"}}}}'),
            }
            build_v2(root, name="before", extra_layers={"deps": deps}, extra_private_files=private)
            build_v2(root, name="after", extra_layers={"deps": deps}, extra_private_files=private)
            _, output = compare(root, "before", "after")
            self.assertIn("declarations disagree in A", output)
            self.assertIn("declarations disagree in B", output)
            self.assertNotIn("^1.0.0", output)
            self.assertNotIn("^2.0.0", output)

    def test_absent_dependency_layer_is_unknown_not_equal(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root, name="left")
            build_v2(root, name="right")
            _, output = compare(root, "left", "right")
            self.assertIn("[deps]", output)
            self.assertIn("deps not compared", output)
            self.assertNotIn("[deps]\n  =", output)

    def test_duplicate_keys_in_private_package_json_are_unknown_not_equal(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            deps = {"packageJson": {"name": "demo", "version": "1.0.0"}, "lockFile": None,
                    "lockFingerprint": None, "resolved": None, "note": "No lockfile found; nothing to pin"}
            duplicate = b'{"dependencies":{"fictional":"1"},"dependencies":{}}'
            for name in ("left", "right"):
                build_v2(root, name=name, extra_layers={"deps": deps},
                         extra_private_files={"package.json": ("deps", duplicate)})
            _, output = compare(root, "left", "right")
            self.assertIn("package.json dependency declarations not compared", output)
            self.assertNotIn("dependency declarations match", output)


if __name__ == "__main__":
    unittest.main()
