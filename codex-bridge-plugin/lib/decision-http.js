import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const worker=fileURLToPath(new URL('./decision_store.py',import.meta.url));

export function decisionRequestAllowed(req,port) {
  const host=req.headers?.host;
  const hosts=new Set(['127.0.0.1','localhost','[::1]'].map(h=>h+':'+port));
  if(!hosts.has(host))return false;
  if(req.method==='GET')return !req.headers.origin||req.headers.origin==='http://'+host;
  return req.headers.origin==='http://'+host &&
    req.headers['x-xinshi-decision']==='1' &&
    /^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'');
}

export async function decisionRequest(config,action,body={}) {
  const home=config.collaborationHome||path.join(os.homedir(),'Library/Application Support/xinshi-collaboration');
  return new Promise(resolve=>{
    const child=spawn('/usr/bin/python3',['-I','-B',worker,home,action],{
      stdio:['pipe','pipe','ignore'],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},
    });
    let result='',settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)};
    const fail=()=>finish({ok:false,error:'INBOX_UNAVAILABLE',status:503});
    const timer=setTimeout(()=>{child.kill();fail()},6500);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      result+=chunk;
      if(result.length>160000){child.kill();fail()}
    });
    child.stdin.on('error',fail);
    child.on('error',fail);
    child.on('close',code=>{
      if(code!==0)return fail();
      try{finish(JSON.parse(result))}catch{fail()}
    });
    child.stdin.end(JSON.stringify(body));
  });
}
