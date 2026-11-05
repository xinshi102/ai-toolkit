"""DSH (DeepSeek): CNY balance from the official user/balance endpoint.

The key is an sk- token found in ~/.dsh/.credentials.yaml. Extra row = today's
token consumption, reusing the existing agent_usage DSH local stats.
"""
from __future__ import annotations

import re
import urllib.error
from pathlib import Path

from . import common

AGENT = 'DSH'
API = 'https://api.deepseek.com/user/balance'
CRED = Path.home() / '.dsh' / '.credentials.yaml'


class NoLogin(Exception):
    pass


def _read_key():
    if not CRED.exists():
        raise NoLogin()
    text = CRED.read_text(encoding='utf-8', errors='ignore')
    m = re.search(r'sk-[A-Za-z0-9_\-]+', text)
    if not m:
        raise NoLogin()
    return m.group(0)


def _today_tokens():
    try:
        import agent_usage
        data = agent_usage.scan(days=1) or {}
        dsh = next((a for a in data.get('agents', []) if a.get('agent') == 'DSH'), None)
        if dsh:
            return common.num((dsh.get('input') or 0) + (dsh.get('output') or 0))
    except Exception:
        return None
    return None


def parse(data, now=None):
    infos = (data or {}).get('balance_infos') or []
    balance = common.num(infos[0].get('total_balance')) if infos else None
    if balance is None:
        return common.unknown(AGENT, '余额接口没有返回数据')
    return common.row(AGENT, unit='CNY', remaining=balance, period='balance',
                      fetched_at=now or common.now())


def fetch():
    try:
        key = _read_key()
    except NoLogin:
        return common.unknown(AGENT, '未找到 DSH 凭证')
    except Exception:
        return common.unknown(AGENT, 'DSH 凭证读取失败')
    try:
        data = common.http_json(API, headers={'Authorization': 'Bearer ' + key})
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return common.unknown(AGENT, 'DSH 凭证已失效')
        return common.unknown(AGENT, '余额接口返回错误')
    except Exception:
        return common.unknown(AGENT, '网络超时或额度接口不可达')
    r = parse(data)
    tok = _today_tokens()
    if tok is not None:
        r['extra'] = [common.row('今日 token', label='今日 token', used=tok)]
    return r
