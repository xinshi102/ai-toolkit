"""SQLite sources (personal edition): none bundled.

The company edition reads desktop-app session databases here. The personal
edition ships no app-specific readers; query() is kept so callers and tests
that probe a database path still work.
"""
import sqlite3
from pathlib import Path

VERSION = 'none (personal edition)'


def query(db, sql, params=()):
    p = Path(db)
    if not p.exists():
        return {'status': 'unknown', 'reason': 'not found'}
    try:
        con = sqlite3.connect(f'file:{p}?mode=ro', uri=True, timeout=2)
        try:
            rows = con.execute(sql, params).fetchall()
        finally:
            con.close()
        return {'status': 'ok', 'rows': rows}
    except Exception as exc:
        return {'status': 'unknown', 'reason': type(exc).__name__}


def health():
    return {'status': 'unknown', 'reason': 'not bundled'}
