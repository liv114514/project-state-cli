from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import unittest
import unittest.mock
from pathlib import Path

import project_state.foundation.state_location as location
import project_state.foundation.state_paths as state_paths_module
from project_state.errors import ProjectStateError
from project_state.state_paths import ensure_state_dir, project_identity, state_dir
from tests._support import temporary_directory


_EXIT_CHILD = r'''
import os, sys
from pathlib import Path
import project_state.foundation.state_location as location
location._PRIVATE_ACL_TEST_HOOK = lambda path: None
target_stage, barrier = sys.argv[1:3]
def hook(name, path):
    if name == target_stage:
        Path(barrier).write_text(name, encoding="ascii")
        os._exit(73)
location._LOCATION_TEST_HOOK = hook
location.initialize_state_location(Path(sys.argv[3]), Path(sys.argv[4]))
'''

_PAUSE_CHILD = r'''
import json, os, sys, time
from pathlib import Path
import project_state.foundation.state_location as location
location._PRIVATE_ACL_TEST_HOOK = lambda path: None
barrier, release = Path(sys.argv[1]), Path(sys.argv[2])
def hook(name, path):
    if name == "control-pending-published":
        barrier.write_text(name, encoding="ascii")
        deadline = time.monotonic() + 12
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not release.exists(): os._exit(74)
location._LOCATION_TEST_HOOK = hook
print(json.dumps(location.initialize_state_location(Path(sys.argv[3]), Path(sys.argv[4]))))
'''


