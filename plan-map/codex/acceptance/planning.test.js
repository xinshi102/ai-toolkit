import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store.js';

test('dependencies, blockers and mutation history survive restart; stale/invalid batches are atomic',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'plan-semantics-'));
 try {
  let store=new Store(dir);
  let p=await store.import({planId:'project',outline:'Project\n  Design\n  Code'});
  const design=p.nodes.find(n=>n.title==='Design').id,code=p.nodes.find(n=>n.title==='Code').id;
  p=await store.node({planId:'project',expectedRevision:p.revision,action:'update',id:code,dependsOn:[design],blockedReason:'Waiting for design review'});
  assert.deepEqual(p.nodes.find(n=>n.id===code).waitingFor,[design]);
  assert.ok(!p.ready.includes(code));
  const bytes=await readFile(store.file('project'),'utf8');
  await assert.rejects(store.batch({planId:'project',expectedRevision:p.revision,operations:[{action:'update',id:design,status:'done'},{action:'update',id:design,dependsOn:[code]}]}),/cycle/);
  assert.equal(await readFile(store.file('project'),'utf8'),bytes);
  await assert.rejects(store.node({planId:'project',expectedRevision:1,action:'update',id:code,status:'done'}),/conflict/);
  p=await store.batch({planId:'project',expectedRevision:p.revision,operations:[{action:'update',id:design,status:'done'},{action:'update',id:code,blockedReason:'',status:'active'}]});
  store=new Store(dir);p=await store.get('project');
  assert.equal(p.current[0].id,code);assert.deepEqual(p.nodes.find(n=>n.id===code).waitingFor,[]);
  const h=await store.history({planId:'project',afterRevision:2});
  assert.equal(h.history.length,1);assert.equal(h.history[0].changes.length,2);
  assert.equal(p.historyCount,3);
  await assert.rejects(store.node({planId:'project',expectedRevision:p.revision,action:'update',id:code,dependsOn:['missing']}),/Unknown dependency/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
