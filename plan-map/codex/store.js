import { validateDependencies, planningView, auditChanges } from './planning.js';
import { mkdir, readFile, writeFile, rename, readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { initialTreeState, parseImport, importNodes, applyPlanNode, treeView } from './dsh-plan-core.js';
const validId = /^[a-zA-Z0-9_-]{1,80}$/;
export class Store {
 constructor(root=path.join(homedir(),'.codex/plan-map')) { this.root=root; }
 file(id){ if(typeof id!=='string'||!validId.test(id)) throw Error('Invalid planId'); return path.join(this.root,id+'.json'); }
 async get(id){ const raw=JSON.parse(await readFile(this.file(id),'utf8')); return this.view(raw); }
 view(raw){ const v=treeView(raw.state); v.nodes=planningView(v.nodes,raw.dependencies,raw.blockedReasons); const leaves=v.nodes.filter(n=>!v.nodes.some(c=>c.parent===n.id)); const active=v.nodes.filter(n=>n.status==='active').filter(n=>!v.nodes.some(c=>{if(c.status!=='active'||c.id===n.id)return false;let p=c.parent;for(let i=0;i<v.nodes.length&&p;i++){if(p===n.id)return true;p=v.nodes.find(a=>a.id===p)?.parent;}return false;})); return {...raw,...v,state:undefined,history:undefined,historyCount:(raw.history||[]).length,ready:v.nodes.filter(n=>n.status==='pending'&&!n.waitingFor.length&&!n.blockedReason).map(n=>n.id),current:active.map(n=>({id:n.id,title:n.title})),progress:{total:leaves.length,done:leaves.filter(n=>n.status==='done').length,blocked:leaves.filter(n=>n.status==='blocked').length,percent:leaves.length?Math.round(leaves.filter(n=>n.status==='done').length*100/leaves.length):0}}; }
 async list(){ await mkdir(this.root,{recursive:true,mode:0o700}); const names=await readdir(this.root); return Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>this.get(n.slice(0,-5))).map(p=>p.then(v=>({planId:v.planId,title:v.title,revision:v.revision,progress:v.progress,current:v.current})))); }
 async change(id,expected,fn){ const file=this.file(id); await mkdir(this.root,{recursive:true,mode:0o700}); const lock=file+'.lock'; let acquired=false;
 for(let n=0;n<50;n++){ try {await mkdir(lock);acquired=true;break;}catch(e){if(e.code!=='EEXIST')throw e; await new Promise(r=>setTimeout(r,20));} }
 if(!acquired) throw Error('Plan busy; retry later');
 try{ let raw;try{raw=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;raw={planId:id,title:id,revision:0,state:initialTreeState()};}
 if(expected!==undefined && expected!==raw.revision)throw Error('Revision conflict; read plan_view before updating');
 if(expected===undefined && raw.revision>0)throw Error('expectedRevision required for existing plan');
 const before=this.view(raw).nodes; const next=await fn(structuredClone(raw)); next.revision=raw.revision+1;next.updatedAt=new Date().toISOString(); next.history=[...(raw.history||[]),{revision:next.revision,at:next.updatedAt,changes:auditChanges(before,this.view(next).nodes)}]; const temp=file+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});await rename(temp,file);return this.view(next);
 }finally{await rmdir(lock);} }
 async import(args){ if(args.title!==undefined&&(typeof args.title!=='string'||args.title.length>120))throw Error('Invalid title'); if(args.conversation!==undefined&&(typeof args.conversation!=='string'||args.conversation.length>120))throw Error('Invalid conversation'); if(typeof args.outline!=='string'||args.outline.length>50000)throw Error('Outline exceeds limit');const parsed=parseImport(args.outline,{maxNodes:201});if(!parsed.length)throw Error('Empty outline');if(parsed.length>200)throw Error('Maximum 200 nodes');return this.change(args.planId,args.expectedRevision,r=>({...r,title:args.title||r.title,conversation:args.conversation||r.conversation||'',dependencies:{},blockedReasons:{},state:importNodes(initialTreeState(),parsed)})); }
 applyNode(raw,args,seq){
  if(!['add','update','remove'].includes(args.action))throw Error('Invalid action');
  if(args.status!==undefined&&!['pending','active','done','blocked'].includes(args.status))throw Error('Invalid status');
  if(args.blockedReason!==undefined&&(typeof args.blockedReason!=='string'||args.blockedReason.length>2000))throw Error('Invalid blocked reason');
  const result=applyPlanNode(raw.state,args,{seq});if(!result.ok)throw Error(result.error);
  const before=treeView(raw.state).nodes;
  const id=before.find(n=>n.id===args.id)?.id||before.find(n=>n.title===args.id)?.id||args.id;
  const nodes=treeView(result.state).nodes, ids=new Set(nodes.map(n=>n.id));
  const dependencies={...raw.dependencies},blockedReasons={...raw.blockedReasons};
  if(args.dependsOn!==undefined)dependencies[id]=args.dependsOn;
  if(args.blockedReason!==undefined)blockedReasons[id]=args.blockedReason;
  for(const key of Object.keys(dependencies)){
   if(!ids.has(key))delete dependencies[key];
   else if(args.action==='remove')dependencies[key]=dependencies[key].filter(ref=>ids.has(ref));
  }
  for(const key of Object.keys(blockedReasons))if(!ids.has(key))delete blockedReasons[key];
  validateDependencies(nodes,dependencies);
  return {...raw,state:result.state,dependencies,blockedReasons};
 }
 async node(args){return this.change(args.planId,args.expectedRevision,r=>this.applyNode(r,args,r.revision+1));}
 async batch(args){
  if(!Array.isArray(args.operations)||!args.operations.length||args.operations.length>100)throw Error('Expected 1 to 100 operations');
  return this.change(args.planId,args.expectedRevision,r=>{
   let next=r;for(const operation of args.operations)next=this.applyNode(next,operation,r.revision+1);return next;
  });
 }
 async history(args){
  const raw=JSON.parse(await readFile(this.file(args.planId),'utf8'));
  const after=args.afterRevision??0;if(!Number.isInteger(after)||after<0)throw Error('Invalid revision');
  return {planId:raw.planId,revision:raw.revision,history:(raw.history||[]).filter(h=>h.revision>after)};
 }
}
