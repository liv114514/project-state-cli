from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path

from project_state.process import resolve_trusted_binary, run_trusted
from tests._support import temporary_directory


class TrustedProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = temporary_directory()
        self.root = Path(self.temp.name)
        self.python = Path(sys.executable).resolve()
        self.command = self.python.stem
        self.child_env = dict(os.environ)
        self.child_env["PATH"] = str(self.python.parent) + os.pathsep + self.child_env.get("PATH", "")

    def tearDown(self):
        self.temp.cleanup()

    def test_binary_resolution_excludes_project_tree_and_requires_simple_name(self):
        local = self.root / "tools"
        local.mkdir()
        (local / ("probe.exe" if os.name == "nt" else "probe")).write_bytes(b"synthetic tool")
        env = dict(self.child_env, PATH=str(local))
        self.assertIsNone(resolve_trusted_binary("probe", self.root, env=env))
        self.assertIsNone(resolve_trusted_binary(str(self.python), self.root, env=env))
        self.assertIsNone(resolve_trusted_binary("../probe", self.root, env=env))
        self.assertEqual(resolve_trusted_binary(self.command, self.root, env=self.child_env), self.python)

    def test_arguments_are_passed_without_shell_interpretation(self):
        marker = "fictional & $(must-not-run) %PATH%"
        result = run_trusted(self.command, ["-c", "import sys; print(sys.argv[1])", marker],
                             cwd=self.root, env=self.child_env)
        self.assertTrue(result["started"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["stdout"].strip(), marker)
        self.assertEqual(result["exitCode"], 0)
        self.assertIsNone(result["signal"])

    def test_missing_tool_is_distinct_from_a_started_process(self):
        result = run_trusted("tool-that-does-not-exist", [], cwd=self.root,
                             env=dict(self.child_env, PATH=""))
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ENOENT")
        self.assertFalse(result["started"])
        self.assertIsNone(result["exitCode"])
        self.assertTrue(result["complete"])

    def test_invalid_tool_names_and_unbounded_limits_are_rejected(self):
        self.assertIsNone(resolve_trusted_binary("git&", self.root, env=self.child_env))
        with self.assertRaises(ValueError):
            run_trusted(self.command, [], cwd=self.root, env=self.child_env, max_output=10**9)
        with self.assertRaises(ValueError):
            run_trusted(self.command, [], cwd=self.root, env=self.child_env, timeout=301)

    def test_nonzero_exit_is_reported_without_becoming_spawn_failure(self):
        result = run_trusted(self.command, ["-c", "import sys; print('marker', file=sys.stderr); sys.exit(7)"],
                             cwd=self.root, env=self.child_env)
        self.assertTrue(result["started"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["exitCode"], 7)
        self.assertIsNone(result["signal"])
        self.assertIn("marker", result["stderr"])
        self.assertEqual(result["code"], 7)

    def test_timeout_is_distinct_and_bounded(self):
        started = time.monotonic()
        result = run_trusted(self.command, ["-c", "import time; time.sleep(30)"],
                             cwd=self.root, env=self.child_env, timeout=0.15)
        self.assertTrue(result["started"])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["code"], "ETIMEDOUT")
        self.assertFalse(result["ok"])
        self.assertLess(time.monotonic() - started, 5)

    def test_output_limit_is_distinct_and_streams_are_drained(self):
        result = run_trusted(self.command, ["-c", "import sys; sys.stdout.write('A'*1000000); sys.stderr.write('B'*1000000)"],
                             cwd=self.root, env=self.child_env, max_output=4096, timeout=5)
        self.assertTrue(result["started"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ENOBUFS")
        self.assertTrue(result["outputTruncated"])
        self.assertTrue(result["complete"])
        self.assertLessEqual(len(result["stdout"].encode()) + len(result["stderr"].encode()), 4096)
        self.assertGreater(result["stdoutBytes"] + result["stderrBytes"], 4096)

    def test_shell_argument_injection_is_not_executed(self):
        marker = self.root / "should-not-exist"
        injected = f"literal; open({str(marker)!r}, 'w').write('x')"
        result = run_trusted(self.command, ["-c", "import sys; print(sys.argv[1])", injected],
                             cwd=self.root, env=self.child_env)
        self.assertTrue(result["ok"])
        self.assertIn("open(", result["stdout"])
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
