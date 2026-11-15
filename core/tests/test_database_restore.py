from __future__ import annotations

import json
import contextlib
import io
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from project_state.errors import ProjectStateError
from project_state.cli import main
import project_state.restore_database as restore_database
from project_state.restore_database import (
    apply_database_restore,
    inspect_database_operation,
    plan_database_restore,
    recover_database_operation,
)
from project_state.snapshot import create_snapshot
from tests._support import temporary_directory, state_dir, ensure_state_dir


class DatabaseRestoreTests(unittest.TestCase):
    def test_unverified_platform_refuses_sqlite_mutations_before_state_access(self):
        before = sorted((path.relative_to(state_dir(self.source)).as_posix(), path.read_bytes())
                        for path in state_dir(self.source).rglob("*") if path.is_file())
        with mock.patch.object(restore_database.os, "name", "posix"):
            actions = (lambda: restore_database.apply_database_restore(self.source, "before", "new.sqlite"),
                       lambda: restore_database.continue_database_operation(self.source, "0" * 32),
                       lambda: restore_database.rollback_database_operation(self.source, "0" * 32))
            for action in actions:
                with self.assertRaises(ProjectStateError) as raised:
                    action()
                self.assertEqual(raised.exception.code, "EPLATFORM_UNVERIFIED")
        after = sorted((path.relative_to(state_dir(self.source)).as_posix(), path.read_bytes())
                       for path in state_dir(self.source).rglob("*") if path.is_file())
        self.assertEqual(before, after)
        self.assertFalse((state_dir(self.source) / "operations").exists())

    def setUp(self):
        self.temp = temporary_directory()
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.destination = self.base / "destination"
        self.source.mkdir()
        self.destination.mkdir()
        self.database = self.source / "app.sqlite"
        self.writer = sqlite3.connect(self.database, isolation_level=None)
        self.assertEqual(self.writer.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, text_value TEXT, nullable TEXT, binary_value BLOB)")
        self.writer.execute("INSERT INTO sample(text_value, nullable, binary_value) VALUES (?, ?, ?)",
                            ("提交行-🌏", None, sqlite3.Binary(b"\x00\x10\xff")))
        self.writer.execute("BEGIN IMMEDIATE")
        self.writer.execute("INSERT INTO sample(text_value, nullable, binary_value) VALUES (?, ?, ?)",
                            ("未提交行", None, sqlite3.Binary(b"uncommitted")))
        self.assertGreater(Path(str(self.database) + "-wal").stat().st_size, 32)
        self.snapshot = create_snapshot(self.source, "db-restore", with_seed=True)
        # The restore-side fixture is a disposable project clone containing only
        # the synthetic public/private snapshot state, never the source database.
        # Locks are process-local coordination state, not snapshot payload.
        # A copied lock owner remains bound to the source root and must never
        # be treated as the destination project's current owner.
        source_state = state_dir(self.source)
        destination_state = ensure_state_dir(self.destination)
        for item in ("snapshots", "secrets"):
            shutil.copytree(source_state / item, destination_state / item)

    def tearDown(self):
        if self.writer:
            if self.writer.in_transaction:
                self.writer.rollback()
            self.writer.close()
        self.temp.cleanup()

    def _rows(self, path: Path):
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            return connection.execute("SELECT text_value, nullable, hex(binary_value) FROM sample ORDER BY id").fetchall()
        finally:
            connection.close()

    def test_snapshot_backup_restores_only_committed_wal_rows_and_rolls_back_to_absent(self):
        backup = (state_dir(self.destination) / "secrets" / "db-restore" / "generations"
                  / self.snapshot["generation"] / "files" / "app.sqlite")
        self.assertEqual(self._rows(backup), [("提交行-🌏", None, "0010FF")])
        preview = plan_database_restore(self.destination, "db-restore", "app.sqlite")
        self.assertEqual(preview["businessWrites"], 0)
        self.assertFalse((self.destination / "app.sqlite").exists())
        result = apply_database_restore(self.destination, "db-restore", "app.sqlite")
        target = self.destination / "app.sqlite"
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self._rows(target), [("提交行-🌏", None, "0010FF")])
        records = restore_database._load_records(self.destination, result["operationId"])
        self.assertIn("ownerBinding", records[0])
        self.assertNotIn("ownerToken", records[0]["ownerBinding"])
        resolver_dir = state_dir(self.destination) / "resolvers" / result["operationId"]
        self.assertFalse(list(resolver_dir.glob("claim-*.json")))
        pin = state_dir(self.destination) / "pins" / f"{result['operationId']}.json"
        self.assertTrue(pin.exists(), "completed restore remains pinned while the user rollback option is live")
        rolled = recover_database_operation(self.destination, result["operationId"], "rollback")
        self.assertEqual(rolled["status"], "rolled-back")
        self.assertFalse(target.exists())
        self.assertFalse(pin.exists())
        claims = [json.loads(path.read_text("utf-8")) for path in sorted(resolver_dir.glob("claim-*.json"))]
        self.assertEqual([item["status"] for item in claims], ["active", "completed"])
        self.assertEqual(recover_database_operation(self.destination, result["operationId"], "rollback")["status"], "rolled-back")

    def test_existing_target_and_each_sidecar_are_refused_unchanged(self):
        target = self.destination / "app.sqlite"
        target.write_bytes(b"external database bytes")
        with self.assertRaises(ProjectStateError):
            plan_database_restore(self.destination, "db-restore", "app.sqlite")
        self.assertEqual(target.read_bytes(), b"external database bytes")
        target.unlink()
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(target) + suffix)
            sidecar.write_bytes(b"external sidecar")
            with self.subTest(sidecar=suffix):
                with self.assertRaises(ProjectStateError):
                    plan_database_restore(self.destination, "db-restore", "app.sqlite")
                self.assertEqual(sidecar.read_bytes(), b"external sidecar")
            sidecar.unlink()

    def test_cross_volume_sqlite_preview_is_refused_before_transaction_or_pin(self):
        destination_state = state_dir(self.destination)
        before_ops = list((destination_state / "operations").glob("*")) if (destination_state / "operations").exists() else []
        before_pins = list((destination_state / "pins").glob("*")) if (destination_state / "pins").exists() else []
        with mock.patch("project_state.paths.volume_identity", side_effect=["volume:project", "volume:state"]):
            with self.assertRaises(ProjectStateError) as raised:
                plan_database_restore(self.destination, "db-restore", "app.sqlite")
        self.assertEqual(raised.exception.code, "ECROSS_VOLUME_UNSUPPORTED")
        after_ops = list((destination_state / "operations").glob("*")) if (destination_state / "operations").exists() else []
        after_pins = list((destination_state / "pins").glob("*")) if (destination_state / "pins").exists() else []
        self.assertEqual(after_ops, before_ops)
        self.assertEqual(after_pins, before_pins)
        self.assertFalse((self.destination / "app.sqlite").exists())

    def test_cross_volume_publish_failure_can_release_pin_as_not_published_cancel(self):
        with mock.patch.object(restore_database, "_publish_no_replace",
                              side_effect=OSError(17, "synthetic ERROR_NOT_SAME_DEVICE")):
            with self.assertRaises(OSError):
                apply_database_restore(self.destination, "db-restore", "app.sqlite")
        operation_id = next(path.name for path in (state_dir(self.destination) / "operations").iterdir())
        observed = inspect_database_operation(self.destination, operation_id)
        self.assertEqual(observed["phase"], "publish-intent")
        self.assertEqual(observed["classification"], "prepared-awaiting-publication")
        self.assertEqual(observed["recoveryActions"], ["--continue", "--rollback"])
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").is_file())
        outcome = recover_database_operation(self.destination, operation_id, "rollback")
        self.assertEqual(outcome["status"], "cancelled")
        self.assertFalse(outcome["restoreApplied"])
        self.assertFalse((self.destination / "app.sqlite").exists())
        self.assertFalse((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        final = inspect_database_operation(self.destination, operation_id)
        self.assertEqual(final["classification"], "cancelled-not-published")
        self.assertEqual(final["pin"], "released")
        self.assertEqual(final["recoveryActions"], [])

    def test_completed_missing_pin_is_not_reported_released_and_blocks_rollback(self):
        result = apply_database_restore(self.destination, "db-restore", "app.sqlite")
        operation_id = result["operationId"]
        target = self.destination / "app.sqlite"
        before = target.read_bytes()
        pin = state_dir(self.destination) / "pins" / f"{operation_id}.json"
        pin.unlink()
        observed = inspect_database_operation(self.destination, operation_id)
        self.assertEqual(observed["pin"], "missing-unexpected")
        records_before = restore_database._load_records(self.destination, operation_id)
        with self.assertRaises(ProjectStateError):
            recover_database_operation(self.destination, operation_id, "rollback")
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(restore_database._load_records(self.destination, operation_id), records_before)

    def test_interrupted_sqlite_cancel_completes_resolver_claim_on_retry(self):
        with mock.patch.object(restore_database, "_publish_no_replace",
                              side_effect=OSError(17, "synthetic ERROR_NOT_SAME_DEVICE")):
            with self.assertRaises(OSError):
                apply_database_restore(self.destination, "db-restore", "app.sqlite")
        operation_id = next(path.name for path in (state_dir(self.destination) / "operations").iterdir())
        with mock.patch.object(restore_database, "complete_recovery",
                              side_effect=OSError("injected interruption after terminal cancellation")):
            with self.assertRaises(OSError):
                recover_database_operation(self.destination, operation_id, "rollback")
        self.assertEqual(inspect_database_operation(self.destination, operation_id)["classification"], "cancelled-not-published")
        self.assertFalse((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        repeated = recover_database_operation(self.destination, operation_id, "rollback")
        self.assertEqual(repeated["status"], "cancelled")
        record = restore_database._load_records(self.destination, operation_id)[-1]
        claims = restore_database.load_claims(self.destination, operation_id, "database", record)
        self.assertEqual([item[0]["status"] for item in claims], ["active", "active", "completed"])

    def test_rollback_interruption_is_inspectable_and_continuable_with_pin_validation(self):
        result = apply_database_restore(self.destination, "db-restore", "app.sqlite")
        target = self.destination / "app.sqlite"
        operation_id = result["operationId"]
        original_append = restore_database._append

        def interrupt_terminal(root, op, state):
            if state.get("status") == "rolled-back":
                raise OSError("injected interruption after quarantine move")
            return original_append(root, op, state)

        with mock.patch.object(restore_database, "_append", side_effect=interrupt_terminal):
            with self.assertRaises(OSError):
                recover_database_operation(self.destination, operation_id, "rollback")
        observed = inspect_database_operation(self.destination, operation_id)
        self.assertEqual(observed["classification"], "rollback-awaiting-retained")
        self.assertFalse(target.exists())
        quarantine = (state_dir(self.destination) / "staging" / operation_id
                      / "private" / "database.rollback")
        self.assertEqual(self._rows(quarantine), [("提交行-🌏", None, "0010FF")])
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        recovered = recover_database_operation(self.destination, operation_id, "continue")
        self.assertEqual(recovered["status"], "rolled-back")
        self.assertFalse(target.exists())
        self.assertTrue(quarantine.exists(), "rollback retains the verified private quarantine instead of unlinking by path")
        self.assertFalse((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())

    def test_new_process_finishes_publish_when_termination_follows_atomic_rename(self):
        original_append = restore_database._append

        def interrupt_after_publish(root, operation_id, state):
            if state.get("phase") == "published":
                raise OSError("injected process-stop boundary after rename")
            return original_append(root, operation_id, state)

        with mock.patch.object(restore_database, "_append", side_effect=interrupt_after_publish):
            with self.assertRaises(OSError):
                apply_database_restore(self.destination, "db-restore", "app.sqlite")
        operations = list((state_dir(self.destination) / "operations").iterdir())
        operation_id = operations[0].name
        observed = inspect_database_operation(self.destination, operation_id)
        self.assertEqual(observed["classification"], "published-awaiting-verification")
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        with self.assertRaises(ProjectStateError) as blocked:
            create_snapshot(self.destination, "must-wait")
        self.assertEqual(blocked.exception.code, "ERECOVERY_REQUIRED")
        self.assertFalse((state_dir(self.destination) / "snapshots" / "must-wait").exists())
        with self.assertRaises(ProjectStateError) as blocked_restore:
            apply_database_restore(self.destination, "db-restore", "app.sqlite")
        self.assertEqual(blocked_restore.exception.code, "ERECOVERY_REQUIRED")
        self.assertTrue((self.destination / "app.sqlite").is_file())
        continued = recover_database_operation(self.destination, operation_id, "continue")
        self.assertEqual(continued["status"], "verified")
        self.assertEqual(self._rows(self.destination / "app.sqlite"), [("提交行-🌏", None, "0010FF")])
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())

    def test_terminated_process_after_publish_is_recovered_by_third_process(self):
        marker = self.base / "published.marker"
        source_root = Path(__file__).resolve().parents[1] / "src"
        child_code = r'''import time
from pathlib import Path
import project_state.restore_database as module
from project_state.restore_database import apply_database_restore
original = module._publish_no_replace
def stopped_after_publish(stage, target):
    original(stage, target)
    Path(__import__("os").environ["PROJECT_STATE_TEST_MARKER"]).write_text("renamed", encoding="ascii")
    time.sleep(60)
module._publish_no_replace = stopped_after_publish
apply_database_restore(Path.cwd(), "db-restore", "app.sqlite")
'''
        env = os.environ.copy()
        env["PYTHONPATH"] = str(source_root)
        env["PROJECT_STATE_TEST_MARKER"] = str(marker)
        child = subprocess.Popen([sys.executable, "-c", child_code], cwd=self.destination,
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not marker.exists() and child.poll() is None:
            time.sleep(0.025)
        try:
            self.assertTrue(marker.exists(), "child did not reach the post-rename barrier")
            self.assertIsNone(child.poll(), "child exited before the parent terminated it")
            self.assertTrue((self.destination / "app.sqlite").exists())
            operations = list((state_dir(self.destination) / "operations").iterdir())
            self.assertEqual(len(operations), 1)
            operation_id = operations[0].name
            self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        finally:
            if child.poll() is None:
                child.terminate()
            child_stdout, child_stderr = child.communicate(timeout=10)
        self.assertIsNotNone(child.returncode, "terminated child did not report a terminal process status")
        self.assertNotEqual(child.returncode, 0, "the barrier child must not finish naturally as a successful restore")
        operation_id = next((state_dir(self.destination) / "operations").iterdir()).name
        recovered = subprocess.run(
            [sys.executable, "-c",
             "import json,sys; from project_state.restore_database import recover_database_operation; "
             "print(json.dumps(recover_database_operation('.', sys.argv[1], 'continue'))) ", operation_id],
            cwd=self.destination, env=env, capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        result = json.loads(recovered.stdout)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self._rows(self.destination / "app.sqlite"), [("提交行-🌏", None, "0010FF")])
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        claims = [json.loads(path.read_text("utf-8")) for path in
                  sorted((state_dir(self.destination) / "resolvers" / operation_id).glob("claim-*.json"))]
        self.assertEqual([claim["status"] for claim in claims], ["active", "completed"])
        self.assertEqual(claims[0]["operationPlanSha256"], claims[1]["operationPlanSha256"])

    def test_rollback_displacement_race_returns_external_object_without_deletion(self):
        result = apply_database_restore(self.destination, "db-restore", "app.sqlite")
        operation_id = result["operationId"]
        target = self.destination / "app.sqlite"
        external_saved = self.base / "external-saved.sqlite"
        external_bytes = b"foreign database object"
        original_rename = restore_database.os.rename

        def replace_before_displacement(source, destination):
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path == target and destination_path.name == "database.rollback":
                os.replace(target, external_saved)
                target.write_bytes(external_bytes)
            return original_rename(source, destination)

        with mock.patch.object(restore_database.os, "rename", side_effect=replace_before_displacement):
            with self.assertRaises(ProjectStateError):
                recover_database_operation(self.destination, operation_id, "rollback")
        self.assertEqual(target.read_bytes(), external_bytes)
        self.assertEqual(self._rows(external_saved), [("提交行-🌏", None, "0010FF")])
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())

    def test_foreign_target_created_before_restore_is_not_overwritten(self):
        target = self.destination / "app.sqlite"
        original_plan = plan_database_restore

        def create_external_after_preview(root, name, filename):
            preview = original_plan(root, name, filename)
            target.write_bytes(b"external object created after preflight")
            return preview

        with mock.patch("project_state.restore_database.plan_database_restore", side_effect=create_external_after_preview):
            with self.assertRaises(ProjectStateError):
                apply_database_restore(self.destination, "db-restore", "app.sqlite")
        self.assertEqual(target.read_bytes(), b"external object created after preflight")

    def test_external_target_at_no_replace_publish_boundary_is_preserved_and_pinned(self):
        target = self.destination / "app.sqlite"
        original_publish = restore_database._publish_no_replace
        external = b"external bytes at final publication boundary"

        def race_publish(stage, destination):
            destination.write_bytes(external)
            return original_publish(stage, destination)

        with mock.patch.object(restore_database, "_publish_no_replace", side_effect=race_publish):
            with self.assertRaises(ProjectStateError):
                apply_database_restore(self.destination, "db-restore", "app.sqlite")
        self.assertEqual(target.read_bytes(), external)
        operations = list((state_dir(self.destination) / "operations").iterdir())
        self.assertEqual(len(operations), 1)
        operation_id = operations[0].name
        self.assertTrue((state_dir(self.destination) / "pins" / f"{operation_id}.json").exists())
        self.assertEqual(inspect_database_operation(self.destination, operation_id)["classification"], "uncertain")

    def test_cli_database_restore_and_printed_rollback_command(self):
        old = Path.cwd()
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            os.chdir(self.destination)
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                preview_code = main(["restore", "db-restore", "--only", "database", "--target", "app.sqlite", "--json"])
            self.assertEqual(preview_code, 0, stderr.getvalue())
            self.assertEqual(json.loads(stdout.getvalue())["businessWrites"], 0)
            stdout.seek(0); stdout.truncate(0)
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                apply_code = main(["restore", "db-restore", "--only", "database", "--target", "app.sqlite", "--yes"])
            self.assertEqual(apply_code, 0, stderr.getvalue())
            printed = stdout.getvalue()
            operation_id = printed.split("Operation: ", 1)[1].split(";", 1)[0]
            self.assertEqual(self._rows(self.destination / "app.sqlite"), [("提交行-🌏", None, "0010FF")])
            stdout.seek(0); stdout.truncate(0)
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                rollback_code = main(["recover", operation_id, "--rollback", "--yes"])
            self.assertEqual(rollback_code, 0, stderr.getvalue())
            result = json.loads(stdout.getvalue())
            self.assertTrue(result["privateQuarantineRetained"])
            self.assertFalse((self.destination / "app.sqlite").exists())
            quarantine = (state_dir(self.destination) / "staging" / operation_id
                          / "private" / "database.rollback")
            self.assertEqual(self._rows(quarantine), [("提交行-🌏", None, "0010FF")])
        finally:
            os.chdir(old)


if __name__ == "__main__":
    unittest.main()
