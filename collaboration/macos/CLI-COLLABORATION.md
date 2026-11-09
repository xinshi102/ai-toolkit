# 主控的命令行协作（DSH / Codex）

用户只在主控（当前 DSH 或 Codex）交办目标；主控生成任务包、选择执行者、派发、复核并更新进度。默认不使用 computer use 操作其他 AI 聊天界面。

## 分工与费用偏好

| 角色 | 默认工作 | 约束 |
| --- | --- | --- |
| 主控（DSH / Codex） | 总计划、重要判断、接口、集成、最终验收 | 执行者自报完成不能直接放行 |
| OpenCode 免费模型 | 简单重复脚本、格式转换、明确边界的小实现 | 已实测 opencode/deepseek-v4.1-flash-free；失败或限速不自动切付费 |
| DSH Flash | 较难独立实现、调试、复核 | 一次性patch显式选 deepseek-official/deepseek-flash，不猜profile默认 |
| Kimi | 非默认 | 保留有限额度，用户点名时核实CLI能力 |

这套分工是用户明确偏好，不是要求所有任务都多AI。直接做完更省事的任务仍可直接处理。普通单次文件任务用适配器；需要跨方可视化的任务使用下述日志层；复杂依赖和恢复继续用原 workflow.py，不另建后台scheduler。

## 一份总计划，两个视图

总计划由主控维护。对话里的内嵌 Plan Map 与协作台“总计划”读取同一份主计划（Codex 宿主为 `~/.codex/plan-map/<planId>.json`），显示同一个revision；协作台只读，不复制成第二套可编辑计划。子任务以 planId/nodeId/runId 关联执行者和回执。较大独立分支可另有子计划，但必须由主控挂回总节点；小脚本不强制另建子计划。

模型先返回产物，运行记录为 awaiting_acceptance。主控独立测试后才能写 passed，并按最新revision更新Plan Map。改总计划保留现有并发锁与原子替换，不由执行者任意覆盖；读取出错时展示错误，不把旧数据当新版本。

## 看哪些命令行内容

协作台默认“命令行协作”，可切到“总计划”或“原协作消息”。每次记录实际原生 argv、cwd、stdin（OpenCode的任务提示在argv中，空stdin属真实）、公共brief、模型/会话、原生工具及回复、失败、产物与独立验收。

派发前记录命令和running，原生输出返回后归档；这不是承诺逐token实时直播。既有证据导入会明确标记“既有CLI回执导入”，不会伪装新派发。模型字符串只按文字展示，不执行。凭据不进入命令、brief、环境转储或日志；只有短命子进程加载所需变量，原始输出经过脱敏。

## 主控调用

以下由AI按任务生成，不要求用户手填JSON：

```sh
python3 collaboration/macos/cli_coordinator.py bind-plan <planId>
python3 collaboration/macos/cli_coordinator.py run <manifest.json>
python3 collaboration/macos/cli_coordinator.py show <runId>
python3 collaboration/macos/cli_coordinator.py accept <runId> --evidence '<独立验证命令与结果>'
```

manifest必填：taskId、planId、nodeId、title、harness（opencode或dsh）、dataClass（public或synthetic）、brief（nonce、required_keys、task）。timeoutSeconds默认180，上限300。当前限定JSON产物，代码可作为code字段由主控核对后物化；不让模型任意写入宿主工程。

运行日志位于 `~/Library/Application Support/xinshi-collaboration/runs/<runId>/`；control.json只登记已授权展示的计划，不扫描其他私人计划。每个attempt独立目录，失败不覆盖，不自动重试或升级模型。接受前重新核对产物SHA256，发现变化拒绝接受。

DSH入口 dsh_adapter.py 复用固定权限overlay和原生日志审计。OpenCode入口 opencode_adapter.py 只允许指定brief和产物两个文件；非Git路径按实际根生成精确规则，Mac Data卷别名必须samefile确认，不授权HOME或任意目录。应用层工具权限不等于OS强隔离。

本次真实免费模型写出的事件整理模块为 event_view.py；首个版本的元数据限长失败和一次模型修复均保留。DSH Flash通过CLI做方案独立复核。证据在本目录 acceptance/，未上传到GitHub。


## 决策收件箱（Mac 已验收：DSH 同会话）

以下由主控操作；用户只需在协作窗口「总览 → 需要你决定」选一项。计划必须已绑定，问题绑定原 DSH CLI 工作包及同一任务节点。每个问题有独立 ID 和有效期。浏览器只可列出当前计划和回答，不能续跑或验收；数据由本机 SQLite 事务保存。

```sh
python3 collaboration/macos/decision_cli.py open <parentRunId> --question '请选择…' --option 'A=方案一' --option 'B=方案二'
python3 collaboration/macos/decision_cli.py list
python3 collaboration/macos/decision_cli.py show <decisionId>
python3 collaboration/macos/decision_cli.py resume <decisionId> <continuation-manifest.json>
python3 collaboration/macos/cli_coordinator.py accept <continuationRunId> --evidence '<独立验证>'
python3 collaboration/macos/decision_cli.py close <decisionId>
```

续做 manifest 沿用原 `planId/nodeId/taskId`，限 DSH 和既有 public/synthetic 数据边界，新的 brief 由主控提供，实际选择由运行器写入。命令在启动前用事务占有决定；重复执行不会再次派发。同一 DSH Session 固定工作目录，续做使用独立文件名，尝试日志另存。中断后先核对原尝试：有已成功的完整原生回执时，用 `recover-artifact <decisionId>` 补归档，不重新调用模型。仅在有记录的工作目录不匹配、原生进程未采纳会话时，才允许主控凭证据用 `retire-prelaunch-failure` 退役该决定；新决定重新确认。其他未知状态保持占用。没有常驻唤醒或后台自动派发。

`--home` 可用于隔离验收；正式窗口默认使用同一个本机协作数据目录。部署要求系统 Python 3（SQLite 标准库），不经 Python 加载提供者凭据。
