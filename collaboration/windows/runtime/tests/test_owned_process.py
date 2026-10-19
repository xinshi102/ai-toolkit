"""Actual local process trees; no model calls."""
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from owned_process import OwnedProcess
import owned_process


class OwnedProcessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            process.close()
        self.directory.cleanup()

    def launch(self, name, parent_delay):
        marker = self.root / (name + '-ready.txt')
        output = self.root / (name + '-late.txt')
        child = 'import time;from pathlib import Path;time.sleep(.7);Path(' + repr(str(output)) + ').write_text("late")'
        code = 'import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,"-c",' + repr(child) + ']);Path(' + repr(str(marker)) + ').write_text(str(p.pid));time.sleep(' + str(parent_delay) + ')'
        process = OwnedProcess([sys.executable, '-B', '-c', code], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=False)
        self.processes.append(process)
        deadline = time.monotonic() + 3
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(marker.exists())
        return process, output

    def test_cancel_kills_real_descendant_and_confirms_empty(self):
        process, output = self.launch('cancel', 5)
        self.assertTrue(process.terminate_tree(timeout=3))
        self.assertEqual(process.active_processes(), 0)
        self.assertTrue(process.close())
        time.sleep(.8)
        self.assertFalse(output.exists())

    def test_normal_parent_exit_cleans_remaining_child(self):
        process, output = self.launch('normal', 0)
        self.assertEqual(process.wait(timeout=3), 0)
        self.assertTrue(process.close())
        time.sleep(.8)
        self.assertFalse(output.exists())

    def test_jobs_are_isolated_and_close_idempotent(self):
        a, out_a = self.launch('first', 5)
        b, out_b = self.launch('second', 0)
        self.assertTrue(a.close())
        self.assertTrue(a.close())
        self.assertEqual(b.wait(timeout=3), 0)
        # A's cleanup must not terminate B or B's independently-owned child.
        deadline = time.monotonic() + 2
        while not out_b.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(out_b.exists())
        self.assertFalse(out_a.exists())
        self.assertTrue(b.close())

    def test_pipe_interface_and_exit_code(self):
        process = OwnedProcess([sys.executable, '-c', 'import sys;print(sys.stdin.read());sys.exit(3)'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        output, error = process.communicate('hello', timeout=3)
        self.assertEqual(output.strip(), 'hello')
        self.assertEqual(process.returncode, 3)
        self.assertTrue(process.close())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows suspended-start failure path')
    def test_assignment_failure_never_executes_unowned_process(self):
        output = self.root / 'must-not-run.txt'
        code = 'from pathlib import Path;Path(' + repr(str(output)) + ').write_text("bad")'
        with patch.object(owned_process._kernel, 'AssignProcessToJobObject', return_value=0):
            with self.assertRaises(OSError):
                OwnedProcess([sys.executable, '-c', code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(.2)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
