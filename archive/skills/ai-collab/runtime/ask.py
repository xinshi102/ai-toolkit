"""挂起问题的命令行入口：python runtime/ask.py list | answer <ask_id> <选项序号|文字>

answer 生成续做 spec（continuation_of + resume=true + 同一会话 id，提示词写
"用户选择了 X，继续"），并调用 run_package 在原会话里接着跑。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import suspend  # noqa: E402
import eventlog  # noqa: E402
import run_package  # noqa: E402


def _choice_text(ask, raw) -> str:
    """<选项序号> 按 1 起解析（跨所有问题的选项扁平编号），否则当文字直接用。"""
    flat = []
    for group in ask.get('options') or []:
        if isinstance(group, list):
            flat.extend(group)
        elif group is not None:
            flat.append(group)
    try:
        idx = int(raw)
    except (ValueError, TypeError):
        return str(raw)
    return str(flat[idx - 1]) if 1 <= idx <= len(flat) else str(raw)


def continuation_spec(ask, choice_text, spec_path) -> dict:
    package_dir = Path(ask['package_dir'])
    original = {}
    src = package_dir / 'spec.json'
    if src.is_file():
        try:
            original = json.loads(src.read_text(encoding='utf-8-sig'))
        except (ValueError, OSError):
            original = {}
    session_id = ask.get('session_id') or original.get('session_id') or ''
    task_id = str(ask.get('task_id') or original.get('task_id') or package_dir.name)
    cont = {
        'task_id': task_id,
        'cwd': str(original.get('cwd') or package_dir),
        'permission': original.get('permission') or 'read-only',
        'prompt': '用户选择了 %s，继续' % choice_text,
        'continuation_of': task_id,
        'resume': True,
        'persist_session': True,
        'session_id': session_id,
        'answer_of': ask['id'],
    }
    if original.get('task'):
        cont['task'] = original['task']
    spec_path = Path(spec_path)
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(json.dumps(cont, ensure_ascii=False, indent=2), encoding='utf-8')
    return cont


def answer(ask_id, raw_choice, path=None):
    ask = suspend.find(ask_id, path=path)
    if ask is None:
        raise ValueError('unknown ask_id: %s' % ask_id)
    choice_text = _choice_text(ask, raw_choice)
    cont_dir = Path(ask['package_dir']) / ('answer-' + ask['id'])
    spec_path = cont_dir / 'spec.json'
    cont = continuation_spec(ask, choice_text, spec_path)
    suspend.record_answer(ask['id'], choice_text, str(spec_path), path=path)
    package_id = str(cont['task_id'])
    eventlog.emit('answer', package_id, reason='用户选择了 %s' % choice_text,
                  mandate_id=cont.get('continuation_of'), task=cont.get('task'))
    eventlog.emit('continue', package_id, reason='同会话续做',
                  mandate_id=cont.get('continuation_of'), task=cont.get('task'))
    return cont, run_package.main(str(spec_path))


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == 'list':
        print(json.dumps(suspend.list_asks(), ensure_ascii=False, indent=2))
        return 0
    if cmd == 'answer':
        if len(argv) != 4:
            print('usage: ask.py answer <ask_id> <选项序号|文字>')
            return 2
        try:
            cont, code = answer(argv[2], argv[3])
        except ValueError as exc:
            print(json.dumps({'error': str(exc)}, ensure_ascii=False))
            return 2
        print(json.dumps({'spec': cont, 'exit_code': code}, ensure_ascii=False))
        return 0
    print('unknown command: %s' % cmd)
    return 2


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
