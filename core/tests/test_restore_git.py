from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from project_state.cli import main
from project_state.errors import ProjectStateError
from project_state.restore import plan_git_restore
from project_state.snapshot import create_snapshot
from tests._support import temporary_directory


class GitRestorePreviewTests(unittest.TestCase):
    def setUp(self):
        if shutil.which("git") is None:
            self.skipTest("Git executable is unavailable")
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)
        self.git(["init", "-q", "-b", "main"])
        self.git(["config", "user.name", "Synthetic Test"])
        self.git(["config", "user.email", "synthetic@example.invalid"])
        (self.root / ".gitignore").write_text(".project-state/\n", encoding="utf-8")
        (self.root / "tracked file.txt").write_bytes(b"state A\n")
        self.git(["add", ".gitignore", "tracked file.txt"])
        self.git(["commit", "-qm", "synthetic state A"])

    def tearDown(self):
        self.temp.cleanup()

    def git(self, args: list[str], check: bool = True):
        result = subprocess.run(["git", *args], cwd=self.root, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if check and result.returncode:
            self.fail(f"synthetic git command failed: {result.stderr.decode('utf-8', 'replace')}")
        return result

    def _tree_state(self):
        tracked = {}
        for path in self.root.rglob("*"):
            if ".git" in path.parts or ".project-state" in path.parts:
                continue
            if path.is_file():
                tracked[path.relative_to(self.root).as_posix()] = path.read_bytes()
        index = hashlib.sha256((self.root / ".git" / "index").read_bytes()).hexdigest()
        head = self.git(["rev-parse", "HEAD"]).stdout
        refs = self.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/"]).stdout
        return tracked, index, head, refs

    def _capture_a_then_commit_b(self):
        captured = self.git(["rev-parse", "HEAD"]).stdout.decode().strip()
        result = create_snapshot(self.root, "state-a")
        self.assertEqual(result["state"], "verified")
        (self.root / "tracked file.txt").write_bytes(b"state B\n")
        self.git(["add", "tracked file.txt"])
        self.git(["commit", "-qm", "synthetic state B"])
        return captured, result

    def test_git_restore_preview_validates_target_and_is_read_only(self):
        captured, _ = self._capture_a_then_commit_b()
        before = self._tree_state()
        plan = plan_git_restore(self.root, "state-a")
        self.assertEqual(plan["target"]["commit"], captured)
        self.assertIsNone(plan["target"]["branchRef"], "a moved branch is not reset to an older snapshot commit")
        self.assertEqual(plan["target"]["headMode"], "detached")
        self.assertEqual(plan["changedPathCount"], 1)
        self.assertEqual(plan["application"], "not-supported-yet")
        self.assertEqual(before, self._tree_state())

    def test_cli_git_apply_is_explicitly_refused_without_mutation(self):
        self._capture_a_then_commit_b()
        before = self._tree_state()
        original = Path.cwd()
        try:
            os.chdir(self.root)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                status = main(["restore", "state-a", "--only", "git", "--yes"])
        finally:
            os.chdir(original)
        self.assertEqual(status, 2)
        self.assertEqual(before, self._tree_state())

    def test_cli_git_preview_emits_json_and_preserves_repository_identity(self):
        self._capture_a_then_commit_b()
        before = self._tree_state()
        original = Path.cwd()
        output = io.StringIO()
        try:
            os.chdir(self.root)
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                status = main(["restore", "state-a", "--only", "git", "--json"])
        finally:
            os.chdir(original)
        self.assertEqual(status, 0)
        value = json.loads(output.getvalue())
        self.assertEqual(value["mode"], "preview-only")
        self.assertEqual(value["selectedLayers"], ["git"])
        self.assertEqual(value["application"], "not-supported-yet")
        self.assertEqual(before, self._tree_state())

    def test_dirty_repository_is_refused_before_git_preview(self):
        self._capture_a_then_commit_b()
        (self.root / "tracked file.txt").write_bytes(b"external edit\n")
        with self.assertRaisesRegex(ProjectStateError, "index or worktree changes"):
            plan_git_restore(self.root, "state-a")

    def test_live_info_attributes_filter_is_refused_without_running_marker(self):
        self._capture_a_then_commit_b()
        marker = self.root / "filter-ran.marker"
        info_attributes = self.root / ".git" / "info" / "attributes"
        info_attributes.write_text("* filter=unsafe-driver\n", encoding="utf-8")
        self.git(["config", "filter.unsafe-driver.clean", f"cmd /c echo ran>{marker}"])
        self.git(["config", "filter.unsafe-driver.smudge", f"cmd /c echo ran>{marker}"])
        with self.assertRaisesRegex(ProjectStateError, "content filter"):
            plan_git_restore(self.root, "state-a")
        self.assertFalse(marker.exists(), "filter preflight must refuse before any content filter is executed")

    def test_ignored_file_at_target_path_is_refused_before_restore_preview(self):
        (self.root / ".gitignore").write_text(".project-state/\nfuture.txt\n", encoding="utf-8")
        (self.root / "future.txt").write_bytes(b"tracked target\n")
        self.git(["add", ".gitignore"])
        self.git(["add", "-f", "--", "future.txt"])
        self.git(["commit", "-qm", "target has future file"])
        captured = self.git(["rev-parse", "HEAD"]).stdout.decode().strip()
        result = create_snapshot(self.root, "state-a")
        self.assertEqual(result["state"], "verified")

        self.git(["rm", "--", "future.txt"])
        self.git(["commit", "-qm", "current target removes file"])
        foreign = b"external ignored content\n"
        (self.root / "future.txt").write_bytes(foreign)
        before = self._tree_state()
        with self.assertRaisesRegex(ProjectStateError, "ignored project data"):
            plan_git_restore(self.root, "state-a")
        self.assertEqual((self.root / "future.txt").read_bytes(), foreign)
        self.assertNotEqual(self.git(["rev-parse", "HEAD"]).stdout.decode().strip(), captured)
        self.assertEqual(before, self._tree_state())

    def test_snapshot_without_git_layer_is_refused(self):
        # A valid schema-v2 snapshot without a Git layer cannot authorize checkout.
        from tests.snapshot_fixture import build_v2
        other = self.root.parent / f"no-git-{self.root.name}"
        other.mkdir()
        try:
            build_v2(other)
            with self.assertRaisesRegex(ProjectStateError, "no collected Git layer"):
                plan_git_restore(other, "before")
        finally:
            shutil.rmtree(other)


if __name__ == "__main__":
    unittest.main()
