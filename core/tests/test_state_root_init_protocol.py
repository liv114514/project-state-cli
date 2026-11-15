from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path

from project_state.errors import ProjectStateError
from project_state.state_paths import ensure_state_dir, state_dir
from tests._support import temporary_directory


_EXIT_CHILD = r'''
import os, sys
from pathlib import Path
import project_state.state_paths as sp
target, barrier, project = sys.argv[1:]
def hook(name, path):
    if name == target:
        with open(barrier, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(name + "\n" + str(path))
            stream.flush(); os.fsync(stream.fileno())
        os._exit(73)
sp._INITIALIZATION_TEST_HOOK = hook
sp.ensure_state_dir(Path(project))
'''

_PAUSE_CHILD = r'''
import os, sys, time
from pathlib import Path
import project_state.state_paths as sp
barrier, release, project = sys.argv[1:]
def hook(name, path):
    if name == "before-publish":
        with open(barrier, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(str(path)); stream.flush(); os.fsync(stream.fileno())
        deadline = time.monotonic() + 10
        while not Path(release).exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not Path(release).exists(): os._exit(74)
sp._INITIALIZATION_TEST_HOOK = hook
try:
    print(sp.ensure_state_dir(Path(project)))
except sp.ProjectStateError as exc:
    print(exc.code)
    raise SystemExit(exc.exit_code)
'''


