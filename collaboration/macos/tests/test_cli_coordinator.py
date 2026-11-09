import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import cli_coordinator as cli


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home, self.plans = self.root/'control', self.root/'plans'
        self.plans.mkdir()
        cli.write_json(self.plans/'master.json', {'planId':'master','state':{'nodes':{'n1':{'id':'n1'}}}})
        cli.bind_plan(self.home, 'master', self.plans)
        self.task = {'taskId':'t1','planId':'master','nodeId':'n1','title':'Test',
                     'dataClass':'synthetic','harness':'opencode',
                     'brief':{'nonce':'challenge','task':'write JSON','required_keys':['nonce','result']}}

    def complete(self):
        directory, value = cli.begin_run(self.home, self.task)
        artifact = directory/'output.json'
        cli.write_json(artifact, {'nonce':'challenge','result':42})
        log = directory/'native.jsonl'
        log.write_text(json.dumps({'type':'text','part':{'text':'done'}})+'\n')
        receipt = {'accepted':True,'exit_code':0,'command_argv':['opencode','run'],
                   'model':cli.FREE_MODEL,'final_text':'done'}
        return directory, cli.finish_run(directory, value, receipt, artifact, log)

    def test_registration_reuses_plan_file_without_mutation(self):
        before = (self.plans/'master.json').read_bytes()
        config = cli.bind_plan(self.home, 'master', self.plans)
        self.assertEqual(config['allowedPlanIds'], ['master'])
        self.assertEqual(before, (self.plans/'master.json').read_bytes())
        with self.assertRaises(ValueError): cli.bind_plan(self.home, '../master', self.plans)

    def test_unknown_nodes_paid_fallback_and_private_inputs_rejected_before_dispatch(self):
        for patch in ({'nodeId':'unknown'},{'planId':'unknown'},
                      {'model':'paid/model'},{'harness':'kimi'},{'dataClass':'private'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                cli.validate_task(self.home, self.task|patch)
        self.assertFalse((self.home/'runs').exists())

    def test_model_transport_is_not_final_acceptance(self):
        directory, value = self.complete()
        self.assertEqual(value['status'], 'awaiting_acceptance')
        self.assertEqual(value['acceptance']['status'], 'pending')
        accepted = cli.accept_run(self.home, value['runId'], 'Independent result 42 and unit checks passed')
        self.assertEqual(accepted['acceptance']['by'], 'Codex')
        self.assertEqual(accepted['status'], 'accepted')
        with self.assertRaises(ValueError): cli.accept_run(self.home, value['runId'], 'duplicate')

    def test_changed_artifact_cannot_be_accepted(self):
        directory, value = self.complete()
        Path(value['artifact']).write_text('{"nonce":"changed"}')
        with self.assertRaises(ValueError): cli.accept_run(self.home, value['runId'], 'Looks fine')

    def test_task_failure_not_silently_retried_or_accepted(self):
        directory, value = cli.begin_run(self.home, self.task)
        log = directory/'native.jsonl'; log.write_text('diagnostic without JSON\n')
        failed = cli.finish_run(directory, value, {'accepted':False,'exit_code':1}, directory/'none.json', log)
        self.assertEqual(failed['status'], 'failed')
        with self.assertRaises(ValueError): cli.accept_run(self.home, value['runId'], 'Override failure')
        self.assertEqual(len(list((self.home/'runs').iterdir())), 1)

    def test_symlink_plan_and_run_escape_refused(self):
        (self.plans/'alias.json').symlink_to(self.plans/'master.json')
        with self.assertRaises(ValueError): cli.bind_plan(self.home, 'alias', self.plans)
        (self.home/'runs').mkdir()
        (self.home/'runs'/'escape').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): cli.accept_run(self.home, 'escape', 'No')


if __name__ == '__main__': unittest.main()
