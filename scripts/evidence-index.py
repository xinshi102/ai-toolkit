#!/usr/bin/env python3
"""Build a local evidence index from .work acceptance and journal notes."""
from __future__ import annotations

import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / '.work'


def collect(pattern):
    return sorted(WORK.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)


def main():
    acceptance = collect('*/acceptance/*.md')
    journals = collect('*/journal/*.md')
    lines = [
        '# 验收证据索引（本机）',
        '',
        '生成时间：' + datetime.datetime.now().isoformat(timespec='seconds'),
        '',
        '证据默认只存本机 .work/，不随分支发布；报告与决定包在 goal 运行目录。',
        '',
        '## 验收记录（' + str(len(acceptance)) + '）',
    ]
    for path in acceptance:
        lines.append('- [' + path.name + '](' + str(path.relative_to(ROOT)) + ')')
    lines.extend(['', '## 里程碑笔记（' + str(len(journals)) + '）'])
    for path in journals:
        lines.append('- [' + path.name + '](' + str(path.relative_to(ROOT)) + ')')
    target = WORK / 'xinshi' / 'evidence-index.md'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(target)


if __name__ == '__main__':
    main()
