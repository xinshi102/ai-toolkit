# Windows 工作区

Python 3.12+ 支持目录联接检测，管理工具使用 `msvcrt` 文件锁；POSIX 使用 `flock`。文本文件明确使用 UTF-8。目录符号链接和 Windows junction 均不能作为迁移或产物目标。

先用源码 `tools/workspace-manager/04-Tools/scripts/init_workspace.py --workspace <绝对目录> --codex-skills <本机技能目录>` 初始化独立工作区。已有 Registry 时拒绝初始化；不搬动已有资产、不改原生宿主配置。用 `~/.config/ai-workspace-manager/config.json` 的 `workspace_root` 告知技能位置。

验收运行 `selftest.py`、`governance_test.py`、`file_lock_test.py`；Windows 使用 junction 代替需要系统权限的测试 symlink。迁移的具体批准要求仍适用。Windows 原生应用启动器尚未验收，不能把工具安装说成启动或绑定会话已成功。
