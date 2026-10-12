#!/usr/bin/env python3
"""Read-only duplicate analysis; hashes only approved skill text/source files."""
import json,os,hashlib
from pathlib import Path
from datetime import datetime,timezone
import discovery
W=Path(__file__).resolve().parents[2]
def audit():
 r=json.loads((W/'08-System/inventory/registry.json').read_text());byid={a['asset_id']:a for a in r['assets']};groups=[]
 for ids in r['duplicates']['same_name']:
  entries=[]
  for aid in ids:
   a=byid[aid];root=Path(a['current_path']);included={};omitted=[];links=[]
   for base,dirs,files in os.walk(root,followlinks=False):
    b=Path(base);depth=len(b.relative_to(root).parts)
    dirs[:]=[d for d in dirs if not discovery.excluded(b/d) and depth<8]
    for f in files:
     p=b/f;rel=str(p.relative_to(root))
     if discovery.excluded(p) or p.is_symlink() or p.suffix not in {'.md','.py','.js','.ts','.sh','.txt'}:
      omitted.append(rel);continue
     if p.stat().st_size>2_000_000:omitted.append(rel);continue
     included[rel]=hashlib.sha256(p.read_bytes()).hexdigest()
   whole=hashlib.sha256(json.dumps(included,sort_keys=True).encode()).hexdigest()
   entries.append({'asset_id':aid,'path':str(root),'harness':a['harness'],'safe_source_file_hashes':included,'safe_subset_sha256':whole,'not_content_read':omitted,'complete_comparison':not omitted,'evidence_status':'VERIFIED safe subset only'})
  groups.append({'name':byid[ids[0]]['name'],'entries':entries,'decision':'retain-native-variants','reason':'different entry hashes; runtime purpose/source authority requires review'})
 return {'generated_at':datetime.now(timezone.utc).isoformat(),'groups':groups,'scope':'Known duplicate skill directories only; excludes credentials/config/data formats and symlinks. No deduplication or movement.'}
if __name__=='__main__':
 d=audit();p=W/'06-Artifacts/reports/DUPLICATE-AUDIT.json';p.write_text(json.dumps(d,ensure_ascii=False,indent=2))
 md='# Duplicate Skill Audit\n\nNo originals changed. Safe source subsets hashed; config/data formats not content-read.\n\n'
 for g in d['groups']:
  md+='## '+g['name']+'\n\n'
  for e in g['entries']:md+='- '+e['path']+': '+str(len(e['safe_source_file_hashes']))+' safe files; '+str(len(e['not_content_read']))+' excluded; '+e['safe_subset_sha256']+'\n'
  md+='\nDecision: retain variants. Entry differences are verified; whether differences are intentional is UNVERIFIED.\n\n'
 (W/'06-Artifacts/reports/DUPLICATE-AUDIT.md').write_text(md)
 print(json.dumps({'groups':len(d['groups']),'decision':'retain-native-variants','report':str(p)}))
