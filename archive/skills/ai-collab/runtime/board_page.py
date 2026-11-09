"""M4 (3): page rendering — every HTML/CSS/JS page is served from board_ui/.

The embedded /classic page and the /v/*, /s/* routes were removed in M4 (2).
"""
from __future__ import annotations

import board_api

UI_DIR = board_api.UI_DIR
PAGE_CSP = ("default-src 'none'; style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline'; connect-src 'self'")

# console lane: register /console here (not in board_api.PAGES, whose exact
# shape is asserted by the M4 clean-routes characterization test).
CONSOLE_PAGES = {'/console': 'console.html'}


def page_path(url_path: str):
    """Map a URL path to an existing file under board_ui/, or None."""
    name = board_api.PAGES.get(url_path) or CONSOLE_PAGES.get(url_path)
    if name:
        p = UI_DIR / name
        return p if p.is_file() else None
    if url_path.startswith('/ui/'):
        name = url_path[4:]
        if '/' in name or '\\' in name:
            return None
        p = UI_DIR / name
        return p if p.is_file() and p.suffix in ('.css', '.js') else None
    return None


def render(url_path: str):
    """Return (bytes, content_type, csp) for a board_ui page, or None."""
    p = page_path(url_path)
    if p is None:
        return None
    data = p.read_bytes()
    if p.suffix == '.html':
        return data, 'text/html; charset=utf-8', PAGE_CSP
    if p.suffix == '.css':
        return data, 'text/css; charset=utf-8', ''
    return data, 'text/javascript; charset=utf-8', ''
