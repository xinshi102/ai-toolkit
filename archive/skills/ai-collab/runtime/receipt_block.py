"""双层回执：正文给用户看，末尾的 ```ai-collab JSON 块给 AI 看。

执行者最后一条回复的正文是自由文字；末尾可附一个语言标记为 ai-collab
的代码块，内容是结构化 JSON。parse() 把它拆成 (prose, block, error)。
JSON 写坏时由 run_package 在**同一会话**里请执行者只重写最后这一段
（最多一次、不重做已完成的工作）；重写仍失败则保留正文并在回执里
标记 block_error。
"""
from __future__ import annotations

import json
import re

LANG = 'ai-collab'
STATUSES = ('done', 'ask', 'blocked')

# 只认正文末尾的一个 ```ai-collab ... ``` 代码块；JSON 允许跨行。
_FENCE = re.compile(
    r'```[ \t]*ai-collab[ \t]*\r?\n(?P<body>.*?)\r?\n```[ \t]*(?:\r?\n|$)',
    re.DOTALL | re.IGNORECASE)

# 追加到提示词末尾，10 行以内：什么时候附块、块的格式。
INSTRUCTION = (
    '\n\n---\n'
    '【回执约定】正文写给用户看（汇报/判断/风险），末尾可附一个 ai-collab 代码块给 AI 看。\n'
    '完成、受阻或需要请示时都附；只输出合法 JSON，别把块写进正文。格式：\n'
    '```ai-collab\n'
    '{"status":"done|ask|blocked","ask":[{"key","title","text","options":[...]}],'
    '"later":{"after_minutes":N,"why":""},"events":[{"type","payload"}],'
    '"evidence":["路径或提交号"],"next":"一句话"}\n'
    '```\n'
    'status=ask 才填 ask（每项含 key/title/text/options）；later 是预约复查，暂不实现定时器。\n'
    '块是写给 AI 看的，正文才是给用户看的；不要重做已完成的工作。'
)


def augment_prompt(prompt: str) -> str:
    """把回执说明追加到提示词末尾；已追加过则不重复。"""
    text = prompt or ''
    if '【回执约定】' in text:
        return text
    return text + INSTRUCTION


def parse(reply_text: str):
    """-> (prose, block|None, error|None)。没有 ai-collab 块时返回 (全文, None, None)。"""
    text = reply_text or ''
    matches = list(_FENCE.finditer(text))
    if not matches:
        return text.strip(), None, None
    m = matches[-1]
    prose = (text[:m.start()] + text[m.end():]).strip()
    try:
        block = json.loads(m.group('body').strip())
    except (ValueError, TypeError) as exc:
        return prose, None, 'invalid ai-collab JSON: %s' % exc
    if not isinstance(block, dict):
        return prose, None, 'ai-collab block must be a JSON object'
    status = block.get('status')
    if status is not None and status not in STATUSES:
        return prose, None, 'invalid status %r (want done|ask|blocked)' % status
    return prose, block, None


def rewrite_prompt(error: str) -> str:
    """请执行者只重写最后这一段块，不重做已完成的工作。"""
    return (
        '你上一条回复末尾的 ai-collab JSON 块写错了（%s）。\n'
        '请只重写最后这一段代码块，不要重做已完成的工作、不要改动正文。\n'
        '只输出一个 ```ai-collab 代码块```，内容为合法 JSON，字段同原约定。' % (error or '解析失败')
    )


def block_field(prose, block, error):
    """回执里可选的 block 字段：成功=解析出的块；失败=保留正文并标记 block_error。"""
    if error:
        return {'block_error': error, 'prose': prose}
    if block is None:
        return None
    return block


def resolve(receipt, spec, rewrite):
    """解析回执里的 ai-collab 块；JSON 写坏时最多在同一会话重写一次。

    rewrite(rw_spec, '.rw') -> 重写那一次的 receipt，由调用方（run_package）提供，
    本模块不碰进程/文件。返回 (block_field, block)。
    """
    prose, block, error = parse(receipt['parsed'].get('final_text', ''))
    if error:
        sid = receipt['parsed'].get('session_id')
        if sid:
            rw_spec = dict(spec, prompt=rewrite_prompt(error),
                           resume=True, persist_session=True, session_id=sid)
            rw_receipt = rewrite(rw_spec, '.rw')
            _p2, block2, error2 = parse(rw_receipt['parsed'].get('final_text', ''))
            if not error2 and block2 is not None:
                block, error = block2, None
    return block_field(prose, block, error), block
