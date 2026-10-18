import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store.js';
import {maintain} from '../maintenance-hook.js';

test('native todo events bind explicitly, preserve manual work, sync atomically and remain idempotent',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'map-maintenance-')); const store=new Store(home);
 const event={hook_event_name:'PostToolUse',session_id:'test-session',transcript_path:'/test/main',tool_name:'update_plan',tool_input:{plan:[{step:'Deploy',status:'in_progress'},{step:'Verify',status:'pending'}]},tool_response:'Plan updated'};
 try {
  await store.import({planId:'test',outline:'Project\n  Manual work'});
  const manual=(await store.get('test')).nodes;
  assert.equal((await maintain(event,home)).skipped,'no explicit plan binding');
  assert.equal((await maintain({...event,tool_name:'mcp__plan_map__plan_view',tool_input:{planId:'test'},tool_response:{planId:'wrong'}},home)).skipped,'unverified selection');
  assert.equal((await maintain({...event,tool_name:'mcp__plan_map__plan_view',tool_input:{planId:'test'},tool_response:{structuredContent:await store.get('test')}},home)).bound,'test');
  await maintain(event,home);let p=await store.get('test');
  assert.deepEqual(p.nodes.filter(n=>manual.some(m=>m.id===n.id)),manual);
  assert.equal(p.nodes.find(n=>n.title==='Deploy').status,'active');
  assert.equal((await maintain(event,home)).unchanged,true);
  assert.equal((await store.get('test')).revision,p.revision);
  const bytes=await readFile(store.file('test'));
  await assert.rejects(maintain({...event,tool_input:{plan:[{step:'Bad',status:'unknown'}]}},home));
  assert.deepEqual(await readFile(store.file('test')),bytes);
  assert.equal((await maintain({...event,tool_response:{isError:true}},home)).skipped,'failed tool');
  assert.equal((await maintain({...event,agent_id:'child'},home)).skipped,'unsupported event');
  assert.equal((await maintain({...event,transcript_path:'/test/child'},home)).skipped,'different transcript');
  assert.equal((await maintain({...event,tool_name:'mcp__plan_map__plan_view',tool_input:{planId:'test'},tool_response:await store.get('test'),transcript_path:'/test/child'},home)).skipped,'different transcript');
  await maintain({...event,tool_input:{plan:[{step:'Deploy',status:'completed'},{step:'New work',status:'pending'}]}},home);
  p=await store.get('test');assert.equal(p.nodes.find(n=>n.title==='Deploy').status,'done');
  assert.ok(!p.nodes.some(n=>n.title==='Verify'));assert.ok(p.nodes.some(n=>n.title==='New work'));
  assert.deepEqual(p.nodes.filter(n=>manual.some(m=>m.id===n.id)),manual);
  assert.ok((await store.history({planId:'test'})).history.length>=3);
 } finally {await rm(home,{recursive:true,force:true});}
});
