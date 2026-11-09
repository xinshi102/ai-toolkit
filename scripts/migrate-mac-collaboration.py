#!/usr/bin/env python3
"""Bounded local skill migration with recoverable backups; never reads credentials."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil

REPO = Path(__file__).resolve().parents[1]
ROOTS = {"codex": Path.home()/".codex/skills", "dsh": Path.home()/".dsh/skills",
         "opencode": Path.home()/".config/opencode/skills"}

def migrate(host):
    root = ROOTS[host]
    if not root.is_dir():
        raise ValueError("host skill root does not exist")
    canonical = {name: REPO/"skills"/name for name in ("xinshi", "ai-collaboration")}
    for source in canonical.values():
        if not (source/"SKILL.md").is_file():
            raise ValueError("canonical skill missing")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = REPO/".sync-backups"/("mac-migration-"+host+"-"+stamp)
    backup.mkdir(parents=True)
    moved, installed = [], []
    try:
        for name in ("xinshiimprove", "xinshi", "ai-collaboration"):
            target = root/name
            if target.exists() or target.is_symlink():
                shutil.move(str(target), str(backup/name))
                moved.append(name)
        for name, source in canonical.items():
            target = root/name
            target.mkdir()
            installed.append(name)
            description = "信使任务入口，读取本机唯一正本。" if name == "xinshi" else "为信使执行跨 AI 协作，核实执行器并验收真实产物。"
            (target/"SKILL.md").write_text("---\nname: "+name+"\ndescription: "+description+"\n---\n\nRead the single canonical skill at `"+str(source/"SKILL.md")+"` and follow it. Resolve references relative to that canonical directory.\n", encoding="utf-8")
        receipt = {"host": host, "backup": str(backup), "installed": [str(root/n) for n in installed],
                   "canonical_sha256": {n: hashlib.sha256((s/"SKILL.md").read_bytes()).hexdigest() for n,s in canonical.items()},
                   "old_entry_archived": "xinshiimprove" in moved}
        (backup/"receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
        return receipt
    except BaseException:
        for name in installed:
            shutil.rmtree(root/name)
        for name in moved:
            shutil.move(str(backup/name), str(root/name))
        raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, choices=ROOTS)
    args = parser.parse_args()
    print(json.dumps(migrate(args.host), ensure_ascii=False))
