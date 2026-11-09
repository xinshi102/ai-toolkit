"""Installation layout contracts; optional real Mac ASAR probe, never inference."""
import os
from pathlib import Path, PureWindowsPath
import sys
import tempfile
import unittest
from unittest import mock

RUNTIME = Path(__file__).resolve().parents[1]
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))

import platform_paths


class LayoutTests(unittest.TestCase):
    def test_mac_app_bundle_with_spaces_and_unicode(self):
        root = Path('/Applications/测试 Apps/DeepSeek Harness.app')
        binary, archive, entry = platform_paths.dsh_layout(root, 'darwin')
        self.assertEqual(binary, root / 'Contents/MacOS/DeepSeek Harness')
        self.assertEqual(archive, root / 'Contents/Resources/app.asar')
        self.assertEqual(entry, archive / 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')

    def test_windows_native_drive_and_spaces(self):
        # Exercise Windows path semantics even on a Mac test host.
        with mock.patch.object(platform_paths, 'Path', PureWindowsPath):
            root = PureWindowsPath(r'C:\Program Files\DeepSeek Harness')
            binary, archive, entry = platform_paths.dsh_layout(root, 'win32')
        self.assertEqual(binary, root / 'DeepSeek Harness.exe')
        self.assertEqual(archive, root / 'resources/app.asar')
        self.assertEqual(entry, archive / 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')

    def test_mac_relative_paths_rejected(self):
        for path in ('', '.', 'Apps/DeepSeek Harness.app', '../DeepSeek Harness.app'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                platform_paths.dsh_layout(path, 'darwin')

    def test_windows_relative_and_drive_relative_paths_rejected(self):
        with mock.patch.object(platform_paths, 'Path', PureWindowsPath):
            for path in ('DeepSeek Harness', r'C:DeepSeek Harness', r'\DeepSeek Harness'):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    platform_paths.dsh_layout(path, 'win32')

    def test_unsupported_platform_fails_closed(self):
        with self.assertRaises(ValueError):
            platform_paths.dsh_layout(Path.cwd(), 'linux')

    def test_reservation_overlap_serializes_case_and_unicode_equivalent_parent(self):
        import workflow
        root = Path.cwd()
        self.assertTrue(workflow.reservation_overlap(root / 'Caf\u00e9',
                                                     root / 'CAFE\u0301' / 'output.txt'))
        self.assertTrue(workflow.reservation_overlap(root / 'Folder',
                                                     root / 'folder' / 'output.txt'))

    @unittest.skipUnless(sys.platform == 'darwin', 'Mac permission boundary semantics')
    def test_authorization_overlap_keeps_case_distinct(self):
        import workflow
        root = Path.cwd()
        self.assertFalse(workflow.overlap(root / 'Folder', root / 'folder' / 'private.txt'))
        self.assertFalse(workflow.overlap(root / 'Caf\u00e9', root / 'Cafe\u0301' / 'private.txt'))


@unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('XINSHI_TEST_REAL_DSH_PREFLIGHT') == '1',
                     'real Mac installation probe requires explicit opt-in')
class RealMacPreflightTests(unittest.TestCase):
    def test_real_readonly_request_probes_asar_without_starting_model(self):
        import dsh_workspace
        root = Path('/Applications/DeepSeek Harness.app')
        binary, archive, entry = platform_paths.dsh_layout(root, 'darwin')
        # Override only installation paths. No host config or credential reads.
        with tempfile.TemporaryDirectory(prefix='xinshi preflight ') as cwd, \
                mock.patch.multiple(dsh_workspace, PROGRAM=root, BINARY=binary,
                                    ARCHIVE=archive, ENTRY=entry), \
                mock.patch.object(dsh_workspace.subprocess, 'run',
                                  wraps=dsh_workspace.subprocess.run) as launch:
            request = dsh_workspace.request({'cwd': cwd, 'prompt': 'not submitted',
                                             'permission': 'read-only'})
            self.assertEqual(launch.call_count, 1)
            args, kwargs = launch.call_args
            self.assertEqual(args[0][:2], [str(binary), '-e'])
            self.assertNotIn('--json', args[0])
            self.assertFalse(kwargs['shell'])
            self.assertEqual(kwargs['env']['ELECTRON_RUN_AS_NODE'], '1')
            self.assertEqual(request['argv'][:2], [str(binary), str(entry)])
            self.assertEqual(request['stdin'], 'not submitted')
            self.assertEqual(request['env_delta']['DSH_PERMISSION_MODE'], 'read-only')


if __name__ == '__main__':
    unittest.main()
