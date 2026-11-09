# Mac 信使迁移与真实协作验收

日期：2026-10-19（Asia/Shanghai）。上游基础：982240a，信使 3.0.0-trial.3。本文记录本机结果，不推定 Windows、其他电脑或其他账号同样可用。

## 已完成

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Codex / DSH / OpenCode 技能替换 | 通过 | 三宿主均为 xinshi 与 ai-collaboration 正本指针，旧 xinshiimprove 移出发现目录；`.sync-backups/mac-migration-*` 保存恢复点 |
| Codex 安装由另一宿主执行 | 通过 | OpenCode session `ses_eab602524ffeP8e7vZ3xfYVuEY` 实际 read → 一次精确 bash → read/read；`acceptance/opencode-codex-install-receipt.json` |
| 技能正本与安装一致 | 通过 | 主控逐个核对六个指针；两个正本 quick_validate 通过；两个组件 sync --check 通过 |
| OpenCode 真实协作 | 通过 | 免费路由 `opencode/deepseek-v4.1-flash-free` 实际 read/write、nonce 与产物一致，随后同session二轮讨论及新进程四文件读取；`acceptance/opencode-*-receipt.json` |
| DeepSeek 真实协作 | 通过 | DSH 两轮共10次原生工具调用，权限审计、最终事件、nonce、文件均核对；`acceptance/dsh-receipt.json` 与 `dsh-review-receipt.json` |
| Kimi 已登录桌面协作 | 通过 | K2.8 Preview 两轮真实回复；指定标记 `KIMI-DESIGN-20261019-Q7M2` 与 `KIMI-REVIEW-20261019-Q7M2`；`acceptance/kimi-ui-evidence.txt` |
| 协作面板美化与部署 | 通过 | 正本、发布副本、本机 desktop/web profile 已更新；实际原生窗口已显示新布局并实测参与者筛选与搜索空态 |
| 实际 UI 指令到 Codex | 通过 | 输入 `UI-ROUTE-20261019-5N8`，原生点击发送，核对 sender=信使/recipient=Codex/direction=deepseek-to-codex，无 DSH 投递；`acceptance/panel-ui-route-receipt.json` |
| 桌面服务发现保护 | 通过 | 只允许明确 desktop-host/web 发布；headless、测试、未知进程不能覆盖桌面地址。测试全套运行前后实际 discovery 字节一致 |

## 真实登录边界与失败记录

- OpenCode 保存的 DeepSeek provider 首次返回401，`acceptance/opencode-deepseek-failed-receipt.json` 保留。随后 `--shared-deepseek` 作用域共享变量路由真实 read/write 成功（session `ses_eab5642b6ffemvvsGoRGsDyNct`，nonce与 result:42 由主控独立核对），`opencode-shared-receipt.json` 记录 accepted=true/persistent_auth_changed=false。账号与旧保存凭据未修改。
- DSH headless 的原生登录入口没有提供 DEEPSEEK_API_KEY，首次失败保留在 `dsh-initial*`。成功任务使用用户指定共享变量，仅在短生命周期子进程加载；没有读取凭据值给模型，也没有修改账号配置。它不代表桌面登录失效。
- DSH 曾真实尝试执行 Codex 安装脚本，但受工作区沙箱拒绝，没有放宽全局策略；失败回执保留。随后由具有精确逐命令权限的 OpenCode 完成同一安装。
- Kimi 是已登录桌面聊天协作，由 Codex 在三方间中转公共方案。没有宣称已获得 Kimi CLI/API 或本地文件工具能力；Kimi 模型未获本机文件/凭据访问。

## 面板设计与功能

OpenCode提出奶油白/青绿和任务导航、时间线、证据层；Kimi提出渐进展开、筛选、阅读保位和验收独立；DSH提出主任务状态带、责任交接、权限边界与证据优先。最终采用克制浅/深色主题、窄任务导航、同向时间线、参与者筛选、搜索、技术详情折叠和真实边界摘要。

修复两个实测问题：临时headless任务/单元测试不再覆盖桌面服务地址；新增 `/codex-collab/command`，避免原OpenCode专用 `/message` 把给Codex的指令强制改投DSH。原OpenCode消息路由及loopback/origin限制保留。

原消息时间线没有独立验收写入接口。2026-10-20新增的命令行协作记录已通过cli_coordinator.py持久化独立验收，参见CLI-ACCEPTANCE.md。面板内本次模型回执标明由Codex归档，不伪装三方实时在线。

## 继续使用与恢复

普通任务调用信使；跨AI执行参考 ai-collaboration。新会话将读取新安装入口，当前Codex对话的初始技能目录快照不会自动替换。Mac 工作流命令见 README.md，OpenCode单次限定读写入口见 opencode_adapter.py。

双击 `/Users/xinshi/Applications/DeepSeek-Codex 协作窗口.app` 查看实际面板。窗口已打开。若重启DSH导致已开窗口仍引用旧端口，关闭协作窗口再打开；不会删除聊天记录。

技能恢复点在 repo `.sync-backups/mac-migration-<host>-<timestamp>`；面板初始恢复点在 `.sync-backups/panel-20261019-224242`，profile backend原文件也保存于同目录上级备份区。恢复时按宿主及收据逐项恢复，不覆盖其他技能或聊天。

本次未提交或推送代码，未修改代理/网络、未重新登录账号，未创建外部后台服务。3个同宿主子agent分别负责OpenCode、DSH与面板，真实外部模型贡献方案与限定任务；最终检查由Codex完成。

## 最终自动检查

- 运行器 unittest 共92项：90通过，2跳过（Windows专项与未显式启用的真实Mac入口预检）；此前显式启用的真实Mac入口预检已通过。
- 本机实际backend完整24项：24通过，无跳过；测试前后桌面discovery文件字节一致。
- 面板正本16项：16通过。OpenCode适配器4项：4通过。
- 两个技能正本校验、六个安装指针核对、两个组件sync --check、git diff --check通过。
- 原生窗口参与者筛选、搜索空态、给Codex实际投递已通过。最终截图：`acceptance/collaboration-panel.png`。


## 2026-10-20 命令行协作续验

用户随后明确要求CLI-only协作，之后未使用computer use操作AI聊天。新调度、总计划同源面板、真实免费模型与Flash任务、重连调查及窗口端口恢复验收见 [CLI-ACCEPTANCE.md](CLI-ACCEPTANCE.md) 与 [RECONNECT-DIAGNOSIS.md](RECONNECT-DIAGNOSIS.md)。以上2026-10-19的Kimi桌面记录仅为历史验收，不代表Kimi CLI可用。
