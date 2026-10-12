"""Cross-process exclusion, timeout and release regression."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from file_lock import file_lock


class LockTests(unittest.TestCase):
    def test_contention_and_exception_release(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / '中文.lock'
            code = ('import sys; from pathlib import Path; from file_lock import file_lock; '
                    '\nwith file_lock(Path(sys.argv[1]), timeout=.2): print("acquired")')
            with file_lock(path):
                run = subprocess.run([sys.executable, '-c', code, str(path)],
                                     cwd=Path(__file__).parent, capture_output=True, text=True)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn('TimeoutError', run.stderr)
            run = subprocess.run([sys.executable, '-c', code, str(path)],
                                 cwd=Path(__file__).parent, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            try:
                with file_lock(path):
                    raise ValueError('fixture')
            except ValueError:
                pass
            with file_lock(path):
                pass


if __name__ == '__main__':
    unittest.main()
