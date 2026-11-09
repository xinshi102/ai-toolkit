"""Synthetic two-way parallel work, automatic join and no-duplicate resume."""
import json
from pathlib import Path
import sys
import tempfile

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'runtime'))
from workflow import Workflow

fixtures = BASE / '.work/runtime-tests'
fixtures.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=fixtures) as temporary:
    project = Path(temporary) / '.work/runtime-tests/project'
    project.mkdir(parents=True)
    nodes = []
    for name in ('left', 'right'):
        nodes.append({'id': name, 'owner': 'synthetic-' + name,
            'provider': 'local-test', 'prompt': name, 'write_paths': [name + '.txt'],
            'checks': [{'kind': 'file_contains', 'path': name + '.txt', 'contains': name}],
            'queue_spec': {'delay': .3, 'artifacts': [{'path': str(project / (name + '.txt')), 'content': name}]}})
    nodes.append({'id': 'join', 'owner': 'synthetic-join', 'provider': 'local-test',
        'depends_on': ['left', 'right'], 'prompt': '{{file:left:left.txt}} {{file:right:right.txt}}',
        'write_paths': ['joined.txt'],
        'checks': [{'kind': 'file_contains', 'path': 'joined.txt', 'contains': 'joined'}],
        'queue_spec': {'artifacts': [{'path': str(project / 'joined.txt'), 'content': 'joined'}]}})
    flow = Workflow(project, project / '.work/flow')
    flow.init({'id': 'synthetic-demo', 'nodes': nodes})
    first = flow.run(max_concurrency=2, timeout_seconds=30, allow_test=True)
    assert first['status'] == 'accepted', first['status']
    ids = [n['task_id'] for n in first['nodes']]
    again = Workflow(project, project / '.work/flow').run(max_concurrency=2, timeout_seconds=10, allow_test=True)
    assert ids == [n['task_id'] for n in again['nodes']]
    print(json.dumps({'test_only': True, 'status': again['status'], 'parallel_branches': 2,
                      'joined_after_acceptance': True, 'resume_no_duplicate_dispatch': True}))
