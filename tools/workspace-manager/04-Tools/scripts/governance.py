#!/usr/bin/env python3
"""Local AI entry/task/artifact governance. No network or native config edits."""
import argparse, hashlib, json, os, re, uuid, unicodedata
from pathlib import Path
from file_lock import file_lock
from datetime import datetime, timezone
W = Path(__file__).resolve().parents[2]

def now(): return datetime.now(timezone.utc).isoformat()
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def check(p):
    p = Path(p).absolute()
    if '..' in p.parts: raise ValueError('Path traversal prohibited')
    for part in (p, *p.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()): raise ValueError('Symlink path prohibited')
    return p

def local(p):
    p = check(p)
    if not p.is_relative_to(W): raise ValueError('Outside Workspace')
    return p

def write(p, data):
    p = local(p); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + '.tmp-' + uuid.uuid4().hex)
    with tmp.open('x', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, p)

def text_new(p, content):
    p = check(p); p.parent.mkdir(parents=True, exist_ok=True)
    with p.open('x', encoding='utf-8') as f: f.write(content); f.flush(); os.fsync(f.fileno())

def audit(action, data):
    p = local(W/'08-System/audit/governance.jsonl'); p.parent.mkdir(parents=True, exist_ok=True)
    with p.open('a', encoding='utf-8') as f:
        f.write(json.dumps({'time':now(), 'action':action, **data}, ensure_ascii=False)+'\n'); f.flush(); os.fsync(f.fileno())

def digest(p):
    h = hashlib.sha256()
    with check(p).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()

def store(name, key):
    p = local(W/'08-System/inventory'/name)
    return read(p) if p.exists() else {'schema_version':1, key:[]}

def entry(h):
    d = read(local(W/'08-System/manifests/harnesses.json'))
    e = next((e for e in d['harnesses'] if e['id']==h), None)
    if not e or e.get('domain') not in ('personal','personal-mac'): raise ValueError('Unknown or non-personal harness')
    return e

def get_task(tid):
    t=next_task(store('tasks.json','tasks')['tasks'], tid)
    expected=W/'01-Projects/AI-Harnesses'/t.get('home_harness','')/'sessions'/tid/'artifacts' if t.get('layout')=='per-harness-session-v1' else W/'06-Artifacts/tasks'/tid
    if t.get('domain') not in ('personal','personal-mac') or t['output_root']!=str(expected): raise ValueError('Task domain or output root invalid')
    return t

def next_task(items, tid):
    t = next((t for t in items if t['task_id']==tid), None)
    if not t: raise ValueError('Unknown task ID')
    return t

def start(h, title, project=None):
    e=entry(h)
    if not title.strip() or len(title)>240: raise ValueError('Task title required, max 240 characters')
    if project:
        a = next((a for a in read(local(W/'08-System/inventory/registry.json'))['assets'] if a['asset_id']==project and a['type']=='project'), None)
        if not a: raise ValueError('Use registered project ID')
    tid = 'task-'+uuid.uuid4().hex
    t = {'task_id':tid,'title':title,'harness':h,'participants':[h],'owner_project':project,'domain':'personal','status':'active','created_at':now(),'output_root':str(W/'06-Artifacts/tasks'/tid),'handoff':str(W/'02-Agents/handoffs'/(tid+'.json'))}
    if e.get('session_root'):
        expected=W/'01-Projects/AI-Harnesses'/h/'sessions'
        if local(e['session_root'])!=expected: raise ValueError('Invalid harness session root')
        session=expected/tid; t.update(layout='per-harness-session-v1',home_harness=h,workspace=str(session),output_root=str(session/'artifacts'))
        session.mkdir(parents=True); write(session/'session.json',{'task_id':tid,'home_harness':h,'domain':'personal','task_state':str(W/'08-System/inventory/tasks.json'),'output_root':t['output_root']})
        text_new(session/'AGENTS.md',f"# 受管工作会话\n\n任务 ID：{tid}；所属 AI：{h}；产物根：{t['output_root']}。\n读取 {W}/00-HOME/NEW-CONVERSATION.md。沿用本任务，不重复 start；独立产物 reserve → 生成 → seal，完成后 finish。其他 AI 接手用 resume 保留路径。禁止公司域与凭据访问。\n")
    local(Path(t['output_root'])).mkdir(parents=True)
    d = store('tasks.json','tasks'); d['tasks'].append(t); write(W/'08-System/inventory/tasks.json', d)
    handoff(t, h); audit('task-start',{'task_id':tid,'harness':h}); return t

