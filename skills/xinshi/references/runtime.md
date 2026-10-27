# 运行器

只在跨渠道执行、多个写入有依赖、需要可恢复的长流程时使用：
`E:/AI-Workspace/Projects/Shared/Agent-Conventions/runtime/workflow.py`

## 怎么用
- 主控生成工作图和验收条件；用户不需要写 JSON，也不需要搬运消息。
- `init` 建图 → `run` **阻塞**执行，直到验收通过、需要处理或超时，然后只返回一次结果。主控在这段时间里不轮询、不 sleep。
- 只跑一个包可以用 `run --timeout-seconds N`；超时后会返回 `resumable`，再调一次 `run` 就能接着跑。
- 不要手写 OwnedProcess 启动脚本加 sleep 读 `stdout.ndjson`（2026-10 的反例）。需要看执行者在做什么，等 `run` 返回后看 receipt 和 `reply.md`。
- 本机适配器：`codex`、`codex-workspace`、`dsh-text`、`dsh-workspace`、`cursor-workspace`。每个适配器当前能不能用，以实际回执为准。
- 接口、修订和恢复规则见 `runtime/WORKFLOWS.md`，工作包字段见 `runtime/WORK_PACKAGE.md`。

## 不用运行器的情况
普通任务、或者原生子 agent 就够用时，不进队列。运行器只负责执行图，不替你理解需求。

## 可选：supervision
只有确实需要额外的主控事件审查时才配置，配置时明确选审查渠道和预算。详见 `runtime/QUOTA_WORKFLOWS.md`。
