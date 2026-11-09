"""python runtime/why.py <包id>：按时间列出事件链，用中文解释为什么跑/依据/停/结果。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eventlog  # noqa: E402


def main(argv):
    if len(argv) != 2:
        print('usage: why.py <包id>')
        return 2
    print(eventlog.narrate(argv[1]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
