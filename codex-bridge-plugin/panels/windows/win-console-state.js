import {readFile,writeFile,mkdir,rename,unlink,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {consoleHome} from './win-console-data.js';
const name='console-ui-state.json';
const taskKey=x=>typeof x==='string'&&/^[a-z0-9_.-]{1,240}$/.test(x);
async function read(home){
  const f=path.join(home,name);
  try{const st=await lstat(f);if(!st.isFile()||st.size>65536)throw Error('INVALID_CONSOLE_STATE');return JSON.parse(await readFile(f,'utf8'))}
  catch(e){if(e.code==='ENOENT')return {};throw e}
}
let writes=Promise.resolve();
function change(config,edit){
  const home=consoleHome(config);
  const next=writes.catch(()=>{}).then(async()=>{
    const old=await read(home),value=await edit(old);
    await mkdir(home,{recursive:true,mode:0o700});
    const temp=path.join(home,'.console-ui-'+randomUUID());
    try{await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temp,path.join(home,name))}
    finally{await unlink(temp).catch(()=>{})}
    return value;
  });
  writes=next;return next;
}
export const consoleState=config=>read(consoleHome(config));
export function saveConsoleLayout(config,raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('INVALID_LAYOUT');
  const layout={open:{}};
  for(const k of ['tree','res','inbox','det'])layout.open[k]=raw.open?.[k]===0?0:1;
  for(const [k,def] of [['lw',.19],['lv',.62],['rv',.30]])layout[k]=Number.isFinite(raw[k])?Math.max(.12,Math.min(k==='lw'?.6:.88,raw[k])):def;
  layout.selected=taskKey(raw.selected)?raw.selected:null;
  layout.folded=Array.isArray(raw.folded)?raw.folded.filter(taskKey).slice(0,256):[];
  layout.inboxFold=Object.fromEntries(['done','ms'].map(k=>[k,raw.inboxFold?.[k]!==false]));
  return change(config,old=>({...old,layout}));
}
export async function markMilestones(config,ids){
  const set=[...new Set(ids.filter(taskKey))].slice(0,256);
  await change(config,old=>({...old,readMilestones:[...new Set([...(old.readMilestones||[]),...set])].slice(-512)}));
  return {ok:true,count:set.length};
}

export async function setRunPlacement(config,id,target){
  if(!taskKey(id)||!(target===null||taskKey(target)))throw Error('INVALID_ASSIGNMENT');
  await change(config,old=>{
    const entries=Object.entries(old.assignments||{}).filter(([k])=>k!==id);
    if(target!==null)entries.push([id,target]);
    return {...old,assignments:Object.fromEntries(entries.slice(-512))};
  });
  return {ok:true};
}
export async function setRunArchived(config,id,archived){
  if(!taskKey(id)||typeof archived!=='boolean')throw Error('INVALID_ARCHIVE');
  await change(config,old=>({...old,archivedRuns:[...(old.archivedRuns||[]).filter(x=>x!==id),...(archived?[id]:[])].slice(-512)}));
  return {ok:true};
}
