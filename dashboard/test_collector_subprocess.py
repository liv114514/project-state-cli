from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

COLLECTOR = Path(__file__).resolve().parents[1] / 'collector' / 'collect_data.py'
FIXTURE = r'''import json, os, sys, time
args = sys.argv[1:]
mode = os.environ['FIXTURE_MODE']
if mode == 'timeout': time.sleep(2)
if args == ['--version']:
    print('0.1.0a39'); sys.exit(0)
cmd = args[0]
if cmd == 'list':
    if mode == 'timeout_partial':
        print(json.dumps({'resultSchemaVersion':2,'toolVersion':'0.1.0a39','command':'list','snapshots':[{'name':'demo','state':'verified'}]}), flush=True); time.sleep(2); sys.exit(0)
    if mode == 'sensitive': print('fictional-private-canary', file=sys.stderr); sys.exit(2)
    if mode == 'truncated': print('{"resultSchemaVersion":'); sys.exit(0)
    if mode == 'missing': print('{}'); sys.exit(0)
    if mode == 'wrongtype':
        print(json.dumps({'resultSchemaVersion':2,'toolVersion':'0.1.0a39','command':'list','snapshots':'wrong'})); sys.exit(0)
    print(json.dumps({'resultSchemaVersion':2,'toolVersion':'0.1.0a39','command':'list','snapshots':[{'name':'demo','state':'verified'}] if mode=='show' else []}))
elif cmd == 'show':
    print(json.dumps({'resultSchemaVersion':2,'toolVersion':'0.1.0a39','command':'show','snapshot':{'name':'demo','state':'incomplete'}})); sys.exit(2)
elif cmd == 'compare':
    print('comparison not performed'); sys.exit(2)
elif cmd == 'doctor':
    if '--task' in args and mode == 'partial': print('{broken'); sys.exit(1)
    print(json.dumps({'resultSchemaVersion':1,'toolVersion':'0.1.0a39','command':'doctor','mode':'general','checks':[],'tools':{},'summary':{'state':'issue'}}))
    print('EDIAG: fictional-private-canary', file=sys.stderr)
    sys.exit(2 if mode == 'nonzero' else 0)
elif cmd == 'recover':
    if mode == 'wrongid': print(json.dumps({'resultSchemaVersion':1,'operationId':'other','status':'completed'})); sys.exit(0)
    if mode == 'badrecover': print('not json'); sys.exit(2)
    print(json.dumps({'resultSchemaVersion':1,'operationId':args[1], 'status':args[1]}))
'''

