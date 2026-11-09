// Mac adapter for the upstream ai-collab console contract. No model launch.
import {realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v);
const key=v=>typeof v==='string'&&/^[a-z0-9_-]+(?:\.[a-z0-9_-]+){0,10}$/.test(v)&&v.length<=180;
const done=s=>['done','completed','passed','accepted'].includes(s);
const sec=v=>Math.floor((Date.parse(v)||0)/1000);
const safe=(v,n=200)=>typeof v==='string'?v.slice(0,n):'';
export const consoleHome=config=>config.collaborationHome||path.join(os.homedir(),'Library/Application Support/xinshi-collaboration');

async function bounded(root,relative,max=1048576) {
  const base=await realpath(root),file=path.resolve(base,relative);
  if(!file.startsWith(base+path.sep)||await realpath(file)!==file)throw Error('UNSAFE_RECORD');
  const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const st=await f.stat();if(!st.isFile()||st.size>max)throw Error('INVALID_RECORD');
    const b=Buffer.alloc(max+1);const {bytesRead}=await f.read(b,0,b.length,0);
    if(bytesRead>max)throw Error('INVALID_RECORD');
    return b.subarray(0,bytesRead).toString('utf8');
  }finally{await f.close()}
}
const read=(root,name,max)=>bounded(root,name,max).then(JSON.parse);
const optional=(root,name,max)=>read(root,name,max).catch(e=>{if(e.code==='ENOENT')return null;throw e});
const mapStatus=s=>({accepted:'ok',awaiting_acceptance:'att',failed:'bad',rejected:'bad',running:'run',done:'done',completed:'done',passed:'done',active:'run',blocked:'blocked',pending:'pending'})[s]||'idle';

