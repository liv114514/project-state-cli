from __future__ import annotations

import hashlib
import os
import sqlite3
import unittest
from pathlib import Path
from unittest import mock

import project_state.database as database_module
from project_state.database import online_backup
from project_state.errors import ProjectStateError
from tests._support import temporary_directory, state_dir, ensure_state_dir


class DatabaseBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)
        ensure_state_dir(self.root)
        self.secrets = state_dir(self.root) / "secrets"
        (self.secrets / "staging" / "op").mkdir(parents=True)
        self.db_path = self.root / "app.sqlite"

    def tearDown(self):
        self.temp.cleanup()

    def test_open_wal_writer_backup_captures_committed_rows_only(self):
        writer = sqlite3.connect(self.db_path, isolation_level=None)
        try:
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower(), "wal")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, text_value TEXT, nullable TEXT, binary_value BLOB)")
            writer.execute("INSERT INTO sample(text_value, nullable, binary_value) VALUES (?, ?, ?)",
                           ("你好 🌏", None, sqlite3.Binary(b"\x00\x01\xff")))
            writer.execute("COMMIT") if writer.in_transaction else None
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("INSERT INTO sample(text_value, nullable, binary_value) VALUES (?, ?, ?)",
                           ("uncommitted-marker", None, sqlite3.Binary(b"not committed")))
            wal = Path(str(self.db_path) + "-wal")
            self.assertTrue(wal.exists(), "fixture must keep committed changes in an active WAL")
            self.assertGreater(wal.stat().st_size, 32)

            result = online_backup(self.root, "app.sqlite", "staging/op/app.sqlite")
            backup = self.secrets / "staging" / "op" / "app.sqlite"
            self.assertTrue(result["consistentBackup"])
            self.assertEqual(result["integrity"], "ok")
            self.assertEqual(result["totalRows"], 1)
            self.assertEqual(result["tables"], ["sample"])
            self.assertEqual(result["sha256"], hashlib.sha256(backup.read_bytes()).hexdigest())
            restored_view = sqlite3.connect(f"file:{backup.as_posix()}?mode=ro", uri=True)
            try:
                self.assertEqual(restored_view.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(restored_view.execute("SELECT text_value, nullable, hex(binary_value) FROM sample").fetchone(),
                                 ("你好 🌏", None, "0001FF"))
                self.assertEqual(restored_view.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sample'").fetchone()[0], 1)
                self.assertEqual(restored_view.execute("SELECT count(*) FROM sample WHERE text_value='uncommitted-marker'").fetchone()[0], 0)
            finally:
                restored_view.close()
            for suffix in ("-wal", "-shm", "-journal"):
                self.assertFalse(Path(str(backup) + suffix).exists(), f"unexpected backup sidecar: {suffix}")
        finally:
            if writer.in_transaction:
                writer.rollback()
            writer.close()

    def test_existing_destination_is_refused_unchanged(self):
        self.db_path.write_bytes(b"not a database")
        target = self.secrets / "staging" / "op" / "existing.sqlite"
        target.write_bytes(b"preexisting")
        with self.assertRaises(ProjectStateError):
            online_backup(self.root, "app.sqlite", "staging/op/existing.sqlite")
        self.assertEqual(target.read_bytes(), b"preexisting")

    def test_invalid_source_does_not_publish_backup(self):
        self.db_path.write_bytes(b"synthetic invalid sqlite input")
        target = self.secrets / "staging" / "op" / "failed.sqlite"
        with self.assertRaises(ProjectStateError):
            online_backup(self.root, "app.sqlite", "staging/op/failed.sqlite")
        self.assertFalse(target.exists())

    def test_public_or_escaping_destination_is_refused_before_writes(self):
        self.db_path.write_bytes(b"synthetic")
        with self.assertRaises(ProjectStateError):
            online_backup(self.root, "app.sqlite", "../../snapshots/exposed.sqlite")
        self.assertFalse((state_dir(self.root) / "snapshots/exposed.sqlite").exists())

    def test_source_replacement_during_backup_is_refused_and_private_stage_removed(self):
        writer = sqlite3.connect(self.db_path)
        writer.execute("CREATE TABLE sample (value TEXT)")
        writer.execute("INSERT INTO sample VALUES ('original')")
        writer.commit()
        writer.close()
        target = self.secrets / "staging" / "op" / "raced.sqlite"
        real_verify = database_module._verify_source_identity
        replacement = self.root / "replacement.sqlite"

        def replace_source(path, before):
            os.replace(self.db_path, replacement)
            self.db_path.write_bytes(b"external replacement")
            return real_verify(path, before)

        with mock.patch.object(database_module, "_verify_source_identity", side_effect=replace_source):
            with self.assertRaises(ProjectStateError) as caught:
                online_backup(self.root, "app.sqlite", "staging/op/raced.sqlite")
        self.assertEqual(caught.exception.code, "ESOURCE_CHANGED")
        self.assertEqual(self.db_path.read_bytes(), b"external replacement")
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
