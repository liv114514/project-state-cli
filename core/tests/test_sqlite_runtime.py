from __future__ import annotations

import sqlite3
import tempfile
import unittest
import os
from pathlib import Path
from unittest import mock

from project_state.capture.database import online_backup
from project_state.capture.snapshot import create_snapshot
from project_state.contracts.errors import ProjectStateError
from project_state.foundation.sqlite_runtime import MIN_SQLITE_VERSION, require_safe_sqlite, sqlite_runtime_status
from project_state.foundation.state_paths import state_dir
from project_state.recovery.operation_gate import RecoveryOperationGate
import project_state.capture.doctor as doctor_module


class SQLiteRuntimeGateTests(unittest.TestCase):
    def test_supported_runtime_is_reported_from_actual_engine(self):
        status = sqlite_runtime_status()
        self.assertEqual(status["version"], sqlite3.sqlite_version)
        self.assertEqual(status["minimum"], MIN_SQLITE_VERSION)
        self.assertEqual(status["supported"], tuple(sqlite3.sqlite_version_info) >= MIN_SQLITE_VERSION)

    def test_unsupported_runtime_fails_before_creating_state_or_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "app.sqlite").write_bytes(b"synthetic database placeholder")
            with (mock.patch.dict(os.environ, {"LOCALAPPDATA": str(root / "local-state-home")}),
                  mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version_info", (3, 49, 1)),
                  mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version", "3.49.1")):
                with self.assertRaises(ProjectStateError) as raised:
                    online_backup(root, "app.sqlite", "staging/op/app.sqlite")
            self.assertEqual(raised.exception.code, "ESQLITE_RUNTIME")
            self.assertFalse((root / "local-state-home").exists())
            self.assertEqual((root / "app.sqlite").read_bytes(), b"synthetic database placeholder")

    def test_explicit_seed_refuses_before_project_state_creation_on_unsupported_runtime(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "project"
            root.mkdir()
            database = root / "app.sqlite"
            connection = sqlite3.connect(database)
            try:
                connection.execute("CREATE TABLE marker (value TEXT)")
                connection.commit()
            finally:
                connection.close()
            state_home = root.parent / "isolated-state-home"
            with (mock.patch.dict(os.environ, {"LOCALAPPDATA": str(state_home)}),
                  mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version_info", (3, 49, 1)),
                  mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version", "3.49.1")):
                state_path = state_dir(root)
                with self.assertRaises(ProjectStateError) as raised:
                    create_snapshot(root, "must-not-publish", with_seed=True,
                                    operation_gate=RecoveryOperationGate())
            self.assertEqual(raised.exception.code, "ESQLITE_RUNTIME")
            self.assertFalse(state_path.exists())
            self.assertFalse(state_home.exists())
            self.assertEqual(database.read_bytes()[:16], b"SQLite format 3\x00")

    def test_unsupported_runtime_is_rejected_directly(self):
        with (mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version_info", (3, 50, 0)),
              mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version", "3.50.0")):
            with self.assertRaises(ProjectStateError) as raised:
                require_safe_sqlite()
        self.assertEqual(raised.exception.code, "ESQLITE_RUNTIME")
        self.assertIn("no database operation was started", str(raised.exception))

    def test_doctor_reports_old_engine_as_issue_not_available(self):
        with tempfile.TemporaryDirectory() as folder:
            with (mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version_info", (3, 49, 1)),
                  mock.patch("project_state.foundation.sqlite_runtime.sqlite3.sqlite_version", "3.49.1"),
                  mock.patch.object(doctor_module, "_probe", return_value={"available": False, "reason": "NOT_FOUND", "version": None})):
                result = doctor_module.doctor(Path(folder))
            check = next(item for item in result["checks"] if item["id"] == "Python SQLite")
            self.assertEqual((check["state"], check["reasonCode"]), ("issue", "SQLITE_RUNTIME_UNSUPPORTED"))
            self.assertFalse(result["tools"]["pythonSqlite"]["supported"])
            self.assertEqual(result["tools"]["pythonSqlite"]["minimum"], "3.51.3")


if __name__ == "__main__":
    unittest.main()
