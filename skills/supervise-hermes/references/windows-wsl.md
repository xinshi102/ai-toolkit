# Windows / WSL

先用 `wsl.exe --list --quiet` 确认发行版，再在指定发行版中检查 `command -v hermes`、`command -v codexworker-run` 和隔离 profile。不能在 Windows 的 PATH 找不到 Hermes 就判定未安装。

Windows 文件路径用该发行版的 `wslpath -u` 转换；传入 WSL 工具的是 Linux 绝对路径。调用方式为 `wsl.exe -d <发行版> -- <已解析的执行器> ...`，使用参数列表，避免把任务内容拼成 Shell 命令。

可以调用 CLI 版本、帮助和隔离脚本检查，但不为安装验收启动模型调用、读取密钥值或复制 Hermes 配置。找不到隔离执行器时说明缺失，继续使用 Codex；不要悄悄把用户已有主 Hermes 会话改成 Worker。
