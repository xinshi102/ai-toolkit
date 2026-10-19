# xinshi（信使）技能

任务入口技能：接到任务先判断环境与协作方式（单对话 / 原生子 agent / 跨 harness / 运行器），把能推进的推进到「必须用户决定」，再停。

- 版本：`3.0.0-trial.3`
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

路径以目标机器和项目配置为准，公开正文不绑定作者电脑布局：

| 示例路径 | 换机器时 |
|---|---|
| 指针里的 canonical | 改成你本机真实存在的 `SKILL.md` 路径 |
| 协作运行器 | 按 [references/runtime.md](references/runtime.md) 定位本机 Windows 组件，未安装就不声称可调用 |
| 跨项目经验库 | 使用用户已有位置，未配置时先不启用沉淀 |
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
| `references/learning.md` | 复用、信号、每 5 个任务汇总、沉淀去向 |
| `agents/openai.yaml` | 界面显示名与隐式调用开关 |

技能本身可供不同系统使用；配套[协作运行器本次为 Windows 版本](../../collaboration/windows/README.md)，需另行配置，不随复制技能自动部署。

版本历史见仓库根 [CHANGELOG.md](../../CHANGELOG.md)。
