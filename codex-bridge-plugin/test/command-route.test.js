import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, createBridge, collaborationCommand } from '../lib/index.js';

test('command envelope fixes sender and direction and rejects unknown recipients',()=>{
 assert.deepEqual(collaborationCommand({recipient:'Codex',sender:'OpenCode',kind:'result',direction:'codex-to-deepseek',taskId:'t'}),{recipient:'Codex',sender:'信使',kind:'command',direction:'deepseek-to-codex',taskId:'t'});
 assert.equal(collaborationCommand({recipient:'DSH'}).recipient,'DeepSeek');
 assert.equal(collaborationCommand({recipient:'Kimi'}),null);
});

test('standalone command route delivers only to requested supported target and preserves local gates',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'bridge-command-'));const routes=new Map();const dispatched=[];
 const ctx={webServer:{host:'127.0.0.1',port:19387,register(route){routes.set(route.path,route);return ()=>{}}},sessionController:{prompt:async input=>dispatched.push(input)},effect(fn,name){if(name==='codex-bridge: server discovery')return ()=>{};return fn()}};
 try{apply(ctx,{root});const bridge=createBridge({root});await bridge.authorize({sessionId:'command-test',task:'Command test',authorized:true,dshSessionId:'real-test'});
 async function send(recipient,origin,remote='127.0.0.1',url='/codex-collab/command'){
  let read=false;const payload={sessionId:'command-test',recipient,sender:'OpenCode',kind:'result',goal:'Test command',action:'Synthetic request',boundary:'Mock dispatch only',returnExpected:'Receipt',taskId:'task-command'};
  const req={method:'POST',url,headers:origin?{origin}:{},socket:{remoteAddress:remote},async *[Symbol.asyncIterator](){read=true;yield Buffer.from(JSON.stringify(payload))}};
  const res={status:0,body:'',writeHead(status){this.status=status},end(body){this.body=body}};await routes.get('/codex-collab').handler(req,res);return {...res,read,value:JSON.parse(res.body)};
 }
 const codex=await send('Codex');assert.equal(codex.status,201);assert.equal(codex.value.message.recipient,'Codex');assert.equal(codex.value.message.sender,'信使');assert.equal(codex.value.message.kind,'command');assert.equal(codex.value.message.direction,'deepseek-to-codex');assert.equal(dispatched.length,0);
 const dsh=await send('DSH');assert.equal(dsh.status,201);assert.equal(dsh.value.message.recipient,'DeepSeek');assert.equal(dsh.value.message.direction,'codex-to-deepseek');assert.equal(dispatched.length,1);
 assert.equal((await send('Kimi')).status,400);assert.equal(dispatched.length,1);
 const foreign=await send('DSH','https://example.com');assert.equal(foreign.status,403);assert.equal(foreign.read,false);assert.equal(dispatched.length,1);
 const remote=await send('DSH',null,'203.0.113.1');assert.equal(remote.status,403);assert.equal(remote.read,false);
 const old=await send('Codex',null,'127.0.0.1','/codex-collab/message');assert.equal(old.status,201);assert.equal(old.value.message.sender,'OpenCode');assert.equal(old.value.message.recipient,'DeepSeek');assert.equal(old.value.message.kind,'request');
 }finally{await rm(root,{recursive:true,force:true})}
});
