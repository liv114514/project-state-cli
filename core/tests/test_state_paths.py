from __future__ import annotations

import os
import unittest
from pathlib import Path

from project_state.errors import ProjectStateError
from project_state.snapshot import create_snapshot
from project_state.state_paths import ensure_state_dir, state_dir
from tests._support import temporary_directory


class StatePathTests(unittest.TestCase):
    def test_python_state_is_external_and_does_not_rewrite_legacy_node_objects(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            legacy_lock = root / ".project-state" / "locks" / "operation.lock"
            legacy_lock.parent.mkdir(parents=True)
            legacy_bytes = b"legacy synthetic lock bytes\n"
            legacy_lock.write_bytes(legacy_bytes)
            (root / ".env").write_bytes(b"TOKEN=fictional\n")

            result = create_snapshot(root, "external-state")

            self.assertEqual(result["state"], "verified")
            self.assertFalse(state_dir(root).is_relative_to(root))
            self.assertEqual(legacy_lock.read_bytes(), legacy_bytes)
            self.assertTrue((state_dir(root) / "state-root.json").is_file())

    def test_state_identity_marker_mismatch_is_preserved_and_rejected(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            state = ensure_state_dir(root)
            marker = state / "state-root.json"
            original = marker.read_bytes()
            marker.write_bytes(original.replace(b"projectIdentity", b"wrongIdentity"))
            damaged = marker.read_bytes()

            with self.assertRaises(ProjectStateError) as caught:
                state_dir(root)

            self.assertEqual(caught.exception.code, "ESTATE_IDENTITY")
            self.assertEqual(marker.read_bytes(), damaged)

    def test_state_identity_marker_hardlink_is_rejected_without_mutation(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            state = ensure_state_dir(root)
            marker = state / "state-root.json"
            alias = state / "marker-alias"
            try:
                os.link(marker, alias)
            except OSError as exc:
                self.skipTest(f"hard links unavailable in this filesystem: {type(exc).__name__}")
            original = marker.read_bytes()

            with self.assertRaises(ProjectStateError) as caught:
                state_dir(root)

            self.assertEqual(caught.exception.code, "EUNSAFE_PATH")
            self.assertEqual(marker.read_bytes(), original)
            self.assertEqual(alias.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
