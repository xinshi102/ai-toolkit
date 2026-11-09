"""Persist long-lived task membership without rewriting Plan Map state."""
import argparse
import fcntl
import json
from pathlib import Path
import re
import uuid
from cli_coordinator import HOME, read_json, write_json


def update(home, records, plan_home=None):
    home=Path(home);home.mkdir(parents=True,exist_ok=True)
    cat=home/'task-catalog.json'
    with (home/'.catalog.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        cfg=read_json(home/'control.json')
        if cfg.get('schemaVersion')!=1:raise ValueError('Registry missing or unsupported')
        plans=Path(cfg['planMapHome']).resolve(strict=True)
        old=read_json(cat) if cat.exists() else {'version':1,'items':[]}
        nodes={r['key']:r for r in old['items']}
        for x in records:
            if not re.fullmatch(r'[a-z0-9_-]+(?:\.[a-z0-9_-]+){0,10}',x.get('key','')) or len(x['key'])>180:
                raise ValueError('Invalid task key')
            if not isinstance(x.get('title'),str) or not 1<=len(x['title'])<=200:
                raise ValueError('Invalid title')
            if x.get('planId'):
                pid=x['planId']
                if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',pid):raise ValueError('Invalid plan ID')
                p=plans/(pid+'.json')
                if p.resolve()!=p or read_json(p).get('planId')!=pid:raise ValueError('Plan not verified')
            nodes[x['key']]=x
        if len(nodes)>128:raise ValueError('Too many nodes')
        bound=[n['planId'] for n in nodes.values() if n.get('planId')]
        if len(set(bound))!=len(bound):raise ValueError('A plan already belongs to another task')
        for k in nodes:
            seen=set()
            while k:
                if k not in nodes or k in seen:raise ValueError('Missing parent or cycle')
                seen.add(k);k=nodes[k].get('parent')
        # Only add display grants for the explicitly placed plans. Active is untouched.
        cfg['allowedPlanIds']=sorted(set(cfg.get('allowedPlanIds',[]))|set(bound))
        write_json(home/'control.json',cfg)
        data={'version':1,'items':list(nodes.values())}
        write_json(cat,data)
        return data


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--home',type=Path,default=HOME)
    p.add_argument('manifest',type=Path)
    a=p.parse_args()
    print(json.dumps(update(a.home,json.loads(a.manifest.read_text())),ensure_ascii=False,indent=2))
if __name__=='__main__':main()
