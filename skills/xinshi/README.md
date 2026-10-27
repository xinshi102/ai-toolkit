# xinshi（信使）技能

任务入口技能：接到任务先判断环境与协作方式（单对话 / 原生子 agent / 跨 harness / 运行器），把能推进的推进到「必须用户决定」，再停。

- 本机版本：`3.1.4`（2026-10-26 精简 + 成本规则 + 秘书模式，未推 GitHub）
- 正本：本目录 `skills/xinshi/`（自包含）
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

脚本只写一个 5 行指针（指向你给的 canonical 目录），遇到已存在的非指针目录会拒绝覆盖。
`canonical` 必须是本机上真实存在、且里面有 `SKILL.md` 的目录：方式 A 装完就是 `~/.codex/skills/xinshi`，也可以直接用 clone 下来的 `ai-toolkit/skills/xinshi`。

## 安装后确认

不同客户端扫描的目录不同，装完用宿主自己的方式确认 `xinshi` 出现：

- Codex CLI：`codex exec -s read-only "List the skill names you can see"`，或直接问模型「你能看到 xinshi 技能吗」。
- DSH：技能目录/设置里查看。
- 其他客户端：新开一个会话，问「列出你当前能看到的技能名称」。

看到 `xinshi` 才算加载；文件存在不等于生效。

## 路径适配（重要）

正文和 references 里有示例绝对路径（`E:/AI-Workspace/...`），那是作者本机的布局，换机器时按实际情况处理：

| 示例路径 | 换机器时 |
|---|---|
| 指针里的 canonical | 改成你本机真实存在的 `SKILL.md` 路径 |
| `runtime/workflow.py` | 本机没有就跳过 [references/runtime.md](references/runtime.md) 对应段落 |
| `E:/AI-Workspace/Knowledge/` | 换成本机知识库位置，或先不启用沉淀 |
| `.work/handoff/STATE.md` | 换成你项目的交接目录 |

普通任务不需要这些依赖；只有确实存在运行器/知识库时才用。

## 更新

```sh
cd ai-toolkit && git pull --ff-only
# 指针方式：重跑一次 install 脚本
# 全量副本：重新 cp -R 覆盖
```

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 正文：偏好与边界、任务判断、升级条件、监督者、验证、持续推进、学习 |
| `references/coordination.md` | 并行写入、资源归属、跨 harness 交接、宿主差异 |
| `references/runtime.md` | 什么时候用运行器（多写入、可恢复长流程） |
| `references/learning.md` | 复用与沉淀去向 |
| `references/pitfalls.md` | 按场景整理的历史坑点（部署、进程、权限、Unity、成本对比） |
| `agents/openai.yaml` | 界面显示名与隐式调用开关 |

版本历史见仓库根 [CHANGELOG.md](../../CHANGELOG.md)。
