# 工作包

沿用 `dispatch_guard.admit()` 和现有的队列，不新增服务。

## 一个工作包 = 一个用户看得见的里程碑

是“统一入口上线”“D1 规范化接入写入链路”这种结果，不是“只修安装脚本里的一个分支”这种动作。执行者在包内自己完成读代码、修改、测试、修复，直到达到验收标准或真实受阻。

```json
{
  "task_id": "unified-entry",
  "continuation_of": "",
  "permission": "workspace-write",
  "prompt": "目标 / 非目标 / 权限边界 / 验收标准 / 交付位置",
  "acceptance": {"checks": ["三库入口线上可用，健康检查 200，原数据计数不变"]},
  "timeout_seconds": 7200,
  "work_package": true
}
```

## 规则
- prompt 写清结果和边界，不写过程步骤，也不限字数（传输上限 64KiB）。不要声明 `limits.prompt_chars`。
- **轮数只是兜底**：默认 300，不需要在 spec 里写。不同模型步子大小不同（deepseek 一次改一点、多次跑测试），不按轮数控制节奏。
- **真正的防护由 `run_package.py` 在本地做，不花模型额度**：同一命令同样报错连续 5 次、20 分钟没有任何文件改动、超过 `timeout_seconds`（默认 2 小时）——任一命中就停进程，回执 `stall` 写明原因。
- 碰到轮数兜底：同一会话自动续，最多 3 次（`auto_continue`）。卡住（stall）不自动续，交主控判断：换方法、换更强模型（写 `model_reason`）或找用户。**不要把剩下的工作拆成更小的包**。
- 必须写验收标准（`work_package=true` 时缺了直接拒绝）。验收标准默认包含：写好里程碑笔记 `journal/<里程碑>.md`（做了什么、为什么、技术概念一两句解释、证据路径）；会写数据的包先留回滚点。测试由执行者在包内自己决定怎么跑，主控不规定测试次数。
- `phase` 可选：`diagnose` 只能只读；不需要先诊断再修，执行者可以在同一个包里诊断加修复。

## 怎么执行（阻塞，不轮询）
- 单包：`python -X utf8 runtime/run_package.py <包目录>/spec.json`。一直等到结束，只输出一行 JSON 摘要。
- 多包、有依赖：`workflow.py run`（见 WORKFLOWS.md）。
- 主控用宿主允许的最长等待时间等这个命令返回（Codex：`exec_command` 返回进程后，用 `write_stdin` 空输入加最大 `yield_time_ms` 续等）。**不要用 sleep 循环，也不要在等待期间读 `stdout.ndjson`**。

## 续做与会话
- 同一任务续做用 `continuation_of` 加原 `session_id`（`resume=true`）；换执行者或开新会话要写 `switch_reason` / `handoff_reason`。
- 支线（`branch`）可以换 agent。
- 有实际资源冲突才互斥：同一文件/目录、显式声明的端口、同一个原生会话。

## 失败
- 超时、无最终回复、续做后仍到上限：记为未完成，保留回执。不自动开新会话重试。
- 原生策略拒绝（tool_error_code=8008）会立即停止进程树，不等轮数耗尽。进程无法确认已停止时记为 UNKNOWN 并保留锁。


## 模型选择（2026-10-26）

执行者默认模型 **deepseek-v4.1-flash**（用户 2026-10-26 要求，claude-sonnet-5 耗尽额度）。

能力不足时在包 spec 写 `"model": "claude-sonnet-5", "model_reason": "需要 X 能力，Y 场景下 deepseek 失败过"`。主控记录升级依据；执行者不擅自切模型。
