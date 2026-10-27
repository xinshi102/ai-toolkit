# xinshi 协作看板（Windows）

本地只读看板，用来回答三个问题：**有没有事要我处理 → 任务做到哪了 → AI 额度和用量**。设计依据见 xinshi 的 `references/pitfalls.md`「界面类任务」。

- 风格：平时几乎全灰，只有需要你处理时才出现琥珀色；深色和浅色可以切换，选择会被记住。
- 「正在进行」按任务归组：同一主控、同一项目的工作包合成一组，显示“N 个包在跑（执行者）”。
- 点任务、执行方块、待处理项会打开详情抽屉，内容包括回复、任务说明、相关文件和里程碑笔记。
- 超过 3 天没更新的任务灰显，超过 7 天的卡点不再进入待处理区。
- 看板只记录通过 xinshi 派出的工作包，以及 Plan Map / STATE.md 里的进度；宿主在对话里自己做的事不在看板上。

## 运行

```powershell
$env:XINSHI_WORKSPACE = "E:/AI-Workspace"   # 你的工作区根目录，默认就是这个
& python collab_dashboard.py --port 18765 --roots "<执行记录目录1>,<执行记录目录2>"
```

然后打开 <http://127.0.0.1:18765/>。只依赖 Python 3.10+ 标准库。

## 数据来源（都只读）

| 内容 | 位置 |
|---|---|
| 工作包执行记录 | `--roots` 指定的目录下，含 `spec.json`/`request.json` + `stdout*.ndjson` 的子目录 |
| 计划进度 | `$XINSHI_WORKSPACE/Data/Plan-Map/Codex/*.json` |
| 任务状态 | `$XINSHI_WORKSPACE/Projects/<主控>/<项目>/.work/<任务>/STATE.md` 与 `journal/` |
| 用量 | Codex / DSH / Cursor 的本地会话记录 |

`task_groups.json`、`task_taxonomy.json`、`task_archive.json`、`dispatch_*.json` 是本机配置，仓库里只放空模板。

## 说明

- 部分执行渠道的适配器属于私有环境，不随仓库发布。代码里用 `ExecA`、`ExecB`、`HostC` 作为占位名，本机没有对应数据时这几张卡片显示为灰色，不影响其余功能。
- 唯一的写操作是 `/api/open`：只在本机、只针对允许的数据目录，调用资源管理器打开文件夹。
