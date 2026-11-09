# 运行器

只在跨渠道执行、多个写入有依赖或需要恢复时使用。按宿主实际配置选入口：

- Mac：单次跨渠道任务走已安装并验证的 CLI 适配器，入口 `collaboration/macos/cli_coordinator.py`，用法见 `collaboration/macos/CLI-COLLABORATION.md`；可恢复工作流用 `collaboration/macos/workflow.py`。Mac 技能分支不附带这些运行组件。
- Windows：使用已安装且验证过的运行器；公开文档位于 `collaboration/windows/runtime/WORKFLOWS.md`。

## 怎么用
- 主控生成工作图和验收条件；用户不需要写 JSON，也不需要搬运消息。
- `run` **阻塞**执行，直到验收通过、需要处理或超时，然后只返回一次结果。主控在这段时间里不轮询、不 sleep。
- 只跑一个包可以用 `run --timeout-seconds N`；超时后会返回 `resumable`，再调一次 `run` 就能接着跑。
- 原生子 agent 是异步的：没有运行器时，结束本轮等结果通知，不要用 sleep 轮询（见 SKILL 第 3 节）。
- 不要手写 OwnedProcess 启动脚本加 sleep 读 `stdout.ndjson`（2026-10 的反例）。需要看执行者在做什么，等 `run` 返回后看 receipt 和 `reply.md`。
- 每个适配器能否启动、限制权限和续做，以本机真实回执为准。确认规则在实际启动入口执行，不能把独立的规则函数当作已生效的授权闸门。本机 Mac 适配器已把模型、超时和工作目录检查放进启动路径（`collaboration/macos/launch_guard.py`），直接调用适配器也会被拦。
- 接口、工作包、修订和恢复以本机所用运行器的 `WORKFLOWS.md` 为准。

## 不用运行器的情况
普通任务、或者原生子 agent 就够用时，不进队列。运行器只负责执行图，不替你理解需求。

## 可选：supervision
只有确实需要额外的主控事件审查时才配置，配置时明确选审查渠道和预算。以当前安装的运行器文档为准。
