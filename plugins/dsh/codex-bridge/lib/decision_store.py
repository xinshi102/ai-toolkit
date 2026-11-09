"""Local transactional inbox. Browser entry exposes only listing and answers."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid

ID = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}')
SESSION = re.compile(r'session-[a-zA-Z0-9-]{1,96}')
KEY = re.compile(r'[A-Z][A-Z0-9]{0,7}')


class Refused(ValueError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


def ident(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Refused('INVALID_ID', 400)
    return value


def read_record(root, name, limit=1024*1024):
    root = Path(root).resolve(strict=True)
    p = root / name
    resolved = p.resolve(strict=True)
    if not resolved.is_relative_to(root) or resolved != p or not p.is_file():
        raise Refused('INVALID_LOCAL_RECORD')
    with p.open('rb') as handle:
        raw = handle.read(limit+1)
    if len(raw) > limit:
        raise Refused('RECORD_TOO_LARGE')
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise Refused('INVALID_LOCAL_RECORD')
    return result


def scopes(home, include_catalog=False):
    try:
        cfg = read_record(home, 'control.json', 65536)
    except FileNotFoundError:
        return None, {}
    plan = ident(cfg.get('activePlanId'))
    if cfg.get('schemaVersion') != 1 or plan not in cfg.get('allowedPlanIds', []):
        raise Refused('UNREGISTERED_PLAN')
    ids={plan}
    if include_catalog:
        try: catalog=read_record(home,'task-catalog.json',65536)
        except FileNotFoundError:catalog={'items':[]}
        items=catalog.get('items',[])
        if not isinstance(items,list) or len(items)>128:raise Refused('INVALID_CATALOG')
        for x in items:
            if isinstance(x,dict) and x.get('planId') in cfg['allowedPlanIds']:
                ids.add(ident(x['planId']))
    nodes={}
    for pid in ids:
        p=read_record(cfg['planMapHome'],pid+'.json')
        if p.get('planId')!=pid:raise Refused('PLAN_ID_MISMATCH')
        nodes[pid]=p['state']['nodes']
    return plan,nodes


def active(home):
    plan,nodes=scopes(home)
    return plan,nodes.get(plan,{})


def scoped_task(home,item):
    _,nodes=scopes(home,True)
    require_active(item,item['planId'],nodes.get(item['planId'],{}))


def run_record(home, run_id):
    r = read_record(home, 'runs/'+ident(run_id)+'/run.json')
    if r.get('runId') != run_id:
        raise Refused('RUN_ID_MISMATCH')
    return r


@contextmanager
def db(home, write=False):
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    p = home/'decisions.sqlite3'
    for candidate in (p, home/'decisions.sqlite3-journal', home/'decisions.sqlite3-wal', home/'decisions.sqlite3-shm'):
        if candidate.is_symlink():
            raise Refused('INVALID_STORE')
    try:
        fd = os.open(p, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
        os.close(fd)
    except FileExistsError:
        if not p.is_file():
            raise Refused('INVALID_STORE')
    con = sqlite3.connect(p, timeout=4)
    con.row_factory = sqlite3.Row
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS decisions(
          id TEXT PRIMARY KEY, planId TEXT NOT NULL, nodeId TEXT NOT NULL, taskId TEXT NOT NULL,
          parentRunId TEXT NOT NULL, sessionId TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL,
          version INTEGER NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL,
          status TEXT NOT NULL, answer TEXT, runId TEXT UNIQUE, answeredAt INTEGER, claimedAt INTEGER, closedAt INTEGER)""")
        con.execute("""CREATE UNIQUE INDEX IF NOT EXISTS one_open_decision
          ON decisions(planId,nodeId,taskId) WHERE status IN ('pending','answered','claimed')""")
        con.execute('CREATE TABLE IF NOT EXISTS decision_text (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        if write:
            con.execute('BEGIN IMMEDIATE')
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def record(row, public=False):
    item = dict(row)
    item['options'] = json.loads(item['options'])
    if public:
        for key in ('sessionId','parentRunId','runId'):
            item.pop(key, None)
    return item


def get(con, decision_id):
    row = con.execute('SELECT * FROM decisions WHERE id=?',(ident(decision_id),)).fetchone()
    if row is None:
        raise Refused('DECISION_NOT_FOUND', 404)
    item=record(row)
    text=con.execute("SELECT body FROM decision_text WHERE id=?",(decision_id,)).fetchone()
    if text:item["answerText"]=text["body"]
    return item


def require_active(item, plan, nodes):
    if item['planId'] != plan or item['nodeId'] not in nodes or nodes[item['nodeId']].get('status') in ('done','completed','passed'):
        raise Refused('DECISION_OUTSIDE_ACTIVE_TASK')


def create(home, parent_run, question, options, ttl=86400):
    parent = run_record(home, parent_run)
    scoped_task(home,parent)
    plan=parent["planId"]
    session = (parent.get('receipt') or {}).get('session_id')
    if parent.get('harness') != 'dsh' or not isinstance(session, str) or not SESSION.fullmatch(session) or parent.get('status') not in ('awaiting_acceptance','accepted'):
        raise Refused('DSH_PARENT_NOT_RESUMABLE')
    if not isinstance(question,str) or not question.strip() or len(question)>500:
        raise Refused('INVALID_QUESTION',400)
    if not isinstance(options,dict) or not 2<=len(options)<=6 or any(not KEY.fullmatch(k) or not isinstance(v,str) or not v.strip() or len(v)>180 for k,v in options.items()):
        raise Refused('INVALID_OPTIONS',400)
    if type(ttl) is not int or not 1<=ttl<=604800:
        raise Refused('INVALID_EXPIRY',400)
    now=int(time.time()); did='decision-'+uuid.uuid4().hex
    with db(home,True) as con:
        con.execute("UPDATE decisions SET status='expired' WHERE status IN ('pending','answered') AND expiresAt<=?", (now,))
        if con.execute("SELECT 1 FROM decisions WHERE parentRunId=? AND status IN ('claimed','closed')",(parent_run,)).fetchone():
            raise Refused('PARENT_ALREADY_CONTINUED')
        try:
            con.execute("""INSERT INTO decisions(id,planId,nodeId,taskId,parentRunId,sessionId,question,options,version,expiresAt,createdAt,status)
                         VALUES (?,?,?,?,?,?,?,?,1,?,?,'pending')""",
                        (did,plan,ident(parent['nodeId']),ident(parent['taskId']),parent_run,session,question.strip(),json.dumps(options,ensure_ascii=False),now+ttl,now))
        except sqlite3.IntegrityError as exc:
            raise Refused('TASK_ALREADY_HAS_OPEN_DECISION') from exc
        return get(con,did)


def listing(home, catalog=False):
    _,nodes=scopes(home,catalog)
    if not nodes or not (Path(home)/'decisions.sqlite3').exists():
        return []
    with db(home) as con:
        ids=list(nodes)
        query="""SELECT * FROM decisions WHERE planId IN ("""+','.join('?' for _ in ids)+""") AND
            (status='claimed' OR (status IN ('pending','answered') AND expiresAt>?))
            ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,createdAt,id LIMIT 60"""
        return [record(row,True) for row in con.execute(query,(*ids,int(time.time())))
            if row['nodeId'] in nodes[row['planId']] and (row['status']=='claimed' or nodes[row['planId']][row['nodeId']].get('status') not in ('done','completed','passed'))]


def answer(home, decision_id, version, choice=None, text=None):
    if type(version) is not int or (choice is None)==(text is None):
        raise Refused('INVALID_ANSWER',400)
    if text is not None:
        if not isinstance(text,str) or not text.strip() or len(text)>1200:
            raise Refused('INVALID_ANSWER',400)
        text=text.strip()
    elif not isinstance(choice,str):
        raise Refused('INVALID_ANSWER',400)
    with db(home,True) as con:
        item=get(con,decision_id)
        scoped_task(home,item)
        if item['version']!=version or item['expiresAt']<=int(time.time()):
            raise Refused('DECISION_STALE')
        if choice is not None and choice not in item['options']:
            raise Refused('INVALID_CHOICE',400)
        if item['status'] in ('answered','claimed','closed') and item['answer']==choice and item.get('answerText')==text:
            return {'status':item['status'],'duplicate':True}
        if item['status']!='pending':
            raise Refused('DECISION_ALREADY_ANSWERED')
        if text is not None:con.execute("INSERT INTO decision_text VALUES (?,?)",(decision_id,text))
        con.execute("UPDATE decisions SET status='answered',answer=?,answeredAt=? WHERE id=?",(choice,int(time.time()),decision_id))
        return {'status':'answered','duplicate':False}


def claim(home, decision_id, run_id, task):
    with db(home,True) as con:
        item=get(con,decision_id)
        scoped_task(home,item)
        if any(item[k]!=task.get(k) for k in ('planId','nodeId','taskId')) or task.get('harness')!='dsh':
            raise Refused('CONTINUATION_IDENTITY_MISMATCH')
        if item['status']!='answered' or item['expiresAt']<=int(time.time()):
            raise Refused('DECISION_NOT_CLAIMABLE')
        con.execute("UPDATE decisions SET status='claimed',runId=?,claimedAt=? WHERE id=?",(ident(run_id),int(time.time()),decision_id))
        return get(con,decision_id)


def close(home, decision_id):
    with db(home,True) as con:
        item=get(con,decision_id)
        if item['status']=='closed':
            return item
        if item['status']!='claimed':
            raise Refused('DECISION_NOT_CLAIMED')
        r=run_record(home,item['runId'])
        a=r.get('acceptance') or {}
        if (r.get('decisionId')!=decision_id or r.get('parentRunId')!=item['parentRunId']
            or any(r.get(k)!=item[k] for k in ('planId','nodeId','taskId'))
            or (r.get('receipt') or {}).get('session_id')!=item['sessionId']
            or r.get('status')!='accepted' or a.get('status')!='passed' or a.get('by')!='Codex' or not a.get('evidence')):
            raise Refused('INDEPENDENT_ACCEPTANCE_REQUIRED')
        con.execute("UPDATE decisions SET status='closed',closedAt=? WHERE id=?",(int(time.time()),decision_id))
        return get(con,decision_id)



def retire_prelaunch_failure(home, decision_id, evidence):
    """Manual recovery for a recorded refusal before session adoption only."""
    if not evidence.strip() or len(evidence)>1000:
        raise Refused('RECOVERY_EVIDENCE_REQUIRED')
    with db(home,True) as con:
        item=get(con,decision_id)
        if item['status']!='claimed':
            raise Refused('DECISION_NOT_CLAIMED')
        r=run_record(home,item['runId'])
        rec=r.get('receipt') or {}
        if (r.get('decisionId')!=decision_id or r.get('status')!='failed'
            or rec.get('exit_code')!=1 or rec.get('timed_out') is not False or rec.get('session_id') is not None
            or rec.get('prelaunch_failure')!='session_workspace_mismatch'):
            raise Refused('PRELAUNCH_FAILURE_NOT_ESTABLISHED')
        # Keep the reason in a separate immutable row, not in the user answer.
        con.execute('CREATE TABLE IF NOT EXISTS decision_recoveries (id TEXT PRIMARY KEY, evidence TEXT NOT NULL, at INTEGER NOT NULL)')
        con.execute('INSERT INTO decision_recoveries VALUES (?,?,?)',(decision_id,evidence,int(time.time())))
        con.execute("UPDATE decisions SET status='retired',closedAt=? WHERE id=?",(int(time.time()),decision_id))
        return get(con,decision_id)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('home',type=Path);p.add_argument('action',choices=('list','list-console','answer'))
    a=p.parse_args()
    try:
        if a.action in ('list','list-console'):
            result={'items':listing(a.home,a.action=='list-console')}
        else:
            x=json.loads(sys.stdin.read(8193))
            if not isinstance(x,dict) or set(x) not in ({'id','version','choice'},{'id','version','text'}):
                raise Refused('INVALID_ANSWER',400)
            result=answer(a.home,x['id'],x['version'],choice=x.get('choice'),text=x.get('text'))
        print(json.dumps({'ok':True,**result},ensure_ascii=False))
    except Refused as exc:
        print(json.dumps({'ok':False,'error':exc.code,'status':exc.status}))
    except (OSError,ValueError,TypeError,KeyError,sqlite3.Error):
        print(json.dumps({'ok':False,'error':'INBOX_UNAVAILABLE','status':503}))


if __name__=='__main__':
    main()
