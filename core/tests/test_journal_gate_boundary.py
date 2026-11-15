from pathlib import Path
from unittest import TestCase, mock

from project_state.contracts.errors import ProjectStateError
from project_state.recovery import operation_gate as journal
from tests._support import temporary_directory


class JournalGateBoundaryTests(TestCase):
    def test_database_family_requires_reader_and_checks_terminal_and_legacy(self):
        with temporary_directory() as tmp:
            state = Path(tmp)
            op = state / 'operations' / ('a' * 32)
            op.mkdir(parents=True)
            (op / 'db-record-000000.json').write_bytes(b'fixture')
            with mock.patch.object(journal, 'state_dir', return_value=state):
                with self.assertRaises(ProjectStateError) as blocked:
                    journal.assert_no_unresolved_operations(state, database_reader=None)
                self.assertEqual(blocked.exception.code, 'EOPERATION_UNCERTAIN')
                with self.assertRaises(ProjectStateError) as legacy:
                    journal.assert_no_unresolved_operations(state, database_reader=lambda *_: [{'status': 'in-progress'}])
                self.assertEqual(legacy.exception.code, 'ERECOVERY_LEGACY')
                with self.assertRaises(ProjectStateError) as pending:
                    journal.assert_no_unresolved_operations(state, database_reader=lambda *_: [{'status': 'in-progress', 'ownerBinding': {}}])
                self.assertEqual(pending.exception.code, 'ERECOVERY_REQUIRED')
                journal.assert_no_unresolved_operations(state, database_reader=lambda *_: [{'status': 'completed'}])
