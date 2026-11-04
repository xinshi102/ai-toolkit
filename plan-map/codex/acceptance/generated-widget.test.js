import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('final MCP widget JavaScript parses after all modules are embedded',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'map-widget-'));
 const client=new Client({name:'generated-widget-check',version:'1.0'});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('server.js')],env:{...process.env,PLAN_MAP_HOME:home}}));
  const resource=await client.readResource({uri:'ui://xinshi-plan-map/v8.html'});
  const html=resource.contents[0].text;
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
  assert.ok(scripts.length,'generated resource must contain executable scripts');
  for(const script of scripts) assert.doesNotThrow(()=>new vm.Script(script), 'final embedded JavaScript must compile');
 } finally {await client.close();await rm(home,{recursive:true,force:true});}
});
