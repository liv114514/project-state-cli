from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, mock
from project_state.contracts.errors import ProjectStateError
from project_state.foundation import snapshot_publication
from tests._support import temporary_directory


class PublicationBoundaryTests(TestCase):
    def test_invalid_generation_token_and_wrong_project_lock_are_refused_before_write(self):
        with temporary_directory() as tmp:
            root=Path(tmp); state=root/'synthetic-state'
            with mock.patch.object(snapshot_publication, 'state_dir', return_value=state):
                cases=[('bad-generation', SimpleNamespace(token='a'*32, path=state/'locks'/'operation.lock'), 'EUNSAFE_PATH'),
                       ('b'*32, SimpleNamespace(token='not-a-token', path=state/'locks'/'operation.lock'), 'ELOCK_UNCERTAIN'),
                       ('b'*32, SimpleNamespace(token='a'*32, path=root/'foreign.lock'), 'ELOCK_UNCERTAIN')]
                for generation,lock,expected in cases:
                    with self.subTest(expected=expected,generation=generation):
                        with self.assertRaises(ProjectStateError) as caught:
                            snapshot_publication.publish_snapshot_generation(root,'fixture',generation,b'{}',lock)
                        self.assertEqual(caught.exception.code,expected)
                        self.assertFalse(state.exists())
