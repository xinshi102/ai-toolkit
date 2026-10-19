# 运行器

只在需要跨模型执行、多写入依赖或可恢复长流程时使用：
`E:/AI-Workspace/Projects/Shared/Agent-Conventions/runtime/workflow.py`

- 主控生成工作图与验收检查；用户不写 JSON、不搬消息。
- 适配器：`codex`、`codex-workspace`、`dsh-text`、`dsh-workspace`；`local-test` 只在显式测试时用。
- 验收检查通过才释放后继；模型结束不等于交付通过。
- 接口、修订与恢复规则见同目录 `WORKFLOWS.md`：init / run / status / revise / cancel。
- 普通任务、原生子 agent 足够时不要进队列；运行器执行图，不替你理解需求。
