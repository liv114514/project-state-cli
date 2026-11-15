from __future__ import annotations

import subprocess
import hashlib
import unittest
from pathlib import Path

from project_state.compare import compare
from tests._support import temporary_directory
from tests.snapshot_fixture import build_v2


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace"))
    return result.stdout.decode("utf-8", "strict").strip()


def git_layer(commit: str, *, branch: str | None = "main", dirty: int = 0) -> dict:
    return {"commit": commit, "branch": branch, "detached": branch is None,
            "dirty": dirty > 0, "dirtyCount": dirty,
            "statusSample": [" M synthetic.txt"] if dirty else []}


class GitCompareTests(unittest.TestCase):
    def test_snapshot_git_commit_and_attachment_differences_are_reported(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            left_commit = "1" * 40
            right_commit = "2" * 40
            build_v2(root, name="left", git_data=git_layer(left_commit, branch="main"))
            build_v2(root, name="right", config=b"KEY=alpha\n", git_data=git_layer(right_commit, branch=None))

            code, output = compare(root, "left", "right")

            self.assertEqual(code, 0)
            self.assertIn(f"{left_commit[:7]} -> {right_commit[:7]}", output)
            self.assertIn("main -> detached", output)
            self.assertIn("2 supported difference(s)", output)

    def test_snapshot_to_live_git_commit_and_dirty_count_are_compared(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            git(root, "init", "-b", "main")
            git(root, "config", "user.name", "Synthetic Test")
            git(root, "config", "user.email", "synthetic@example.invalid")
            (root / ".gitignore").write_text(".env\n.project-state/\n", encoding="utf-8")
            tracked = root / "tracked.txt"
            tracked.write_text("A\n", encoding="utf-8")
            git(root, "add", ".gitignore", "tracked.txt")
            git(root, "commit", "-m", "baseline")
            first = git(root, "rev-parse", "HEAD")
            build_v2(root, git_data=git_layer(first, branch="main"))

            tracked.write_text("B\n", encoding="utf-8")
            git(root, "add", "tracked.txt")
            git(root, "commit", "-m", "changed")
            second = git(root, "rev-parse", "HEAD")
            tracked.write_text("C\n", encoding="utf-8")
            index_before = hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest()
            refs_before = git(root, "for-each-ref", "--format=%(refname) %(objectname)")
            tracked_before = tracked.read_bytes()

            code, output = compare(root, "before")

            self.assertEqual(code, 0)
            self.assertIn(f"{first[:7]} -> {second[:7]}", output)
            self.assertIn("0 changed path(s) -> 1 changed path(s)", output)
            self.assertNotIn("tracked.txt", output, "comparison should not echo worktree path samples")
            self.assertEqual(git(root, "rev-parse", "HEAD"), second)
            self.assertEqual(git(root, "for-each-ref", "--format=%(refname) %(objectname)"), refs_before)
            self.assertEqual(hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest(), index_before)
            self.assertEqual(tracked.read_bytes(), tracked_before)

    def test_missing_or_skipped_git_evidence_is_unknown_not_equal(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            build_v2(root, name="left")
            build_v2(root, name="right", config=b"KEY=alpha\n")

            code, output = compare(root, "left", "right")

            self.assertEqual(code, 0)
            self.assertIn("Git commit, branch, and worktree summary not compared", output)
            self.assertNotIn("Git commit: same", output)


if __name__ == "__main__":
    unittest.main()