class StateLocationTests(unittest.TestCase):
    def setUp(self):
        self._old_acl_hook = location._PRIVATE_ACL_TEST_HOOK
        location._PRIVATE_ACL_TEST_HOOK = lambda path: None

    def tearDown(self):
        location._PRIVATE_ACL_TEST_HOOK = self._old_acl_hook

    def _paths(self, tmp: str) -> tuple[Path, Path, Path]:
        container = Path(tmp)
        project = container / "project with 空格"
        project.mkdir()
        target = container / "private state"
        return container, project, target

    def test_show_and_check_are_read_only_then_explicit_init_routes_all_callers(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            before = sorted(path.name for path in container.iterdir())
            shown = location.inspect_state_location(project)
            checked = location.check_state_location(project, target)
            self.assertEqual(shown["mode"], "default")
            self.assertFalse(shown["stateExists"])
            self.assertTrue(checked["sameVolume"])
            self.assertFalse(checked["stateChanged"])
            self.assertEqual(sorted(path.name for path in container.iterdir()), before)

            result = location.initialize_state_location(project, target)
            self.assertEqual(result["status"], "initialized")
            self.assertEqual(state_dir(project), target)
            self.assertEqual(ensure_state_dir(project), target)
            self.assertEqual(location.inspect_state_location(project)["mode"], "explicit")
            with self.assertRaises(ProjectStateError) as caught:
                location.initialize_state_location(project, container / "other")
            self.assertEqual(caught.exception.code, "ELOCATION_CONFLICT")

    @unittest.skipUnless(os.name == "nt", "Windows launcher path-budget behavior")
    def test_long_control_publication_path_is_rejected_before_any_write(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            # Keep the configured state parent absent and make the longest
            # deterministic control publication path exceed Win32 MAX_PATH.
            # The candidate and project remain short and independently valid.
            long_home = Path(tmp) / ("state-home-" + ("x" * 140))
            expected_control_parent = long_home / "project-state-python" / "v1"
            patched_control = expected_control_parent / project_identity(project)
            longest_control_child = expected_control_parent / (
                ".project-state-location-control-" + project_identity(project) + "-" + ("0" * 32)
            ) / location._CONTROL_OWNER
            self.assertGreaterEqual(len(os.path.abspath(os.fspath(longest_control_child)).encode("utf-16-le")) // 2 + 1, 260)
            with unittest.mock.patch.object(state_paths_module, "_user_state_home", return_value=long_home):
                with self.assertRaises(ProjectStateError) as caught:
                    location.initialize_state_location(project, target)
            self.assertEqual(caught.exception.code, "EWINDOWS_PATH_LIMIT")
            self.assertFalse(long_home.exists(), "path refusal must happen before creating the private control parent")
            self.assertFalse(target.exists())
            self.assertEqual(sorted(path.name for path in container.iterdir()), ["project with 空格"])

    def test_existing_default_state_refuses_location_switch_and_preserves_marker(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            old_state = ensure_state_dir(project)
            marker = old_state / "state-root.json"
            before = marker.read_bytes()
            with self.assertRaises(ProjectStateError) as caught:
                location.initialize_state_location(project, target)
            self.assertEqual(caught.exception.code, "ELOCATION_EXISTING")
            self.assertEqual(marker.read_bytes(), before)
            self.assertFalse(target.exists())

    def test_pending_control_and_published_data_resume_after_real_process_exit(self):
        for stop_at in ("control-stage-ready", "control-pending-published", "data-root-published"):
            with self.subTest(stop_at=stop_at), temporary_directory() as tmp:
                container, project, target = self._paths(tmp)
                barrier = container / "child-reached.txt"
                env = os.environ.copy()
                env["PYTHONPATH"] = os.fspath(Path(__file__).resolve().parents[1] / "src")
                child = subprocess.Popen([sys.executable, "-c", _EXIT_CHILD, stop_at,
                    os.fspath(barrier), os.fspath(project), os.fspath(target)], cwd=project, env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline and not barrier.exists() and child.poll() is None:
                    time.sleep(0.01)
                self.assertTrue(barrier.exists(), f"child did not reach {stop_at}; exit={child.poll()}")
                _, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 73, stderr)
                if stop_at == "control-pending-published":
                    with self.assertRaises(ProjectStateError) as blocked:
                        state_dir(project)
                    self.assertEqual(blocked.exception.code, "ELOCATION_PENDING")
                elif stop_at == "data-root-published":
                    with self.assertRaises(ProjectStateError) as blocked:
                        state_dir(project)
                    self.assertEqual(blocked.exception.code, "ELOCATION_PENDING")
                result = location.initialize_state_location(project, target)
                self.assertEqual(result["status"], "initialized")
                self.assertEqual(state_dir(project), target)

    def test_owned_partial_data_stage_continues_but_unowned_stage_is_preserved_and_rejected(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            barrier = container / "child-reached.txt"
            env = os.environ.copy()
            env["PYTHONPATH"] = os.fspath(Path(__file__).resolve().parents[1] / "src")
            child = subprocess.Popen([sys.executable, "-c", _EXIT_CHILD, "data-stage-owner-published",
                os.fspath(barrier), os.fspath(project), os.fspath(target)], cwd=project, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and not barrier.exists() and child.poll() is None:
                time.sleep(0.01)
            self.assertTrue(barrier.exists(), f"child did not reach data-stage-owner-published; exit={child.poll()}")
            _, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 73, stderr)
            stage_dirs = list(container.glob(".project-state-location-stage-*"))
            self.assertEqual(len(stage_dirs), 1)
            stage_before = {p.name: p.read_bytes() for p in stage_dirs[0].iterdir() if p.is_file()}
            result = location.initialize_state_location(project, target)
            self.assertEqual(result["status"], "initialized")
            self.assertTrue((target / "state-location.json").is_file())
            self.assertFalse(stage_dirs[0].exists())
            self.assertEqual((target / ".state-location-stage-owner.json").read_bytes(),
                             stage_before[".state-location-stage-owner.json"])

    def test_active_registry_damage_never_falls_back_to_empty_default(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            location.initialize_state_location(project, target)
            control = location._control_path(project)
            marker = control / "state-root.json"
            before = marker.read_bytes()
            target_before = {p.name: p.read_bytes() for p in target.iterdir() if p.is_file()}
            marker.write_bytes(before.replace(b'"active"', b'"broken"'))
            damaged = marker.read_bytes()
            with self.assertRaises(ProjectStateError):
                state_dir(project)
            self.assertEqual(marker.read_bytes(), damaged)
            self.assertEqual({p.name: p.read_bytes() for p in target.iterdir() if p.is_file()}, target_before)

    def test_unowned_stage_is_rejected_and_preserved(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            barrier = container / "child-reached.txt"
            env = os.environ.copy()
            env["PYTHONPATH"] = os.fspath(Path(__file__).resolve().parents[1] / "src")
            child = subprocess.Popen([sys.executable, "-c", _EXIT_CHILD, "control-pending-published",
                os.fspath(barrier), os.fspath(project), os.fspath(target)], cwd=project, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and not barrier.exists() and child.poll() is None:
                time.sleep(0.01)
            self.assertTrue(barrier.exists())
            _, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 73, stderr)
            record = location._control_record(location._control_path(project), project_identity(project))[1]
            foreign_stage = target.parent / f".project-state-location-stage-{record['operationId']}"
            foreign_stage.mkdir()
            sentinel = foreign_stage / "foreign.txt"
            sentinel.write_bytes(b"preserve foreign synthetic object")
            with self.assertRaises(ProjectStateError) as caught:
                location.initialize_state_location(project, target)
            self.assertEqual(caught.exception.code, "ELOCATION_RECORD")
            self.assertEqual(sentinel.read_bytes(), b"preserve foreign synthetic object")
            self.assertFalse(target.exists())

    def test_orphan_registration_blocks_only_its_project(self):
        with temporary_directory() as tmp:
            container, project_a, target_a = self._paths(tmp)
            project_b = container / "project-b"
            project_b.mkdir()
            barrier = container / "child-reached.txt"
            env = os.environ.copy()
            env["PYTHONPATH"] = os.fspath(Path(__file__).resolve().parents[1] / "src")
            child = subprocess.Popen([sys.executable, "-c", _EXIT_CHILD, "control-stage-ready",
                os.fspath(barrier), os.fspath(project_a), os.fspath(target_a)], cwd=project_a, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and not barrier.exists() and child.poll() is None:
                time.sleep(0.01)
            self.assertTrue(barrier.exists(), f"child did not reach control-stage-ready; exit={child.poll()}")
            _, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 73, stderr)
            with self.assertRaises(ProjectStateError) as own:
                state_dir(project_a)
            self.assertEqual(own.exception.code, "ELOCATION_RESIDUE")
            with self.assertRaises(ProjectStateError) as own_show:
                location.inspect_state_location(project_a)
            self.assertEqual(own_show.exception.code, "ELOCATION_RESIDUE")
            state_b = ensure_state_dir(project_b)
            self.assertTrue(state_b.is_dir())
            stage = location._control_path(project_a).parent / (
                f"{location._CONTROL_STAGE_PREFIX}{project_identity(project_a)}-"
            )
            self.assertEqual(len(list(stage.parent.glob(stage.name + "*"))), 1)

    def test_competing_initializer_gets_busy_without_mutating_pending_intent(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            barrier, release = container / "barrier", container / "release"
            env = os.environ.copy()
            env["PYTHONPATH"] = os.fspath(Path(__file__).resolve().parents[1] / "src")
            child = subprocess.Popen([sys.executable, "-c", _PAUSE_CHILD, os.fspath(barrier),
                os.fspath(release), os.fspath(project), os.fspath(target)], cwd=project, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and not barrier.exists() and child.poll() is None:
                time.sleep(0.01)
            if not barrier.exists():
                stdout, stderr = child.communicate(timeout=5)
                self.fail(f"initializer did not reach barrier; exit={child.returncode}; stdout={stdout}; stderr={stderr}")
            marker_before = (location._control_path(project) / "state-root.json").read_bytes()
            with self.assertRaises(ProjectStateError) as caught:
                location.initialize_state_location(project, target)
            self.assertEqual(caught.exception.code, "ELOCATION_BUSY")
            self.assertEqual((location._control_path(project) / "state-root.json").read_bytes(), marker_before)
            self.assertFalse(target.exists())
            release.write_text("continue", encoding="ascii")
            stdout, stderr = child.communicate(timeout=12)
            self.assertEqual(child.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout)["status"], "initialized")
            self.assertEqual(state_dir(project), target)

    def test_old_a45_style_resolver_fails_closed_on_location_control_marker(self):
        with temporary_directory() as tmp:
            container, project, target = self._paths(tmp)
            location.initialize_state_location(project, target)
            # The legacy reader knows only the default path and exact legacy
            # marker schema. Its refusal is safer than creating a parallel root.
            from project_state.foundation.state_paths import _verify_state_dir, project_identity
            with self.assertRaises(ProjectStateError):
                _verify_state_dir(location._control_path(project), project_identity(project))
            self.assertEqual(state_dir(project), target)


if __name__ == "__main__":
    unittest.main()