def handoff(t, h):
    e = entry(h)
    d = {'schema_version':1,'task_id':t['task_id'],'target_harness':h,'domain':'personal','task_state':str(W/'08-System/inventory/tasks.json'),'artifact_state':str(W/'08-System/inventory/artifacts.json'),'registry':str(W/'08-System/inventory/registry.json'),'instructions':str(W/'00-HOME/NEW-CONVERSATION.md'),'entry':e['bootstrap'],'output_root':t['output_root'],'transfer_policy':'local references only; no messages, uploads or source copies','created_at':now()}
    write(Path(t['handoff']), d); return d

def resume(tid, h):
    entry(h); d=store('tasks.json','tasks'); t=next_task(d['tasks'],tid)
    if t['status']!='active': raise ValueError('Task is closed')
    t['harness']=h; t['participants']=list(dict.fromkeys(t.get('participants',[])+[h]))
    write(W/'08-System/inventory/tasks.json',d); result=handoff(t,h)
    audit('task-resume',{'task_id':tid,'harness':h}); return result

def reserve(tid, name, kind):
    t = get_task(tid)
    if t['status']!='active': raise ValueError('Task is closed')
    if not re.fullmatch(r'[^/\\\x00-\x1f]{1,180}',name) or name in ('.','..'): raise ValueError('Single filename required')
    if any(x in name.lower() for x in ('.env','credential','private-key','token','secret')): raise ValueError('Sensitive output name prohibited')
    if kind not in ('documents','reports','images','exports','other'): raise ValueError('Unknown artifact kind')
    p = local(Path(t['output_root'])/kind/name)
    d = store('artifacts.json','artifacts')
    if p.exists() or any(unicodedata.normalize('NFC',a['path']).casefold()==unicodedata.normalize('NFC',str(p)).casefold() for a in d['artifacts']): raise ValueError('Artifact path already occupied or reserved')
    p.parent.mkdir(parents=True,exist_ok=True)
    a = {'artifact_id':'artifact-'+uuid.uuid4().hex,'task_id':tid,'producer':t['harness'],'owner_project':t['owner_project'],'name':name,'kind':kind,'path':str(p),'status':'reserved','created_at':now(),'sha256':None}
    d['artifacts'].append(a); write(W/'08-System/inventory/artifacts.json',d); audit('artifact-reserve',{'artifact_id':a['artifact_id'],'task_id':tid}); return a

def seal(aid):
    d = store('artifacts.json','artifacts'); a = next((a for a in d['artifacts'] if a['artifact_id']==aid),None)
    if not a: raise ValueError('Unknown artifact ID')
    if a['status']!='reserved': raise ValueError('Already sealed; reserve a new filename for a new version')
    p = local(a['path']); t = get_task(a['task_id'])
    if not p.is_relative_to(Path(t['output_root'])) or not p.is_file(): raise ValueError('Expected regular task output file')
    a.update(status='ready',sha256=digest(p),size=p.stat().st_size,sealed_at=now()); write(W/'08-System/inventory/artifacts.json',d)
    audit('artifact-seal',{'artifact_id':aid,'sha256':a['sha256']}); return a

def cancel(aid):
    d=store('artifacts.json','artifacts'); a=next((a for a in d['artifacts'] if a['artifact_id']==aid),None)
    if not a or a['status']!='reserved' or local(a['path']).exists(): raise ValueError('Only an uncreated reservation can be cancelled; no file deletion')
    a.update(status='cancelled',cancelled_at=now()); write(W/'08-System/inventory/artifacts.json',d)
    audit('artifact-cancel',{'artifact_id':aid}); return a

def finish(tid):
    d = store('tasks.json','tasks'); t = next_task(d['tasks'],tid)
    pending = [a for a in store('artifacts.json','artifacts')['artifacts'] if a['task_id']==tid and a['status']=='reserved']
    if pending: raise ValueError('Task has unsealed outputs')
    for a in store('artifacts.json','artifacts')['artifacts']:
        if a['task_id']==tid and a['status']=='ready' and (not local(a['path']).is_file() or digest(local(a['path']))!=a['sha256']): raise ValueError('Output changed after sealing')
    t.update(status='done',finished_at=now()); write(W/'08-System/inventory/tasks.json',d); audit('task-finish',{'task_id':tid}); return t

