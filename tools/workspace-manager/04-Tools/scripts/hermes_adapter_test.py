#!/usr/bin/env python3
"""Test Hermes adapter in an isolated home; deny network and native credential state."""
from pathlib import Path
import tempfile,subprocess,os,json
W=Path(__file__).resolve().parents[2]
ADAPTER=W/'03-Skills/adapters/hermes/ai-workspace-manager/SKILL.md'
def main():
 with tempfile.TemporaryDirectory(prefix='hermes-workspace-skill-test-') as t:
  root=Path(t).resolve();p=root/'skills/ai-workspace-manager';p.mkdir(parents=True);(p/'SKILL.md').write_text(ADAPTER.read_text())
  code="""import sys,json,os
from pathlib import Path
root=Path(os.environ['HERMES_HOME']).resolve()
def guard(event,args):
 if event=='socket.connect':raise RuntimeError('Network prohibited in isolated loader test')
 if event=='open' and isinstance(args[0],(str,bytes)):
  path=Path(os.fsdecode(args[0])).absolute()
  sensitive_name=path.name.startswith('.env') or (path.suffix not in ['.py','.pyc'] and any(x in path.name.lower() for x in ['credential','secret','token']))
  if path.is_relative_to(root) and path.name.startswith('.env') and not path.exists():return
  if path.is_relative_to(Path('/Users/xinshi/.hermes')) or sensitive_name:raise RuntimeError('Sensitive/native state access prohibited in loader test: '+str(path))
sys.addaudithook(guard)
sys.path.insert(0,'/Users/xinshi/Projects/hermes-agent')
from tools.skills_tool import skill_view,skills_list
loaded=json.loads(skill_view('ai-workspace-manager',preprocess=False))
assert loaded.get('success') is True,loaded.get('error','skill load failed')
assert loaded['name']=='ai-workspace-manager'
assert str(root) in loaded['skill_dir']
assert '/Users/xinshi/AI-Workspace/03-Skills/shared/ai-workspace-manager/SKILL.md' in loaded['content']
catalog=skills_list()
assert 'ai-workspace-manager' in catalog
print(json.dumps({'isolated_real_hermes_skill_view':True,'isolated_real_hermes_skills_list':True,'canonical_path_reference':True,'no_network':True,'native_home_or_credentials_access_guarded':True,'readiness':loaded.get('readiness_status')},ensure_ascii=False))
"""
  env=os.environ.copy();env['HERMES_HOME']=str(root);env['PYTHONPATH']='/Users/xinshi/Projects/hermes-agent'
  run=subprocess.run(['/Users/xinshi/.local/pipx/venvs/hermes-agent/bin/python','-c',code],cwd=root,env=env,capture_output=True,text=True,timeout=45)
  if run.returncode:print(json.dumps({'exit_code':run.returncode,'test_error':run.stderr[-3500:]}));return 1
  result=json.loads(run.stdout);(W/'06-Artifacts/reports/HERMES-ADAPTER-ISOLATED-TEST.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
  print(json.dumps(result,ensure_ascii=False));return 0
if __name__=='__main__':raise SystemExit(main())
