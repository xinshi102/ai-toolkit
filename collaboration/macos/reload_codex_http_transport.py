#!/usr/bin/env python3
"""One-shot reload after this turn is saved; migrates via official RPC, never edits state DB."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import selectors
import signal
import sqlite3
import subprocess
import time
import tomllib

CLI='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
class RPC:
    def __init__(self, command):
        self.p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
        self.selector=selectors.DefaultSelector();self.selector.register(self.p.stdout,selectors.EVENT_READ)
        self.pending=b'';self.id=0;self.notifications=[]
    def send(self,method,params=None,notification=False):
        msg={'jsonrpc':'2.0','method':method}
        if params is not None:msg['params']=params
        if not notification:self.id+=1;msg['id']=self.id
        self.p.stdin.write((json.dumps(msg)+'\n').encode());self.p.stdin.flush()
        if notification:return None
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            r=self.read()
            if r.get('id')==self.id and ('result' in r or 'error' in r):
                if 'error' in r:raise RuntimeError('RPC rejected request: '+str(r['error'].get('code')))
                return r['result']
            self.notifications.append(r)
        raise TimeoutError('RPC deadline')
    def read(self):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if b'\n' not in self.pending:
                if not self.selector.select(1):continue
                block=os.read(self.p.stdout.fileno(),65536)
                if not block:raise RuntimeError('RPC process closed')
                self.pending+=block
                continue
            line,self.pending=self.pending.split(b'\n',1)
            try:return json.loads(line)
            except ValueError:continue
        raise TimeoutError('RPC deadline')
    def close(self):
        self.p.terminate()
        try:self.p.wait(5)
        except subprocess.TimeoutExpired:self.p.kill()

def processes():
    result=[]
    for row in subprocess.check_output(['ps','-axo','pid=,ppid=,comm='],text=True).splitlines():
        parts=row.strip().split(None,2)
        if len(parts)==3:result.append((int(parts[0]),int(parts[1]),parts[2]))
    return result

def migrate_thread(thread):
    rpc=RPC([CLI,'app-server','--stdio'])
    try:
        rpc.send('initialize',{'clientInfo':{'name':'http_transport_reload','version':'1.0'},'capabilities':{'experimentalApi':True}})
        rpc.send('initialized',notification=True)
        r=rpc.send('thread/resume',{'threadId':thread,'modelProvider':'openai-http','excludeTurns':True})
        if r.get('modelProvider')!='openai-http':raise RuntimeError('Resume did not select HTTP provider')
        return {'resolvedProvider':r['modelProvider'],'threadId':thread}
    finally:rpc.close()

def restart():
    app=Path('/Applications/ChatGPT.app')
    executable=plistlib.loads((app/'Contents/Info.plist').read_bytes())['CFBundleExecutable']
    command=str(app/'Contents/MacOS'/executable)
    old=[pid for pid,parent,comm in processes() if parent==1 and comm==command]
    for pid in old:os.kill(pid,signal.SIGTERM)
    deadline=time.monotonic()+12
    while time.monotonic()<deadline and any(pid in old for pid,_,_ in processes()):time.sleep(.5)
    for pid,parent,comm in processes():
        if pid in old and comm==command:os.kill(pid,signal.SIGKILL)
    time.sleep(1)
    for attempt in range(3):
        subprocess.run(['open','-a',str(app)],check=True)
        for _ in range(15):
            current=[pid for pid,parent,comm in processes() if parent==1 and comm==command and pid not in old]
            if current:return {'oldPids':old,'newPid':current[0]}
            time.sleep(1)
    raise RuntimeError('App did not restart')

def finish_plan(plan_id):
    config=tomllib.loads((Path.home()/'.codex/config.toml').read_text())
    server=config['mcp_servers']['plan-map']
    rpc=RPC([server['command'],*server.get('args',[])])
    try:
        rpc.send('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'http_transport_acceptance','version':'1.0'}})
        rpc.send('notifications/initialized',notification=True)
        def call(name,args):return rpc.send('tools/call',{'name':name,'arguments':args})
        view=call('plan_view',{'planId':plan_id});rev=view['structuredContent']['revision']
        for node,note in [('network-reload','当前会话通过原生thread/resume切到HTTP provider；回复保存后客户端自动重启并核对新进程。'),('network','HTTP/SSE兼容修复已部署并通过同模型真实多轮、20秒工具等待、上下文继续和桌面重载；历史TLS中断的底层责任归因仍不冒充已证实。')]:
            r=call('plan_node',{'planId':plan_id,'expectedRevision':rev,'action':'update','id':node,'status':'done','blockedReason':'','note':note})
            rev=r['structuredContent']['revision']
        return rev
    finally:rpc.close()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--thread-id',required=True);parser.add_argument('--rollout',type=Path,required=True)
    parser.add_argument('--receipt',type=Path,required=True);parser.add_argument('--plan-id',required=True)
    args=parser.parse_args()
    if not re.fullmatch(r'[0-9a-f-]{36}',args.thread_id):raise ValueError('Invalid thread ID')
    if args.thread_id not in args.rollout.name or not args.rollout.resolve().is_relative_to(Path.home()/'.codex/sessions'):raise ValueError('Unexpected rollout')
    offset=args.rollout.stat().st_size;pending=b'';deadline=time.monotonic()+600
    receipt={'status':'waiting_for_turn_save','threadId':args.thread_id,'startedAt':time.time()}
    def save():args.receipt.write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
    save()
    try:
        done=False; completed_at=None
        while time.monotonic()<deadline:
            with args.rollout.open('rb') as stream:
                stream.seek(offset);block=stream.read();offset=stream.tell()
            pending+=block
            while b'\n' in pending:
                line,pending=pending.split(b'\n',1)
                try:event=json.loads(line)
                except ValueError:continue
                if event.get('type')=='event_msg':
                    kind=event.get('payload',{}).get('type')
                    if kind=='task_started':completed_at=None
                    if kind=='task_complete':completed_at=time.monotonic()
            if completed_at is not None and time.monotonic()-completed_at>=3:
                done=True;break
            time.sleep(.5)
        if not done:raise TimeoutError('Turn did not finish; no restart performed')
        time.sleep(2)
        config=tomllib.loads((Path.home()/'.codex/config.toml').read_text())
        assert config.get('model_provider')=='openai-http'
        assert config['model_providers']['openai-http']['supports_websockets'] is False
        receipt['status']='migrating_saved_thread';save()
        receipt['threadMigration']=migrate_thread(args.thread_id)
        receipt['status']='restarting_client';save()
        receipt['clientRestart']=restart()
        for _ in range(20):
            receipt['newAppServerPids']=[pid for pid,parent,comm in processes() if parent==receipt['clientRestart']['newPid'] and comm.endswith('/codex')]
            if receipt['newAppServerPids']:break
            time.sleep(1)
        if not receipt['newAppServerPids']:raise RuntimeError('New app-server not observed')
        db=sqlite3.connect('file:'+str(Path.home()/'.codex/state_5.sqlite')+'?mode=ro',uri=True)
        receipt['storedThreadProvider']=db.execute('select model_provider from threads where id=?',(args.thread_id,)).fetchone()[0];db.close()
        if receipt['storedThreadProvider']!='openai-http':raise RuntimeError('Thread provider persistence not confirmed')
        receipt['status']='passed';receipt['completedAt']=time.time();save()
        try:receipt['planRevision']=finish_plan(args.plan_id)
        except Exception as exc:receipt['planUpdateError']=type(exc).__name__
        save()
    except Exception as exc:
        receipt['status']='failed';receipt['errorType']=type(exc).__name__;save()
        raise
if __name__=='__main__':main()
