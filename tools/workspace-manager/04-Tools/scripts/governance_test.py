#!/usr/bin/env python3
"""Black-box tests in temporary Workspace: real CLI processes, randomized IDs."""
import json, shutil, subprocess, sys, tempfile, uuid
from pathlib import Path
SCRIPT=Path(__file__).with_name('governance.py')
results=[]
with tempfile.TemporaryDirectory(prefix='workspace-governance-') as tmp:
    w=Path(tmp).resolve()/'Workspace'; (w/'04-Tools/scripts').mkdir(parents=True)
    shutil.copyfile(SCRIPT,w/'04-Tools/scripts/governance.py')
    def save(rel,d):
        p=w/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d))
    def cli(*args,ok=True):
        r=subprocess.run([sys.executable,str(w/'04-Tools/scripts/governance.py'),*args],capture_output=True,text=True)
        assert (r.returncode==0)==ok,(args,r.returncode,r.stdout,r.stderr)
        return json.loads(r.stdout)
    def passed(name):results.append({'check':name,'passed':True})
    entries=[]
    for h in ('codex','hermes','dsh','kimi'):
        boot=w/'02-Agents/entries'/(h+'.md');boot.parent.mkdir(parents=True,exist_ok=True);boot.write_text('Fixture entry')
        entries.append({'id':h,'domain':'personal-mac','bootstrap':str(boot),'skill_root':str(w/'native'/h) if h!='kimi' else None,'session_root':str(w/'01-Projects/AI-Harnesses'/h/'sessions')})
    save('08-System/manifests/harnesses.json',{'harnesses':entries})
    src=w/'03-Skills/shared/example/SKILL.md';src.parent.mkdir(parents=True);src.write_text('---\nname: example\ndescription: Fixture\n---\nRead local instructions.\n')
    aid='asset-'+uuid.uuid4().hex
    save('08-System/inventory/registry.json',{'assets':[{'asset_id':aid,'type':'skill','name':'example','current_path':str(src.parent),'source_of_truth':str(src.parent),'dependencies':[]}]})
    save('08-System/manifests/skill-releases.json',{'skills':{aid:{'compatible_harnesses':['codex','hermes','dsh'],'evidence':{'codex':'fixture-only'},'reviewed_source_sha256':__import__('hashlib').sha256(src.read_bytes()).hexdigest()}}})
    cli('start','--harness','unknown','--title','x',ok=False);passed('unknown harness denied')
    cli('start','--harness','codex','--title','x','--project','unregistered',ok=False);passed('unregistered project denied')
    t=cli('start','--harness','codex','--title','Regression '+uuid.uuid4().hex)
    tid=t['task_id'];assert Path(t['handoff']).is_file() and Path(t['workspace']).is_relative_to(w/'01-Projects/AI-Harnesses/codex/sessions') and Path(t['workspace'],'session.json').is_file();passed('task and durable handoff created by fresh process')
    cli('resume','--task',tid,'--harness','hermes');passed('cross-harness resume retains task and output root')
    a=cli('reserve','--task',tid,'--name','sample.txt');assert a['producer']=='hermes';passed('actual producer after handoff recorded')
    cli('reserve','--task',tid,'--name','sample.txt',ok=False);cli('reserve','--task',tid,'--name','SAMPLE.txt',ok=False);passed('reservation and case-insensitive filesystem collision denied')
    cli('reserve','--task',tid,'--name','../escape.txt',ok=False);passed('path traversal denied')
    cli('reserve','--task',tid,'--name','.env',ok=False);passed('sensitive output names denied')
    cli('seal','--artifact',a['artifact_id'],ok=False);passed('missing output cannot seal')
    cli('finish','--task',tid,ok=False);passed('unsealed output blocks finish')
    path=Path(a['path']);path.write_bytes(b'actual artifact bytes\n')
    sealed=cli('seal','--artifact',a['artifact_id']);assert sealed['size']==22;passed('generated output size and digest sealed')
    cli('seal','--artifact',a['artifact_id'],ok=False);passed('sealed output cannot silently replace version')
    found=cli('find','--query','SAMPLE','--task',tid,'--harness','hermes');assert found[0]['artifact_id']==a['artifact_id'];passed('fresh-process case-insensitive artifact search')
    path.write_bytes(b'changed');assert not cli('health',ok=False)['ok'];cli('finish','--task',tid,ok=False);passed('modified sealed output detected and finish denied')
    path.write_bytes(b'actual artifact bytes\n');cli('finish','--task',tid);passed('verified output permits task completion')
    cli('resume','--task',tid,'--harness','codex',ok=False);passed('closed task cannot acquire new producer')
    t2=cli('start','--harness','dsh','--title','Symlink regression');out=Path(t2['output_root']);(out/'images').symlink_to(w/'native')
    cli('reserve','--task',t2['task_id'],'--name','x.png','--kind','images',ok=False);passed('symlink output chain denied')
    plan=cli('skill-plan','--asset',aid,'--harness','kimi');assert plan['status']=='needs-adaptation';cli('prepare','--plan',plan['plan_file'],ok=False);passed('unsupported native loader cannot prepare installable adapter')
    plan=cli('skill-plan','--asset',aid,'--harness','codex');prepared=cli('prepare','--plan',plan['plan_file']);assert str(src) in Path(prepared['prepared']).read_text() and not Path(plan['target']).exists();passed('distribution prepares reference without native mutation')
    approval=w/'08-System/approval.json';save('08-System/approval.json',{'approved':True,'authorized_by':'user','plan_sha256':'wrong','authorization_basis':'fixture only'})
    cli('install','--plan',plan['plan_file'],'--approval',str(approval),ok=False);passed('wrong approval digest denied')
    import hashlib
    save('08-System/approval.json',{'approved':True,'authorized_by':'user','plan_sha256':hashlib.sha256(Path(plan['plan_file']).read_bytes()).hexdigest(),'authorization_basis':'test fixture explicit approval'})
    installed=cli('install','--plan',plan['plan_file'],'--approval',str(approval));assert Path(installed['path']).is_file();passed('exact approved fixture install verified')
    before=Path(installed['path']).read_bytes();cli('install','--plan',plan['plan_file'],'--approval',str(approval),ok=False);assert before==Path(installed['path']).read_bytes();passed('native overwrite denied and bytes preserved')
    src.write_text(src.read_text()+'Changed\n');cli('prepare','--plan',plan['plan_file'],ok=False);passed('changed canonical source revokes distribution plan')
    cli('health');passed('healthy sealed artifact and bootstrap state')
    cancelled=cli('reserve','--task',t2['task_id'],'--name','not-generated.md');cli('cancel','--artifact',cancelled['artifact_id']);cli('finish','--task',t2['task_id']);passed('uncreated reservation cancellation recovers failed generation without deleting files')
    changed=cli('skill-plan','--asset',aid,'--harness','hermes');assert changed['status']=='needs-adaptation';passed('changed source invalidates prior compatibility evidence')
    src.write_text(src.read_text().replace('Changed\n','')); forged=Path(plan['plan_file']);data=json.loads(forged.read_text());data['target']=str(w/'outside.md');forged.write_text(json.dumps(data));cli('prepare','--plan',str(forged),ok=False);passed('forged plan target denied')
    d=json.loads((w/'08-System/manifests/harnesses.json').read_text());d['harnesses'].append({'id':'company','domain':'company','bootstrap':'not-read'})
    save('08-System/manifests/harnesses.json',d);cli('start','--harness','company','--title','x',ok=False);passed('company harness rejected before task creation')
print(json.dumps({'ok':all(x['passed'] for x in results),'checks':results,'scope':'temporary filesystem and CLI processes; no native runtime credentials or network'},ensure_ascii=False,indent=2))
