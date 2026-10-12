#!/usr/bin/env python3
"""Mac/GPT use the same local launcher; app-focus is never called session binding."""
import argparse,json,subprocess,shlex,sys,fcntl
from pathlib import Path
import governance as g
CODEX='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
HERMES='/Users/xinshi/.local/bin/hermes'
def plan(h, workspace):
 e=g.entry(h);root=g.local(workspace)
 if not root.is_relative_to(g.W/'01-Projects/AI-Harnesses'): raise ValueError('Unmanaged workspace')
 if h=='codex':return {'mode':'native-workspace-command','argv':[CODEX,'app',str(root)],'binding':'native command supports PATH; runtime UI not yet verified'}
 if h=='hermes':return {'mode':'hermes-cli-in-terminal','argv':[HERMES,'--in',str(root)],'binding':'CLI source pins cwd; desktop Hermes.app not bound'}
 return {'mode':'app-focus-only','argv':['/usr/bin/open','-a',e['app_path']],'binding':'UNBOUND; no native session directory injection'}
def open_plan(p):
 if p['mode']=='hermes-cli-in-terminal':
  # Generated local command only. No prompt, credential copying or model auto-call.
  command='exec '+shlex.join(p['argv'])
  script='tell application "Terminal" to do script '+json.dumps(command)
  subprocess.run(['/usr/bin/osascript','-e',script],check=True,capture_output=True)
 else:subprocess.run(p['argv'],check=True,capture_output=True)
 return {'command_dispatched':True,'mode':p['mode'],'native_session_bound':'UNVERIFIED','note':p['binding']}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('action',choices=['list','plan','session','open-app']);ap.add_argument('--harness');ap.add_argument('--title',default='新工作会话');ap.add_argument('--open',action='store_true');a=ap.parse_args()
 if a.action=='list':return g.read(g.W/'08-System/manifests/harnesses.json')
 e=g.entry(a.harness)
 if a.action=='plan':return plan(a.harness,e['work_root'])
 if a.action=='open-app':
  p={'mode':'app-focus-only','argv':['/usr/bin/open','-a',e['app_path']],'binding':'opens original app; session binding unchanged'}
  return open_plan(p) if a.open else p
 if a.harness not in ('codex','hermes'):raise ValueError('Native session-directory binding not verified; use open-app or wait for specific adapter')
 with g.local(g.W/'08-System/audit/governance.lock').open('a') as f:
  fcntl.flock(f,fcntl.LOCK_EX);t=g.start(a.harness,a.title)
  p=plan(a.harness,t['workspace']);g.audit('launch-session-prepared',{'task_id':t['task_id'],'harness':a.harness,'mode':p['mode']})
 result={'task':t,'launch_plan':p,'opened':False}
 if a.open:
  result['launch_result']=open_plan(p);result['opened']=True
 return result
if __name__=='__main__':
 try: print(json.dumps(main(),ensure_ascii=False,indent=2))
 except (ValueError,OSError,KeyError,subprocess.CalledProcessError) as e:
  print(json.dumps({'status':'BLOCKED','reason':str(e)},ensure_ascii=False));sys.exit(2)
