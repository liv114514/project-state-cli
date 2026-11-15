from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from project_state.errors import ProjectStateError
from project_state.git_state import inspect_git, parse_index_entries, parse_status
from tests._support import temporary_directory


class GitStateTests(unittest.TestCase):
    def setUp(self):
        if shutil.which("git") is None:
            self.skipTest("Git executable is unavailable in this test environment")
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)
        self.git(["init", "-q", "-b", "main"])
        self.git(["config", "user.name", "Synthetic Test"])
        self.git(["config", "user.email", "synthetic@example.invalid"])
        (self.root / "tracked.txt").write_bytes(b"base\n")
        self.git(["add", "tracked.txt"])
        self.git(["commit", "-qm", "synthetic base"])

    def tearDown(self):
        self.temp.cleanup()

    def git(self, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run(["git", *args], cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=False, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if check and result.returncode != 0:
            self.fail(f"synthetic Git setup failed with {result.returncode}: {result.stderr.decode('utf-8', 'replace')}")
        return result

    def test_clean_repo_observation_preserves_index_bytes_and_refs(self):
        index = self.root / ".git" / "index"
        before_index = hashlib.sha256(index.read_bytes()).hexdigest()
        head = self.git(["rev-parse", "HEAD"]).stdout.decode().strip()
        refs = self.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/"]).stdout
        state = inspect_git(self.root)
        self.assertTrue(state["isGit"])
        self.assertTrue(state["clean"])
        self.assertEqual(state["head"], head)
        self.assertEqual(state["branchRef"], "refs/heads/main")
        self.assertEqual(state["refsText"].encode(), refs)
        self.assertEqual(hashlib.sha256(index.read_bytes()).hexdigest(), before_index)

    def test_dirty_worktree_is_reported_and_not_called_clean(self):
        (self.root / "tracked.txt").write_bytes(b"dirty\n")
        state = inspect_git(self.root)
        self.assertFalse(state["clean"])
        self.assertEqual(state["dirty"][0]["path"], "tracked.txt")

    def test_detached_head_is_explicit(self):
        self.git(["checkout", "--detach", "-q"])
        state = inspect_git(self.root)
        self.assertIsNone(state["branchRef"])
        self.assertIsNone(state["branch"])

    def test_subdirectory_is_refused(self):
        child = self.root / "nested"
        child.mkdir()
        with self.assertRaisesRegex(ProjectStateError, "repository root"):
            inspect_git(child)

    def test_non_git_directory_is_not_reported_as_clean(self):
        other = self.root.parent / f"not-git-{self.root.name}"
        other.mkdir()
        state = inspect_git(other)
        self.assertEqual(state, {"isGit": False, "reasonCode": "NOT_A_GIT_REPOSITORY"})

    def test_normal_and_special_named_filters_are_rejected_before_status(self):
        cases = (
            ("named", "filter=project-state-marker"),
            ("unset", "filter=unset"),
            ("unspecified", "filter=unspecified"),
        )
        for driver, attribute in cases:
            with self.subTest(driver=driver):
                self.git(["config", "--unset-all", f"filter.{driver}.clean"], check=False)
                attrs = self.root / ".gitattributes"
                attrs.write_text(f"tracked.txt {attribute}\n", encoding="utf-8")
                self.git(["add", ".gitattributes"])
                self.git(["commit", "-qm", f"attribute {driver}"])
                self.git(["config", f"filter.{driver}.clean", "synthetic-filter-must-not-run"])
                calls: list[list[str]] = []
                from project_state import git_state
                original = git_state._git

                def observe(root: Path, args: list[str], **kwargs):
                    calls.append(args)
                    return original(root, args, **kwargs)

                with patch("project_state.git_state._git", side_effect=observe):
                    with self.assertRaisesRegex(ProjectStateError, "content filter"):
                        inspect_git(self.root)
                self.assertFalse(any("status" in args for args in calls), "filter must be rejected before git status")

    def test_staged_addition_is_in_attribute_preflight_before_status(self):
        new_path = self.root / "staged-added.cfg"
        new_path.write_bytes(b"source\n")
        self.git(["add", "staged-added.cfg"])
        info_attributes = self.root / ".git" / "info" / "attributes"
        info_attributes.write_text("staged-added.cfg filter=staged-driver\n", encoding="utf-8")
        self.git(["config", "filter.staged-driver.clean", "synthetic-filter-must-not-run"])
        from project_state import git_state
        calls: list[list[str]] = []
        original = git_state._git

        def observe(root: Path, args: list[str], **kwargs):
            calls.append(args)
            return original(root, args, **kwargs)

        with patch("project_state.git_state._git", side_effect=observe):
            with self.assertRaisesRegex(ProjectStateError, "content filter"):
                inspect_git(self.root)
        self.assertFalse(any("status" in args for args in calls))

    def test_ignored_restore_target_is_added_to_filter_preflight_before_status(self):
        (self.root / ".gitignore").write_text(".env\n", encoding="utf-8")
        self.git(["add", ".gitignore"])
        self.git(["commit", "-qm", "ignore private config"])
        attrs = self.root / ".gitattributes"
        attrs.write_text(".env filter=restore-driver\n", encoding="utf-8")
        self.git(["add", ".gitattributes"])
        self.git(["commit", "-qm", "assign filter to ignored config"])
        (self.root / ".env").write_bytes(b"TOKEN=synthetic\n")
        self.git(["config", "filter.restore-driver.clean", "synthetic-filter-must-not-run"])
        from project_state import git_state
        calls: list[list[str]] = []
        original = git_state._git

        def observe(root: Path, args: list[str], **kwargs):
            calls.append(args)
            return original(root, args, **kwargs)

        with patch("project_state.git_state._git", side_effect=observe):
            with self.assertRaisesRegex(ProjectStateError, "content filter"):
                inspect_git(self.root, extra_paths=[".env"])
        self.assertFalse(any("status" in args for args in calls), "filter must be rejected before Git status")

    def test_porcelain_parser_keeps_spaces_and_rename_source(self):
        parsed = parse_status(" M path with spaces.txt\0R  new name.txt\0old name.txt\0")
        self.assertEqual(parsed, [
            {"code": " M", "path": "path with spaces.txt"},
            {"code": "R ", "path": "new name.txt", "originalPath": "old name.txt"},
        ])

    def test_index_parser_splits_only_first_tab(self):
        rows = parse_index_entries("100644 " + "a" * 40 + " 0\tpath with\ttab\0")
        self.assertEqual(rows[0]["path"], "path with\ttab")
        with self.assertRaises(ProjectStateError):
            parse_index_entries("100644 " + "a" * 40 + " 0\tmissing-terminator")


if __name__ == "__main__":
    unittest.main()
