#!/usr/bin/env python3
"""Personal Mac workspace controller. No network; no daemon."""
import argparse,json,os,hashlib,uuid,fcntl
from pathlib import Path
from datetime import datetime,timezone
import discovery
W=Path(__file__).resolve().parents[2]
R=W/'08-System/inventory/registry.json'
def now():return datetime.now(timezone.utc).isoformat()
def read(p):return json.loads(p.read_text())
def write(p,d):
 p.parent.mkdir(parents=True,exist_ok=True)
 tmp=p.with_name(p.name+'.tmp-'+uuid.uuid4().hex)
 with tmp.open('x') as f:json.dump(d,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
def audit(action,details):
 p=W/'08-System/audit/operations.jsonl'
 with p.open('a') as f:f.write(json.dumps({'time':now(),'action':action,'details':details},ensure_ascii=False)+'\n');f.flush();os.fsync(f.fileno())
def get(d,aid):
 a=next((x for x in d['assets'] if x['asset_id']==aid),None)
 if not a:raise ValueError('Unknown asset ID')
 return a
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def validate(d):
 issues=[];ids=set()
 required={'asset_id','name','type','owner_project','source_of_truth','original_path','current_path','harness','version','status','dependencies','last_verified','management_policy'}
 for a in d['assets']:
  if required-set(a):
   issues.append({'id':a.get('asset_id'),'problem':'missing fields','fields':sorted(required-set(a))});continue
  if a['asset_id'] in ids:issues.append({'id':a['asset_id'],'problem':'duplicate ID'})
  ids.add(a['asset_id'])
  if not Path(a['current_path']).exists() and a['status']!='missing':issues.append({'id':a['asset_id'],'problem':'path unavailable'})
  for dep in a['dependencies']:
   if not any(x['asset_id']==dep for x in d['assets']):issues.append({'id':a['asset_id'],'problem':'unknown dependency'})
 return issues
def artifact_projection():
 p=W/'08-System/inventory/artifacts.json'
 if not p.exists():return []
 return [dict(a,asset_id=a['artifact_id'],type='artifact',current_path=a['path'],source_of_truth=a['path'],harness=a['producer'],management_policy='A',evidence_status='VERIFIED file sealed' if a['status']=='ready' else 'UNVERIFIED reserved output') for a in read(p)['artifacts']]
def render(d):
 counts={}
 for a in d['assets']:counts[a['type']]=counts.get(a['type'],0)+1
 home=W/'00-HOME'
 rows=d['assets']+artifact_projection()
 (home/'DIRECTORY.md').write_text('# Workspace Directory Map\n\n资产状态：../08-System/inventory/registry.json；产物状态：../08-System/inventory/artifacts.json。原生资产保留原路径。\n\n| 类型 | 名称 | 当前绝对路径 | 证据 |\n|---|---|---|---|\n'+''.join('| '+a['type']+' | '+a['name'].replace('|','\\|')+' | '+a['current_path'].replace('|','\\|')+' | '+a['evidence_status']+' |\n' for a in rows))
 body='# Mac AI Workspace\n\n个人 Mac，禁止公司域同步。更新时间：'+d['generated_at']+'\n\n资产 '+str(len(d['assets']))+' 项；已登记新产物 '+str(len(artifact_projection()))+' 件。\n\n'
 if (home/'PROJECT-CATEGORIES.md').exists():body+='- [按用途查找：AI Studio / Learn / Computer / Unity / Life](PROJECT-CATEGORIES.md)\n\n'
 body+='- [项目重复、归档与迁移核查](../06-Artifacts/reports/PROJECT-REVIEW.md)\n- [下一步项目整理清单](../08-System/manifests/project-next-work.json)\n- [全部本机 AI 启动与专属工作区](AI-ENTRIES/README.md)\n- [新对话统一入口](NEW-CONVERSATION.md)\n- [AI 入口与能力](../08-System/manifests/harnesses.json)\n- [任务与参与 AI](../08-System/inventory/tasks.json)\n- [产物索引](../08-System/inventory/artifacts.json)\n- [目录与资产定位](DIRECTORY.md)\n- [管理验收](../06-Artifacts/reports/GOVERNANCE-ACCEPTANCE.md)\n- [Manager Skill](../03-Skills/shared/ai-workspace-manager/SKILL.md)\n- [风险](../08-System/policies/RISK-REGISTER.md)\n- [迁移计划](../08-System/migrations/MIGRATION-PLAN.md)\n- [兼容性](../06-Artifacts/reports/COMPATIBILITY.md)\n- [重复资产核查](../06-Artifacts/reports/DUPLICATE-AUDIT.md)\n- [完整验收记录](../06-Artifacts/reports/ACCEPTANCE.json)\n\n'
 p=W/'08-System/manifests/harnesses.json'
 if p.exists():
  body+='| AI | 管理入口 | 自动发现 Manager |\n|---|---|---|\n'
  for e in read(p)['harnesses']:body+='| '+e['id']+' | '+e['manager_entry_status']+' | '+str(e['capabilities']['native_manager_autodiscovery'])+' |\n'
 body+='\n总体目标仍在进行中：直接点击原应用图标尚未统一接入。详见 [真实入口状态](../06-Artifacts/reports/AI-ENTRY-STATUS.md) 与 [具体原生变更方案](../08-System/integration-proposals/NATIVE-ENTRY-PROPOSAL.json)。\n\n验收由管理者执行，不要求用户制造测试任务。真实模型对话效果在之后自然使用时观察，不作为管理工具交付门槛。新产物遵循任务分配与封存协议；没有全局写盘拦截。现有项目及原生资源通过原位索引定位。\n\nSkill 分发由兼容记录、准备方案和具体原生安装授权驱动；DSH 准备源、Kimi 本机交接入口不等于已原生自动接入。\n\nPlan Map 是计划唯一权威源：~/.codex/plan-map/mac-ai-workspace-20261011.json。这里只引用，当前显示入口由 plan_view 获取。\n'
 (home/'DASHBOARD.md').write_text(body)
def index(d):
 found=discovery.discover(d);seen={a['asset_id'] for a in found['assets']}
 for a in d['assets']:
  if a['asset_id'] not in seen:
   a=dict(a)
   if a.get('management_policy')=='A' and Path(a['current_path']).exists():a['status']='present'
   else:a['status']='missing' if not Path(a['current_path']).exists() else 'outside-current-scan'
   found['assets'].append(a)
 # Resolve only verified containment relationships, without inferring runtime dependencies.
 projects=[a for a in found['assets'] if a['type']=='project']
 for a in found['assets']:
  parents=[p for p in projects if a['asset_id']!=p['asset_id'] and Path(a['current_path']).is_relative_to(p['current_path'])]
  if parents:
   parent=max(parents,key=lambda p:len(p['current_path']))
   a['owner_project']=parent['asset_id'];a['ownership_evidence']='VERIFIED path containment'
  if a['type']=='plan':
   stores=[x for x in found['assets'] if x['type']=='plan-store' and Path(a['current_path']).parent==Path(x['current_path'])]
   a['dependencies']=list(dict.fromkeys(a['dependencies']+[x['asset_id'] for x in stores]))
 write(W/'08-System/audit'/('registry-before-'+uuid.uuid4().hex+'.json'),d)
 write(R,found);render(found);audit('index',{'assets':len(found['assets'])});return found
def reject_symlink_chain(p):
 for part in [p,*p.parents]:
  if part.is_symlink():raise ValueError('Symlink path component prohibited')
def check_file(a,p):
 reject_symlink_chain(p)
 if a['type'] not in ['workflow','prompt','agent']:raise ValueError('Only reviewed individual workflow/prompt/agent files are supported; native plans/configs/skills are retained')
 if p.is_symlink() or not p.is_file():raise ValueError('Regular file required')
 if any(x in p.name.lower() for x in ['.env','auth','token','secret','credential']):raise ValueError('Sensitive file prohibited')
 if p.suffix not in ['.md','.json','.yaml','.yml','.txt']:raise ValueError('Unsupported file')
def destination(p):
 p=Path(p).absolute()
 if '..' in p.parts or not p.is_relative_to(W/'09-Inbox/incoming'):raise ValueError('Destination must be in Workspace 09-Inbox/incoming')
 for parent in [p,*p.parents]:
  if parent==W.parent:break
  if parent.is_symlink():raise ValueError('Symlink destination prohibited')
 if p.exists():raise ValueError('Destination exists')
 return p
def migrate(plan_path,approval_path,d):
 plan=read(plan_path);approval=read(approval_path)
 if approval.get('plan_sha256')!=digest(plan_path) or approval.get('approved') is not True or approval.get('authorized_by')!='user':raise ValueError('Exact user approval required')
 a=get(d,plan['asset_id']);src=Path(a['current_path']);check_file(a,src);dst=destination(plan['destination'])
 if str(src)!=plan['source'] or digest(src)!=plan['source_sha256']:raise ValueError('Source changed; replan')
 operation=uuid.uuid4().hex;record=W/'08-System/migrations'/('operation-'+operation+'.json')
 tx={'operation_id':operation,'asset_id':a['asset_id'],'source':str(src),'destination':str(dst),'sha256':plan['source_sha256'],'before':dict(a),'status':'prepared','time':now()}
 write(record,tx)
 dst.parent.mkdir(parents=True,exist_ok=True)
 # Hardlink creation is atomic and fails on collision or different volumes.
 os.link(src,dst,follow_symlinks=False)
 try:
  if digest(dst)!=tx['sha256']:raise ValueError('Verification mismatch')
  if not os.path.samefile(src,dst) or digest(src)!=tx['sha256']:raise ValueError('Concurrent source modification')
  src.unlink()
 except Exception:
  dst.unlink();raise
 tx['status']='file-moved';write(record,tx)
 a.update(current_path=str(dst),source_of_truth=str(dst),management_policy='A',last_verified=now())
 write(R,d);tx['status']='committed';write(record,tx);render(d);audit('migrate',{'record':str(record)})
 return tx
def rollback(record_path,approval_path,d):
 tx=read(record_path);approval=read(approval_path)
 if approval.get('record_sha256')!=digest(record_path) or approval.get('approved') is not True or approval.get('authorized_by')!='user':raise ValueError('Exact rollback approval required')
 src=Path(tx['source']);dst=Path(tx['destination'])
 reject_symlink_chain(src);reject_symlink_chain(dst)
 if tx['status']!='committed' or src.exists() or dst.is_symlink() or digest(dst)!=tx['sha256']:raise ValueError('Unsafe rollback state')
 a=get(d,tx['asset_id'])
 if a['current_path']!=str(dst):raise ValueError('Registry changed')
 os.link(dst,src,follow_symlinks=False);dst.unlink()
 a.clear();a.update(tx['before']);write(R,d)
 tx['status']='rolled-back';write(record_path,tx);render(d);audit('rollback',{'record':str(record_path)});return tx
def main():
 ap=argparse.ArgumentParser()
 ap.add_argument('command',choices=['discover','index','locate','organize','plan-migrate','migrate','rollback','validate','audit','report'])
 ap.add_argument('--asset');ap.add_argument('--query',default='');ap.add_argument('--type');ap.add_argument('--project');ap.add_argument('--destination');ap.add_argument('--plan');ap.add_argument('--approval');ap.add_argument('--record')
 args=ap.parse_args()
 with (W/'08-System/audit/controller.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  d=read(R)
  if args.command=='discover':out=discovery.discover(d)
  elif args.command=='index':out={'assets':len(index(d)['assets'])}
  elif args.command=='locate':
   out=[a for a in d['assets']+artifact_projection() if (not args.asset or a['asset_id']==args.asset) and (not args.type or a['type']==args.type) and (not args.project or a['owner_project']==args.project) and args.query.lower() in (a['name']+' '+a['current_path']).lower()]
  elif args.command=='organize':out={'duplicates':d['duplicates'],'action':'proposal-only; no deduplication without authority review'}
  elif args.command=='validate':
   out={'evidence_status':'VERIFIED','issues':validate(d)}
   if out['issues']:print(json.dumps(out,ensure_ascii=False));return 1
  elif args.command=='audit':out=(W/'08-System/audit/operations.jsonl').read_text() if (W/'08-System/audit/operations.jsonl').exists() else ''
  elif args.command=='report':render(d);out={'dashboard':str(W/'00-HOME/DASHBOARD.md')}
  elif args.command=='plan-migrate':
   a=get(d,args.asset);p=Path(a['current_path']);check_file(a,p);dest=destination(args.destination)
   out={'asset_id':a['asset_id'],'source':str(p),'destination':str(dest),'source_sha256':digest(p),'risk':'Native caller/path dependencies UNVERIFIED; explicit user review required','rollback':'exact original path, no overwrite','status':'requires-user-approval'}
   path=W/'08-System/migrations'/('proposal-'+uuid.uuid4().hex+'.json');write(path,out);audit('proposal',{'path':str(path)});out={'proposal':str(path),'plan_sha256':digest(path),'details':out}
  elif args.command=='migrate':out=migrate(Path(args.plan),Path(args.approval),d)
  elif args.command=='rollback':out=rollback(Path(args.record),Path(args.approval),d)
  print(json.dumps(out,ensure_ascii=False,indent=2));return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except (ValueError,OSError,KeyError,TypeError) as e:print(json.dumps({'status':'BLOCKED','reason':str(e)},ensure_ascii=False));raise SystemExit(2)
