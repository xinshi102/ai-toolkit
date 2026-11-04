#!/usr/bin/env python3
import tempfile,json,sys,hashlib
from pathlib import Path
import manager as m
from test_paths import directory_link
def approved(p,field):
 f=p.parent/(p.name+'.approval.json')
 m.write(f,{field:m.digest(p),'approved':True,'authorized_by':'user'});return f
with tempfile.TemporaryDirectory(prefix='ai-workspace-validation-') as tmp:
 w=Path(tmp).resolve()/'workspace';w.mkdir();m.W=w;m.R=w/'08-System/inventory/registry.json'
 for rel in ['00-HOME','08-System/inventory','08-System/audit','08-System/migrations','09-Inbox/incoming']:(w/rel).mkdir(parents=True)
 source=Path(tmp).resolve()/'workflow.json';source.write_text('{"fixture":true}', encoding='utf-8')
 a={'asset_id':'test-stable-id','name':source.name,'type':'workflow','owner_project':None,'source_of_truth':str(source),'original_path':str(source),'current_path':str(source),'harness':None,'version':None,'status':'present','dependencies':[],'last_verified':m.now(),'management_policy':'B','evidence_status':'VERIFIED'}
 d={'assets':[a],'generated_at':m.now(),'duplicates':{}}
 m.write(m.R,d);destination=w/'09-Inbox/incoming/workflow.json'
 plan=w/'08-System/migrations/proposal.json'
 m.write(plan,{'asset_id':a['asset_id'],'source':str(source),'destination':str(destination),'source_sha256':m.digest(source)})
 bad=plan.parent/'bad.json';m.write(bad,{'approved':True,'authorized_by':'user','plan_sha256':'wrong'})
 try:m.migrate(plan,bad,d);raise AssertionError('invalid approval accepted')
 except ValueError:pass
 assert source.exists() and not destination.exists()
 ok=approved(plan,'plan_sha256')
 source.write_text('{"fixture":false}', encoding='utf-8')
 try:m.migrate(plan,ok,d);raise AssertionError('stale hash accepted')
 except ValueError:pass
 source.write_text('{"fixture":true}', encoding='utf-8')
 destination.write_text('collision', encoding='utf-8')
 try:m.migrate(plan,ok,d);raise AssertionError('collision overwritten')
 except ValueError:pass
 assert destination.read_text(encoding='utf-8')=='collision';destination.unlink()
 try:m.destination(w.parent/'outside.json');raise AssertionError('outside path accepted')
 except ValueError:pass
 tx=m.migrate(plan,ok,d)
 assert not source.exists() and destination.exists() and m.read(m.R)['assets'][0]['asset_id']=='test-stable-id'
 record=w/'08-System/migrations'/('operation-'+tx['operation_id']+'.json')
 approval=approved(record,'record_sha256')
 m.rollback(record,approval,d)
 assert source.read_text(encoding='utf-8')=='{"fixture":true}' and not destination.exists()
 assert m.read(m.R)['assets'][0]['current_path']==str(source)
 assert not m.validate(d)
 print(json.dumps({'VERIFIED':['wrong approval rejected','changed source rejected','collision preserved','outside destination rejected','migration bytes and stable ID','approved rollback restores source and registry'],'fixture':'isolated temporary directory'},ensure_ascii=False))

# Curated metadata must survive discovery; changed skill entry must revoke runtime evidence.
import discovery as scan
with tempfile.TemporaryDirectory(prefix='workspace-state-test-') as tmp:
 home=Path(tmp).resolve();skill=home/'skills/example';skill.mkdir(parents=True);(skill/'SKILL.md').write_text('Fixture version one', encoding='utf-8')
 oldhome,oldroots,oldprojects=scan.H,scan.SKILL_ROOTS,scan.PROJECT_ROOTS
 try:
  scan.H=home;scan.SKILL_ROOTS=[home/'skills'];scan.PROJECT_ROOTS=[]
  one=scan.discover();a=next(a for a in one['assets'] if a['current_path']==str(skill))
  a.update(owner_project='reviewed-owner',dependencies=['reviewed-dependency'],version='reviewed-version',source_authority='reviewed-authority',runtime_validation='VERIFIED current-turn load')
  two=scan.discover(one);b=next(a for a in two['assets'] if a['current_path']==str(skill))
  for field in ['asset_id','owner_project','dependencies','version','source_authority','runtime_validation']:assert a[field]==b[field],field
  (skill/'SKILL.md').write_text('Fixture changed', encoding='utf-8')
  three=scan.discover(two);c=next(a for a in three['assets'] if a['current_path']==str(skill));assert c['runtime_validation']=='UNVERIFIED'
  assert m.validate({'assets':[{'asset_id':'bad'}]})[0]['problem']=='missing fields'
  alias=home/'alias';directory_link(alias,home/'skills')
  try:m.check_file({'type':'prompt'},alias/'example/SKILL.md');raise AssertionError('source symlink chain accepted')
  except ValueError:pass
  print(json.dumps({'VERIFIED':['curated metadata retained','changed entry revokes runtime evidence','schema error reported','symlink source chain rejected']}))
 finally:scan.H,scan.SKILL_ROOTS,scan.PROJECT_ROOTS=oldhome,oldroots,oldprojects
