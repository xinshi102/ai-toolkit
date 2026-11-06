"""车道 inbox：三类事项的分类/排序/窗口、act 的 7 种分支、可选 tree、后台续做。

续做用假的 run_package / ask 打桩，并把 launch 换成同步调用，不真起进程。
"""
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ask  # noqa: E402
import eventlog  # noqa: E402
import inbox  # noqa: E402
import run_package  # noqa: E402
import suspend  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / 'roots'
        self.root.mkdir()
        self.data = base / 'data'
        self.env = mock.patch.dict(os.environ, {'AI_COLLAB_DATA': str(self.data)})
        self.env.start()
        eventlog.reset_cache()
        inbox.set_roots([self.root])

    def tearDown(self):
        inbox.set_roots(None)
        for name in ('task_tree', 'tree', 'tree_api'):
            sys.modules.pop(name, None)
        self.env.stop()
        eventlog.reset_cache()
        self.tmp.cleanup()

    def pkg(self, name, ok, *, reason='', mtime=None, task=None, task_id=None,
            auto_continue=None, n=1, session='sess'):
        d = self.root / name
        d.mkdir()
        spec = {'task_id': task_id or name, 'cwd': str(d), 'permission': 'read-only',
                'prompt': '目标：完成 ' + name, 'session_id': session}
        if task is not None:
            spec['task'] = task
        if auto_continue is not None:
            spec['auto_continue'] = auto_continue
        (d / 'spec.json').write_text(json.dumps(spec), encoding='utf-8')
        for i in range(n):
            suffix = '' if i == 0 else '.c%d' % (i + 1)
            rec = {'ok': ok, 'exit_code': 0 if ok else 1}
            if reason:
                rec['reason'] = reason
            (d / ('receipt%s.json' % suffix)).write_text(json.dumps(rec), encoding='utf-8')
        (d / 'stdout.ndjson').write_text('', encoding='utf-8')
        if mtime is not None:
            for p in d.glob('receipt*.json'):
                os.utime(p, (mtime, mtime))
        return d

    def ask(self, package_dir=None, task_id='ask-task'):
        d = package_dir or self.root
        return suspend.record_ask(
            {'ask': [{'key': 'fmt', 'title': '要不要支持拖拽', 'text': '拖拽要多 40KB 前端库',
                      'options': ['A', 'B']}], 'evidence': ['commit abc'], 'next': '等回答'},
            str(d), 'sess-42', task_id)

    def sync_launch(self):
        """把后台线程换成同步调用，避免竞态；不真起进程。"""
        return mock.patch.object(inbox, 'launch', side_effect=lambda fn, *a: fn(*a))


