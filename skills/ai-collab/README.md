# ai-collab（个人版）

xinshi 下面的多 AI 协作子技能：主控 AI（GPT/Codex）把开发工作打成“工作包”，派给 DSH 等执行者，阻塞等待结果、按风险分级验收；再配一个本地只读看板。

- 正文 `SKILL.md`；工作包格式、多包工作图、协作边界、看板、场景坑点见 `references/`；样例见 `examples/`。
- 运行器 `runtime/`：`run_package.py`（单包，阻塞等待，最后打印一行 JSON）、`workflow.py`（多包依赖图），以及 v1.1 的统一卡住检测（`guard.py`）和适配器注册表（`adapters/`）。
- 个人版适配器：`codex`、`codex-workspace`、`dsh-workspace`、`dsh-text`、`local-test`。Kimi / Hermes / OpenCode 待接入。

## 安装
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Codex -Dsh
powershell -File start-dashboard.ps1          # http://127.0.0.1:18765/
```
需要 Windows、Python 3.10+。只用标准库，DSH 适配器需要本机已安装 DSH。

## 环境变量（都可选）
| 变量 | 作用 |
|---|---|
| `DSH_PROGRAM` | DSH 安装目录 |
| `AI_COLLAB_ROOTS` | 看板额外扫描的工作包目录，多个用逗号分隔 |
| `AI_COLLAB_PROJECTS` | 项目根目录：看板从这里找 `.work/*/STATE.md`，也用来限定 workflow 的项目范围 |
| `AI_COLLAB_PLANMAP` | Plan Map JSON 目录，默认 `~/.ai-collab/plan-map` |
| `AI_COLLAB_HOME` | 运行器所在的项目根目录 |

## 测试
```powershell
cd runtime; $env:DSH_PROGRAM="<你的 DSH 目录>"; python -B -m unittest discover -s tests -p "test_*.py"
```
`install.ps1` 要先跑一次，DSH 覆盖文件里的路径才会被填好。

## 2026-11-05 · v1.2 主控台
- `/console`：任务树（宽时变导图）、需要处理的事（决定 / 失败 / 完成待验收，原位作答并续接原会话）、任务细节、AI 资源；各区域可收起归零，从屏幕边缘拉出。
- 任务身份：spec 可带 `task`（点号层级），续做自动继承；`GET /api/tree`、`POST /api/tree/assign`。
- 收件箱：`GET /api/inbox`、`POST /api/inbox/act`；Windows 桌面通知（每件单独弹，可设安静时段，`--no-notify` 关闭）。
- 规则与授权（`rules/`）、主控预算（`budget2/`）、双层回执与挂起零消耗（`receipt_block.py`、`suspend.py`、`ask.py`）、事件日志与 `why.py`。
- 执行者墙钟超时默认 6 小时，卡住检测（5 次同错 / 20 分钟无进展）不变。
