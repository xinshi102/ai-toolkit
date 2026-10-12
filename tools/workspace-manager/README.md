# Workspace Manager 确定性工具源码

配合 ../../skills/ai-workspace-manager 使用，部署到个人AI-Workspace的04-Tools/scripts下。源码保留现有布局解析；不包含本机Registry、聊天、任务、产物、审计和凭据。目标机需先创建自己的00-HOME、08-System/inventory、manifests和audit，并按实际应用建立配置。不能把源码复制当作原生AI入口已加载。

manager.py：发现/索引/定位/迁移/回滚/验证；governance.py：任务、交接、产物与Skill适配；launch_ai.py：已登记的本机AI启动。selftest.py和governance_test.py使用隔离目录验证，不启动真实模型。
