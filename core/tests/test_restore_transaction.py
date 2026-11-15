from __future__ import annotations

import hashlib
import errno
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from project_state.cli import main
from project_state.errors import ProjectStateError
from project_state.restore_transaction import (apply_config_restore, continue_operation,
                                                inspect_operation, rollback_operation)
from project_state.transaction import append_record, load_records, operation_dir
from tests._support import temporary_directory, state_dir, ensure_state_dir


class RestoreTransactionTests(unittest.TestCase):
    def test_unverified_platform_refuses_config_mutations_before_state_access(self):
        import project_state.recovery.config as tx
        with temporary_directory() as tmp:
            root = Path(tmp)
            with mock.patch.object(tx.os, "name", "posix"):
                for action in (lambda: tx.apply_config_restore(root, "before"),
                               lambda: tx.continue_operation(root, "0" * 32),
                               lambda: tx.rollback_operation(root, "0" * 32)):
                    with self.assertRaises(ProjectStateError) as raised:
                        action()
                    self.assertEqual(raised.exception.code, "EPLATFORM_UNVERIFIED")
            self.assertFalse(state_dir(root).exists())

    def _project(self, root: Path, content: bytes) -> tuple[str, str, str]:
        (root / ".gitignore").write_bytes(b".env\r\n.env.local\r\n.project-state/\r\n")
        (root / ".env").write_bytes(content)
        subprocess.run(["git", "init", "--quiet", "-b", "main"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "Synthetic"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "synthetic@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "add", ".gitignore"], cwd=root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=root, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        index = hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest()
        refs = subprocess.check_output(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"], cwd=root, text=True)
        return head, index, refs

    def _invoke(self, root: Path, *args: str) -> tuple[int, str, str]:
        previous = Path.cwd()
        try:
            os.chdir(root)
            import contextlib
            import io
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(list(args))
            return code, out.getvalue(), err.getvalue()
        finally:
            os.chdir(previous)

    def test_cross_volume_preview_and_task_doctor_refuse_before_mutation(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            original = b"TOKEN=fictional-alpha\r\n"
            (root / ".env").write_bytes(original)
            self._project(root, original)
            self.assertEqual(self._invoke(root, "snapshot", "cross-volume-source")[0], 0)
            changed = b"TOKEN=fictional-beta\r\n"
            (root / ".env").write_bytes(changed)
            state = state_dir(root)
            before = sorted(str(path.relative_to(state)) for path in state.rglob("*") if path.is_file())
            with mock.patch("project_state.paths.volume_identity", side_effect=["volume:project", "volume:state"]):
                with self.assertRaises(ProjectStateError) as raised:
                    from project_state.restore import plan_config_restore
                    plan_config_restore(root, "cross-volume-source")
            self.assertEqual(raised.exception.code, "ECROSS_VOLUME_UNSUPPORTED")
            with mock.patch("project_state.paths.volume_identity", side_effect=["volume:project", "volume:state"]):
                from project_state.doctor import task_doctor
                report = task_doctor(root, "config-restore", "cross-volume-source")
            self.assertEqual(report["summary"]["state"], "blocked")
            self.assertEqual(report["checks"][1]["reasonCode"], "ECROSS_VOLUME_UNSUPPORTED")
            with mock.patch("project_state.paths.volume_identity", side_effect=["volume:project", "volume:state"]):
                with self.assertRaises(ProjectStateError) as apply_error:
                    apply_config_restore(root, "cross-volume-source")
            self.assertEqual(apply_error.exception.code, "ECROSS_VOLUME_UNSUPPORTED")
            after = sorted(str(path.relative_to(state)) for path in state.rglob("*") if path.is_file())
            self.assertEqual(after, before)
            self.assertEqual((root / ".env").read_bytes(), changed)
            self.assertFalse((state / "operations").exists())

    def test_failed_displacement_can_be_safely_cancelled_without_claiming_restore(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            original = b"TOKEN=fictional-alpha\r\n"
            changed = b"TOKEN=fictional-beta\r\n"
            (root / ".env").write_bytes(original)
            head, index, refs = self._project(root, original)
            self.assertEqual(self._invoke(root, "snapshot", "cancel-source")[0], 0)
            (root / ".env").write_bytes(changed)
            from project_state.recovery import config as tx
            with mock.patch.object(tx, "_move_noreplace", side_effect=OSError(errno.EXDEV, "synthetic cross-volume refusal")):
                with self.assertRaises(ProjectStateError) as raised:
                    apply_config_restore(root, "cancel-source")
            self.assertEqual(raised.exception.code, "EPUBLISH")
            operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
            observed = inspect_operation(root, operation_id)
            self.assertEqual(observed["phase"], "displace-intent")
            self.assertEqual(observed["classification"], "not-applied-awaiting-cancel")
            stage_record = load_records(root, operation_id)[-1]["stage"]
            stage_path = state_dir(root) / Path(*stage_record["relativePath"].split("/"))
            stage_bytes = stage_path.read_bytes()
            safety = observed["safety"]
            outcome = rollback_operation(root, operation_id)
            self.assertEqual(outcome["status"], "cancelled")
            self.assertFalse(outcome["restoreApplied"])
            self.assertEqual((root / ".env").read_bytes(), changed)
            self.assertEqual(stage_path.read_bytes(), stage_bytes)
            terminal = inspect_operation(root, operation_id)
            self.assertEqual(terminal["classification"], "cancelled-not-applied")
            self.assertEqual(terminal["recoveryActions"], [])
            self.assertTrue((state_dir(root) / "secrets" / safety["name"] / "generations" / safety["generation"]).is_dir())
            self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), head)
            self.assertEqual(hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest(), index)
            self.assertEqual(subprocess.check_output(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"], cwd=root, text=True), refs)
            self.assertEqual(self._invoke(root, "snapshot", "after-cancellation")[0], 0)

    def test_interrupted_cancel_terminal_completes_active_resolver_on_retry(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            original = b"TOKEN=fictional-alpha\r\n"
            changed = b"TOKEN=fictional-beta\r\n"
            (root / ".env").write_bytes(original)
            self._project(root, original)
            self.assertEqual(self._invoke(root, "snapshot", "cancel-interrupt")[0], 0)
            (root / ".env").write_bytes(changed)
            from project_state.recovery import config as tx
            with mock.patch.object(tx, "_move_noreplace", side_effect=OSError(errno.EXDEV, "synthetic cross-volume refusal")):
                with self.assertRaises(ProjectStateError):
                    apply_config_restore(root, "cancel-interrupt")
            operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
            with mock.patch.object(tx, "complete_recovery", side_effect=OSError("injected interruption after terminal cancellation")):
                with self.assertRaises(OSError):
                    rollback_operation(root, operation_id)
            self.assertEqual(inspect_operation(root, operation_id)["classification"], "cancelled-not-applied")
            self.assertEqual((root / ".env").read_bytes(), changed)
            result = rollback_operation(root, operation_id)
            self.assertEqual(result["status"], "cancelled")
            from project_state.resolver import load_claims
            claims = load_claims(root, operation_id, "config", load_records(root, operation_id)[-1])
            self.assertEqual([item[0]["status"] for item in claims], ["active", "active", "completed"])

    def test_not_applied_cancellation_refuses_replaced_target_and_quarantine(self):
        for tamper in ("target", "quarantine"):
            with self.subTest(tamper=tamper), temporary_directory() as tmp:
                root = Path(tmp)
                original = b"TOKEN=fictional-alpha\r\n"
                changed = b"TOKEN=fictional-beta\r\n"
                (root / ".env").write_bytes(original)
                self._project(root, original)
                self.assertEqual(self._invoke(root, "snapshot", f"cancel-{tamper}")[0], 0)
                (root / ".env").write_bytes(changed)
                from project_state.recovery import config as tx
                with mock.patch.object(tx, "_move_noreplace", side_effect=OSError(errno.EXDEV, "synthetic cross-volume refusal")):
                    with self.assertRaises(ProjectStateError):
                        apply_config_restore(root, f"cancel-{tamper}")
                operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
                if tamper == "target":
                    replacement = root / ".env.replacement"
                    replacement.write_bytes(changed)
                    replacement.replace(root / ".env")
                else:
                    record = load_records(root, operation_id)[-1]
                    displaced = tx._displaced_path(root, record, "previous")
                    displaced.write_bytes(changed)
                with self.assertRaises(ProjectStateError) as raised:
                    rollback_operation(root, operation_id)
                self.assertEqual(raised.exception.code, "EOPERATION_UNCERTAIN")
                self.assertEqual(load_records(root, operation_id)[-1]["phase"], "displace-intent")

    def test_config_apply_and_rollback_preserve_git_and_pin_safety_generation(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a = b"TOKEN=fictional-alpha\r\nPORT=12716\r\n"
            b = b"TOKEN=fictional-beta\r\nPORT=12717\r\n"
            (root / ".env").write_bytes(a)
            head, index, refs = self._project(root, a)
            # Baseline commit includes only .gitignore; config remains ignored.
            code, _, _ = self._invoke(root, "snapshot", "state-a")
            self.assertEqual(code, 0)
            (root / ".env").write_bytes(b)
            before_preview = (root / ".env").read_bytes()
            code, preview, _ = self._invoke(root, "restore", "state-a", "--only", "config", "--json")
            self.assertEqual(code, 0)
            self.assertIn('"mode":"preview-only"', preview)
            self.assertEqual((root / ".env").read_bytes(), before_preview)
            self.assertEqual(self._invoke(root, "restore", "state-a", "--only", "config", "--yes")[0], 0)
            self.assertEqual((root / ".env").read_bytes(), a)
            operation_dir = state_dir(root) / "operations"
            operation_id = next(p.name for p in operation_dir.iterdir() if p.is_dir())
            inspected = inspect_operation(root, operation_id)
            self.assertEqual(inspected["classification"], "completed")
            terminal = json.loads(sorted((operation_dir / operation_id).glob("record-*.json"))[-1].read_text("utf-8"))
            self.assertIn("ownerBinding", terminal)
            self.assertNotIn("ownerToken", terminal["ownerBinding"])
            resolver_dir = state_dir(root) / "resolvers" / operation_id
            self.assertFalse(list(resolver_dir.glob("claim-*.json")))
            safety = terminal["safety"]
            safety_pair = json.loads((state_dir(root) / "snapshots" / safety["name"] / "current.json").read_text("utf-8"))
            self.assertEqual(safety_pair["generation"], safety["generation"])
            # Original rollback operation returns to B, while the safety generation remains intact.
            self.assertTrue(rollback_operation(root, operation_id)["verified"])
            self.assertEqual((root / ".env").read_bytes(), b)
            resolver_records = [json.loads(path.read_text("utf-8")) for path in sorted(resolver_dir.glob("claim-*.json"))]
            self.assertEqual([item["status"] for item in resolver_records], ["active", "completed"])
            self.assertEqual(len({item["claimId"] for item in resolver_records}), 1)
            code, out, err = self._invoke(root, "recover", operation_id, "--continue", "--yes")
            self.assertEqual(code, 0, err)
            self.assertIn('"classification":"rolled-back"', out)
            self.assertTrue((state_dir(root) / "secrets" / safety["name"] / "generations" / safety["generation"]).is_dir())

    def test_multi_config_batch_restores_and_rolls_back_all_targets(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before_env = b"TOKEN=fictional-a\r\nPORT=12716\r\n"
            before_local = b"REGION=fictional\nEMPTY=\n"
            (root / ".env").write_bytes(before_env)
            (root / ".env.local").write_bytes(before_local)
            head, index, refs = self._project(root, before_env)
            self.assertEqual(self._invoke(root, "snapshot", "batch-before")[0], 0)
            after_env = b"TOKEN=fictional-b\r\nPORT=12717\r\n"
            after_local = b"REGION=changed\nEMPTY=\n"
            (root / ".env").write_bytes(after_env)
            (root / ".env.local").write_bytes(after_local)
            code, preview, _ = self._invoke(root, "restore", "batch-before", "--only", "config", "--json")
            self.assertEqual(code, 0)
            self.assertIn('"target":".env"', preview)
            self.assertIn('"target":".env.local"', preview)
            self.assertEqual((root / ".env").read_bytes(), after_env)
            self.assertEqual((root / ".env.local").read_bytes(), after_local)
            code, output, error = self._invoke(root, "restore", "batch-before", "--only", "config", "--yes")
            self.assertEqual(code, 0, error)
            self.assertEqual((root / ".env").read_bytes(), before_env)
            self.assertEqual((root / ".env.local").read_bytes(), before_local)
            operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
            records = load_records(root, operation_id)
            self.assertEqual(records[-1]["schemaVersion"], 2)
            self.assertEqual(records[-1]["transactionKind"], "config-batch")
            self.assertEqual(inspect_operation(root, operation_id)["classification"], "completed")
            rolled = rollback_operation(root, operation_id)
            self.assertEqual(rolled["status"], "rolled-back")
            self.assertEqual((root / ".env").read_bytes(), after_env)
            self.assertEqual((root / ".env.local").read_bytes(), after_local)
            self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), head)
            self.assertEqual(hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest(), index)
            self.assertEqual(subprocess.check_output(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"], cwd=root, text=True), refs)

    def test_multi_config_batch_restores_missing_target_and_new_process_continues_interruption(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            before_env = b"TOKEN=fictional-a\r\n"
            before_local = b"PORT=12716\n"
            (root / ".env").write_bytes(before_env)
            (root / ".env.local").write_bytes(before_local)
            head, index, refs = self._project(root, before_env)
            self.assertEqual(self._invoke(root, "snapshot", "batch-missing")[0], 0)
            after_env = b"TOKEN=fictional-b\r\n"
            (root / ".env").write_bytes(after_env)
            (root / ".env.local").unlink()
            code, preview, _ = self._invoke(root, "restore", "batch-missing", "--only", "config", "--json")
            self.assertEqual(code, 0)
            self.assertIn('"action":"create"', preview)
            child = ("import os\nfrom project_state.recovery import config as tx\n"
                     "original=tx._move_noreplace\n"
                     "def stop(source,destination):\n"
                     " original(source,destination)\n"
                     " if destination.name == '.env':\n  os._exit(87)\n"
                     "tx._move_noreplace=stop\n"
                     "from project_state.application import apply_config_restore\n"
                     f"apply_config_restore(r'{root}','batch-missing')\n")
            proc = subprocess.run([sys.executable, "-c", child], cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(proc.returncode, 87, proc.stderr)
            operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
            status = inspect_operation(root, operation_id)
            self.assertEqual(status["classification"], "interrupted")
            recovery = ("from project_state.recovery.config import continue_operation; "
                        f"print(continue_operation(r'{root}','{operation_id}')['status'])")
            proc = subprocess.run([sys.executable, "-c", recovery], cwd=root, capture_output=True, text=True, timeout=45)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), "verified")
            self.assertEqual((root / ".env").read_bytes(), before_env)
            self.assertEqual((root / ".env.local").read_bytes(), before_local)
            rollback_child = ("import os\nfrom project_state.recovery import config as tx\n"
                              "original=tx._move_to_displaced\n"
                              "def stop(source,destination,expected):\n"
                              " original(source,destination,expected)\n"
                              " if destination.name.endswith('.rollback-post'): os._exit(88)\n"
                              "tx._move_to_displaced=stop\n"
                              f"tx.rollback_operation(r'{root}','{operation_id}')\n")
            proc = subprocess.run([sys.executable, "-c", rollback_child], cwd=root,
                                  capture_output=True, text=True, timeout=45)
            self.assertEqual(proc.returncode, 88, proc.stderr)
            rollback_resume = ("from project_state.recovery.config import rollback_operation; "
                               f"print(rollback_operation(r'{root}','{operation_id}')['status'])")
            proc = subprocess.run([sys.executable, "-c", rollback_resume], cwd=root,
                                  capture_output=True, text=True, timeout=45)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), "rolled-back")
            self.assertEqual((root / ".env").read_bytes(), after_env)
            self.assertFalse((root / ".env.local").exists())
            self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), head)
            self.assertEqual(hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest(), index)
            self.assertEqual(subprocess.check_output(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"], cwd=root, text=True), refs)

    def test_multi_config_batch_recovers_new_process_at_each_first_target_boundary(self):
        boundaries = ("displace-intent", "displaced", "publish-intent", "after-publish")
        for number, boundary in enumerate(boundaries):
            with self.subTest(boundary=boundary), temporary_directory() as tmp:
                root = Path(tmp)
                before_env, before_local = b"TOKEN=before\r\n", b"PORT=12716\n"
                after_env, after_local = b"TOKEN=after\r\n", b"PORT=12717\n"
                (root / ".env").write_bytes(before_env)
                (root / ".env.local").write_bytes(before_local)
                head, index, refs = self._project(root, before_env)
                self.assertEqual(self._invoke(root, "snapshot", f"batch-cut-{number}")[0], 0)
                (root / ".env").write_bytes(after_env)
                (root / ".env.local").write_bytes(after_local)
                child = [
                    "import os",
                    "from project_state.recovery import config as tx",
                ]
                if boundary == "after-publish":
                    child.extend([
                        "original=tx._move_noreplace",
                        "def stop(source,destination):",
                        " original(source,destination)",
                        " if destination.name == '.env': os._exit(93)",
                        "tx._move_noreplace=stop",
                    ])
                else:
                    child.extend([
                        "original=tx._record",
                        "def stop(root,operation,state):",
                        " result=original(root,operation,state)",
                        f" if state['resources'][0]['phase'] == '{boundary}': os._exit({90+number})",
                        " return result",
                        "tx._record=stop",
                    ])
                child.extend([
                    "from project_state.application import apply_config_restore",
                    f"apply_config_restore(r'{root}', 'batch-cut-{number}')",
                ])
                proc = subprocess.run([sys.executable, "-c", "\n".join(child)], cwd=root,
                                      capture_output=True, text=True, timeout=35)
                expected_exit = 93 if boundary == "after-publish" else 90 + number
                self.assertEqual(proc.returncode, expected_exit, proc.stderr)
                operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
                inspection = inspect_operation(root, operation_id)
                self.assertIn(inspection["classification"], {"not-applied", "interrupted"})
                resume = ("from project_state.recovery.config import continue_operation; "
                          f"continue_operation(r'{root}','{operation_id}')")
                proc = subprocess.run([sys.executable, "-c", resume], cwd=root,
                                      capture_output=True, text=True, timeout=45)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual((root / ".env").read_bytes(), before_env)
                self.assertEqual((root / ".env.local").read_bytes(), before_local)
                rollback = ("from project_state.recovery.config import rollback_operation; "
                            f"rollback_operation(r'{root}','{operation_id}')")
                proc = subprocess.run([sys.executable, "-c", rollback], cwd=root,
                                      capture_output=True, text=True, timeout=45)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual((root / ".env").read_bytes(), after_env)
                self.assertEqual((root / ".env.local").read_bytes(), after_local)
                self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), head)
                self.assertEqual(hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest(), index)
                self.assertEqual(subprocess.check_output(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"], cwd=root, text=True), refs)

    def test_multi_config_batch_preserves_external_file_after_process_interruption(self):
        from project_state.storage import validate_pair
        for index, target in enumerate((".env", ".env.local")):
            with self.subTest(target=target), temporary_directory() as tmp:
                root = Path(tmp)
                original_env, original_local = b"TOKEN=before\r\n", b"PORT=12716\n"
                (root / ".env").write_bytes(original_env)
                (root / ".env.local").write_bytes(original_local)
                self._project(root, original_env)
                self.assertEqual(self._invoke(root, "snapshot", f"batch-external-{index}")[0], 0)
                (root / ".env").write_bytes(b"TOKEN=after!\r\n")
                (root / ".env.local").write_bytes(b"PORT=12717\n")
                external = b"TOKEN=external-owned\r\n" if target == ".env" else b"PORT=external-owned\n"
                child = (
                    "import os\nfrom project_state.recovery import config as tx\n"
                    "original=tx._record\n"
                    "def stop(root,operation,state):\n"
                    " result=original(root,operation,state)\n"
                    " if state.get('resources') and state['resources'][0].get('phase')=='displaced': os._exit(96)\n"
                    " return result\n"
                    "tx._record=stop\n"
                    "from project_state.application import apply_config_restore\n"
                    f"apply_config_restore(r'{root}','batch-external-{index}')\n"
                )
                crashed = subprocess.run([sys.executable, "-c", child], cwd=root,
                                         capture_output=True, text=True, timeout=30)
                self.assertEqual(crashed.returncode, 96, crashed.stderr)
                operation_id = next(path.name for path in (state_dir(root) / "operations").iterdir() if path.is_dir())
                (root / target).write_bytes(external)
                before_records = load_records(root, operation_id)
                source = before_records[-1]["source"]
                safety = before_records[-1]["safety"]
                with self.assertRaises(ProjectStateError) as raised:
                    continue_operation(root, operation_id)
                self.assertEqual(raised.exception.code, "EOPERATION_UNCERTAIN")
                self.assertEqual((root / target).read_bytes(), external)
                if target == ".env":
                    self.assertEqual((root / ".env.local").read_bytes(), b"PORT=12717\n")
                else:
                    self.assertEqual((root / ".env").read_bytes(), original_env)
                after_records = load_records(root, operation_id)
                self.assertGreaterEqual(after_records[-1]["sequence"], before_records[-1]["sequence"])
                self.assertNotIn(after_records[-1]["phase"], {"completed", "rolled-back"})
                self.assertEqual(inspect_operation(root, operation_id)["classification"], "uncertain")
                pair = validate_pair(root, safety["name"], safety["generation"])
                self.assertTrue(pair["generation"] == safety["generation"])
                self.assertTrue((state_dir(root) / "secrets" / safety["name"] / "generations" / safety["generation"]).is_dir())
                self.assertEqual(source["name"], f"batch-external-{index}")

    def test_legacy_pending_config_journal_is_inspectable_but_not_claimable(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a, b = b"TOKEN=fictional-a\r\n", b"TOKEN=fictional-b\r\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "legacy-fixture")[0], 0)
            (root / ".env").write_bytes(b)
            result = apply_config_restore(root, "legacy-fixture")
            directory = operation_dir(root, result["operationId"])
            paths = sorted(directory.glob("record-*.json"))
            previous = None
            values = []
            for sequence, path in enumerate(paths):
                value = json.loads(path.read_text("utf-8"))
                value.pop("ownerBinding", None)
                value.pop("resolverClaim", None)
                value["previousRecordSha256"] = previous
                if sequence == len(paths) - 1:
                    value["status"], value["phase"] = "in-progress", "published"
                data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
                path.write_bytes(data)
                previous = hashlib.sha256(data).hexdigest()
                values.append(value)
            # The obsolete resolver directory is absent, matching an a35 journal.
            resolver_dir = state_dir(root) / "resolvers" / result["operationId"]
            if resolver_dir.exists():
                import shutil
                shutil.rmtree(resolver_dir)
            inspected = inspect_operation(root, result["operationId"])
            self.assertEqual(inspected["resolver"], "legacy-unbound")
            self.assertEqual(inspected["recoveryActions"], [])
            with self.assertRaises(ProjectStateError) as raised:
                from project_state.restore_transaction import continue_operation
                continue_operation(root, result["operationId"])
            self.assertEqual(raised.exception.code, "ERECOVERY_LEGACY")

    def test_corrupt_resolver_claim_blocks_inspection_without_touching_target(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a, b = b"TOKEN=fictional-alpha\n", b"TOKEN=fictional-beta\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b)
            result = apply_config_restore(root, "state-a")
            self.assertEqual((root / ".env").read_bytes(), a)
            rollback_operation(root, result["operationId"])
            self.assertEqual((root / ".env").read_bytes(), b)
            claim = state_dir(root) / "resolvers" / result["operationId"] / "claim-000000.json"
            original = claim.read_bytes()
            changed = original.replace(b'"action":"rollback"', b'"action":"continue"')
            self.assertNotEqual(original, changed)
            claim.write_bytes(changed)
            with self.assertRaises(ProjectStateError) as raised:
                inspect_operation(root, result["operationId"])
            self.assertEqual(raised.exception.code, "ERESOLVER_INVALID")
            self.assertEqual((root / ".env").read_bytes(), b)

    def test_rollback_restores_previously_missing_target(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional-alpha\n")
            self._project(root, b"TOKEN=fictional-alpha\n")
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").unlink()
            result = apply_config_restore(root, "state-a")
            self.assertEqual((root / ".env").read_bytes(), b"TOKEN=fictional-alpha\n")
            rollback_operation(root, result["operationId"])
            self.assertFalse((root / ".env").exists())

    def test_prepared_missing_target_can_be_continued_or_cancelled_after_real_process_exit(self):
        for action in ("continue", "rollback"):
            with self.subTest(action=action), temporary_directory() as tmp:
                root = Path(tmp)
                a = b"TOKEN=fictional-alpha\\n"
                (root / ".env").write_bytes(a)
                self._project(root, a)
                self.assertEqual(self._invoke(root, "snapshot", f"prepared-{action}")[0], 0)
                (root / ".env").unlink()
                env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src"))
                child_code = """
import os
from project_state.recovery import config as tx
from project_state.cli import main
original = tx._record
def stop_after_prepared(root, operation_id, state):
    result = original(root, operation_id, state)
    if state.get('phase') == 'prepared': os._exit(73)
    return result
tx._record = stop_after_prepared
raise SystemExit(main(['restore', NAME, '--only', 'config', '--yes']))
""".replace("NAME", repr(f"prepared-{action}"))
                killed = subprocess.run([sys.executable, "-c", child_code], cwd=root, env=env,
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual(killed.returncode, 73, killed.stderr)
                op_id = next(path.name for path in (state_dir(root) / "operations").iterdir()
                             if path.is_dir())
                before = inspect_operation(root, op_id)
                self.assertEqual(before["phase"], "prepared")
                self.assertIn("--continue", before["recoveryActions"])
                self.assertIn("--rollback", before["recoveryActions"])
                if action == "continue":
                    result = continue_operation(root, op_id)
                    self.assertEqual(result["status"], "verified")
                    self.assertEqual((root / ".env").read_bytes(), a)
                    self.assertEqual(rollback_operation(root, op_id)["status"], "rolled-back")
                    self.assertFalse((root / ".env").exists())
                else:
                    result = rollback_operation(root, op_id)
                    self.assertEqual(result["status"], "cancelled")
                    self.assertFalse((root / ".env").exists())
                    self.assertEqual(self._invoke(root, "snapshot", f"after-{action}")[0], 0)

    def test_published_unverified_rollback_refuses_before_claim_or_stage(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a, b = b"TOKEN=alpha\\n", b"TOKEN=beta!\\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "publish-check")[0], 0)
            (root / ".env").write_bytes(b)
            env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src"))
            code = """
import os
from project_state.recovery import config as tx
from project_state.cli import main
original = tx._record
def stop(root, operation_id, state):
    value = original(root, operation_id, state)
    if state.get('phase') == 'published': os._exit(74)
    return value
tx._record = stop
raise SystemExit(main(['restore', 'publish-check', '--only', 'config', '--yes']))
"""
            killed = subprocess.run([sys.executable, "-c", code], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(killed.returncode, 74, killed.stderr)
            op_id = next(path.name for path in (state_dir(root) / "operations").iterdir()
                         if path.is_dir())
            self.assertEqual(inspect_operation(root, op_id)["recoveryActions"], ["--continue"])
            with self.assertRaises(ProjectStateError):
                rollback_operation(root, op_id)
            operation_dir_path = state_dir(root) / "operations" / op_id
            self.assertFalse((state_dir(root) / "staging" / op_id / "private" / "rollback.stage").exists())
            self.assertFalse((state_dir(root) / "resolvers" / op_id).exists())
            self.assertEqual((root / ".env").read_bytes(), a)
            self.assertEqual(continue_operation(root, op_id)["status"], "verified")
            self.assertEqual(rollback_operation(root, op_id)["status"], "rolled-back")
            self.assertEqual((root / ".env").read_bytes(), b)

    def test_rollback_preserves_external_replacement(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a = b"TOKEN=fictional-alpha\n"
            b = b"TOKEN=fictional-beta\n"
            c = b"TOKEN=fictional-external\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b)
            result = apply_config_restore(root, "state-a")
            replacement = root / ".env.external"
            replacement.write_bytes(c)
            (root / ".env").unlink()
            os.replace(replacement, root / ".env")
            with self.assertRaises(ProjectStateError):
                rollback_operation(root, result["operationId"])
            self.assertEqual((root / ".env").read_bytes(), c)

    def test_external_replacement_at_quarantine_boundary_is_returned_without_overwrite(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a, b, c = b"A=1\n", b"A=2\n", b"A=external\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b)
            result = apply_config_restore(root, "state-a")
            import project_state.recovery.config as tx
            real_move = tx._move_noreplace
            original_proof = tx._file_proof
            replacement_file_id = None
            def racing_move(source, destination):
                nonlocal replacement_file_id
                if destination.name.endswith("rollback-post"):
                    replacement = root / ".env.racing"
                    replacement.write_bytes(c)
                    os.replace(replacement, source)
                    replacement_file_id = original_proof(source)["fileId"]
                return real_move(source, destination)
            with mock.patch.object(tx, "_move_noreplace", side_effect=racing_move):
                with self.assertRaises(ProjectStateError):
                    rollback_operation(root, result["operationId"])
            self.assertEqual((root / ".env").read_bytes(), c)
            self.assertEqual(tx._file_proof(root / ".env")["fileId"], replacement_file_id)
            self.assertEqual(inspect_operation(root, result["operationId"])["classification"], "uncertain")

    def test_new_process_continues_after_real_termination_at_published_record(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a = b"TOKEN=fictional-alpha\n"
            b = b"TOKEN=fictional-beta\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b)
            code = """
import os, sys
from project_state.recovery import config as tx
from project_state.cli import main
original = tx._record
def stop_after_publish(root, operation_id, state):
    result = original(root, operation_id, state)
    if state.get('phase') == 'published':
        os._exit(73)
    return result
tx._record = stop_after_publish
raise SystemExit(main(['restore', 'state-a', '--only', 'config', '--yes']))
"""
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
            child = subprocess.run([sys.executable, "-c", code], cwd=root, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(child.returncode, 73)
            operations = state_dir(root) / "operations"
            operation_id = next(p.name for p in operations.iterdir() if p.is_dir())
            # The restore reached its publish boundary but did not reach a
            # terminal journal state. A new snapshot must not race recovery.
            blocked = subprocess.run(
                [sys.executable, "-c", "from project_state.cli import main; raise SystemExit(main(['snapshot','must-wait']))"],
                cwd=root, env=env, capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(blocked.returncode, 2, blocked.stderr)
            self.assertIn("ERECOVERY_REQUIRED", blocked.stderr)
            self.assertFalse((state_dir(root) / "snapshots" / "must-wait").exists())
            self.assertEqual((root / ".env").read_bytes(), a)
            blocked_restore = subprocess.run(
                [sys.executable, "-c", "from project_state.cli import main; raise SystemExit(main(['restore','state-a','--only','config','--yes']))"],
                cwd=root, env=env, capture_output=True, text=True, timeout=15,
            )
            self.assertNotEqual(blocked_restore.returncode, 0)
            self.assertIn("ERECOVERY_REQUIRED", blocked_restore.stderr)
            self.assertEqual((root / ".env").read_bytes(), a)
            result = subprocess.run([sys.executable, "-c", f"from project_state.cli import main; raise SystemExit(main(['recover','{operation_id}','--inspect']))"], cwd=root, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('published-awaiting-verification', result.stdout)
            result = subprocess.run([sys.executable, "-c", f"from project_state.cli import main; raise SystemExit(main(['recover','{operation_id}','--continue','--yes']))"], cwd=root, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / ".env").read_bytes(), a)
            self.assertIn('completed', inspect_operation(root, operation_id)["classification"])

    def test_resolver_claim_and_operation_pointer_interruptions_are_reentrant(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a, b = b"TOKEN=fictional-alpha\n", b"TOKEN=fictional-beta\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b)
            source_root = Path(__file__).resolve().parents[1] / "src"
            env = dict(os.environ, PYTHONPATH=str(source_root))

            initial_crash = """
import os
from project_state.recovery import config as tx
from project_state.cli import main
original = tx._record
def stop_before_publish(root, operation_id, state):
    result = original(root, operation_id, state)
    if state.get('phase') == 'publish-intent': os._exit(73)
    return result
tx._record = stop_before_publish
raise SystemExit(main(['restore','state-a','--only','config','--yes']))
"""
            first = subprocess.run([sys.executable, "-c", initial_crash], cwd=root, env=env,
                                   capture_output=True, text=True, timeout=15)
            self.assertEqual(first.returncode, 73, first.stderr)
            operation_id = next(p.name for p in (state_dir(root) / "operations").iterdir())
            displaced = state_dir(root) / "staging" / operation_id / "private" / "restore.previous"
            self.assertFalse((root / ".env").exists())
            self.assertEqual(displaced.read_bytes(), b)

            claim_crash = """
import os
import project_state.recovery.config as resolver
from project_state.cli import main
original = resolver.begin_recovery
def stop_after_claim(*args, **kwargs):
    result = original(*args, **kwargs)
    os._exit(74)
resolver.begin_recovery = stop_after_claim
raise SystemExit(main(['recover', os.environ['TEST_OPERATION_ID'], '--continue', '--yes']))
"""
            child_env = dict(env, TEST_OPERATION_ID=operation_id)
            second = subprocess.run([sys.executable, "-c", claim_crash], cwd=root, env=child_env,
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(second.returncode, 74, second.stderr)
            self.assertFalse((root / ".env").exists())
            self.assertEqual(displaced.read_bytes(), b)
            claim_dir = state_dir(root) / "resolvers" / operation_id
            self.assertEqual(len(list(claim_dir.glob("claim-*.json"))), 1)
            self.assertNotIn("resolverClaim", load_records(root, operation_id)[-1])

            pointer_crash = """
import os
import project_state.recovery.config as tx
from project_state.cli import main
original = tx._record
def stop_after_pointer(root, operation_id, state):
    result = original(root, operation_id, state)
    if state.get('resolverClaim'): os._exit(75)
    return result
tx._record = stop_after_pointer
raise SystemExit(main(['recover', os.environ['TEST_OPERATION_ID'], '--continue', '--yes']))
"""
            third = subprocess.run([sys.executable, "-c", pointer_crash], cwd=root, env=child_env,
                                   capture_output=True, text=True, timeout=15)
            self.assertEqual(third.returncode, 75, third.stderr)
            self.assertFalse((root / ".env").exists())
            self.assertEqual(displaced.read_bytes(), b)
            pointer_state = load_records(root, operation_id)[-1]
            self.assertEqual(pointer_state["resolverClaim"]["sequence"], 1)

            recovered = self._invoke(root, "recover", operation_id, "--continue", "--yes")
            self.assertEqual(recovered[0], 0, recovered[2])
            self.assertEqual((root / ".env").read_bytes(), a)
            records = [json.loads(path.read_text("utf-8")) for path in sorted(claim_dir.glob("claim-*.json"))]
            self.assertEqual([record["status"] for record in records], ["active", "active", "active", "completed"])
            self.assertEqual(len({record["claimId"] for record in records}), 3)
            self.assertEqual(inspect_operation(root, operation_id)["classification"], "completed")
            self.assertEqual(self._invoke(root, "snapshot", "after-recovery")[0], 0)

    def test_only_one_live_resolver_can_advance_a_pending_operation(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            a, b = b"TOKEN=fictional-alpha\n", b"TOKEN=fictional-beta\n"
            (root / ".env").write_bytes(a)
            self._project(root, a)
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b)
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
            interrupted = """
import os
from project_state.recovery import config as tx
from project_state.cli import main
original=tx._record
def stop(root, op, state):
 result=original(root,op,state)
 if state.get('phase')=='published': os._exit(73)
 return result
tx._record=stop
raise SystemExit(main(['restore','state-a','--only','config','--yes']))
"""
            child = subprocess.run([sys.executable, "-c", interrupted], cwd=root, env=env,
                                   capture_output=True, text=True, timeout=20)
            self.assertEqual(child.returncode, 73, child.stderr)
            operation_id = next((state_dir(root) / "operations").iterdir()).name
            ready = root / "resolver.ready"
            release = root / "resolver.release"
            resolver = f"""
import time
from pathlib import Path
from project_state.recovery import config as tx
original=tx._record
def pause_before_terminal(root, op, state):
 if state.get('phase')=='verified':
  Path({str(ready)!r}).write_bytes(b'ready')
  limit=time.monotonic()+10
  while not Path({str(release)!r}).exists():
   if time.monotonic()>limit: raise SystemExit(75)
   time.sleep(0.01)
 return original(root,op,state)
tx._record=pause_before_terminal
tx.continue_operation({str(root)!r},{operation_id!r})
"""
            child = subprocess.Popen([sys.executable, "-c", resolver], cwd=root, env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            try:
                deadline = __import__("time").monotonic() + 10
                while not ready.exists() and child.poll() is None and __import__("time").monotonic() < deadline:
                    __import__("time").sleep(0.01)
                self.assertTrue(ready.exists(), "first resolver did not reach the held journal boundary")
                self.assertIsNone(child.poll(), "first resolver exited before the competing attempt")
                competing = subprocess.run(
                    [sys.executable, "-c",
                     "from project_state.cli import main; raise SystemExit(main(['recover','" + operation_id + "','--continue','--yes']))"],
                    cwd=root, env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(competing.returncode, 2, competing.stderr)
                self.assertIn("ELOCKED", competing.stderr)
                release.write_bytes(b"continue")
                out, err = child.communicate(timeout=20)
                self.assertEqual(child.returncode, 0, err)
                self.assertEqual((root / ".env").read_bytes(), a)
                self.assertEqual(inspect_operation(root, operation_id)["classification"], "completed")
            finally:
                if child.poll() is None:
                    release.write_bytes(b"abort")
                    child.terminate()
                    child.communicate(timeout=10)


    def test_third_process_resumes_rollback_at_intent_quarantine_and_publish_windows(self):
        for stop_at, exit_code in (("intent", 81), ("quarantined", 82), ("published", 83)):
            with self.subTest(window=stop_at), temporary_directory() as tmp:
                root = Path(tmp)
                a = b"TOKEN=fictional-alpha\r\n"
                b = b"TOKEN=fictional-beta\r\n"
                (root / ".env").write_bytes(a)
                head, git_index, refs = self._project(root, a)
                self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
                (root / ".env").write_bytes(b)
                applied = apply_config_restore(root, "state-a")
                operation_id = applied["operationId"]
                safety_ref = applied["safety"]
                if stop_at == "intent":
                    child = "import os\nfrom project_state.recovery import config as tx\noriginal=tx._record\ndef stop(root, op, state):\n result=original(root,op,state)\n if state.get('phase')=='rollback-displace-intent': os._exit(81)\n return result\ntx._record=stop\ntx.rollback_operation(r'" + str(root) + "','" + operation_id + "')\n"
                elif stop_at == "quarantined":
                    child = "import os\nfrom project_state.recovery import config as tx\noriginal=tx._move_to_displaced\ndef stop(target,destination,expected):\n result=original(target,destination,expected)\n if destination.name.endswith('.rollback-post'): os._exit(82)\n return result\ntx._move_to_displaced=stop\ntx.rollback_operation(r'" + str(root) + "','" + operation_id + "')\n"
                else:
                    child = "import os\nfrom project_state.recovery import config as tx\noriginal=os.rename\ndef stop(source,destination):\n result=original(source,destination)\n if str(destination).endswith(r'\\.env'): os._exit(83)\n return result\nos.rename=stop\ntx.rollback_operation(r'" + str(root) + "','" + operation_id + "')\n"
                env = dict(os.environ)
                env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
                crashed = subprocess.run([sys.executable, "-c", child], cwd=root, env=env,
                                         capture_output=True, text=True, timeout=20)
                self.assertEqual(crashed.returncode, exit_code, crashed.stderr)
                inspect = subprocess.run([sys.executable, "-c",
                    "from project_state.restore_transaction import inspect_operation; import json; print(json.dumps(inspect_operation(r'" + str(root) + "','" + operation_id + "')))"],
                    cwd=root, env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(inspect.returncode, 0, inspect.stderr)
                self.assertNotIn('"classification": "uncertain"', inspect.stdout)
                recovered = subprocess.run([sys.executable, "-c",
                    "from project_state.cli import main; raise SystemExit(main(['recover','" + operation_id + "','--continue','--yes']))"],
                    cwd=root, env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(recovered.returncode, 0, recovered.stderr)
                self.assertEqual((root / ".env").read_bytes(), b)
                self.assertEqual(inspect_operation(root, operation_id)["classification"], "rolled-back")
                safety = state_dir(root) / "secrets" / safety_ref["name"] / "generations" / safety_ref["generation"]
                self.assertTrue(safety.is_dir())
                self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), head)
                self.assertEqual(hashlib.sha256((root / ".git" / "index").read_bytes()).hexdigest(), git_index)
                self.assertEqual(subprocess.check_output(["git", "for-each-ref", "--format=%(refname) %(objectname)", "refs/"], cwd=root, text=True), refs)

    def test_journal_rejects_non_monotonic_and_mistyped_records(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional-alpha\n")
            self._project(root, b"TOKEN=fictional-alpha\n")
            self.assertEqual(self._invoke(root, "snapshot", "state-a")[0], 0)
            (root / ".env").write_bytes(b"TOKEN=fictional-beta\n")
            result = apply_config_restore(root, "state-a")
            op_id = result["operationId"]
            records = load_records(root, op_id)
            latest = records[-1]
            folder = operation_dir(root, op_id)
            current_path = folder / f"record-{latest['sequence']:06d}.json"
            record_hash = hashlib.sha256(current_path.read_bytes()).hexdigest()
            changed_target = {**latest, "sequence": len(records),
                              "previousRecordSha256": record_hash, "target": ".env.local"}
            with self.assertRaises(ProjectStateError):
                append_record(root, op_id, changed_target)
            malformed_type = {**latest, "sequence": len(records),
                              "previousRecordSha256": record_hash, "status": []}
            with self.assertRaises(ProjectStateError):
                append_record(root, op_id, malformed_type)
            self.assertEqual(len(load_records(root, op_id)), len(records))

    def test_snapshot_cannot_race_a_restore_global_write_lock(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / ".env").write_bytes(b"TOKEN=fictional\n")
            self._project(root, b"TOKEN=fictional\n")
            ready = root.parent / f"{root.name}.lock-held"
            env = dict(os.environ)
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
            child_code = "import time; from pathlib import Path; from project_state.snapshot import _lock; import sys; lock=_lock(Path(sys.argv[1]),'transaction'); Path(sys.argv[2]).write_text('ready'); time.sleep(10); lock.release()"
            child = subprocess.Popen([sys.executable, "-c", child_code, str(root), str(ready)],
                                     cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                import time
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "lock owner did not publish its ready marker")
                code, _, error = self._invoke(root, "snapshot", "blocked-snapshot")
                self.assertEqual(code, 2)
                self.assertIn("ELOCKED", error)
                self.assertFalse((state_dir(root) / "snapshots" / "blocked-snapshot").exists())
            finally:
                child.terminate()
                child.wait(timeout=5)
                ready.unlink(missing_ok=True)

if __name__ == "__main__":
    unittest.main()
