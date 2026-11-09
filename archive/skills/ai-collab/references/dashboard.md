# 看板

本地只读协作看板，默认地址 <http://127.0.0.1:18765/>。只依赖 Python 3.10+ 标准库。

## 启动
```powershell
powershell -File <技能目录>\start-dashboard.ps1            # 默认端口 18765
powershell -File <技能目录>\start-dashboard.ps1 -Port 18800 -Roots "D:\proj\a\.work,D:\proj\b\.work"
```
`-Roots` 用来指定在哪些目录下找工作包（含 `spec.json` + `stdout*.ndjson` 的子目录），多个目录用逗号分隔。默认是本技能目录下的 `outputs/` 和 `.work/`，以及环境变量 `AI_COLLAB_ROOTS`。

## 页面上有什么
| 区域 | 内容 |
|---|---|
| 大字标题 | “无需你处理”或“有 N 件事需要你”；浏览器标签标题会显示数字 |
| 待处理 | Plan Map 里被阻塞的节点、STATE.md 里需要用户决定的事项；超过 7 天未更新的卡点自动隐藏 |
| 正在进行 | 按“主控 + 项目”归组；每个包显示要做什么、最近一步动作、多久前有动作（超过 15 分钟没动作会变成琥珀色） |
| 任务 | Plan Map 计划和 STATE.md 任务；超过 3 天没更新的灰显；详情底部可以归档 |
| 今天的执行 | 每个方块是一个工作包，红色表示失败；点开看回复、执行过程和证据文件 |
| AI 资源 | GPT 5 小时/周额度、DSH（DeepSeek）余额与今日 token；Kimi / Hermes / OpenCode 待接入 |

## 数据来源（都只读）
| 内容 | 位置 | 环境变量 |
|---|---|---|
| 工作包 | `-Roots` 指定的目录 | `AI_COLLAB_ROOTS` |
| 计划进度 | Plan Map JSON 目录 | `AI_COLLAB_PLANMAP`（默认 `~/.ai-collab/plan-map`） |
| 任务状态 | `<项目根>/<项目>/.work/<任务>/STATE.md` 与 `journal/` | `AI_COLLAB_PROJECTS`（项目根目录） |
| 用量 | Codex `~/.codex/sessions`、DSH `~/.dsh/sessions` | — |

没有某个渠道的数据时，那张卡片显示为灰色，不影响其余部分。

## 写操作
只有两处：
- `/api/open`：只在本机、只针对允许的数据目录，用资源管理器打开文件夹。
- `/api/archive`：把任务或工作包标记为归档，写入 `runtime/task_archive.json`，不改计划和 STATE 文件。