export async function consoleScope(config){
  const home=consoleHome(config),reg=await optional(home,'control.json',65536);
  const cat=await optional(home,'task-catalog.json',65536)||{version:1,items:[]};
  if(cat.version!==1||!Array.isArray(cat.items)||cat.items.length>128)throw Error('INVALID_CATALOG');
  const scope=new Set(Array.isArray(reg?.allowedPlanIds)?reg.allowedPlanIds.filter(id):[]);
  const entries=new Map(),plans=new Map();
  for(const x of cat.items){
    if(!key(x?.key)||!safe(x.title)||entries.has(x.key)||x.parent!==undefined&&x.parent!==null&&!key(x.parent))throw Error('INVALID_TASK_KEY');
    if(x.planId!==undefined&&(!id(x.planId)||!scope.has(x.planId)||plans.has(x.planId)))throw Error('INVALID_PLAN_BINDING');
    entries.set(x.key,{key:x.key,title:safe(x.title),parent:x.parent||null,controller:'Codex',modules:Array.isArray(x.modules)?x.modules.filter(v=>typeof v==='string').slice(0,8):[],planId:x.planId});
    if(x.planId)plans.set(x.planId,x.key);
  }
  for(const x of entries.values()){
    const seen=new Set([x.key]);let p=x.parent;
    while(p){if(!entries.has(p)||seen.has(p))throw Error('INVALID_TASK_PARENT');seen.add(p);p=entries.get(p).parent}
  }
  if(scope.has(reg?.activePlanId)&&!plans.has(reg.activePlanId))plans.set(reg.activePlanId,'active_'+reg.activePlanId.toLowerCase());
  return {home,reg,entries,plans};
}
export async function consoleTree(config,ui={}){
  const {home,reg,entries,plans}=await consoleScope(config);
  const source=new Map(),byPlanNode=new Map(),errors=[],unassigned=[];
  for(const [pid,taskKey] of plans){
    try{
      const p=await read(reg.planMapHome,pid+'.json');if(p.planId!==pid)throw Error('PLAN_ID_MISMATCH');
      const nodes=p.state?.nodes||{}, keys=Object.keys(nodes).filter(id);
      if(keys.length>500)throw Error('PLAN_TOO_LARGE');
      if(!entries.has(taskKey))entries.set(taskKey,{key:taskKey,parent:null,title:safe(p.title)||pid,controller:'Codex',modules:[],planId:pid});
      source.set(pid,p);
      const inner=new Map(keys.map(n=>[n,taskKey+'.n_'+n.toLowerCase()]));
      for(const n of keys){
        const k=inner.get(n);if(entries.has(k))throw Error('DUPLICATE_NODE_KEY');
        const v=nodes[n],parent=inner.get(v.parent)||taskKey;
        entries.set(k,{key:k,parent,title:safe(v.title)||n,status:mapStatus(v.status),note:safe(v.note,5000),controller:'Codex',modules:[],planId:pid,nodeId:n});
        byPlanNode.set(pid+'\u0000'+n,k);
      }
    }catch(e){errors.push({planId:pid,reason:e.code||e.message})}
  }
  const packageMap=new Map();
  let runFiles=[];
  try{
    const r=path.join(await realpath(home),'runs');
    if(await realpath(r)!==r)throw Error('UNSAFE_RUNS');
    runFiles=(await readdir(r,{withFileTypes:true})).filter(v=>v.isDirectory()&&id(v.name)).map(v=>v.name);
    if(runFiles.length>1200){errors.push({reason:'RUN_INDEX_LIMIT'});runFiles=[]}
  }catch(e){if(e.code!=='ENOENT')errors.push({reason:e.code||e.message})}
  for(const rid of runFiles){
    try{
      const r=await read(home,'runs/'+rid+'/run.json',524288);
      if(r.runId!==rid||!source.has(r.planId))continue;
      const row={id:rid,dir:rid,status:mapStatus(r.status),title:safe(r.title)||rid,agent:safe(r.harness,32),updated_at:sec(r.updatedAt||r.createdAt),last_action:({accepted:'主控验收通过',awaiting_acceptance:'等待主控验收',failed:'执行失败',running:'执行中'})[r.status]||'',taskId:r.taskId};
      if(Array.isArray(ui.archivedRuns)&&ui.archivedRuns.includes(rid))continue;
      const assigned=Object.hasOwn(ui.assignments||{},rid)?ui.assignments[rid]:null;
      const target=entries.get(assigned);
      const k=target?.planId===r.planId?assigned:byPlanNode.get(r.planId+'\u0000'+r.nodeId);
      if(!k)unassigned.push(row);
      else{if(!packageMap.has(k))packageMap.set(k,[]);packageMap.get(k).push(row)}
    }catch(e){errors.push({runId:rid,reason:e.code||e.message})}
  }
  const children=new Map();
  for(const n of entries.values()){if(!children.has(n.parent))children.set(n.parent,[]);children.get(n.parent).push(n.key)}
  const visiting=new Set(),visited=new Set(),out=[];
  const priority=['bad','blocked','att','run','pending','idle','done','ok'];
  function roll(k){
    if(visiting.has(k)||visited.has(k))return null;
    const n=entries.get(k);visiting.add(k);out.push(n);
    const packages=(packageMap.get(k)||[]).sort((a,b)=>b.updated_at-a.updated_at);
    const latest=new Map();for(const p of packages)if(!latest.has(p.taskId||p.id))latest.set(p.taskId||p.id,p);
    const sub=(children.get(k)||[]).map(roll).filter(Boolean);
    const counts=sub.map(v=>v.progress);
    // A Plan Map leaf contributes once, not once per model attempt.
    if(n.nodeId&&!sub.length)counts.push([done(n.status)&&[...latest.values()].every(p=>done(p.status))?1:0,1]);
    const states=[...sub.map(v=>v.status),...[...latest.values()].map(p=>p.status),n.status].filter(Boolean);
    n.status=priority.find(s=>states.includes(s))||'idle';
    if(states.length&&states.every(s=>s==='ok'||s==='done'))n.status='done';
    n.progress=counts.reduce((a,p)=>[a[0]+p[0],a[1]+p[1]],[0,0]);
    n.executor=[...new Set([...latest.values()].map(p=>p.agent).filter(Boolean))].join(' / ');
    n.updated_at=Math.max(0,...packages.map(p=>p.updated_at),...sub.map(v=>v.updated_at));
    n.packages=packages.slice(0,30);
    n.stages=[{title:'工作包与验收',status:n.status,packages:n.packages.map(p=>p.id)}];
    visiting.delete(k);visited.add(k);return n;
  }
  for(const k of children.get(null)||[])roll(k);
  if(visited.size!==entries.size)errors.push({reason:'INVALID_PLAN_HIERARCHY'});
  return {nodes:out,unassigned:unassigned.slice(0,30),errors,activePlanId:reg?.activePlanId||null};
}
export async function consoleRun(config,rid){
  if(!id(rid))throw Error('INVALID_RUN_ID');
  const {home,plans}=await consoleScope(config);
  const r=await read(home,'runs/'+rid+'/run.json',524288);
  if(r.runId!==rid||!plans.has(r.planId))throw Error('RUN_NOT_REGISTERED');
  let activity=[];
  try{
    activity=(await bounded(home,'runs/'+rid+'/events.jsonl',2097152)).split('\n').filter(Boolean).slice(-15).map(l=>JSON.parse(l)).map(e=>({t:sec(e.at),what:safe(e.text||e.kind,300)}));
  }catch(e){if(e.code!=='ENOENT')throw e}
  const files=[];
  for(const file of ['task-design.json','task-brief.json']){
    try{await bounded(home,'runs/'+rid+'/'+file,524288);files.push(file)}catch(e){if(e.code!=='ENOENT')throw e}
  }
  return {id:rid,planId:r.planId,status:mapStatus(r.status),agent:safe(r.harness),model:safe(r.model),label:r.status==='accepted'?'验收通过':r.status==='awaiting_acceptance'?'待主控验收':undefined,
    reason:safe(r.acceptance?.evidence,4000),goal:safe(r.title),reply:safe(r.response,24000),prompt:safe(JSON.stringify(r.input||{},null,2),24000),
    command:safe(JSON.stringify(r.command||{},null,2),24000),activity,dir:rid,time:r.updatedAt||'',files,usageAvailable:false};
}

