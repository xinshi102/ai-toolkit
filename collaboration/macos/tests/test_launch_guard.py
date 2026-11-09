import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('launch_guard', Path(__file__).parents[1] / 'launch_guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class TimeoutTests(unittest.TestCase):
    def test_accepts_bounded_integers(self):
        for value in (1, 180, guard.MAX_TIMEOUT_SECONDS):
            self.assertEqual(guard.check_timeout(value), value)

    def test_rejects_out_of_range_and_non_integers(self):
        for value in (0, -1, guard.MAX_TIMEOUT_SECONDS + 1, 1.5, True, '180', None):
            with self.subTest(value=value), self.assertRaises(guard.LaunchDenied):
                guard.check_timeout(value)


class ModelTests(unittest.TestCase):
    def test_opencode_free_model_only(self):
        guard.check_model('opencode', guard.FREE_MODEL)
        with self.assertRaises(guard.LaunchDenied):
            guard.check_model('opencode', 'paid/model')
        with self.assertRaises(guard.LaunchDenied):
            guard.check_model('opencode', guard.SHARED_DEEPSEEK_MODEL)

    def test_shared_route_is_opt_in(self):
        guard.check_model('opencode', guard.SHARED_DEEPSEEK_MODEL, shared_deepseek=True)

    def test_dsh_flash_only(self):
        for value in guard.DSH_MODELS:
            guard.check_model('dsh', value)
        for value in (guard.FREE_MODEL, 'gpt-4o', ''):
            with self.subTest(value=value), self.assertRaises(guard.LaunchDenied):
                guard.check_model('dsh', value)

    def test_unknown_harness_rejected(self):
        with self.assertRaises(guard.LaunchDenied):
            guard.check_model('kimi', 'x')


class WorkspaceTests(unittest.TestCase):
    def test_real_directory_resolves(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'run'
            directory.mkdir()
            self.assertEqual(guard.check_directory(directory), directory.resolve())

    def test_missing_home_and_root_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(guard.LaunchDenied):
                guard.check_directory(Path(root) / 'missing')
        for value in (Path.home(), Path('/')):
            with self.assertRaises(guard.LaunchDenied):
                guard.check_directory(value)


class FilenameTests(unittest.TestCase):
    def test_plain_filenames_only(self):
        for name in ('brief.json', 'run-1-output.json'):
            self.assertEqual(guard.check_filename(name, 'brief'), name)
        for name in ('../x', '/tmp/x', 'a/b', '..', '', 'a\\b', '*.json', 'b?.json', None, 7):
            with self.subTest(name=name), self.assertRaises(guard.LaunchDenied):
                guard.check_filename(name, 'brief')


class CheckTests(unittest.TestCase):
    def test_combined_check_rejects_identical_files(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with self.assertRaises(guard.LaunchDenied):
                guard.check('opencode', model=guard.FREE_MODEL, timeout=180, directory=directory,
                            brief='same.json', output='same.json')

    def test_combined_check_returns_resolved_directory(self):
        with tempfile.TemporaryDirectory() as root:
            resolved = guard.check('opencode', model=guard.FREE_MODEL, timeout=180,
                                   directory=Path(root), brief='brief.json', output='out.json')
            self.assertEqual(resolved, Path(root).resolve())


if __name__ == '__main__':
    unittest.main()
