from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import update_delivery_manifest as updater


class ManifestUpdateTests(unittest.TestCase):
    def fixture(self, root: Path) -> None:
        (root / "current").mkdir()
        (root / "tools").mkdir()
        (root / "README.md").write_text("synthetic\n", encoding="utf-8")
        (root / "current" / "source.py").write_text("value = 1\n", encoding="utf-8")
        (root / "DELIVERY-MANIFEST.csv").write_bytes(b"previous-valid-manifest\n")

    def test_atomic_update_excludes_its_temporary_and_lists_exact_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            self.assertEqual(updater.update_manifest(root), 0)
            rows = updater.collect(root, root / "DELIVERY-MANIFEST.csv")
            self.assertEqual([row[0] for row in rows], ["README.md", "current/source.py"])
            self.assertFalse(list(root.glob(".DELIVERY-MANIFEST.csv.tmp-*")))

    def test_failed_publish_preserves_previous_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            old = (root / "DELIVERY-MANIFEST.csv").read_bytes()
            with mock.patch.object(updater.os, "replace", side_effect=PermissionError("injected")):
                self.assertEqual(updater.update_manifest(root), 2)
            self.assertEqual((root / "DELIVERY-MANIFEST.csv").read_bytes(), old)
            self.assertFalse(list(root.glob(".DELIVERY-MANIFEST.csv.tmp-*")))

    def test_undeclared_root_is_refused_without_changing_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            (root / "sandbox").mkdir()
            old = (root / "DELIVERY-MANIFEST.csv").read_bytes()
            self.assertEqual(updater.update_manifest(root), 2)
            self.assertEqual((root / "DELIVERY-MANIFEST.csv").read_bytes(), old)

    def test_unresolvable_root_is_a_controlled_refusal(self):
        with mock.patch("sys.argv", ["update_delivery_manifest.py", "--root", "unreadable"]), \
                mock.patch.object(Path, "resolve", side_effect=PermissionError("injected")):
            self.assertEqual(updater.main(), 2)


if __name__ == "__main__":
    unittest.main()