class CollectTests(_Base):
    def test_three_kinds_classification_and_sort_and_counts(self):
        self.ask()
        self.pkg('bad-pkg', False, reason='上游 500', n=2, mtime=time.time() - 100)
        self.pkg('good-pkg', True, mtime=time.time() - 50)
        out = inbox.collect([self.root])
        self.assertEqual(out['counts'], {'decide': 1, 'ms': 0, 'fail': 1, 'done': 1, 'queued': 0})
        self.assertEqual([i['kind'] for i in out['items']], ['decide', 'fail', 'done'])
        self.assertEqual([i['id'] for i in out['items']],
                         ['ask:' + suspend.list_asks()[0]['ask_id'],
                          'fail:bad-pkg', 'done:good-pkg'])

    def test_same_kind_sorted_by_created_at_desc(self):
        self.pkg('old', True, mtime=time.time() - 5000)
        self.pkg('new', True, mtime=time.time() - 10)
        out = inbox.collect([self.root])
        self.assertEqual([i['id'] for i in out['items']], ['done:new', 'done:old'])

    def test_fail_only_when_rules_will_not_auto_retry(self):
        # 单次失败、无卡住、auto-continue 未用完 -> 仍会自动重试，不进收件箱
        self.pkg('still-retrying', False, reason='timeout', n=1)
        self.assertEqual(inbox.collect([self.root])['counts']['fail'], 0)
        # 同一原因失败 >=2 次 -> 进收件箱
        self.pkg('same-reason', False, reason='500', n=2)
        # auto-continue 用完（预算 1，出现 1 次即算用完）-> 进收件箱
        self.pkg('budget-gone', False, reason='x', n=1, auto_continue=1)
        # 卡住（stall）永不自动续跑 -> 进收件箱
        d = self.pkg('stalled', False, n=1)
        rec = json.loads((d / 'receipt.json').read_text(encoding='utf-8'))
        rec['stall'] = {'category': 'stall', 'reason': 'same command 5x'}
        (d / 'receipt.json').write_text(json.dumps(rec), encoding='utf-8')
        out = inbox.collect([self.root])
        self.assertEqual(sorted(i['id'] for i in out['items'] if i['kind'] == 'fail'),
                         ['fail:budget-gone', 'fail:same-reason', 'fail:stalled'])

    def test_accepted_packages_no_longer_appear(self):
        self.pkg('done-1', True)
        self.assertEqual(inbox.collect([self.root])['counts']['done'], 1)
        inbox.act('done:done-1', 'A', None)
        self.assertEqual(inbox.collect([self.root])['counts']['done'], 0)
        self.assertIn('done-1', json.loads(inbox.accepted_path().read_text(encoding='utf-8')))

    def test_done_only_within_7_days(self):
        self.pkg('recent', True, mtime=time.time() - 3600)
        self.pkg('ancient', True, mtime=time.time() - 8 * 86400)
        out = inbox.collect([self.root])
        self.assertEqual([i['id'] for i in out['items']], ['done:recent'])

    def test_item_shape_and_options(self):
        self.ask()
        self.pkg('f', False, reason='500', n=2)
        self.pkg('g', True)
        for it in inbox.collect([self.root])['items']:
            for field in ('id', 'kind', 'title', 'context', 'task', 'task_title',
                          'parent_title', 'who', 'options', 'created_at'):
                self.assertIn(field, it)
            self.assertIsInstance(it['created_at'], (int, float))
            self.assertIsInstance(it['options'], list)
        kinds = {i['kind']: i for i in inbox.collect([self.root])['items']}
        self.assertEqual([o['key'] for o in kinds['fail']['options']], ['A', 'B', 'C'])
        self.assertEqual([o['key'] for o in kinds['done']['options']], ['A', 'B'])
        self.assertEqual([o['key'] for o in kinds['decide']['options']], ['A', 'B'])

    def test_task_info_inferred_from_spec_task_field(self):
        self.pkg('n', True, task='xinshi.planmap')
        it = inbox.collect([self.root])['items'][0]
        self.assertEqual(it['task'], 'xinshi.planmap')
        self.assertEqual(it['task_title'], 'planmap')
        self.assertEqual(it['parent_title'], 'xinshi')

    def test_task_info_inferred_from_directory(self):
        # 没有 tree 模块时，从包所在目录推断 task_title
        self.pkg('n', True)
        it = inbox.collect([self.root])['items'][0]
        self.assertEqual(it['task'], 'n')
        self.assertEqual(it['task_title'], 'roots')

    def test_unknown_folder_left_blank(self):
        # 父/祖父目录都像临时目录时推断不出来，留空
        task, tt, pt = inbox._infer_task('/tmp/tmpabc/tmpdef/pkg', {})
        self.assertEqual(task, 'pkg')
        self.assertEqual((tt, pt), ('', ''))

    def test_tree_module_is_optional_and_used_when_present(self):
        self.pkg('n', True)
        fake = types.ModuleType('task_tree')
        fake.for_package = lambda d: {'task': 'tree.key', 'task_title': '树标题',
                                      'parent_title': '父标题'}
        with mock.patch.object(inbox, '_tree_module', return_value=fake):
            it = inbox.collect([self.root])['items'][0]
        self.assertEqual((it['task'], it['task_title'], it['parent_title']),
                         ('tree.key', '树标题', '父标题'))
        # 缺失 tree 模块时回退，不抛异常
        with mock.patch.object(inbox, '_tree_module', return_value=None):
            it = inbox.collect([self.root])['items'][0]
        self.assertEqual(it['task'], 'n')

    def test_optional_import_never_raises(self):
        # 合并后 tree 模块已存在：可选 import 应拿到它且不抛异常
        mod = inbox._tree_module()
        self.assertTrue(mod is None or hasattr(mod, 'for_package'))


