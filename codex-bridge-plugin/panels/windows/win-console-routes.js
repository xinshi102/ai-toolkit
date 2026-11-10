import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {decisionRequest,decisionRequestAllowed} from '../../lib/decision-http.js';
import {consoleTree,consoleRun,consoleFile,consoleRunFolder,consoleQuota} from './win-console-data.js';
import {consoleState,saveConsoleLayout,markMilestones,setRunPlacement,setRunArchived} from './win-console-state.js';

const dir=new URL('./console/',import.meta.url);
const base='/codex-collab/win-api';
const reply=(res,code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const milestoneId=n=>'ms.'+n.key;
const milestoneNodes=tree=>tree.nodes.filter(n=>n.planId&&!n.nodeId&&n.progress[1]>0&&n.progress[0]===n.progress[1]&&n.status==='done');
const getAsset=async(name,res)=>{
  const html=name.endsWith('.html');
  const body=await readFile(fileURLToPath(new URL(name,dir)));
  res.writeHead(200,{'content-type':html?'text/html; charset=utf-8':'text/javascript; charset=utf-8',
    'cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"});
  res.end(body);
};
export async function winConsoleRoute(req,res,pathname,port,config,bodyJson){
  const get=req.method==='GET', post=req.method==='POST';
  if(get&&['/codex-collab/win-console'].includes(pathname)){await getAsset('console.html',res);return true}
  if(get&&pathname==='/codex-collab/win-ui/console.js'){await getAsset('console.js',res);return true}
  if(!pathname.startsWith(base+'/'))return false;
  if(!decisionRequestAllowed(req,port)){reply(res,403,{ok:false,error:'CONSOLE_ORIGIN_REQUIRED'});return true}
  const route=pathname.slice(base.length);
  try {
    const treeData=async()=>consoleTree(config,await consoleState(config));
    if(get&&route==='/tree')reply(res,200,await treeData());
    else if(get&&route==='/quota')reply(res,200,await consoleQuota(config));
    else if(get&&route==='/layout')reply(res,200,await consoleState(config));
    else if(get&&route==='/detail'){
      const rid=new URL(req.url,'http://localhost').searchParams.get('dir');
      const run=await consoleRun(config,rid),ui=await consoleState(config);
      const tree=await consoleTree(config,ui);
      reply(res,200,{...run,placement:ui.assignments?.[rid]||null,archived:(ui.archivedRuns||[]).includes(rid),
        placementOptions:tree.nodes.filter(n=>n.planId===run.planId).map(n=>({key:n.key,title:n.title}))});
    }else if(get&&route==='/file'){
      const query=new URL(req.url,'http://localhost').searchParams;
      const body=await consoleFile(config,query.get('dir'),query.get('name'));
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-store'});res.end(body);
    }else if(post&&route==='/open'){
      const input=await bodyJson(req),dir=await consoleRunFolder(config,input.dir);
      await new Promise((resolve,reject)=>{
        const child=spawn('/usr/bin/open',[dir],{stdio:'ignore'});
        child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('OPEN_FAILED')));
      });
      reply(res,200,{ok:true});
    }else if(get&&route==='/inbox'){
      const [tree,ui,d]=await Promise.all([treeData(),consoleState(config),decisionRequest(config,'list-console')]);
      if(!d.ok){reply(res,503,d);return true}
      const known=new Map(tree.nodes.map(n=>[n.key,n]));
      const task=(pid,nid)=>tree.nodes.find(n=>n.planId===pid&&n.nodeId===nid);
      const items=d.items.filter(x=>x.status==='pending').map(x=>{
        const t=task(x.planId,x.nodeId);
        return {id:x.id,version:x.version,kind:'decide',title:x.question,who:'Codex',task_title:t?.title||'已登记任务',parent_title:known.get(t?.parent)?.title,created_at:x.createdAt,
          options:Object.entries(x.options).map(([key,label])=>({key,label}))};
      });
      for(const n of milestoneNodes(tree)){
        const mid=milestoneId(n);if((ui.readMilestones||[]).includes(mid))continue;
        items.push({id:mid,kind:'ms',title:n.title,task_title:known.get(n.parent)?.title,context:'计划全部步骤完成，按主控已记录状态显示。',created_at:n.updated_at,options:[{key:'A',label:'已读'}]});
      }
      reply(res,200,{items,counts:{queued:d.items.filter(x=>x.status==='answered'||x.status==='claimed').length}});
    }else if(post&&route==='/assign'){
      const input=await bodyJson(req),run=await consoleRun(config,input.id),tree=await treeData();
      if(input.target!==null&&!tree.nodes.some(n=>n.key===input.target&&n.planId===run.planId)){
        reply(res,409,{ok:false,error:'ASSIGNMENT_OUTSIDE_PLAN'});
      }else reply(res,200,await setRunPlacement(config,input.id,input.target));
    }else if(post&&route==='/archive'){
      const input=await bodyJson(req),run=await consoleRun(config,input.id);
      if(input.archived&&run.status==='run')reply(res,409,{ok:false,error:'RUN_STILL_ACTIVE'});
      else reply(res,200,await setRunArchived(config,input.id,input.archived));
    }else if(get&&route==='/archive'){
      const ui=await consoleState(config),runs=[];
      for(const id of (ui.archivedRuns||[]).slice(-100)){try{const r=await consoleRun(config,id);runs.push({id,title:r.goal||id})}catch{}}
      reply(res,200,{runs});
    }else if(post&&route==='/layout'){
      await saveConsoleLayout(config,await bodyJson(req));reply(res,200,{ok:true});
    }else if(post&&(route==='/inbox/act'||route==='/inbox/read_all')){
      const x=await bodyJson(req);
      if(route==='/inbox/read_all'||typeof x?.id==='string'&&x.id.startsWith('ms.')){
        const ids=milestoneNodes(await treeData()).map(milestoneId);
        const ui=await consoleState(config),unread=ids.filter(id=>!(ui.readMilestones||[]).includes(id));
        if(route==='/inbox/read_all'&&x.kind==='ms')reply(res,200,await markMilestones(config,unread));
        else if(x.choice==='A'&&!x.text&&ids.includes(x.id))reply(res,200,{...(await markMilestones(config,[x.id])),next:'read'});
        else reply(res,409,{ok:false,error:'MILESTONE_NOT_ACTIONABLE'});
      }else{
        const value=await decisionRequest(config,'answer',{id:x.id,version:x.version,...(x.text?{text:x.text}:{choice:x.choice})});
        reply(res,value.ok?200:value.status||503,value.ok?{...value,next:'queued',controller:'Codex'}:value);
      }
    }else reply(res,404,{ok:false,error:'CONSOLE_ROUTE_NOT_FOUND'});
  }catch(e){
    reply(res,['RUN_NOT_REGISTERED','INVALID_RUN_ID','FILE_NOT_REGISTERED','ENOENT'].includes(e.message)||e.code==='ENOENT'?404:503,
      {ok:false,error:['RUN_NOT_REGISTERED','INVALID_RUN_ID'].includes(e.message)?e.message:'CONSOLE_UNAVAILABLE'});
  }
  return true;
}
