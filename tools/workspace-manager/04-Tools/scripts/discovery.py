import os,json,hashlib,uuid,platform,shutil,subprocess,plistlib
from pathlib import Path
from datetime import datetime,timezone
H=Path.home()
NOW=datetime.now(timezone.utc).isoformat()
SKILL_ROOTS=[H/x for x in ['.codex/skills','.codex/plugins/cache','.hermes/skills','.dsh/skills','.config/opencode/skills','Documents/Game/.codex','AI-Workspace/03-Skills/shared']]
PROJECT_ROOTS=[H/x for x in ['Documents/Game','Documents/deepseek','Documents/Computer']]
if os.name=='nt':
 SKILL_ROOTS=[H/'.codex/skills']
 PROJECT_ROOTS=[]
if os.environ.get('AI_SKILL_ROOTS'):
 SKILL_ROOTS=[Path(p).expanduser() for p in json.loads(os.environ['AI_SKILL_ROOTS'])]
if os.environ.get('AI_PROJECT_ROOTS'):
 PROJECT_ROOTS=[Path(p).expanduser() for p in json.loads(os.environ['AI_PROJECT_ROOTS'])]
EXCLUDED={'node_modules','.git','__pycache__','.venv','venv','cache','sessions','logs','backups','sources','knowledge-vault','knowledge-vault-mcp'}
def excluded(p):
 return any(t in p.name.lower() for t in ['credential','secret','token','auth','.env','knowledge-vault']) or p.name in EXCLUDED
def walk(root,depth):
 if not root.exists(): return
 for base,dirs,files in os.walk(root,followlinks=False):
  b=Path(base);level=len(b.relative_to(root).parts)
  dirs[:]=sorted(d for d in dirs if not excluded(b/d) and level<depth)
  yield b,[f for f in files if not excluded(b/f)]