class CollectorSubprocessTests(unittest.TestCase):
    def run_case(self, mode, missing_executable=False):
        with tempfile.TemporaryDirectory(prefix='fixture 中文 ') as tmp:
            root = Path(tmp)
            project, out = root / 'project', root / 'output'
            project.mkdir()
            fixture = root / 'cli fixture.py'
            fixture.write_text(FIXTURE, encoding='utf-8')
            argv = [str(root / 'missing.exe')] if missing_executable else [sys.executable, str(fixture)]
            command = [sys.executable, str(COLLECTOR), '--project', str(project), '--cli-argv', json.dumps(argv), '--out-dir', str(out)]
            for operation in ('cancelled', 'rolled-back', 'pending', 'uncertain', 'unrecognized'):
                command.extend(['--operation', operation])
            env = dict(os.environ, FIXTURE_MODE=mode, PYTHONIOENCODING='utf-8')
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=env, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
            raw = (out / 'live-data.json').read_text(encoding='utf-8')
            js = (out / 'live-data.js').read_text(encoding='utf-8')
            self.assertNotIn('fictional-private-canary', raw + js)
            self.assertIn('window.PROJECT_STATE_DATA', js)
            return json.loads(raw)

    def test_valid_and_nonzero_json_and_operation_states(self):
        for mode in ('valid', 'nonzero'):
            with self.subTest(mode=mode):
                bundle = self.run_case(mode)
                self.assertEqual(bundle['meta']['source'], 'live')
                self.assertEqual(bundle['doctor']['general']['observedExitCode'], 2 if mode == 'nonzero' else 0)
                self.assertEqual(bundle['doctor']['tasks'][0]['observedExitCode'], 2 if mode == 'nonzero' else 0)
                self.assertEqual(bundle['doctor']['general']['verdict'], 'issue')
                self.assertEqual([op['status'] for op in bundle['operations']], ['cancelled','rolled-back','pending','uncertain','unrecognized'])

    def test_invalid_missing_wrong_type_and_partial(self):
        for mode in ('truncated', 'missing', 'wrongtype', 'partial', 'sensitive'):
            with self.subTest(mode=mode):
                bundle = self.run_case(mode)
                self.assertTrue(bundle['meta']['errors'])
                if mode != 'partial':
                    self.assertIsNone(bundle['list'])
                else:
                    self.assertIsNotNone(bundle['list'])

    def test_executable_missing_produces_bundle_with_errors(self):
        bundle = self.run_case('valid', missing_executable=True)
        self.assertTrue(bundle['meta']['errors'])
        self.assertEqual(bundle['meta']['toolVersion'], 'unknown')

    def test_successful_collection_prints_with_legacy_windows_code_page(self):
        # Windows console sessions commonly expose cp936/GBK. The collector's
        # output files are UTF-8, but its human-readable summary must also be
        # writable without raising after the files have already been created.
        with tempfile.TemporaryDirectory(prefix='fixture GBK ') as tmp:
            root = Path(tmp)
            project, out = root / 'project', root / 'output'
            project.mkdir()
            fixture = root / 'cli fixture.py'
            fixture.write_text(FIXTURE, encoding='utf-8')
            command = [sys.executable, str(COLLECTOR), '--project', str(project),
                       '--cli-argv', json.dumps([sys.executable, str(fixture)]),
                       '--out-dir', str(out)]
            env = dict(os.environ, FIXTURE_MODE='valid', PYTHONIOENCODING='gbk')
            result = subprocess.run(command, capture_output=True, text=False, env=env, timeout=40)
            stdout = result.stdout.decode('gbk', errors='replace')
            stderr = result.stderr.decode('gbk', errors='replace')
            self.assertEqual(result.returncode, 0, stderr)
            self.assertIn('[OK] 成功写出 JSON:', stdout)
            self.assertIn('[OK] 成功写出 JS:', stdout)
            self.assertTrue((out / 'live-data.json').is_file())
            self.assertTrue((out / 'live-data.js').is_file())
            bundle = json.loads((out / 'live-data.json').read_text(encoding='utf-8'))
            self.assertEqual(bundle['meta']['source'], 'live')

    def test_nonzero_show_retains_snapshot_and_exit_status(self):
        bundle = self.run_case('show')
        self.assertEqual(bundle['list']['snapshots'][0]['state'], 'incomplete')
        self.assertEqual(bundle['list']['snapshots'][0]['observedExitCode'], 2)
        self.assertEqual(bundle['compares'][0]['exitCode'], 2)

    def test_inspect_wrong_identity_and_missing_json_are_reported(self):
        for mode in ('wrongid', 'badrecover'):
            with self.subTest(mode=mode):
                bundle = self.run_case(mode)
                self.assertFalse(bundle['operations'])
                self.assertEqual(sum(e['command'] == 'recover --inspect' for e in bundle['meta']['errors']), 5)

    def test_timeout_is_reported_in_generated_bundle(self):
        spec = importlib.util.spec_from_file_location('test_collector_timeout', COLLECTOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='fixture timeout ') as tmp:
            root = Path(tmp)
            fixture = root / 'cli.py'
            fixture.write_text(FIXTURE, encoding='utf-8')
            out = root / 'out'
            argv = ['collector', '--project', str(root), '--cli-argv', json.dumps([sys.executable, str(fixture)]), '--out-dir', str(out)]
            from unittest import mock
            with mock.patch.object(module, '_TIMEOUT_SECONDS', 0.1), mock.patch.object(sys, 'argv', argv), mock.patch.dict(os.environ, {'FIXTURE_MODE': 'timeout'}), contextlib.redirect_stdout(io.StringIO()):
                module.main()
            bundle = json.loads((out / 'live-data.json').read_text(encoding='utf-8'))
            self.assertEqual(bundle['meta']['toolVersion'], 'unknown')
            self.assertTrue(any(e['exitCode'] == -2 and e['error'] == 'ETIMEDOUT' for e in bundle['meta']['errors']))

    def test_timed_out_valid_prefix_is_not_accepted(self):
        spec = importlib.util.spec_from_file_location('test_collector_timeout_prefix', COLLECTOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='fixture timeout prefix ') as tmp:
            root = Path(tmp); fixture = root / 'cli.py'; out = root / 'out'
            fixture.write_text(FIXTURE, encoding='utf-8')
            argv = ['collector', '--project', str(root), '--cli-argv', json.dumps([sys.executable, str(fixture)]), '--out-dir', str(out)]
            from unittest import mock
            with mock.patch.object(module, '_TIMEOUT_SECONDS', 0.2), mock.patch.object(sys, 'argv', argv), mock.patch.dict(os.environ, {'FIXTURE_MODE': 'timeout_partial'}), contextlib.redirect_stdout(io.StringIO()):
                module.main()
            bundle = json.loads((out / 'live-data.json').read_text(encoding='utf-8'))
            self.assertIsNone(bundle['list'])
            self.assertTrue(any(e['command'] == 'list --json' and e['error'] == 'ETIMEDOUT' for e in bundle['meta']['errors']))
            self.assertEqual(bundle['compares'], [])

if __name__ == '__main__':
    unittest.main()