def skill_plan(aid, h):
    e = entry(h)
    a = next((a for a in read(local(W/'08-System/inventory/registry.json'))['assets'] if a['asset_id']==aid and a['type']=='skill'),None)
    if not a: raise ValueError('Unknown skill asset ID')
    src = local(Path(a['current_path'])/'SKILL.md')
    if not src.is_relative_to(W/'03-Skills/shared') or a['source_of_truth']!=a['current_path']: raise ValueError('Publish an authoritative shared source first; native variants cannot be silently unified')
    if not src.is_file(): raise ValueError('Missing canonical skill')
    release = read(local(W/'08-System/manifests/skill-releases.json')).get('skills',{}).get(aid,{})
    compatible = h in release.get('compatible_harnesses',[]) and release.get('reviewed_source_sha256')==digest(src)
    deps = {x['asset_id']:x for x in read(local(W/'08-System/inventory/registry.json'))['assets']}
    missing = [x for x in a['dependencies'] if x not in deps or not Path(deps[x]['current_path']).exists()]
    state = 'ready-to-prepare' if compatible and e.get('skill_root') and not missing else 'needs-adaptation'
    p = {'plan_id':'distribution-'+uuid.uuid4().hex,'asset_id':aid,'name':a['name'],'harness':h,'source':str(src),'source_sha256':digest(src),'dependencies':a['dependencies'],'missing_dependencies':missing,'compatibility':release.get('evidence',{}).get(h,'UNVERIFIED'),'status':state,'target':str(Path(e['skill_root'])/src.parent.name/'SKILL.md') if e.get('skill_root') else None,'created_at':now(),'mode':'reference-adapter; no copied canonical source or credentials'}
    file = W/'08-System/distribution'/(p['plan_id']+'.json'); write(file,p); p['plan_file']=str(file); return p

def adapter(plan):
    name = Path(plan['source']).parent.name
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',name): raise ValueError('Unsupported skill slug')
    return f'---\nname: {name}\ndescription: 使用个人 AI Workspace 的 {name} 权威技能。\n---\n\n读取并遵循 {plan["source"]}。相对资源路径以权威 Skill 目录为基准。\n管理状态入口：{W}/00-HOME/NEW-CONVERSATION.md。\n本文件是引用入口，源码唯一权威位置在 Workspace；不要复制凭据或迁移原资产。\n'

def load_plan(file):
    p = read(local(file))
    # Recompute trusted source/target/compatibility against current state; never trust plan paths.
    e = entry(p['harness'])
    a = next((a for a in read(local(W/'08-System/inventory/registry.json'))['assets'] if a['asset_id']==p['asset_id'] and a['type']=='skill'),None)
    if not a: raise ValueError('Unknown source')
    src = local(Path(a['current_path'])/'SKILL.md')
    if not src.is_relative_to(W/'03-Skills/shared') or a['source_of_truth']!=a['current_path']: raise ValueError('Non-authoritative source')
    release = read(local(W/'08-System/manifests/skill-releases.json'))['skills'].get(p['asset_id'],{})
    if release.get('reviewed_source_sha256')!=digest(src) or p['harness'] not in release.get('compatible_harnesses',[]) or not e.get('skill_root'): raise ValueError('Adapter requires compatibility review')
    target = str(Path(e['skill_root'])/src.parent.name/'SKILL.md')
    if p['source']!=str(src) or p['target']!=target or p['source_sha256']!=digest(src): raise ValueError('Plan stale or paths changed; replan')
    assets = {a['asset_id']:a for a in read(local(W/'08-System/inventory/registry.json'))['assets']}
    if any(x not in assets or not Path(assets[x]['current_path']).exists() for x in a['dependencies']): raise ValueError('Dependency unavailable')
    return p

def prepare(file):
    p = load_plan(file)
    dst = local(W/'03-Skills/adapters'/p['harness']/(p['plan_id'])/'SKILL.md')
    text_new(dst,adapter(p)); audit('skill-prepare',{'plan_id':p['plan_id'],'path':str(dst)}); return {'prepared':str(dst),'native_target':p['target'],'native_install':False}

