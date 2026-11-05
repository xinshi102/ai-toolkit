"""M4 (2): dead board routes and the embedded /classic page are removed."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import board_api
import collab_dashboard


class CleanRoutesTest(unittest.TestCase):
    def test_only_calm_pages_remain(self):
        self.assertEqual(board_api.PAGES, {'/': 'calm.html', '/calm': 'calm.html'})

    def test_bad_routes_are_gone(self):
        for path in ('/v/a', '/v/b', '/v/c', '/s/1', '/s/2', '/s/3'):
            self.assertNotIn(path, board_api.PAGES)

    def test_page_files_exist_in_board_ui(self):
        for name in board_api.PAGES.values():
            self.assertTrue((board_api.UI_DIR / name).is_file(), name)

    def test_embedded_classic_page_and_route_removed(self):
        self.assertFalse(hasattr(collab_dashboard, 'PAGE'))
        source = (Path(__file__).resolve().parents[1] / 'collab_dashboard.py').read_text(encoding='utf-8')
        self.assertNotIn("u.path == '/classic'", source)
        self.assertNotIn('PAGE = r', source)


if __name__ == '__main__':
    unittest.main()
