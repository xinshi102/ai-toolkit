"""Initialize an independent workspace without moving native assets."""
import argparse
import json
import shutil
import sys
from pathlib import Path
from datetime import datetime, timezone


def initialize(root, skill_root):
    root = root.expanduser().absolute()
    # Only the workspace entry itself must not be a link/junction. Parent
    # system paths are legitimately symlinked on macOS (/var -> /private/var,
    # /tmp -> /private/tmp), so walking every parent would reject temp dirs.
    if root.is_symlink() or (hasattr(root, 'is_junction') and root.is_junction()):
        raise ValueError('Workspace link or junction prohibited')
    root = root.resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError('Initialization requires an empty or new workspace')
    skill_root = skill_root.expanduser().resolve()
    if not skill_root.is_dir():
        raise ValueError('Codex skill directory does not exist')
    for rel in ('00-HOME','04-Tools/scripts','08-System/inventory',
                '08-System/audit','08-System/manifests','08-System/migrations',
                '09-Inbox/incoming','02-Agents/entries'):
        (root / rel).mkdir(parents=True, exist_ok=True)
    for source in Path(__file__).parent.glob('*.py'):
        shutil.copyfile(source, root / '04-Tools/scripts' / source.name)
    def save(rel, data):
        (root / rel).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    save('08-System/inventory/registry.json', {'generated_at': datetime.now(timezone.utc).isoformat(), 'assets':[], 'duplicates':{}})
    bootstrap = root / '02-Agents/entries/codex.md'
    bootstrap.write_text('# Codex\n\nRead this workspace’s 00-HOME/README.md. Native skills remain in their installed directory.\n', encoding='utf-8')
    save('08-System/manifests/harnesses.json', {'harnesses':[{
        'id':'codex', 'domain':'personal', 'platform':sys.platform,
        'bootstrap':str(bootstrap), 'skill_root':str(skill_root),
        'session_root':str(root/'01-Projects/AI-Harnesses/codex/sessions'),
        'work_root':str(root/'01-Projects/AI-Harnesses/codex')}]})
    save('08-System/manifests/skill-releases.json', {'skills':{}})
    (root/'00-HOME/README.md').write_text('# AI Workspace\n\n独立管理工作区；原生 Skill 和已有项目保留原位。资产登记在 08-System/inventory/registry.json。\n\n索引前按本机实际路径设置 AI_SKILL_ROOTS、AI_PROJECT_ROOTS（JSON 路径列表）。不填写项目目录时不会扫描个人项目。Windows 应用启动尚未验收。\n', encoding='utf-8')
    (root/'00-HOME/NEW-CONVERSATION.md').write_text('# 新对话\n\n先读 README.md 和 Registry。任务交接只用本机路径，不复制私人来源。\n', encoding='utf-8')
    return root


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--codex-skills', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(initialize(args.workspace, args.codex_skills))
    except (ValueError, OSError) as exc:
        parser.exit(2, str(exc)+'\n')
