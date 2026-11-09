import importlib.util
from pathlib import Path
import unittest
import tempfile
import fnmatch
from unittest import mock

spec = importlib.util.spec_from_file_location('opencode_adapter', Path(__file__).parents[1] / 'opencode_adapter.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class ScopedConfigTests(unittest.TestCase):
    def test_shared_route_uses_env_reference_only_and_is_opt_in(self):
        original = {'permission': {'bash': 'deny'}}
        self.assertNotIn('provider', mod.provider_config(dict(original), False))
        configured = mod.provider_config(dict(original), True)
        self.assertEqual(configured['provider']['deepseek']['options']['apiKey'], '{env:DEEPSEEK_API_KEY}')
        self.assertEqual(configured['permission'], original['permission'])
        compile(mod.SHARED_LOADER, '<scoped-child-loader>', 'exec')

    def test_escape_is_rejected(self):
        for name in ('../private', '/tmp/private', 'sub/file'):
            with self.assertRaises(ValueError):
                mod.scoped_config(Path('/tmp/synthetic'), name, 'result.json')

    def test_native_cli_matches_repository_relative_paths(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root)
            (repo / '.git').mkdir()
            directory = repo / 'acceptance'
            directory.mkdir()
            p = mod.scoped_config(directory, 'brief.json', 'result.json')['permission']
            self.assertEqual(p['read']['acceptance/brief.json'], 'allow')
            self.assertEqual(p['edit']['acceptance/result.json'], 'allow')
            self.assertNotIn('**/brief.json', p['read'])

    @staticmethod
    def decision(rules, path):
        decision = None
        for pattern, action in rules.items():
            if fnmatch.fnmatchcase(path, pattern):
                decision = action
        return decision

    def test_non_git_all_ancestor_relative_paths_are_exact(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / 'nested' / 'run'
            directory.mkdir(parents=True)
            p = mod.scoped_config(directory, 'brief.json', 'result.json')['permission']
            for ancestor in directory.parents:
                target = str((directory / 'brief.json').relative_to(ancestor))
                self.assertEqual(self.decision(p['read'], target), 'allow')
                self.assertEqual(self.decision(p['read'], './' + target), 'allow')
            for path in (str(directory / 'private.json'), str(directory.parent / 'brief.json'), 'other/brief.json'):
                self.assertEqual(self.decision(p['read'], path), 'deny')
            self.assertEqual(self.decision(p['read'], str(directory / 'result.json')), 'deny')
            self.assertEqual(self.decision(p['edit'], str(directory / 'brief.json')), 'deny')
            self.assertEqual(self.decision(p['external_directory'], str(directory) + '/**'), 'allow')
            self.assertEqual(self.decision(p['external_directory'], str(directory.parent) + '/other/**'), 'deny')
            self.assertEqual(self.decision(p['read'], str(directory / 'nested' / 'brief.json')), 'deny')

    def test_mac_data_alias_requires_samefile_and_remains_scoped(self):
        directory = Path('/Users/synthetic/scoped-run')
        alias = Path('/System/Volumes/Data/Users/synthetic/scoped-run')
        with mock.patch.object(Path, 'samefile', return_value=False):
            p = mod.scoped_config(directory, 'brief.json', 'result.json')['permission']
            self.assertEqual(self.decision(p['read'], str(alias / 'brief.json')), 'deny')
            self.assertEqual(self.decision(p['external_directory'], str(alias) + '/**'), 'deny')
        with mock.patch.object(Path, 'samefile', return_value=True) as check:
            p = mod.scoped_config(directory, 'brief.json', 'result.json')['permission']
            check.assert_called_with(directory)
            self.assertEqual(self.decision(p['read'], str(alias / 'brief.json')), 'allow')
            self.assertEqual(self.decision(p['edit'], str(alias / 'result.json')), 'allow')
            self.assertEqual(self.decision(p['read'], str(alias / 'private.json')), 'deny')
            self.assertEqual(self.decision(p['external_directory'], str(alias.parent / 'other') + '/**'), 'deny')
            self.assertEqual(self.decision(p['external_directory'], '/Users/synthetic/**'), 'deny')

    def test_no_wildcard_file_names_or_directories(self):
        for directory, name in [(Path('/tmp/scoped'), '*.json'), (Path('/tmp/scoped'), 'b?.json'), (Path('/tmp/scope*'), 'brief.json')]:
            with self.assertRaises(ValueError):
                mod.scoped_config(directory, name, 'result.json')

    def test_path_permissions_and_external_tools(self):
        config = mod.scoped_config(Path('/tmp/synthetic'), 'brief.json', 'result.json')
        p = config['permission']
        self.assertNotIn('*', p)  # Global deny blocks even explicitly allowed tool calls in native CLI.
        self.assertEqual(p['read']['*'], 'deny')
        self.assertEqual(p['edit']['*'], 'deny')
        self.assertEqual(p['read']['/tmp/synthetic/brief.json'], 'allow')
        self.assertEqual(p['edit']['/tmp/synthetic/result.json'], 'allow')
        for tool in ('bash', 'task', 'webfetch', 'websearch', 'skill'):
            self.assertEqual(p[tool], 'deny')

if __name__ == '__main__':
    unittest.main()