export async function consoleFile(config,rid,name){
  if(!['task-design.json','task-brief.json'].includes(name))throw Error('FILE_NOT_REGISTERED');
  const r=await consoleRun(config,rid);
  if(!r.files.includes(name))throw Error('FILE_NOT_REGISTERED');
  return bounded(consoleHome(config),'runs/'+rid+'/'+name,524288);
}
export async function consoleRunFolder(config,rid){
  await consoleRun(config,rid);
  return path.join(await realpath(consoleHome(config)),'runs',rid);
}

export async function consoleQuota(config){
  const doc=await optional(consoleHome(config),'console-quota.json',32768);
  const rows=[];
  if(doc?.version===1&&Array.isArray(doc.rows)){
    for(const r of doc.rows.slice(0,2)){
      const at=Date.parse(r.observedAt);
      if(!['gpt','gpt-week'].includes(r.key)||!Number.isFinite(at)||Date.now()-at>86400000||
          !Number.isFinite(r.pct_used)||r.pct_used<0||r.pct_used>100)continue;
      rows.push({key:r.key,agent:safe(r.agent,50),status:'ok',pct_used:r.pct_used,period:safe(r.period,30),
        reset_at:Number.isFinite(r.reset_at)?r.reset_at:null,note:'会话记录 · '+new Date(at).toLocaleString('zh-CN')});
    }
  }
  if(!rows.length)rows.push({key:'gpt',agent:'Codex',status:'unavailable',reason:'没有近期已核验额度数据'});
  for(const key of ['dsh','opencode'])rows.push({key,agent:key,status:'unavailable',reason:'暂无已核验额度数据'});
  return rows;
}
