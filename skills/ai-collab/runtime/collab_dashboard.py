"""Collab dashboard entry point.

M4 split: data aggregation -> board_data.py, HTTP routing -> board_routes.py,
page rendering -> board_page.py (all pages come from board_ui/). This module is
only the CLI/HTTP server bootstrap; port 18765, 127.0.0.1-only binding and the
read-only behaviour are unchanged.
"""
import argparse
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import board_data
import board_routes
import notify
import package_discovery
import quota.service as quota_service
import session_scanner
import token_meter
import userdata


def main():
    userdata.ensure_all()
    ap = argparse.ArgumentParser()
    ap.add_argument('--roots', default=','.join(str(p) for p in board_data.DEFAULT_ROOTS),
                    help='comma-separated run roots; registered and discovered packages are added automatically')
    ap.add_argument('--root', default='', help='single root override')
    ap.add_argument('--port', type=int, default=18765)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-notify', action='store_true', help='disable Windows desktop notifications')
    args = ap.parse_args()
    if args.root:
        roots = [Path(args.root)]
    else:
        roots = [Path(part.strip()) for part in args.roots.split(',') if part.strip()]
    roots = [r for r in roots if r.exists()]
    if not roots:
        print('no existing roots: ' + args.roots)
        return 2
    httpd = ThreadingHTTPServer((args.host, args.port), board_routes.make_handler(roots))
    threading.Thread(target=session_scanner.scan_all, daemon=True).start()
    threading.Thread(target=token_meter.scan, daemon=True).start()
    threading.Thread(target=lambda: board_data.collect_all(roots), daemon=True).start()
    package_discovery.start_background()
    quota_service.start()
    notify.start(port=args.port, enabled=not args.no_notify)
    print(f'collab dashboard: http://{args.host}:{args.port}/  (roots: {", ".join(str(r) for r in roots)})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
