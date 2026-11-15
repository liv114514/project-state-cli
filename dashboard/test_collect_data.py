from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "collector" / "collect_data.py"
SPEC = importlib.util.spec_from_file_location("project_state_dashboard_collector", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(collector)


class CollectorProtocolTests(unittest.TestCase):
    def test_cli_argv_is_json_argv_without_shell_or_windows_backslash_splitting(self):
        argv = [r"C:\Program Files\Python\python.exe", "-m", "project_state.cli", "quoted arg", "中文()!&"]
        self.assertEqual(json.loads(json.dumps(argv)), argv)

    def test_json_result_requires_version_and_command_identity(self):
        valid = {"resultSchemaVersion": 1, "toolVersion": "0.1.0a38", "command": "doctor", "mode": "general"}
        self.assertEqual(collector.parse_json_result(json.dumps(valid), command="doctor", version="0.1.0a38"), valid)
        for invalid in (
            {**valid, "command": "list"}, {**valid, "toolVersion": "different"},
            {**valid, "resultSchemaVersion": 9}, {"command": "doctor"},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                collector.parse_json_result(json.dumps(invalid), command="doctor", version="0.1.0a38")

    def test_process_timeout_and_output_limit_are_not_reported_as_normal_exit(self):
        timeout_proc = [sys.executable, "-c", "import time; time.sleep(2)"]
        with mock.patch.object(collector, "_TIMEOUT_SECONDS", 0.1):
            rc, _out, err = collector.run_cmd(timeout_proc)
        self.assertEqual(rc, -2)
        self.assertIn("ETIMEDOUT", err)
        output_proc = [sys.executable, "-c", "print('x' * 500000)"]
        with mock.patch.object(collector, "_OUTPUT_LIMIT", 1024):
            rc, out, err = collector.run_cmd(output_proc)
        self.assertEqual(rc, -3)
        self.assertLessEqual(len(out.encode("utf-8")), 1024)
        self.assertIn("EOUTPUT_LIMIT", err)

    def test_show_and_recover_payloads_can_be_retained_on_nonzero_exit(self):
        with tempfile.TemporaryDirectory(prefix="collector 中文 ") as tmp:
            root = Path(tmp)
            fixture = root / "cli fixture.py"
            fixture.write_text('''import json,sys\na=sys.argv[1:]\nif a==["--version"]: print("0.1.0a39")\nelif a[:1]==["list"]: print(json.dumps({"resultSchemaVersion":2,"toolVersion":"0.1.0a39","command":"list","snapshots":[]}))\nelif a[:1]==["doctor"]: print(json.dumps({"resultSchemaVersion":1,"toolVersion":"0.1.0a39","command":"doctor","mode":"general","checks":[],"tools":{},"summary":{"state":"issue"}})); sys.exit(2)\nelif a[:1]==["recover"]: print(json.dumps({"resultSchemaVersion":1,"operationId":a[1],"state":"pending"})); sys.exit(2)\n''', encoding="utf-8")
            out = root / "output"
            env = dict(os.environ, PYTHONIOENCODING="utf-8")
            run = subprocess.run([sys.executable, str(MODULE_PATH), "--project", str(root),
                                  "--cli-argv", json.dumps([sys.executable, str(fixture)]),
                                  "--out-dir", str(out), "--operation", "op-test"],
                                 capture_output=True, text=True, encoding="utf-8", env=env, timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr)
            bundle = json.loads((out / "live-data.json").read_text(encoding="utf-8"))
            self.assertEqual(bundle["doctor"]["general"]["observedExitCode"], 2)
            self.assertEqual(bundle["doctor"]["general"]["verdict"], "issue")
            self.assertEqual(bundle["operations"][0]["observedExitCode"], 2)
            self.assertEqual(bundle["operations"][0]["state"], "pending")
            self.assertTrue((out / "live-data.js").exists())


if __name__ == "__main__":
    unittest.main()
