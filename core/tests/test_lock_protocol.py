from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

from project_state.errors import ProjectStateError
from project_state.snapshot import _lock
from tests._support import temporary_directory, state_dir, ensure_state_dir


class SharedOperationLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_active_lock_uses_single_link_os_locked_file_and_releases(self):
        lock = _lock(self.root, "synthetic")
        try:
            self.assertTrue(lock.path.is_file())
            self.assertEqual(lock.path.stat().st_nlink, 1)
            os.lseek(lock.fd, 0, os.SEEK_SET)
            owner = json.loads(os.read(lock.fd, 65536).decode("utf-8"))
            self.assertEqual(owner["rootIdentity"], __import__("hashlib").sha256(os.path.normcase(str(self.root)).encode()).hexdigest())
            self.assertEqual(owner["operation"], "snapshot")
            self.assertEqual(owner["token"], lock.token)
            lock.verify()
        finally:
            lock.release()
        self.assertTrue(lock.path.is_file(), "the stable lock inode is retained for cross-process serialization")

    def test_second_writer_is_refused_until_first_owner_releases(self):
        first = _lock(self.root, "first")
        try:
            with self.assertRaises(ProjectStateError) as caught:
                _lock(self.root, "second")
            self.assertEqual(caught.exception.code, "ELOCKED")
            self.assertTrue(first.path.is_file())
        finally:
            first.release()
        second = _lock(self.root, "second")
        second.release()

    def test_foreign_directory_at_lock_path_is_preserved_and_refused(self):
        claim = ensure_state_dir(self.root) / "locks" / "operation.lock"
        claim.mkdir(parents=True)
        marker = claim / "owner.json"
        marker.write_bytes(b"synthetic foreign owner evidence")
        with self.assertRaises(ProjectStateError) as caught:
            _lock(self.root, "blocked")
        self.assertEqual(caught.exception.code, "ELOCK_FOREIGN")
        self.assertEqual(marker.read_bytes(), b"synthetic foreign owner evidence")

    def test_foreign_regular_file_at_shared_lock_path_is_refused_unchanged(self):
        locks = ensure_state_dir(self.root) / "locks"
        locks.mkdir(parents=True)
        path = locks / "operation.lock"
        path.write_bytes(b"foreign lock object")
        with self.assertRaises(ProjectStateError) as caught:
            _lock(self.root, "blocked")
        self.assertIn(caught.exception.code, {"ELOCK_FOREIGN", "ELOCK_UNCERTAIN"})
        self.assertEqual(path.read_bytes(), b"foreign lock object")

    def test_changed_owner_is_not_released(self):
        lock = _lock(self.root, "synthetic")
        os.lseek(lock.fd, 0, os.SEEK_SET)
        os.ftruncate(lock.fd, 0)
        os.write(lock.fd, b"{}")
        with self.assertRaises(ProjectStateError) as caught:
            lock.release()
        self.assertEqual(caught.exception.code, "ELOCK_UNCERTAIN")
        self.assertTrue(lock.path.is_file())
        self.assertEqual(lock.path.stat().st_size, 2)

    def test_partial_owner_write_fails_closed_without_business_operation(self):
        # Pre-create state outside the injected os.write boundary so the
        # failure is specifically the lock-owner write, not first-root setup.
        ensure_state_dir(self.root)
        real_write = os.write
        calls = 0

        def partial_then_fail(fd: int, data: bytes) -> int:
            nonlocal calls
            calls += 1
            if calls != 2:
                return real_write(fd, data)
            real_write(fd, bytes(data[:7]))
            raise OSError("synthetic partial owner write failure")

        with mock.patch("project_state.snapshot.os.write", side_effect=partial_then_fail):
            with self.assertRaises(ProjectStateError) as caught:
                _lock(self.root, "synthetic")
        self.assertEqual(caught.exception.code, "ELOCK_CREATE")
        lock_root = state_dir(self.root) / "locks"
        lock_path = lock_root / "operation.lock"
        self.assertTrue(lock_path.is_file())
        self.assertEqual(lock_path.stat().st_size, 1)
        retry = _lock(self.root, "second")
        retry.verify()
        retry.release()


if __name__ == "__main__":
    unittest.main()
