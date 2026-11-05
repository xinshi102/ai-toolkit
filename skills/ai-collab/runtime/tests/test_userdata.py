"""M3: isolated user-data directory, per-store schema versions, idempotent migration.

Every fixture is a TemporaryDirectory plus an explicit AI_COLLAB_DATA override and
a fake installation directory.  Nothing here reads, migrates or writes the real
~/.ai-collab (or any real client session database).  No AI is started.
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import userdata  # noqa: E402
import events  # noqa: E402
import controller_usage  # noqa: E402
import task_runner  # noqa: E402


class UserDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / 'data'
        self.install = self.root / 'install'          # no .git -> treated as an installed copy
        self.runtime = self.install / 'runtime'
        self.runtime.mkdir(parents=True)
        (self.install / '.work').mkdir()
        self.env = mock.patch.dict(os.environ, {userdata.ENV: str(self.data)})
        self.env.start()
        userdata.set_install_dir(self.install)

    def tearDown(self):
        userdata.set_install_dir(None)               # restore default + clear _warmed
        self.env.stop()
        self.tmp.cleanup()

    # -- directory resolution -------------------------------------------------
    def test_env_override_wins(self):
        self.assertEqual(userdata.data_dir(), self.data.resolve())
        self.assertEqual(userdata.path('task_archive.json'), self.data.resolve() / 'task_archive.json')

    def test_default_is_home_dot_ai_collab(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(userdata.Path, 'home', return_value=self.root / 'home'):
            self.assertEqual(userdata.data_dir(), (self.root / 'home' / '.ai-collab').resolve())

    def test_all_eight_artifacts_are_managed(self):
        self.assertEqual(len(userdata.ARTIFACTS), 8)
        self.assertEqual(len(userdata.JSON_NAMES), 5)
        self.assertEqual(len(userdata.DB_NAMES), 3)
        with self.assertRaises(ValueError):
            userdata.path('not-managed.json')
        with self.assertRaises(ValueError):
            userdata.db_path('not-managed.sqlite')

    def test_db_path_with_state_is_project_local(self):
        # Regression guard: an explicit state dir must never collapse into the
        # shared data dir (it broke Queue's project_root binding on the first
        # interrupted M3 attempt, and wrote to the real user home).
        state = self.root / 'project' / '.work' / 'queue'
        expected = Path(state).absolute()
        self.assertEqual(userdata.db_path('tasks.sqlite', state), expected / 'tasks.sqlite')
        self.assertEqual(userdata.db_path('collab.sqlite', state), expected / 'collab.sqlite')
        self.assertNotEqual(userdata.db_path('tasks.sqlite', state).parent, self.data.resolve())

    # -- migration ------------------------------------------------------------
    @staticmethod
    def _make_db(path, value):
        con = sqlite3.connect(str(path))
        con.execute('CREATE TABLE t (k TEXT)')
        con.execute('INSERT INTO t VALUES (?)', (value,))
        con.commit()
        con.close()

    def _seed_legacy(self):
        payloads = {}
        for i, name in enumerate(userdata.JSON_NAMES):
            payloads[name] = {'marker': name, 'n': i}
            (self.runtime / name).write_text(json.dumps(payloads[name]), encoding='utf-8')
        for name in userdata.DB_NAMES:
            self._make_db(self.install / '.work' / name, 'row-' + name)
        return payloads

    def test_five_json_preserved_and_bak(self):
        payloads = self._seed_legacy()
        results = {r['name']: r for r in userdata.migrate(install=self.install, target=self.data)}
        for name, payload in payloads.items():
            self.assertEqual(results[name]['status'], 'migrated', name)
            self.assertEqual(json.loads((self.data / name).read_text(encoding='utf-8')), payload)
            self.assertTrue((self.runtime / (name + '.bak')).is_file(), name)   # original kept
            self.assertFalse((self.runtime / name).exists(), name)

    def test_three_db_records_preserved_and_bak(self):
        self._seed_legacy()
        results = {r['name']: r for r in userdata.migrate(install=self.install, target=self.data)}
        for name in userdata.DB_NAMES:
            self.assertEqual(results[name]['status'], 'migrated', name)
            con = sqlite3.connect(str(self.data / name))
            self.assertEqual(con.execute('SELECT k FROM t').fetchall(), [('row-' + name,)])
            con.close()
            self.assertTrue((self.install / '.work' / (name + '.bak')).is_file(), name)

    def test_repeat_run_is_idempotent(self):
        self._seed_legacy()
        userdata.migrate(install=self.install, target=self.data)
        again = userdata.migrate(install=self.install, target=self.data)
        self.assertTrue(all(r['status'] == 'kept' for r in again))
        for name in userdata.JSON_NAMES:
            self.assertFalse((self.runtime / name).exists())
            self.assertTrue((self.runtime / (name + '.bak')).is_file())

    def test_existing_target_is_not_overwritten(self):
        self._seed_legacy()
        (self.data).mkdir(parents=True, exist_ok=True)
        (self.data / 'task_archive.json').write_text('{"owner":"user"}', encoding='utf-8')
        results = {r['name']: r for r in userdata.migrate(install=self.install, target=self.data)}
        self.assertEqual(results['task_archive.json']['status'], 'kept')
        self.assertEqual((self.data / 'task_archive.json').read_text(encoding='utf-8'),
                         '{"owner":"user"}')
        self.assertTrue((self.runtime / 'task_archive.json').exists())  # source untouched

    def test_absent_legacy_is_reported(self):
        results = userdata.migrate(install=self.install, target=self.data)
        self.assertTrue(all(r['status'] == 'absent' for r in results))
        self.assertFalse(self.data.exists())

    def test_readonly_install_keeps_source_and_still_migrates(self):
        # A read-only installation cannot rename the source to .bak; migration
        # must still produce the target and leave the source in place.
        self._seed_legacy()
        with mock.patch.object(userdata.Path, 'replace', side_effect=OSError('read-only')):
            results = {r['name']: r for r in userdata.migrate(install=self.install, target=self.data)}
        for name in userdata.JSON_NAMES:
            self.assertEqual(results[name]['status'], 'migrated', name)
            self.assertIsNone(results[name]['backup'])
            self.assertTrue((self.data / name).is_file())                 # copied
            self.assertTrue((self.runtime / name).is_file())             # source kept, not deleted
            self.assertFalse((self.runtime / (name + '.bak')).exists())

    def test_ensure_all_runs_once_for_installed_copy(self):
        self._seed_legacy()
        first = userdata.ensure_all()
        self.assertEqual(len(first), 8)
        self.assertTrue((self.data / 'task_archive.json').is_file())
        self.assertEqual(userdata.ensure_all(), [])                        # warmed, no second copy

    def test_ensure_all_skips_source_checkout(self):
        (self.install / '.git').mkdir()
        self.assertEqual(userdata.ensure_all(), [])
        self.assertFalse(self.data.exists())

    # -- per-store schema versions -------------------------------------------
    def test_each_store_has_schema_version_and_migration(self):
        for mod in (task_runner, events, controller_usage):
            self.assertIsInstance(getattr(mod, 'SCHEMA_VERSION'), int)
            self.assertTrue(callable(getattr(mod, 'migrate_schema')))

    def test_schema_migrations_are_idempotent(self):
        # events + controller-usage ledgers
        for mod in (events, controller_usage):
            con = sqlite3.connect(':memory:')
            self.assertEqual(mod.migrate_schema(con), mod.SCHEMA_VERSION)
            self.assertEqual(mod.migrate_schema(con), mod.SCHEMA_VERSION)   # repeat is safe
            self.assertEqual(con.execute('PRAGMA user_version').fetchone()[0], mod.SCHEMA_VERSION)
            con.close()
        # tasks queue: adds attempt_id and stamps the version
        con = sqlite3.connect(':memory:')
        con.execute('CREATE TABLE tasks (id TEXT)')
        self.assertEqual(task_runner.migrate_schema(con), task_runner.SCHEMA_VERSION)
        self.assertIn('attempt_id', {r[1] for r in con.execute('PRAGMA table_info(tasks)')})
        self.assertEqual(task_runner.migrate_schema(con), task_runner.SCHEMA_VERSION)
        con.close()


if __name__ == '__main__':
    unittest.main()
