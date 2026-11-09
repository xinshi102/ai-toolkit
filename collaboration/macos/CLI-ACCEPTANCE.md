# Mac 命令行协作验收续报

2026-10-20，Codex主控。上游基础982240a，本机改造尚未commit或push。

## 已部署与验收

- 信使、AI协作六个正式入口均指向本机唯一正本；两个技能quick_validate与两组件sync --check通过。
- OpenCode免费模型 `opencode/deepseek-v4.1-flash-free` 真实编写event_view.py，首轮边界错误经一次真实模型修复后通过7项独立测试。DSH显式 `deepseek-official/deepseek-flash` 原生CLI完成独立复核。
- cli_coordinator.py真实派发OpenCode，首次非Git/APFS路径权限失败保留；修复精确文件规则后新attempt实际read/write，返回1至7平方和140，Codex独立复算、核对nonce与SHA256后接受。无自动重试或付费升级。
- 协作面板实际desktop/web profile均已部署，默认“命令行协作”，另有“总计划”和旧消息。实际argv/cwd/stdin、任务brief、模型回复、工具事件和独立验收分层显示。输出返回后归档，不声称逐token直播。
- 运行状态与最终验收分离；3条已验收记录、1条失败attempt均显示，导入的旧CLI证据有单独标签。
- 总计划mac-cli-collaboration-20261019读取Codex同一个JSON/revision，协作台只读，不建第二份任务树。
- 实际HTTP /codex-collab/control 读取计划及4条运行，errors为空；无头Chrome渲染结果见acceptance/cli-panel-live.png与html。截图通过CLI生成，未使用computer use操作AI。
- 本机原生Swift窗口增加持续服务发现：DSH重启换端口时自动重载，稳定端口不重复刷新。已编译、备份并部署到实际.app，原生didFinish日志记录实际加载端口；详情见acceptance/cli-native-window.log。

## 独立检查

Mac测试23项通过；共享运行器92项，90通过/2环境专项跳过；实际插件30项通过；仓库发布面板22项通过。git diff --check通过。测试入口限制test/*.test.js，旧真实桥集成脚本改为显式opt-in，避免普通单测启动真实web宿主覆盖服务发现。

真实派发运行：coordinator-smoke-ccdc24bf0396；失败证据coordinator-smoke-a8a67336c591保留。免费脚本任务free-normalizer-e947ff9204bf、Flash复核dsh-cli-review-8211cd90b33e为明确标记的已有CLI回执导入。

## 使用与恢复

用户继续在Codex交办目标，主控生成manifest和验收证据。命令、职责与权限见CLI-COLLABORATION.md。双击本机DeepSeek-Codex协作窗口即可查看；不用手填任务JSON。

数据位于 ~/Library/Application Support/xinshi-collaboration/。技能和插件恢复点保存在仓库.sync-backups/mac-migration-*、cli-panel-*、cli-final-*。不修改原有账号凭据。

网络历史故障仍不能确证根因，独立记录于RECONNECT-DIAGNOSIS.md；不能把协作成功或网页探测通过写成云端反复重连已彻底修复。


## 2026-10-20 重连兼容修复续验

已部署默认HTTP/SSE传输，保持官方后端、同账号同模型；实际app-server两轮（20秒原生工具等待、计算、上下文继续）均通过。当前桌面会话通过本轮保存后的单次原生迁移与自动重启生效；最终状态以acceptance/reconnect-http-desktop-reload.json为准，脚本仅在验收通过后完成计划。详见RECONNECT-DIAGNOSIS.md末节。
