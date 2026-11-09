"""Local fixture engine adapter (``local-test``).

This is never a native AI: it runs a scripted child process in a dedicated
fixture directory so the queue, guard and receipt paths can be exercised
without a model.  It keeps the same wall-clock timeout protection as every
other adapter (user decision for v1.1: no test exemption).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from adapters.base import Adapter

RUNTIME = Path(os.path.abspath(__file__)).parent.parent


class LocalTestAdapter(Adapter):
    name = 'local-test'
    supported_permissions = ('read-only', 'shell-read-only')
    test_only = True
    terminal_types = ('local_test.completed',)
    success_events = ('local_test.completed',)
    # One completion record, no tool events: guard degrades on purpose.
    normalize = None

    def validate_adapter(self, spec, context):
        super().validate_adapter(spec, context)
        if not context['allow_test']:
            raise ValueError('local adapter requires --allow-test-adapter')
        allowed = (context['project'] / '.work/full-acceptance-20261016/runtime-tests',
                   context['queue'].project / '.work/runtime-tests')
        cwd = Path(spec['cwd'])
        if not any(cwd.resolve().is_relative_to(root.resolve()) for root in allowed):
            raise ValueError('local-test cwd must be a dedicated engine fixture directory')

    def validate_tail(self, spec, context):
        delay = spec.get('delay', 0)
        if type(delay) not in (int, float) or not 0 <= delay <= 60:
            raise ValueError('test delay must be 0..60 seconds')
        if type(spec.get('exit_code', 0)) is not int:
            raise ValueError('test exit code must be int')
        if type(spec.get('test_ignore_stdin', False)) is not bool:
            raise ValueError('test_ignore_stdin must be bool')

    def probe(self, spec):
        return {'adapter': 'local-test', 'test_only': True}

    def build_command(self, spec):
        argv = [sys.executable, '-B', str(RUNTIME / 'local_adapter.py')]
        if spec.get('test_ignore_stdin'):
            argv += ['--ignore-stdin', str(spec.get('delay', 0))]
        return argv, json.dumps(spec)