def discover(previous=None):
 old={a['current_path']:a for a in (previous or {}).get('assets',[])}
 assets={};errors=[];links=[]
 def add(p,typ,harness=None,policy='B',owner=None,version=None,evidence='VERIFIED'):
  p=Path(p);key=str(p)
  if key in assets:return
  prior=old.get(key,{})
  a=dict(prior)
  a.update(asset_id=prior.get('asset_id','asset-'+uuid.uuid4().hex),name=p.name,type=typ,owner_project=prior.get('owner_project',owner),
   source_of_truth=prior.get('source_of_truth',key),original_path=prior.get('original_path',key),current_path=key,harness=harness,
   version=version if version is not None else prior.get('version'),status='present' if p.exists() else 'missing',dependencies=prior.get('dependencies',[]),last_verified=NOW,
   management_policy=prior.get('management_policy',policy),evidence_status=evidence,source_authority=prior.get('source_authority','UNVERIFIED' if typ=='skill' else 'native-location'),
   runtime_validation=prior.get('runtime_validation','UNVERIFIED'))
  if typ=='skill':
   f=p/'SKILL.md'
   try:
    if f.is_symlink():
     a['fingerprint_scope']='symlink entry not read';a['entry_hash_status']='BLOCKED';assets[key]=a;return
    st=f.stat();a['fingerprint_scope']='SKILL.md only; supporting files not compared'
    if prior.get('stat')==[st.st_mtime_ns,st.st_size] and prior.get('entry_sha256'):a['entry_sha256']=prior['entry_sha256']
    else:a['entry_sha256']=hashlib.sha256(f.read_bytes()).hexdigest()
    if prior.get('entry_sha256') and a['entry_sha256']!=prior['entry_sha256']:
     a['runtime_validation']='UNVERIFIED';a['runtime_validation_reason']='Skill entry changed after previous verification'
    a['stat']=[st.st_mtime_ns,st.st_size]
   except OSError as e:errors.append({'path':str(f),'error':type(e).__name__})
  assets[key]=a
 for root in SKILL_ROOTS:
  harness='shared' if 'AI-Workspace' in str(root) else 'codex' if '.codex' in str(root) else 'hermes' if '.hermes' in str(root) else 'dsh' if '.dsh' in str(root) else 'opencode'
  for b,files in walk(root,9):
   if 'SKILL.md' in files:add(b,'skill',harness,'A' if harness=='shared' else 'B',owner='mac-ai-workspace' if harness=='shared' else None)
   try:
    for x in b.iterdir():
     if x.is_symlink() and not excluded(x):
      links.append({'path':str(x),'target':os.readlink(x),'valid':x.exists()})
   except OSError:pass
 for rel,typ,harness in [('.codex/config.toml','config','codex'),('.hermes/config.yaml','config','hermes'),('.config/opencode/opencode.json','config','opencode'),('.config/opencode/service.json','config','opencode'),('.dsh/profiles/desktop','harness-profile','dsh'),('.dsh/profiles/web','harness-profile','dsh'),('.hermes/mcp','mcp-install','hermes'),('.codex/generated_images','artifact-directory','codex'),('.codex/visualizations','artifact-directory','codex'),('.codex/memories','knowledge-directory','codex'),('.codex/plan-map','plan-store','codex'),('.hermes/cron','automation-directory','hermes'),('.hermes/workflow','workflow-directory','hermes'),('.hermes/scripts','script-directory','hermes'),('Documents/Game/assets','artifact-directory',None),('Documents/Game/visual_jobs','artifact-directory',None)]:
  p=H/rel
  if p.exists():add(p,typ,harness,'C' if typ in ['artifact-directory','knowledge-directory'] else 'B')
 for rel,typ in [('.hermes/agents','agent'),('Documents/Game/workflows','workflow'),('.codex/plan-map','plan')]:
  root=H/rel
  if root.exists():
   for p in root.iterdir():
    if p.is_file() and not excluded(p) and p.suffix in ['.yaml','.yml','.json','.md']:add(p,typ,'hermes' if '.hermes' in str(root) else 'codex' if '.codex' in str(root) else None)
 for root in PROJECT_ROOTS:
  if not root.exists():continue
  candidates=[root]+[p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and not excluded(p) and not p.name.startswith('.')]
  for p in candidates:
   if (p/'.git').exists() or (p/'AGENTS.md').exists() or (p/'package.json').exists() or (p/'project.godot').exists():
    add(p,'project',policy='B',owner=p.name)
   for sub,typ in [('docs','project-documents'),('scripts','script-directory'),('workflows','workflow-directory'),('experiments','experiment-directory')]:
    if (p/sub).is_dir():add(p/sub,typ,policy='B',owner=p.name)
 # Metadata-only application inspection; never launch the applications.
 for root in [Path('/Applications'),H/'Applications']:
  if root.exists():
   for p in root.glob('*.app'):
    if any(n in p.name.lower() for n in ['chatgpt','codex','hermes','deepseek','opencode','kimi','autoglm','agents','cc switch','claude','cursor','gemini','buddy']):
     ver=None
     try:ver=plistlib.loads((p/'Contents/Info.plist').read_bytes()).get('CFBundleShortVersionString')
     except OSError:pass
     add(p,'application',p.stem,'C',version=ver)
 plan=H/'Documents/deepseek/work/dshworkspace/adapters/codex-plan-map'
 if plan.exists():add(plan,'mcp-server','codex',owner='plan-map')
 for rel,typ in [('Documents/deepseek/work/dshworkspace','project'),('Documents/deepseek/macos-skin','project'),('Documents/deepseek/harness-desktop-macos','project'),('Documents/deepseek/work/dshworkspace/mcp','mcp-install'),('Documents/deepseek/work/dshworkspace/tasks','project-plan-directory'),('Documents/deepseek/work/dshworkspace/adapters','adapter-directory'),('.dsh/profiles/desktop/cordis.yml','config'),('.dsh/profiles/desktop/cordis.patch.yml','config')]:
  p=H/rel
  if p.exists():add(p,typ,policy='B',owner='dshworkspace' if 'dshworkspace' in rel else None)
 for root in [H/'.hermes',H/'.config/opencode',H/'.dsh/profiles/desktop']:
  if root.exists():
   for p in root.iterdir():
    if p.is_file() and not excluded(p) and '.bak' in p.name and any(x in p.name for x in ['config','opencode','cordis']):add(p,'config-backup',policy='C')
 for root in [H/'Documents/deepseek/work/dshworkspace/mcp',H/'Documents/deepseek/work/dshworkspace/adapters']:
  if root.exists():
   for p in root.iterdir():
    if p.is_dir() and not excluded(p):add(p,'mcp-candidate' if root.name=='mcp' else 'adapter',policy='B',owner='dshworkspace',evidence='INFERRED')
 for rel,typ in [('AI-Workspace/04-Tools/scripts/manager.py','controller'),('AI-Workspace/04-Tools/scripts/discovery.py','controller'),('AI-Workspace/04-Tools/scripts/selftest.py','controller-test'),('AI-Workspace/04-Tools/scripts/duplicate_audit.py','controller'),('AI-Workspace/04-Tools/scripts/hermes_adapter_test.py','controller-test'),('AI-Workspace/03-Skills/adapters/hermes/ai-workspace-manager','skill-adapter'),('AI-Workspace/08-System/manifests/workspace.json','workspace-manifest'),('AI-Workspace/04-Tools/scripts/launch_ai.py','controller'),('AI-Workspace/00-HOME/AI-ENTRIES','ai-launcher-directory'),('AI-Workspace/04-Tools/scripts/governance.py','controller'),('AI-Workspace/04-Tools/scripts/governance_test.py','controller-test'),('AI-Workspace/08-System/manifests/harnesses.json','harness-registry'),('AI-Workspace/08-System/manifests/skill-releases.json','skill-release-registry'),('AI-Workspace/08-System/inventory/tasks.json','task-registry'),('AI-Workspace/08-System/inventory/artifacts.json','artifact-registry'),('AI-Workspace/02-Agents/entries','harness-entry-directory'),('AI-Workspace/00-HOME/NEW-CONVERSATION.md','workspace-protocol'),('AI-Workspace/03-Skills/adapters/dsh','skill-adapter-source')]:
  p=H/rel
  if p.exists():add(p,typ,policy='A',owner='mac-ai-workspace')
 root=H/'AI-Workspace/01-Projects/AI-Harnesses'
 if root.exists():
  for p in root.iterdir():
   if p.is_dir() and not p.is_symlink():add(p,'project',harness=p.name,policy='A',owner='mac-ai-workspace')
 canonical=str(H/'AI-Workspace/03-Skills/shared/ai-workspace-manager')
 adapter=str(H/'.codex/skills/ai-workspace-manager')
 if canonical in assets:
  assets[canonical]['source_authority']='VERIFIED workspace canonical source'
 if adapter in assets and canonical in assets:
  assets[adapter]['type']='skill-adapter';assets[adapter]['source_of_truth']=canonical;assets[adapter]['source_authority']='VERIFIED explicit installation';assets[adapter]['dependencies']=[assets[canonical]['asset_id']]
 draft=str(H/'AI-Workspace/03-Skills/adapters/hermes/ai-workspace-manager')
 if draft in assets and canonical in assets:
  assets[draft].update(type='skill-adapter',harness='hermes',source_of_truth=canonical,management_policy='A',dependencies=[assets[canonical]['asset_id']],source_authority='VERIFIED Workspace adapter source',runtime_validation='VERIFIED isolated loader; native file installation checked separately')
 native_hermes=str(H/'.hermes/skills/ai-workspace-manager')
 if native_hermes in assets and draft in assets and canonical in assets:
  a=assets[native_hermes];a.update(type='skill-adapter',source_of_truth=draft,source_authority='VERIFIED explicitly approved native install',dependencies=[assets[draft]['asset_id'],assets[canonical]['asset_id']])
  if a['runtime_validation']=='UNVERIFIED':a['runtime_validation']='VERIFIED native indexer; model conversation effects not observed'
 byname={};byhash={}
 for a in assets.values():
  if a['type']=='skill':
   byname.setdefault(a['name'],[]).append(a['asset_id'])
   if a.get('entry_sha256'):byhash.setdefault(a['entry_sha256'],[]).append(a['asset_id'])
 return {'schema_version':1,'domain':'personal-mac','generated_at':NOW,'assets':list(assets.values()),
  'duplicates':{'same_name':[v for v in byname.values() if len(v)>1],'same_entry_hash':[v for v in byhash.values() if len(v)>1]},
  'symlinks':links,'errors':errors,'scope':{'skill_roots':list(map(str,SKILL_ROOTS)),'project_roots':list(map(str,PROJECT_ROOTS)),
  'excluded':sorted(EXCLUDED),'limits':'No home-wide scan; no config values, databases, credentials, knowledge-vault connections or project source contents. Skill hashes cover entry files only; project enumeration depth one.'}}
if __name__=='__main__':
 d=discover();print(json.dumps(d,ensure_ascii=False))
