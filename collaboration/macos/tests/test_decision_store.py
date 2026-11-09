import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'plugins/dsh/codex-bridge/lib'))
import decision_store as s


class InboxTest(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.home=Path(tmp.name)
        (self.home/'plans').mkdir()
        self.put('control.json',dict(schemaVersion=1,activePlanId='plan',allowedPlanIds=['plan'],planMapHome=str(self.home/'plans')))
        self.put('plans/plan.json',dict(planId='plan',state={'nodes':{'node':{'status':'active'}}}))
        self.task=dict(planId='plan',nodeId='node',taskId='task',harness='dsh')
        self.session='session-test-abc'
        self.put('runs/parent/run.json',dict(self.task,runId='parent',status='accepted',receipt={'session_id':self.session}))

    def put(self,name,data):
        p=self.home/name;p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(json.dumps(data))

    def decision(self):
        return s.create(self.home,'parent','Question?',{'A':'yes','B':'no'})

    def test_only_one_claim_and_close_requires_bound_same_session_acceptance(self):
        d=self.decision();did=d['id']
        self.assertFalse(s.answer(self.home,did,1,'A')['duplicate'])
        self.assertTrue(s.answer(self.home,did,1,'A')['duplicate'])
        with self.assertRaisesRegex(s.Refused,'ALREADY_ANSWERED'):s.answer(self.home,did,1,'B')
        def claim(rid):
            try:return s.claim(self.home,did,rid,self.task)['runId']
            except s.Refused:return None
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            result=list(pool.map(claim,['run-a','run-b']))
        ids=[x for x in result if x];self.assertEqual(len(ids),1)
        rid=ids[0]
        run=dict(self.task,runId=rid,decisionId=did,parentRunId='parent',status='accepted',
                 acceptance={'status':'passed','by':'Codex','evidence':'fixture'})
        self.put(f'runs/{rid}/run.json',dict(run,receipt={'session_id':'session-other'}))
        with self.assertRaisesRegex(s.Refused,'ACCEPTANCE_REQUIRED'):s.close(self.home,did)
        self.put(f'runs/{rid}/run.json',dict(run,receipt={'session_id':self.session}))
        self.assertEqual(s.close(self.home,did)['status'],'closed')
        self.assertEqual(s.listing(self.home),[])

    def test_stale_foreign_scope_and_unregistered_items_fail_closed(self):
        d=self.decision();did=d['id']
        with self.assertRaisesRegex(s.Refused,'NOT_FOUND'):s.answer(self.home,'unknown',1,'A')
        with self.assertRaisesRegex(s.Refused,'STALE'):s.answer(self.home,did,0,'A')
        s.answer(self.home,did,1,'A')
        with self.assertRaisesRegex(s.Refused,'IDENTITY_MISMATCH'):s.claim(self.home,did,'wrong',dict(self.task,taskId='other'))
        with s.db(self.home,True) as conn:conn.execute('UPDATE decisions SET expiresAt=0 WHERE id=?',(did,))
        with self.assertRaisesRegex(s.Refused,'NOT_CLAIMABLE'):s.claim(self.home,did,'run-a',self.task)
        self.assertEqual(s.listing(self.home),[])
        self.assertNotEqual(self.decision()['id'],did)
