import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests._support import temporary_directory


class FixtureLifecycleTests(unittest.TestCase):
    def test_initialization_failure_preserves_container_and_environment(self):
        key = 'LOCALAPPDATA' if os.name == 'nt' else 'XDG_STATE_HOME'
        original_mkdir = Path.mkdir
        created = []
        def fail_state(path, *args, **kwargs):
            if path.name == 's':
                created.append(path.parent)
                raise OSError('synthetic setup failure')
            return original_mkdir(path, *args, **kwargs)
        with mock.patch.dict(os.environ, {key: 'original-fixture-value'}):
            with mock.patch.object(Path, 'mkdir', fail_state):
                with self.assertRaisesRegex(OSError, 'synthetic setup failure'):
                    temporary_directory()
            self.assertEqual(os.environ[key], 'original-fixture-value')
        self.assertEqual(len(created), 1)
        container = created[0]
        self.assertTrue((container / 'p').is_dir())
        (container / 'p').rmdir()
        container.rmdir()

    def test_import_does_not_create_configured_root(self):
        base = os.environ.get('PROJECT_STATE_TEST_ROOT') or str(Path(__file__).resolve().parents[4] / '_pt')
        Path(base).mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base, prefix='import-') as tmp:
            target = Path(tmp) / 'not-created'
            env = dict(os.environ, PROJECT_STATE_TEST_ROOT=str(target))
            result = subprocess.run([sys.executable, '-B', '-c', 'import tests._support'], env=env,
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(target.exists())

    def test_nested_context_and_exception_restore_state_home(self):
        key = 'LOCALAPPDATA' if os.name == 'nt' else 'XDG_STATE_HOME'
        with mock.patch.dict(os.environ, {key: 'original-fixture-value'}):
            with self.assertRaisesRegex(RuntimeError, 'fixture exception'):
                with temporary_directory() as outer:
                    outer_home = os.environ[key]
                    with temporary_directory() as inner:
                        self.assertNotEqual(outer, inner)
                        self.assertNotEqual(os.environ[key], outer_home)
                    self.assertEqual(os.environ[key], outer_home)
                    raise RuntimeError('fixture exception')
            self.assertEqual(os.environ[key], 'original-fixture-value')

    def test_default_root_runs_complete_restore_and_rollback(self):
        from project_state.snapshot import create_snapshot
        from project_state.restore_transaction import apply_config_restore, rollback_operation
        with mock.patch.dict(os.environ):
            os.environ.pop('PROJECT_STATE_TEST_ROOT', None)
            with temporary_directory() as tmp:
                root = Path(tmp)
                target = root / '.env'
                target.write_bytes(b'FIXTURE=one\n')
                create_snapshot(root, 'before')
                target.write_bytes(b'FIXTURE=two\n')
                operation = apply_config_restore(root, 'before')
                self.assertEqual(target.read_bytes(), b'FIXTURE=one\n')
                self.assertTrue(rollback_operation(root, operation['operationId'])['verified'])
                self.assertEqual(target.read_bytes(), b'FIXTURE=two\n')

    def test_replaced_container_is_preserved_and_environment_restored(self):
        key = 'LOCALAPPDATA' if os.name == 'nt' else 'XDG_STATE_HOME'
        with mock.patch.dict(os.environ, {key: 'original-fixture-value'}):
            fixture = temporary_directory()
            container = Path(fixture.name).parent
            moved = container.with_name(container.name + '-original')
            container.rename(moved)
            container.mkdir()
            marker = container / 'foreign-marker'
            marker.write_bytes(b'preserve')
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                fixture.cleanup()
            self.assertEqual(os.environ[key], 'original-fixture-value')
            self.assertEqual(marker.read_bytes(), b'preserve')
            # Both objects were created by this test and remain identity-known.
            marker.unlink()
            container.rmdir()
            (moved / 'p').rmdir()
            (moved / 's').rmdir()
            moved.rmdir()

if __name__ == '__main__':
    unittest.main()
