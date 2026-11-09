#!/usr/bin/env python3
"""xinshi 发布门禁：版本一致性、失效引用、指针完整性。

用法：python3 scripts/check-xinshi.py
退出码 0 表示通过，1 表示有阻断项。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = ROOT / "skills" / "xinshi"
MANIFEST = ROOT / "sync" / "targets.json"

errors: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        try:
            label: object = path.relative_to(ROOT)
        except ValueError:
            label = path
        fail(f"读不到 {label}：{exc}")
        return ""


def main() -> int:
    skill_md = SKILL_DIR / "SKILL.md"
    text = read(skill_md)
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        fail("SKILL.md 缺少 frontmatter")
        return report()

    front = m.group(1)
    version = re.search(r'^\s*version:\s*"([^"]+)"', front, re.M)
    revision = re.search(r'^\s*local_revision:\s*"([^"]+)"', front, re.M)
    if not version:
        fail("SKILL.md frontmatter 缺少 version")
    if not revision:
        fail("SKILL.md frontmatter 缺少 local_revision")
    if not version or not revision:
        return report()

    ver, rev = version.group(1), revision.group(1)

    # 1) 版本标记在 README / CHANGELOG / coordination 中一致
    readme = read(SKILL_DIR / "README.md")
    changelog = read(ROOT / "CHANGELOG.md")
    coordination = read(SKILL_DIR / "references" / "coordination.md")

    if rev not in readme:
        fail(f"README.md 未出现本机修订 {rev}")
    if rev not in changelog[:4000]:
        fail(f"CHANGELOG.md 顶部未出现本机修订 {rev}")
    if version.group(1) not in coordination or rev not in coordination:
        fail(f"references/coordination.md 版本头未同步为 {ver} / {rev}")

    # 2) README 的更新命令不能指向错误分支
    if "origin/main" in readme:
        fail("README.md 仍让用户 diff origin/main；Mac 修订在 origin/xinshi-mac")
    if "origin/xinshi-mac" not in readme:
        warn("README.md 未写明从 origin/xinshi-mac 审查更新")

    # 3) 相对 Markdown 链接必须可解析
    link_re = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    for md in SKILL_DIR.rglob("*.md"):
        body = read(md)
        for raw in link_re.findall(body):
            target = raw.split("#", 1)[0].strip()
            if not target or "://" in target or target.startswith(("mailto:", "<")):
                continue
            resolved = (md.parent / target).resolve()
            if not resolved.exists():
                fail(f"{md.relative_to(ROOT)} 链接失效：{raw}")

    # 4) 反引号里的仓库相对路径必须存在（外部路径和占位符跳过）
    code_re = re.compile(r"`([^`\n]+)`")
    prefixes = ("collaboration/", "scripts/", "skills/", "archive/", "outputs/")
    for md in SKILL_DIR.rglob("*.md"):
        body = read(md)
        for raw in code_re.findall(body):
            p = raw.strip().rstrip(".,;:")
            if not p or "://" in p or p.startswith(("~", "/", "E:", "C:", "<")) or "\\" in p:
                continue
            if not p.startswith(prefixes):
                continue
            base = SKILL_DIR if p.startswith("references/") else ROOT
            if not (base / p).exists():
                if p.startswith("collaboration/"):
                    warn(f"{md.relative_to(ROOT)} 引用的运行组件不在当前分支：{p}")
                else:
                    fail(f"{md.relative_to(ROOT)} 引用的路径不存在：{p}")

    # 5) 安装指针必须真的指向正本
    if MANIFEST.is_file():
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for comp in data.get("components", []):
            if comp.get("component") != "xinshi":
                continue
            for target in comp.get("targets", []):
                if target.get("kind") != "pointer":
                    continue
                pointer = Path(target["path"]) / "SKILL.md"
                if not pointer.is_file():
                    fail(f"指针缺失：{pointer}")
                    continue
                content = read(pointer)
                ref = re.search(r"`([^`]+/skills/xinshi/SKILL\.md)`", content)
                if not ref:
                    fail(f"指针未包含 canonical 路径：{pointer}")
                else:
                    ref_path = Path(ref.group(1))
                    if not ref_path.is_file():
                        fail(f"指针指向的正本不存在：{ref_path}（{pointer}）")
                if "Resolve references" not in content and "正本" not in content:
                    warn(f"指针缺少相对引用解析说明：{pointer}")

    return report()


def report() -> int:
    if warnings:
        for w in warnings:
            print(f"WARN  {w}")
    if errors:
        for e in errors:
            print(f"FAIL  {e}")
        print(f"\n{len(errors)} 个阻断项；不通过。")
        return 1
    print("PASS  xinshi 发布检查通过（版本一致、引用有效、指针指向正本）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