def install(file, approval):
    p = load_plan(file); ap = read(local(approval))
    if ap.get('approved') is not True or ap.get('authorized_by')!='user' or ap.get('plan_sha256')!=digest(local(file)) or not ap.get('authorization_basis'): raise ValueError('Exact human approval with authorization basis required')
    dst = check(p['target'])
    if dst.exists(): raise ValueError('Native entry exists; overwrite forbidden')
    text_new(dst,adapter(p)); audit('skill-install',{'plan_id':p['plan_id'],'target':str(dst),'sha256':digest(dst)})
    return {'path':str(dst),'file_verified':True,'native_loader':'UNVERIFIED until harness-specific inspection'}

def health():
    issues=[]
    for a in store('artifacts.json','artifacts')['artifacts']:
        try:
            p=local(a['path'])
            if a['status']=='ready' and (not p.is_file() or digest(p)!=a['sha256']): issues.append({'artifact_id':a['artifact_id'],'problem':'missing or modified after sealing'})
        except ValueError as ex: issues.append({'artifact_id':a['artifact_id'],'problem':str(ex)})
    for e in read(local(W/'08-System/manifests/harnesses.json'))['harnesses']:
        if e.get('domain') not in ('personal','personal-mac') or not local(e['bootstrap']).is_file(): issues.append({'harness':e['id'],'problem':'invalid domain or missing bootstrap'})
        if e.get('manager_entry_status')=='installed-reference':
            native=check(Path(e['skill_root'])/'ai-workspace-manager/SKILL.md'); canonical=local(W/'03-Skills/shared/ai-workspace-manager/SKILL.md')
            if not native.is_file() or not canonical.is_file() or str(canonical) not in native.read_text(encoding='utf-8'): issues.append({'harness':e['id'],'problem':'native reference missing or canonical unavailable'})
    return {'checked_at':now(),'ok':not issues,'issues':issues,'scope':'local governance state and sealed artifact integrity; no model calls'}

def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    sub.add_parser('entries'); sub.add_parser('health')
    x=sub.add_parser('start'); x.add_argument('--harness',required=True); x.add_argument('--title',required=True); x.add_argument('--project')
    x=sub.add_parser('resume'); x.add_argument('--task',required=True); x.add_argument('--harness',required=True)
    x=sub.add_parser('reserve'); x.add_argument('--task',required=True); x.add_argument('--name',required=True); x.add_argument('--kind',default='documents')
    x=sub.add_parser('seal'); x.add_argument('--artifact',required=True)
    x=sub.add_parser('cancel'); x.add_argument('--artifact',required=True)
    x=sub.add_parser('finish'); x.add_argument('--task',required=True)
    x=sub.add_parser('find'); x.add_argument('--query',default=''); x.add_argument('--task'); x.add_argument('--harness')
    x=sub.add_parser('skill-plan'); x.add_argument('--asset',required=True); x.add_argument('--harness',required=True)
    x=sub.add_parser('prepare'); x.add_argument('--plan',required=True)
    x=sub.add_parser('install'); x.add_argument('--plan',required=True); x.add_argument('--approval',required=True)
    a=p.parse_args()
    lock=local(W/'08-System/audit/governance.lock'); lock.parent.mkdir(parents=True,exist_ok=True)
    with file_lock(lock) as f:
        if a.cmd=='entries': result=read(local(W/'08-System/manifests/harnesses.json'))
        elif a.cmd=='start': result=start(a.harness,a.title,a.project)
        elif a.cmd=='resume': result=resume(a.task,a.harness)
        elif a.cmd=='reserve': result=reserve(a.task,a.name,a.kind)
        elif a.cmd=='seal': result=seal(a.artifact)
        elif a.cmd=='cancel': result=cancel(a.artifact)
        elif a.cmd=='finish': result=finish(a.task)
        elif a.cmd=='find': result=[x for x in store('artifacts.json','artifacts')['artifacts'] if a.query.casefold() in (x['name']+' '+x['artifact_id']).casefold() and (not a.task or x['task_id']==a.task) and (not a.harness or x['producer']==a.harness)]
        elif a.cmd=='skill-plan': result=skill_plan(a.asset,a.harness)
        elif a.cmd=='prepare': result=prepare(a.plan)
        elif a.cmd=='install': result=install(a.plan,a.approval)
        else: result=health()
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 1 if a.cmd=='health' and not result['ok'] else 0
if __name__=='__main__':
    try: raise SystemExit(main())
    except (ValueError,OSError,KeyError,TypeError) as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False)); raise SystemExit(2)
