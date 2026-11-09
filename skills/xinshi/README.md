# xinshi（信使）技能

任务入口技能：接到任务先判断环境与协作方式（单对话 / 原生子 agent / 跨 harness / 运行器），把能推进的推进到「必须用户决定」，再停。

- 上游版本：`3.1.4`（评审基线 `2280a07`）。
- 本机修订：`mac.8`（2026-11-09）。默认自主：里程碑连续做、完成只报一次三行；多里程碑用 batch，遇决定才停。
- 正本：本目录 `skills/xinshi/`（正文自包含；运行器、plan-map、经验库都是可选加速件）
- 依赖：无硬依赖。运行器、plan-map、knowledge-vault 都是可选的加速件，本机没有就跳过对应段落。

## 安装

### 方式 A：全量副本（最简单，不依赖正本路径）

```sh
git clone https://github.com/xinshi102/ai-toolkit.git
cp -R ai-toolkit/skills/xinshi ~/.codex/skills/xinshi
# 其他宿主换成实际技能根：~/.agents/skills、~/.dsh/skills、~/.config/opencode/skills、...
```

Windows PowerShell：

```powershell
git clone https://github.com/xinshi102/ai-toolkit.git
Copy-Item -Recurse ai-toolkit\skills\xinshi C:\Users\<me>\.codex\skills\xinshi
```

### 方式 B：指针（正文只维护一份，适合多机同步）

```sh
cd ai-toolkit
bash scripts/install-xinshi.sh "$PWD/skills/xinshi" ~/.codex/skills ~/.agents/skills ~/.dsh/skills
```

```powershell
powershell -File scripts\install-xinshi.ps1 -Canonical <repo>\skills\xinshi -Roots C:\Users\<me>\.codex\skills,C:\Users\<me>\.agents\skills
```

脚本只写一个 6 行指针（指向你给的 canonical 目录），遇到已存在的非指针目录会拒绝覆盖并返回非 0。
`canonical` 必须是本机上真实存在、且里面有 `SKILL.md` 的目录：方式 A 装完就是 `~/.codex/skills/xinshi`，也可以直接用 clone 下来的 `ai-toolkit/skills/xinshi`。

## 安装后确认

不同客户端扫描的目录不同，装完用宿主自己的方式确认 `xinshi` 出现：

- Codex CLI（若本机已安装）：`codex exec -s read-only "List the skill names you can see"`，或直接问模型「你能看到 xinshi 技能吗」。
- DSH：技能目录/设置里查看；本会话能加载到 `xinshi` 即生效。
- 其他客户端：新开一个会话，问「列出你当前能看到的技能名称」。

看到 `xinshi` 才算加载；文件存在不等于生效。

## 路径适配（重要）

运行器和经验库按宿主实际配置定位：

| 示例路径 | 换机器时 |
|---|---|
| 指针里的 canonical | 改成你本机真实存在的 `SKILL.md` 路径 |
| `collaboration/macos/workflow.py` / `cli_coordinator.py` | Mac 运行组件；本机没有就跳过 [references/runtime.md](references/runtime.md) 对应段落 |
| `collaboration/windows/runtime/workflow.py` | Windows 运行组件；同上 |
| 跨项目经验库 | 使用已确认的本机目录，未配置时先留在项目内 |
| `.work/handoff/STATE.md` | 换成你项目的交接目录 |

普通任务不需要这些依赖；只有确实存在运行器/知识库时才用。

## 更新

```sh
cd ai-toolkit
git fetch origin
git diff origin/xinshi-mac -- skills/xinshi
# 按本机分支的提交审查并合并；指针方式无需重装
python3 scripts/check-xinshi.py
bash scripts/sync-xinshi.sh --check
```

## Mac 分支发布

本机 xinshi 技能每次升级验收通过后，提交到 GitHub `xinshi-mac` 分支。以远端同名分支为基础；首次从远端 `main` 建分支。用独立工作区审查、校验并提交，仅包含本次技能改动和对应发布说明。推送后核对远端提交号；遇到远端新提交先合并并复验，不强推。

发布前必须跑 `python3 scripts/check-xinshi.py`（版本一致性、失效引用、指针完整性），失败不提交。

这项约定只适用于 xinshi 的 Mac 技能变更。面板、运行器、私人回执、本机配置和其他工作区修改不随技能发布。不安装自动同步任务。

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 正文：任务判断、谁来做、派发与等待、分级验收、交付物边界、秘书模式、状态与沉淀 |
| `references/coordination.md` | 并行写入、资源归属、跨 harness 交接、宿主差异 |
| `references/decisions.md` | 决定编号与授权范围、Mac 决策收件箱、恢复与验收 |
| `references/runtime.md` | 什么时候用运行器（多写入、可恢复长流程） |
| `references/learning.md` | 复用与沉淀去向 |
| `references/pitfalls.md` | 按场景整理的历史坑点（部署、进程、权限、Unity、成本对比） |
| `agents/openai.yaml` | 界面显示名与隐式调用开关 |

版本历史见仓库根 [CHANGELOG.md](../../CHANGELOG.md)。
