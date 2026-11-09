"""Codex-side decision operations; HTTP clients cannot launch or close work."""
import argparse
import json
from pathlib import Path
import sys
import uuid

from cli_coordinator import HOME, finish_run, run_task, validate_task

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'codex-bridge-plugin/lib'))
import decision_store as store


def resume(home, decision_id, task, interpret=None):
    validate_task(home,task)
    run_id=task['taskId'][:45]+'-'+uuid.uuid4().hex[:12]
    with store.db(home) as con:
        pending=store.get(con,decision_id)
    runs=(Path(home)/'runs').resolve(strict=True)
    parent_id=pending['parentRunId']
    seen=set()
    while parent_id:
        if parent_id in seen or len(seen)>=64:
            raise store.Refused('INVALID_RUN_ANCESTRY')
        seen.add(parent_id)
        parent=store.run_record(home,parent_id)
        if any(parent.get(k)!=pending[k] for k in ('planId','nodeId','taskId')) or (parent.get('receipt') or {}).get('session_id')!=pending['sessionId']:
            raise store.Refused('CONTINUATION_IDENTITY_MISMATCH')
        parent_id=parent.get('parentRunId')
    cwd=runs/parent['runId']
    if cwd.resolve(strict=True)!=cwd or not cwd.is_dir():
        raise store.Refused('INVALID_RESUME_WORKSPACE')
    if pending['status']!='answered':
        raise store.Refused('DECISION_NOT_CLAIMABLE')
    choice=pending['answer']
    if pending.get('answerText'):
        if interpret not in pending['options']:
            raise store.Refused('FREE_TEXT_NEEDS_CONTROLLER_INTERPRETATION')
        choice=interpret
    elif interpret is not None:
        raise store.Refused('STRUCTURED_CHOICE_ALREADY_SET')
    brief=dict(task['brief'])
    brief['confirmedDecision']={'id':decision_id,'version':pending['version'],'question':pending['question'],
                                'choice':choice,'label':pending['options'][choice]}
    # Do not send free text to the model. Codex reviews it and explicitly
    # selects an existing option only if that matches the user's authorization.
    continuation=dict(task,brief=brief)
    validate_task(home,continuation)
    # Reserve once before touching the worker. An interruption leaves the
    # reserved attempt for inspection; it never silently triggers a new run.
    item=store.claim(home,decision_id,run_id,task)
    return run_task(home,continuation,run_id=run_id,
                    binding={'decisionId':decision_id,'parentRunId':item['parentRunId']},
                    resume_session=item['sessionId'],resume_workspace=cwd)



def recover_artifact(home, decision_id):
    """Finalize an already completed native attempt without launching DSH."""
    with store.db(home,True) as con:
        item=store.get(con,decision_id)
        if item['status']!='claimed':
            raise store.Refused('DECISION_NOT_CLAIMED')
        rid=item['runId']
        run=store.run_record(home,rid)
        if run.get('status') not in ('failed','running') or run.get('decisionId')!=decision_id:
            raise store.Refused('RECOVERY_NOT_APPLICABLE')
        directory=(Path(home)/'runs'/rid).resolve(strict=True)
        rec=store.read_record(directory,rid+'-design-receipt.json')
        if not (rec.get('accepted') is True and rec.get('same_session_verified') is True
                and rec.get('exit_code')==0 and rec.get('session_id')==item['sessionId']):
            raise store.Refused('NATIVE_SUCCESS_NOT_ESTABLISHED')
        workspace=Path(run['command']['cwd'])
        runs=(Path(home)/'runs').resolve(strict=True)
        if workspace.parent!=runs or workspace.resolve(strict=True)!=workspace:
            raise store.Refused('INVALID_RESUME_WORKSPACE')
        artifact=store.read_record(workspace,rid+'-design.json')
        brief=store.read_record(directory,'task-brief.json')
        if artifact.get('nonce')!=brief['nonce'] or any(k not in artifact for k in brief['required_keys']):
            raise store.Refused('ARTIFACT_MISMATCH')
        target=directory/'task-design.json'
        if target.exists():
            if store.read_record(directory,'task-design.json')!=artifact:raise store.Refused('ARTIFACT_MISMATCH')
        else:
            with target.open('x',encoding='utf-8') as f:json.dump(artifact,f,ensure_ascii=False,indent=2)
        return finish_run(directory,run,rec,target,directory/(rid+'-design-native.jsonl'))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--home',type=Path,default=HOME)
    subs=p.add_subparsers(dest='action',required=True)
    op=subs.add_parser('open');op.add_argument('parent_run');op.add_argument('--question',required=True)
    op.add_argument('--option',action='append',required=True);op.add_argument('--ttl',type=int,default=86400)
    subs.add_parser('list')
    r=subs.add_parser('resume');r.add_argument('decision_id');r.add_argument('manifest',type=Path);r.add_argument('--interpret')
    c=subs.add_parser('close');c.add_argument('decision_id')
    recover=subs.add_parser('recover-artifact');recover.add_argument('decision_id')
    failed=subs.add_parser('retire-prelaunch-failure');failed.add_argument('decision_id');failed.add_argument('--evidence',required=True)
    s=subs.add_parser('show');s.add_argument('decision_id')
    a=p.parse_args()
    try:
        if a.action=='open':
            pairs=[o.split('=',1) for o in a.option]
            options=dict(pairs)
            if len(options)!=len(pairs):raise store.Refused('DUPLICATE_OPTION')
            value=store.create(a.home,a.parent_run,a.question,options,a.ttl)
        elif a.action=='list':value=store.listing(a.home,True)
        elif a.action=='resume':value=resume(a.home,a.decision_id,json.loads(a.manifest.read_text()),a.interpret)
        elif a.action=='recover-artifact':value=recover_artifact(a.home,a.decision_id)
        elif a.action=='close':value=store.close(a.home,a.decision_id)
        elif a.action=='retire-prelaunch-failure':value=store.retire_prelaunch_failure(a.home,a.decision_id,a.evidence)
        else:
            with store.db(a.home) as con:value=store.get(con,a.decision_id)
        print(json.dumps(value,ensure_ascii=False,indent=2))
    except store.Refused as exc:
        print(exc.code,file=sys.stderr)
        raise SystemExit(2) from None

if __name__=='__main__':
    main()
