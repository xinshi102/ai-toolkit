"""Project only quota metadata from the current Codex thread into the panel."""
import argparse
import datetime
import json
import os
from pathlib import Path
import sqlite3
from cli_coordinator import HOME,write_json

def capture(home,thread):
    root=Path.home()/'.codex'
    with sqlite3.connect((root/'state_5.sqlite').as_uri()+'?mode=ro',uri=True) as con:
        row=con.execute('select rollout_path from threads where id=?',(thread,)).fetchone()
    if not row:raise ValueError('No rollout for current thread')
    p=Path(row[0]).resolve(strict=True)
    if not p.is_relative_to((root/'sessions').resolve()) or thread not in p.name:
        raise ValueError('Unverified thread path')
    found=None
    with p.open('rb') as f:
        f.seek(max(0,p.stat().st_size-4*1024*1024))
        for line in f:
            try:e=json.loads(line)
            except ValueError:continue
            x=e.get('payload',{})
            if e.get('type')=='event_msg' and x.get('type')=='token_count' and isinstance(x.get('rate_limits'),dict):
                found=(e.get('timestamp'),x['rate_limits'])
    rows=[]
    if found:
        at,limits=found
        for part in ('primary','secondary'):
            w=limits.get(part) or {}
            used,window=w.get('used_percent'),w.get('window_minutes')
            if type(used) not in (int,float) or not 0<=used<=100 or type(window) is not int or window<1:
                continue
            period={300:'5h',10080:'week'}.get(window,f'{window} 分钟')
            row={'key':'gpt' if part=='primary' else 'gpt-week','agent':'Codex' if part=='primary' else 'Codex 周额度',
                 'status':'ok','pct_used':used,'period':period,'observedAt':at,'note':'当前会话记录'}
            reset=w.get('resets_at')
            if type(reset) in (int,float) and reset>0:row['reset_at']=reset
            rows.append(row)
    write_json(Path(home)/'console-quota.json',{'version':1,'rows':rows})
    return {'captured':len(rows),'source':'current Codex thread rate-limit metadata'}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--home',type=Path,default=HOME)
    a=p.parse_args();t=os.environ.get('CODEX_THREAD_ID')
    if not t:raise SystemExit('No current Codex thread')
    print(json.dumps(capture(a.home,t)))
