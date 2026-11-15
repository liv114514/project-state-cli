from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from typing import get_type_hints
from unittest import TestCase, mock

from project_state import application
from project_state.contracts.capabilities import CROSS_VOLUME_MESSAGE
from project_state.contracts.errors import ProjectStateError
from project_state.contracts.results import OperationInspection, RestorePlan
from project_state.foundation import location
from project_state.recovery import config, planning
from project_state import cli
from tests._support import temporary_directory


class ContractUseTests(TestCase):
    def test_cross_volume_diagnostic_is_shared_and_does_not_change_code(self):
        denied = ProjectStateError('ECROSS_VOLUME_UNSUPPORTED', 'old text', 2)
        with mock.patch.object(location, 'require_same_volume', side_effect=denied):
            with self.assertRaises(ProjectStateError) as caught:
                location.check_restore_location(Path('synthetic-target'), Path('synthetic-state'))
        self.assertEqual(caught.exception.code, 'ECROSS_VOLUME_UNSUPPORTED')
        self.assertEqual(str(caught.exception), CROSS_VOLUME_MESSAGE)
        with temporary_directory() as tmp:
            with mock.patch.object(application, 'plan_config_restore', side_effect=caught.exception):
                result = application.task_doctor(tmp, 'config-restore', 'synthetic')
        check = result['checks'][1]
        self.assertEqual(check['reasonCode'], 'ECROSS_VOLUME_UNSUPPORTED')
        self.assertEqual(check['message'], CROSS_VOLUME_MESSAGE)
        self.assertEqual(result['summary']['state'], 'blocked')
        self.assertIn('automatic relocation is not supported', check['message'])

    def test_safety_reference_binds_verified_snapshot_identity(self):
        adapter = application.CaptureSafetyPointAdapter(mock.Mock())
        pair = {'name': 'safety-test', 'generation': 'a'*32,
                'manifest': {'schemaVersion': 2}, 'artifacts': [
                    {'id':'config:.env','layer':'config','kind':'file','target':'.env',
                     'privacy':'private','restore':'restore-file','size':3,'sha256':'f'*64}]}
        with mock.patch.object(application.capture_snapshot, 'create_snapshot', return_value={'generation':'a'*32, 'state':'verified'}), \
             mock.patch.object(application, 'validate_pair', return_value=pair):
            reference = adapter.create_safety_point(Path('project'), 'safety-test', object())
        self.assertTrue(reference.verified)
        self.assertEqual((reference.name, reference.generation), ('safety-test','a'*32))
        self.assertEqual(reference.protected_artifacts[0].target, '.env')
        with mock.patch.object(application.capture_snapshot, 'create_snapshot', return_value={'generation':'b'*32, 'state':'verified'}), \
             mock.patch.object(application, 'validate_pair', return_value=pair):
            self.assertFalse(adapter.create_safety_point(Path('project'), 'safety-test', object()).verified)

    def test_actual_public_use_cases_expose_internal_result_types(self):
        self.assertIs(get_type_hints(planning.plan_config_restore)['return'], RestorePlan)
        self.assertIs(get_type_hints(config.inspect_operation)['return'], OperationInspection)
        capability = next(x for x in application.capabilities() if x.name == 'config-restore')
        self.assertEqual(capability.diagnostic.object_kind, 'configuration')
        self.assertIn('private verified artifact', capability.constraints)

    def test_snapshot_and_database_capabilities_drive_diagnosis(self):
        capabilities = {entry.name: entry for entry in application.capabilities()}
        snapshot = capabilities['snapshot']
        self.assertTrue(any('.env.local' in item for item in snapshot.constraints))
        self.assertTrue(any('package-lock.json' in item for item in snapshot.constraints))
        self.assertTrue(any('.node-version' in item for item in snapshot.constraints))
        self.assertIn('private verified SQLite backup', capabilities['sqlite-restore'].constraints)
        self.assertIn('same-volume private state', capabilities['sqlite-restore'].constraints)
        self.assertTrue(capabilities['git-write-restore'].diagnostic.next_step)
        with temporary_directory() as tmp:
            (Path(tmp) / '.env').write_bytes(b'FIXTURE=fictional\n')
            result = application.task_doctor(tmp, 'config-snapshot')
        check = next(item for item in result['checks'] if item['id'] == 'python.snapshot-implementation')
        self.assertEqual(check['message'], snapshot.diagnostic.message)
        self.assertEqual(check['reasonCode'], snapshot.diagnostic.code)

    def test_refusal_guidance_has_category_next_step_and_redacts_internal_exception(self):
        for code in ('EARG_UNKNOWN', 'ECROSS_VOLUME_UNSUPPORTED', 'EJOURNAL_INVALID',
                     'EARTIFACT_INTEGRITY', 'EGIT_DIRTY', 'EDATABASE_BACKUP',
                     'EUNSAFE_PATH', 'EUNKNOWN'):
            with self.subTest(code=code):
                result = application.describe_error(ProjectStateError(code, 'sanitized reason', 2))
                self.assertEqual((result.code, result.message), (code, 'sanitized reason'))
                self.assertTrue(result.object_kind)
                self.assertTrue(result.next_step)
        output, errors = StringIO(), StringIO()
        with mock.patch.object(cli, 'doctor', side_effect=RuntimeError('fictional-private-canary')), \
             redirect_stdout(output), redirect_stderr(errors):
            status = cli.main(['doctor'])
        self.assertEqual(status, 2)
        self.assertEqual(output.getvalue(), '')
        self.assertTrue(errors.getvalue().startswith('EINTERNAL: command failed safely'))
        self.assertIn('Affected: requested operation.', errors.getvalue())
        self.assertIn('Next:', errors.getvalue())
        self.assertNotIn('fictional-private-canary', errors.getvalue())
        output, errors = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = cli.main(['list', '--unknown=fictional-private-canary'])
        self.assertEqual(status, 1)
        self.assertIn('EARG_UNKNOWN:', errors.getvalue())
        self.assertNotIn('fictional-private-canary', errors.getvalue())
