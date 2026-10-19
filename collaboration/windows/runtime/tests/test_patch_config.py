"""Check relocatable overlays and concurrent generation, without DSH."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import patch_config


class OverlayTests(unittest.TestCase):
    def test_literal_plugin_path_and_immutable_template(self):
        for name, plugin in patch_config.PLUGINS.items():
            template = patch_config.BASE / name
            before = template.read_bytes()
            output = patch_config.render_patch(template)
            text = output.read_text(encoding='utf-8')
            self.assertIn('name: ' + json.dumps(str(patch_config.BASE / plugin)), text)
            self.assertNotIn(patch_config.TOKEN, text)
            self.assertEqual(before, template.read_bytes())
            self.assertTrue(output.is_relative_to(patch_config.BASE.parent / '.work/generated-overlays'))

    def test_concurrent_render_is_stable(self):
        template = patch_config.BASE / 'dsh-workspace.patch.yml'
        with ThreadPoolExecutor(max_workers=4) as pool:
            paths = list(pool.map(patch_config.render_patch, [template] * 12))
        self.assertEqual(len(set(paths)), 1)
        self.assertIn('runtimeDshWorkspaceAudit', paths[0].read_text())

    def test_external_overlay_is_rejected(self):
        with self.assertRaises(ValueError):
            patch_config.render_patch(patch_config.BASE.parent / 'foreign.patch.yml')
