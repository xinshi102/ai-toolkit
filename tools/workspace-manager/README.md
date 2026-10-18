# Workspace Manager 确定性工具源码

配合 ../../skills/ai-workspace-manager 使用，部署到个人AI-Workspace的04-Tools/scripts下。源码保留现有布局解析；不包含本机Registry、聊天、任务、产物、审计和凭据。目标机需先创建自己的00-HOME、08-System/inventory、manifests和audit，并按实际应用建立配置。不能把源码复制当作原生AI入口已加载。

manager.py：发现/索引/定位/迁移/回滚/验证；governance.py：任务、交接、产物与Skill适配；launch_ai.py：已登记的本机AI启动。selftest.py和governance_test.py使用隔离目录验证，不启动真实模型。

## Windows

Python 3.12+ 可使用 `init_workspace.py --workspace <新工作区绝对目录> --codex-skills <本机Codex技能目录>` 初始化独立工作区。非空目录拒绝初始化；没有移动或覆盖现有项目。设置 `AI_SKILL_ROOTS`、`AI_PROJECT_ROOTS` 为实际绝对路径的 JSON 数组可控制盘点范围；Windows 默认只盘点 Codex 技能，不扫描私人项目。

`file_lock.py` 分别使用 Windows `msvcrt` 与 POSIX `flock`，文本显式 UTF-8。迁移和产物路径拒绝 symlink/junction。验收依次执行 `selftest.py`、`governance_test.py`、`file_lock_test.py`、`init_workspace_test.py`。Windows 原生应用启动和会话绑定未验收，`launch_ai.py` 在 Windows 拒绝派发此类操作。