class ActTests(_Base):
    def _events(self):
        return eventlog.read_events()

    def _actions(self):
        return [e.get('payload', {}).get('action') for e in self._events()
                if e.get('payload', {}).get('action')]

    def test_decide_A_calls_ask_answer(self):
        a = self.ask()
        with self.sync_launch(), \
             mock.patch.object(run_package, 'main', return_value=0) as rp, \
             mock.patch.object(ask, 'run_package', run_package):
            res = inbox.act('ask:' + a['ask_id'], 'A', None)
        self.assertEqual(res['next'], 'resumed')
        self.assertEqual(res['package'], 'ask-task')
        rp.assert_called_once()
        # 回答后不再挂起
        self.assertEqual(suspend.list_asks(), [])
        self.assertIn('answer', self._actions())

    def test_decide_free_text_used_as_answer(self):
        a = self.ask()
        with self.sync_launch(), \
             mock.patch.object(run_package, 'main', return_value=0), \
             mock.patch.object(ask, 'answer', wraps=ask.answer) as aa:
            inbox.act('ask:' + a['ask_id'], None, '用方案 C')
        self.assertEqual(aa.call_args[0][1], '用方案 C')

    def test_done_A_writes_accepted(self):
        self.pkg('d', True)
        res = inbox.act('done:d', 'A', None)
        self.assertEqual(res['next'], 'accepted')
        self.assertIsNone(res['package'])
        self.assertIn('d', json.loads(inbox.accepted_path().read_text(encoding='utf-8')))
        self.assertIn('accept', self._actions())

    def test_done_B_reject_continuation(self):
        self.pkg('d', True, session='sess-D')
        with self.sync_launch(), mock.patch.object(run_package, 'main', return_value=0) as rp:
            res = inbox.act('done:d', 'B', '把按钮调大')
        self.assertEqual(res['next'], 'resumed')
        rp.assert_called_once()
        spec = json.loads(Path(rp.call_args[0][0]).read_text(encoding='utf-8'))
        self.assertEqual(spec['continuation_of'], 'd')
        self.assertTrue(spec['resume'])
        self.assertEqual(spec['session_id'], 'sess-D')
        self.assertIn('把按钮调大', spec['prompt'])
        self.assertNotIn('model', spec)
        self.assertIn('reject', self._actions())

    def test_fail_A_retry_with_hy4std(self):
        self.pkg('f', False, reason='500', n=2, session='sess-F')
        with self.sync_launch(), mock.patch.object(run_package, 'main', return_value=0) as rp:
            res = inbox.act('fail:f', 'A', None)
        self.assertEqual(res['next'], 'resumed')
        rp.assert_called_once()
        spec = json.loads(Path(rp.call_args[0][0]).read_text(encoding='utf-8'))
        self.assertEqual(spec['model'], 'hy4std')
        self.assertTrue(spec['resume'])
        self.assertEqual(spec['session_id'], 'sess-F')
        self.assertIn('retry', self._actions())

    def test_fail_B_only_records(self):
        self.pkg('f', False, reason='500', n=2)
        with self.sync_launch(), mock.patch.object(run_package, 'main', return_value=0) as rp:
            res = inbox.act('fail:f', 'B', None)
        rp.assert_not_called()
        self.assertNotIn('f', json.loads(inbox.dismissed_path().read_text(encoding='utf-8'))
                         if inbox.dismissed_path().exists() else {})
        self.assertIn('retry', self._actions())
        self.assertEqual(res['ok'], True)

    def test_fail_C_writes_dismissed(self):
        self.pkg('f', False, reason='500', n=2)
        res = inbox.act('fail:f', 'C', None)
        self.assertEqual(res['next'], 'dismissed')
        self.assertIsNone(res['package'])
        self.assertIn('f', json.loads(inbox.dismissed_path().read_text(encoding='utf-8')))
        self.assertIn('dismiss', self._actions())

    def test_acted_card_never_reappears(self):
        self.pkg('d', True)
        self.pkg('f', False, reason='500', n=2)
        self.assertEqual(len(inbox.collect([self.root])['items']), 2)
        with self.sync_launch(), mock.patch.object(run_package, 'main', return_value=0):
            inbox.act('done:d', 'B', '再改改')
            inbox.act('fail:f', 'B', None)
        self.assertEqual(inbox.collect([self.root])['items'], [])

    def test_all_branches_emit_eventlog(self):
        a = self.ask()
        self.pkg('d1', True)
        self.pkg('d2', True)
        self.pkg('f1', False, reason='500', n=2)
        self.pkg('f2', False, reason='500', n=2)
        self.pkg('f3', False, reason='500', n=2)
        with self.sync_launch(), mock.patch.object(run_package, 'main', return_value=0):
            inbox.act('ask:' + a['ask_id'], 'A', None)
            inbox.act('done:d1', 'A', None)
            inbox.act('done:d2', 'B', None)
            inbox.act('fail:f1', 'A', None)
            inbox.act('fail:f2', 'B', None)
            inbox.act('fail:f3', 'C', None)
        self.assertEqual(set(self._actions()),
                         {'answer', 'accept', 'reject', 'retry', 'dismiss'})

    def test_unknown_ask_and_bad_id_are_rejected(self):
        self.assertEqual(inbox.act('done:x', 'A', None)['ok'], True)  # 容错：状态照写
        self.assertFalse(inbox.act('nope', 'A', None)['ok'])
        self.assertFalse(inbox.act('weird:x', 'A', None)['ok'])
        self.assertFalse(inbox.act('ask:missing', 'A', None)['ok'])

    def test_text_over_2000_clamped_in_act(self):
        self.pkg('d', True)
        with self.sync_launch(), mock.patch.object(run_package, 'main', return_value=0) as rp:
            inbox.act('done:d', 'B', 'x' * 3000)
        spec = json.loads(Path(rp.call_args[0][0]).read_text(encoding='utf-8'))
        self.assertLessEqual(len(spec['prompt']), 2000 + len('按用户意见继续修改'))


class LaunchTests(_Base):
    def test_resume_does_not_block_dashboard(self):
        self.pkg('f', False, reason='500', n=2)
        release = threading.Event()

        def slow(_path):
            release.wait(0.6)  # 若同步执行会阻塞 0.6s

        with mock.patch.object(run_package, 'main', side_effect=slow):
            t0 = time.time()
            res = inbox.act('fail:f', 'A', None)
            elapsed = time.time() - t0
        release.set()
        self.assertEqual(res['next'], 'resumed')
        self.assertLess(elapsed, 0.4, 'act() 不应等待后台续做')


if __name__ == '__main__':
    unittest.main()
