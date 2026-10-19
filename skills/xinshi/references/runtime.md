# 可选协作运行器

普通任务或原生子 agent 足够时不要启动运行器。需要多个执行者的写入依赖、可恢复长流程时，主控生成任务图、约束与验收检查，用户不维护 JSON 或搬运消息。

本仓库配套实现位于 `collaboration/windows/runtime/workflow.py`，是 **Windows 版本**。安装与配置见仓库 `collaboration/windows/README.md`。全量仓库中从本文件可打开 [Windows 使用说明](../../../collaboration/windows/README.md)。单独安装技能时，这个可选相邻目录可能不存在；先查本机既有实现或仓库副本，缺失时说明，不声称已部署。

- 运行器由主控按本机实际绝对路径调用；项目规则给出工作区根目录和允许范围。
- 适配器：`codex`、`codex-workspace`、`dsh-text`、`dsh-workspace`、`codebuddy-workspace`；`local-test` 仅用于明确标识的离线引擎测试。
- 检查通过才释放后继，模型结束不等于交付通过；修订仅重做受影响分支，保留失败和旧版本。
- `init / run / status / revise / cancel` 格式见运行器旁的 `WORKFLOWS.md`。
- 运行器执行已给出的图；主控负责语义规划、动态修订、授权判断和验收。
- macOS/Linux 尚未做本发布包验收；远端 SSH 连接与权限须单独核实，本包不携带任何公司的主机、账号或网络配置。
