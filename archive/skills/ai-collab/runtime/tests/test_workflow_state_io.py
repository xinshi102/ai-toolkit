"""Windows concurrent readers must not lose atomic workflow publication."""
import json,os
from pathlib import Path
import sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from workflow import Workflow

@unittest.skipUnless(os.name=='nt','Windows sharing violation behavior')
class AtomicStateTests(unittest.TestCase):
    def test_transient_reader_conflict_retries_only_replace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);flow=Workflow(root,root/'.work/flow')
            flow.save({'revision':1})
            replace=os.replace;attempts=[]
            def publish(source,target):
                attempts.append((source,target))
                self.assertEqual(json.loads(flow.path.read_text())['revision'],1)
                if len(attempts)<3:
                    error=PermissionError('concurrent reader');error.winerror=5;raise error
                replace(source,target)
            with patch('workflow.os.replace',side_effect=publish):flow.save({'revision':2})
            self.assertEqual(len(attempts),3)
            self.assertEqual(len(set(p[0] for p in attempts)),1)
            self.assertEqual(json.loads(flow.path.read_text())['revision'],2)

    def test_persistent_conflict_preserves_old_state_and_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);flow=Workflow(root,root/'.work/flow');flow.save({'revision':1})
            error=PermissionError('persistent conflict');error.winerror=32
            with patch('workflow.os.replace',side_effect=error) as replace,patch('workflow.time.monotonic',side_effect=[0,3]):
                with self.assertRaises(PermissionError):flow.save({'revision':2})
                self.assertEqual(replace.call_count,1)
            self.assertEqual(json.loads(flow.path.read_text())['revision'],1)

if __name__=='__main__':unittest.main()
