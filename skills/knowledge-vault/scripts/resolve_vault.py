"""Locate a vault using explicit settings or Obsidian's registered vaults."""
import argparse
import json
import os
import sys
from pathlib import Path

def checked(value, origin):
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise ValueError("Configured vault is missing or not a directory: " + str(path))
    return {"status": "found", "vault_path": str(path), "origin": origin}

def resolve(args):
    if args.vault:
        return checked(args.vault, "argument")
    if os.environ.get("KNOWLEDGE_VAULT_PATH"):
        return checked(os.environ["KNOWLEDGE_VAULT_PATH"], "environment")
    config_env = os.environ.get("KNOWLEDGE_VAULT_CONFIG")
    config = Path(config_env).expanduser() if config_env else Path.home() / ".config/knowledge-vault/config.json"
    if config_env and not config.is_file():
        raise ValueError("Explicit configuration file is missing: " + str(config))
    if config.is_file():
        data = json.loads(config.read_text(encoding="utf-8-sig"))
        if not data.get("vault_path"):
            raise ValueError("Configuration requires vault_path")
        return checked(data["vault_path"], "configuration")
    if args.registry:
        registry = args.registry.expanduser()
    elif sys.platform == "win32":
        registry = Path(os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming"))) / "obsidian/obsidian.json"
    elif sys.platform == "darwin":
        registry = Path.home() / "Library/Application Support/obsidian/obsidian.json"
    else:
        registry = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "obsidian/obsidian.json"
    candidates = []
    if registry.is_file():
        data = json.loads(registry.read_text(encoding="utf-8-sig"))
        for item in data.get("vaults", {}).values():
            value = item.get("path")
            if value and Path(value).expanduser().is_dir():
                resolved = str(Path(value).expanduser().resolve())
                if resolved not in candidates:
                    candidates.append(resolved)
        if not candidates and data.get("vaults"):
            raise ValueError("Registered vaults are unavailable; check paths or synchronization")
    if len(candidates) == 1:
        return checked(candidates[0], "obsidian-registry")
    if candidates:
        return {"status": "ambiguous", "candidates": candidates}
    if not args.create_temp:
        return {"status": "not-found", "hint": "Set a vault path or create a temporary vault in an authorized workspace."}
    if not args.workspace:
        raise ValueError("--create-temp requires --workspace")
    workspace = args.workspace.expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError("Workspace must already exist")
    vault = workspace / "temporary-knowledge-vault"
    if vault.exists():
        return {"status": "temporary-existing", "vault_path": str(vault),
                "hint": "Check this existing folder before adopting it; nothing was changed."}
    vault.mkdir()
    (vault / "wiki/summaries").mkdir(parents=True)
    (vault / "wiki/index.md").write_text("# 工作问题索引\n\n## 摘要\n", encoding="utf-8")
    (vault / "wiki/log.md").write_text("# 知识库维护日志\n", encoding="utf-8")
    (vault / "schema.md").write_text("# 临时库规范\n\n案例放 wiki/summaries；按工具与问题类别加标签。维护 wiki/index.md 与仅追加的 wiki/log.md。原始材料不删除，未验证原因标 pending。\n", encoding="utf-8")
    return {"status": "temporary-created", "vault_path": str(vault),
            "hint": "Download Obsidian from https://obsidian.md/download and open this folder as a vault."}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault")
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--create-temp", action="store_true")
    parser.add_argument("--workspace", type=Path)
    args = parser.parse_args()
    try:
        result = resolve(args)
    except (ValueError, OSError, TypeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=True))
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=True))

if __name__ == "__main__":
    main()
