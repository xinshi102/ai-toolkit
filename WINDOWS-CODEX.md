# Windows Codex 适配验收

日期：2026-10-13（Asia/Shanghai）。基础提交：`f7ea5c3decd0e5b1215cb12a151983cced33ca2a`。

## 修改

- 工作区工具：Windows/POSIX 进程文件锁、UTF-8 序列化、Windows junction 路径拒绝、可配置盘点根目录、新工作区初始化，以及按实际文件生成 Dashboard。保留旧 `personal-mac` 域兼容，新增工作区使用 `personal` 域。
- Plan Map：官方 npm 源锁文件（原快照包含不可下载版本）；跨平台界面验收脚本不再写死 Mac Node 路径或用 Windows 不支持的管道 selector。
- 技能：管理工作区按本机配置定位；Hermes 支持 WSL 环境检查并保留隔离 Worker 前提；视觉指导允许宿主图片工具；Plan Map 按 MCP 注册定位；修复 daily-office-work 的 YAML description。

## 验收

环境：Windows、Node.js 22.23.3、Python 3.13、Playwright 1.63.0、Chrome；另在 Ubuntu WSL 验证 POSIX 锁分支。

| 检查 | 结果 |
|---|---|
| Plan Map Node 测试 | 6/6，通过真实 MCP 初始化、5 工具发现、资源读取、存储与布局检查 |
| Plan Map Chrome 交互 | 通过菜单、折叠展开、方向保持、状态编辑、保存与重开恢复 |
| 工作区 selftest | 迁移、回滚、哈希、碰撞与链接拒绝检查通过 |
| 工作区 governance_test | 28/28 隔离 CLI 检查通过 |
| file_lock_test | Windows 与 Ubuntu WSL 均通过跨进程争用、超时与释放检查 |
| init_workspace_test | 初始化、现有数据保护和最小 manifest 报告通过 |
| 真实新工作区 | index、validate、health 通过 |
| hatch-pet 原有回归 | 28/28 通过 |
| 已安装技能元数据 | 11/11 通过 quick_validate |

## 边界

Codex Plan Map 已按本机绝对路径注册。当前会话的工具目录不动态刷新；宿主重连后的内嵌 MCP App 显示与自然语言技能发现仍待确认。脚本与协议验收不等于这些界面效果已验收。

Windows 原生应用启动/会话绑定未验收，启动器明确拒绝未配置的 Windows 操作。Hermes 在 WSL 中存在，但隔离 `codexworker-run` 与 profile 未找到，因此没有运行监督 Worker 或付费模型调用。ComfyUI 专用执行技能未安装；视觉指导可使用宿主已有图片工具。

本记录不含本机 Registry、配置备份、知识库、聊天、凭据或模型。DSH 插件由 DSH 独立部署，不在本次 Codex 适配提交中覆盖。