@unittest.skipUnless(os.name == "nt", "Windows is the only verified state-root no-replace publisher")
class StateRootInitializationProtocolTests(unittest.TestCase):
    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        env["PYTHONPATH"] = os.fspath(Path(__file__).resolve().parents[1] / "src")
        return env

    def _wait_barrier(self, process: subprocess.Popen[str], barrier: Path) -> str:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not barrier.exists() and process.poll() is None:
            time.sleep(0.01)
        self.assertTrue(barrier.exists(), f"child did not reach barrier; exit={process.poll()}")
        return barrier.read_text("utf-8")

    def test_new_root_is_published_only_with_complete_bound_identity(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            state = ensure_state_dir(project)
            marker_path = state / "state-root.json"
            proof_path = state / "state-root.initialization.json"
            marker = json.loads(marker_path.read_text("utf-8"))
            proof = json.loads(proof_path.read_text("utf-8"))
            self.assertEqual(set(marker), {"runtime", "layoutVersion", "projectIdentity"})
            self.assertEqual(proof["projectIdentity"], marker["projectIdentity"])
            self.assertEqual(proof["directoryIdentity"], {"device": state.stat().st_dev, "inode": state.stat().st_ino})
            marker_stat = marker_path.stat()
            self.assertEqual(proof["markerIdentity"], {"device": marker_stat.st_dev, "inode": marker_stat.st_ino})
            self.assertEqual(state_dir(project), state)

            # The legacy a38 reader accepts the unchanged marker and ignores
            # the extra proof file; older valid state roots remain readable.
            baseline_root = Path(os.environ.get("PROJECT_STATE_A38_ROOT", Path(__file__).resolve().parents[3] / "audit-repair-20261108-01"))
            manifest = (baseline_root / "report" / "SOURCE-MANIFEST.csv").read_bytes()
            self.assertEqual(hashlib.sha256(manifest).hexdigest(), "c667ec80fa8b5333e4bea60e54ab7b20ea24d3b6e9d08be98fc9e304b0582ca8")
            baseline_rows = [row for row in csv.DictReader(io.StringIO(manifest.decode('utf-8-sig'))) if row['path'].startswith('core/src/')]
            self.assertTrue(baseline_rows)
            for row in baseline_rows:
                content = (baseline_root / row['path']).read_bytes()
                self.assertEqual(len(content), int(row['bytes']))
                self.assertEqual(hashlib.sha256(content).hexdigest(), row['sha256'])
            baseline_src = baseline_root / "core" / "src"
            legacy_env = self._env()
            legacy_env["PYTHONPATH"] = os.fspath(baseline_src)
            legacy_code = r'''
import sys
from pathlib import Path
from project_state.state_paths import state_dir
print(state_dir(Path(sys.argv[1])))
'''
            legacy = subprocess.run([sys.executable, "-c", legacy_code, os.fspath(project)], cwd=project,
                                    env=legacy_env, capture_output=True, text=True, timeout=10)
            self.assertEqual(legacy.returncode, 0, legacy.stderr)
            self.assertEqual(Path(legacy.stdout.strip()), state)

    def test_real_process_termination_windows_are_retryable_without_adopting_residue(self):
        stages = ("container-created", "marker-created", "marker-partial", "marker-flushed",
                  "proof-flushed", "before-publish", "after-publish")
        for stage in stages:
            with self.subTest(stage=stage), temporary_directory() as tmp:
                project = Path(tmp)
                official = state_dir(project)
                barrier = project.parent / f"barrier-{uuid.uuid4().hex}.txt"
                child = subprocess.Popen([sys.executable, "-c", _EXIT_CHILD, stage, os.fspath(barrier), os.fspath(project)],
                                         cwd=project, env=self._env(), stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL)
                observed = self._wait_barrier(child, barrier).splitlines()
                self.assertEqual(observed[0], stage)
                self.assertEqual(child.wait(timeout=5), 73)
                residue = Path(observed[1])
                before = ({p.relative_to(residue).as_posix(): p.read_bytes()
                           for p in residue.rglob("*") if p.is_file()} if residue.exists() else {})
                published = stage == "after-publish"
                self.assertEqual(official.exists(), published)

                retry_code = r'''
import json, sys
from pathlib import Path
from project_state.state_paths import ensure_state_dir, state_dir
root = Path(sys.argv[1]); state = ensure_state_dir(root)
print(json.dumps({"state": str(state), "same": state_dir(root) == state}))
'''
                retry = subprocess.run([sys.executable, "-c", retry_code, os.fspath(project)], cwd=project,
                                       env=self._env(), capture_output=True, text=True, timeout=10)
                self.assertEqual(retry.returncode, 0, retry.stderr)
                result = json.loads(retry.stdout)
                self.assertEqual(Path(result["state"]), official)
                self.assertTrue(result["same"])
                self.assertTrue((official / "state-root.json").is_file())
                self.assertTrue((official / "state-root.initialization.json").is_file())
                if not published:
                    self.assertTrue(residue.is_dir())
                    after = {p.relative_to(residue).as_posix(): p.read_bytes()
                             for p in residue.rglob("*") if p.is_file()}
                    self.assertEqual(after, before, "retry must preserve, not adopt or rewrite old residue")

    def test_two_initializers_have_one_winner_and_read_only_observer_does_not_repair(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            official = state_dir(project)
            barrier = project.parent / f"barrier-{uuid.uuid4().hex}.txt"
            release = project.parent / f"release-{uuid.uuid4().hex}.txt"
            child = subprocess.Popen([sys.executable, "-c", _PAUSE_CHILD, os.fspath(barrier),
                                      os.fspath(release), os.fspath(project)], cwd=project, env=self._env(),
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self._wait_barrier(child, barrier)
            self.assertEqual(state_dir(project), official)
            self.assertFalse(official.exists(), "read-only lookup must not create or repair the official leaf")
            winner = ensure_state_dir(project)
            release.write_text("continue", encoding="ascii")
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr)
            self.assertEqual(Path(stdout.strip()), winner)
            self.assertEqual(winner, official)
            self.assertTrue((winner / "state-root.initialization.json").is_file())
            self.assertEqual(len(list(winner.parent.glob(".project-state-init-*"))), 1,
                             "the losing private container remains non-authoritative evidence")

    def test_unknown_markerless_roots_are_preserved_and_rejected(self):
        for nonempty in (False, True):
            with self.subTest(nonempty=nonempty), temporary_directory() as tmp:
                project = Path(tmp)
                state = state_dir(project)
                state.parent.mkdir(parents=True)
                state.mkdir()
                sentinel = state / "foreign.txt"
                if nonempty:
                    sentinel.write_bytes(b"synthetic foreign data")
                before = sentinel.read_bytes() if sentinel.exists() else None
                with self.assertRaises(ProjectStateError) as caught:
                    ensure_state_dir(project)
                self.assertEqual(caught.exception.code, "ESTATE_IDENTITY")
                self.assertEqual(sentinel.read_bytes() if sentinel.exists() else None, before)

    def test_same_bytes_replaced_marker_is_rejected_and_preserved(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            state = ensure_state_dir(project)
            marker = state / "state-root.json"
            original = marker.read_bytes()
            displaced = state / "marker.original"
            marker.rename(displaced)
            marker.write_bytes(original)
            self.assertEqual(marker.read_bytes(), original)
            with self.assertRaises(ProjectStateError) as caught:
                state_dir(project)
            self.assertEqual(caught.exception.code, "ESTATE_IDENTITY")
            self.assertEqual(marker.read_bytes(), original)
            self.assertEqual(displaced.read_bytes(), original)

    def test_same_bytes_replaced_state_directory_is_rejected_and_preserved(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            state = ensure_state_dir(project)
            held = state.with_name(state.name + ".held")
            state.rename(held)
            state.mkdir()
            for name in ("state-root.json", "state-root.initialization.json"):
                (state / name).write_bytes((held / name).read_bytes())
            copied = {p.name: p.read_bytes() for p in state.iterdir()}
            with self.assertRaises(ProjectStateError) as caught:
                state_dir(project)
            self.assertEqual(caught.exception.code, "ESTATE_IDENTITY")
            self.assertEqual({p.name: p.read_bytes() for p in state.iterdir()}, copied)
            self.assertTrue((held / "state-root.initialization.json").is_file())

    def test_raced_in_foreign_target_is_not_replaced(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            official = state_dir(project)
            barrier = project.parent / f"barrier-{uuid.uuid4().hex}.txt"
            release = project.parent / f"release-{uuid.uuid4().hex}.txt"
            child = subprocess.Popen([sys.executable, "-c", _PAUSE_CHILD, os.fspath(barrier),
                                      os.fspath(release), os.fspath(project)], cwd=project, env=self._env(),
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self._wait_barrier(child, barrier)
            official.parent.mkdir(parents=True, exist_ok=True)
            official.mkdir()
            release.write_text("continue", encoding="ascii")
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 2, stderr)
            self.assertIn("ESTATE_IDENTITY", stdout)
            self.assertEqual(list(official.iterdir()), [], "empty raced-in directory must not be replaced")
            self.assertFalse((official / "state-root.json").exists())

    def test_damaged_initialization_proof_is_rejected_and_preserved(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            state = ensure_state_dir(project)
            proof = state / "state-root.initialization.json"
            original = proof.read_bytes()
            proof.write_bytes(original + b"x")
            before = {p.name: p.read_bytes() for p in state.iterdir() if p.is_file()}
            with self.assertRaises(ProjectStateError) as caught:
                state_dir(project)
            self.assertEqual(caught.exception.code, "ESTATE_IDENTITY")
            self.assertEqual({p.name: p.read_bytes() for p in state.iterdir() if p.is_file()}, before)

    def test_legacy_marker_without_optional_proof_remains_readable(self):
        with temporary_directory() as tmp:
            project = Path(tmp)
            state = ensure_state_dir(project)
            (state / "state-root.initialization.json").unlink()
            marker = (state / "state-root.json").read_bytes()
            self.assertEqual(state_dir(project), state)
            self.assertEqual(ensure_state_dir(project), state)
            self.assertFalse((state / "state-root.initialization.json").exists())
            self.assertEqual((state / "state-root.json").read_bytes(), marker)


if __name__ == "__main__":
    unittest.main()
