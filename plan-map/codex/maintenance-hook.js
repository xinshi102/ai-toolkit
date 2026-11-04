// PostToolUse bridge. No transcript parsing, model calls, or guessed plan binding.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0,24);
const valid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
export async function maintain(event, home) {
  if (!home || event.hook_event_name !== 'PostToolUse' || !valid(event.session_id) || event.agent_id) return { skipped:'unsupported event' };
  const meta = path.join(home,'.maintenance');
  const bindingFile = path.join(meta,hash(event.session_id)+'.json');
  const store = new Store(home);
  let response = event.tool_response;
  if (typeof response === 'string') { try { response=JSON.parse(response); } catch {} }
  if (response?.isError || response?.error) return { skipped:'failed tool' };
  // Successful explicit plan views/imports select the plan for subsequent native todos.
  if (/^mcp__plan[_-]map__plan_(view|import)$/.test(event.tool_name)) {
    const id=event.tool_input?.planId;
    const result=response?.structuredContent || response;
    if (!valid(id) || result?.planId !== id || !event.transcript_path) return { skipped:'unverified selection' };
    let existing;
    try { existing=JSON.parse(await readFile(bindingFile,'utf8')); } catch(e) {if(e.code!=='ENOENT')throw e;}
    if(existing?.transcriptPath && existing.transcriptPath!==event.transcript_path) return {skipped:'different transcript'};
    await store.get(id);
    await mkdir(meta,{recursive:true});
    const temp=bindingFile+'.'+process.pid+'.tmp';
    await writeFile(temp,JSON.stringify({sessionId:event.session_id,planId:id,transcriptPath:event.transcript_path}),{mode:0o600});
    await rename(temp,bindingFile);
    return { bound:id };
  }
  if (event.tool_name !== 'update_plan') return { skipped:'unrelated tool' };
  let binding;
  try { binding=JSON.parse(await readFile(bindingFile,'utf8')); }
  catch(e) { if(e.code==='ENOENT')return {skipped:'no explicit plan binding'};throw e; }
  if (binding.sessionId !== event.session_id || !valid(binding.planId)) throw Error('Invalid binding');
  if(!event.transcript_path || binding.transcriptPath!==event.transcript_path) return {skipped:'different transcript'};
  const items=event.tool_input?.plan;
  const statuses={pending:'pending',in_progress:'active',completed:'done'};
  if (!Array.isArray(items) || !items.length || items.length>90 || items.some(i=>typeof i.step!=='string'||!i.step.trim()||i.step.length>120||!Object.hasOwn(statuses,i.status))) throw Error('Invalid native plan');
  if (new Set(items.map(i=>i.step)).size!==items.length) throw Error('Duplicate native steps');
  const parent='host-todo-'+hash(event.session_id);
  // Read fresh revision; Store.batch supplies locking and atomic conflict rejection.
  const plan=await store.get(binding.planId), operations=[];
  const previous=plan.nodes.find(n=>n.id===parent);
  const owner='Plan Map native todo bridge: '+event.session_id;
  if (previous && previous.note!==owner) throw Error('Bridge ownership mismatch');
  if(!previous) operations.push({action:'add',id:parent,title:'宿主待办联动',note:owner,status:'pending'});
  const desired=new Set();
  for(const item of items) {
    const id=parent+'-'+hash(item.step);desired.add(id);
    const node=plan.nodes.find(n=>n.id===id);
    if(node && node.parent!==parent) throw Error('Native todo ownership mismatch');
    if(!node)operations.push({action:'add',id,parent,title:item.step,status:statuses[item.status]});
    else if(node.status!==statuses[item.status]||node.title!==item.step)operations.push({action:'update',id,title:item.step,status:statuses[item.status]});
  }
  for(const node of plan.nodes.filter(n=>n.parent===parent&&!desired.has(n.id))) {
    if(!node.id.startsWith(parent+'-')||plan.nodes.some(n=>n.parent===node.id)) throw Error('Manual structure in native todo branch');
    operations.push({action:'remove',id:node.id});
  }
  if(!operations.length)return {unchanged:true};
  const result=await store.batch({planId:binding.planId,expectedRevision:plan.revision,operations});
  return {planId:binding.planId,revision:result.revision,operations:operations.length};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1000000)throw Error('Hook payload too large');}
    const event=JSON.parse(input);
    const home=process.env.PLAN_MAP_HOME || 'E:/AI-Workspace/Data/Plan-Map/Codex';
    const result=await maintain(event,home);
    // Minimal operational evidence only: never retain tool payloads or transcript paths.
    const meta=path.join(home,'.maintenance');
    await mkdir(meta,{recursive:true});
    await writeFile(path.join(meta,'last-hook.json'),JSON.stringify({at:new Date().toISOString(),event:event.hook_event_name,tool:event.tool_name,inputKeys:Object.keys(event.tool_input||{}),responseKeys:Object.keys(event.tool_response||{}),result}),{mode:0o600});
  } catch(error) {
    // Advisory feedback: failure must be visible; never pretend a sync succeeded.
    console.log(JSON.stringify({systemMessage:'Plan Map 自动维护未同步：'+error.message}));
    process.exitCode=1;
  }
}
