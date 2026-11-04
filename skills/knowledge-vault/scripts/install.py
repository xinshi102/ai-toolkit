"""Install a portable skill package without overwriting another version."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

FILES = ["SKILL.md", "agents/openai.yaml", "assets/problem-note.md",
         "references/install.md", "scripts/install.py", "scripts/resolve_vault.py"]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path, help="Verified native skill root")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    dest = args.target.expanduser().resolve() / "knowledge-vault"
    if dest == source:
        print(json.dumps({"status": "already-source", "path": str(dest)}))
        return
    if dest.exists():
        for name in FILES:
            target_file = dest / name
            if not target_file.is_file() or hashlib.sha256(target_file.read_bytes()).digest() != hashlib.sha256((source / name).read_bytes()).digest():
                parser.error("Existing skill differs; refusing to overwrite: " + str(dest))
        print(json.dumps({"status": "already-installed", "path": str(dest)}))
        return
    dest.mkdir(parents=True, exist_ok=False)
    for name in FILES:
        target_file = dest / name
        target_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target_file)
    print(json.dumps({"status": "installed", "path": str(dest)}))

if __name__ == "__main__":
    main()
