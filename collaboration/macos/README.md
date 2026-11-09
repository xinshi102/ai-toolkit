# 信使与 AI 协作：macOS 适配

当前正式迁移与真实验收见 [ACCEPTANCE.md](ACCEPTANCE.md)。基于上游 `982240a`（信使 3.0.0-trial.3）。本目录是 Mac 专用入口，复用 `../windows/runtime` 的工作流、队列、权限审计和验收协议，不复制第二套核心。目录名暂保留以减少上游合并冲突；后续可在 Windows 回归后统一迁往 `collaboration/runtime`。

## 使用方式

普通任务直接使用信使；可独立并行工作用宿主子 agent。只有跨执行器、需要持久恢复或多写入依赖时使用运行器。运行器不替用户作授权决定，也不自行生成语义计划。

主控在单次进程中设置本机项目根与 DSH 应用路径，不修改全局环境，不读取或复制凭据：

```sh
export XINSHI_PROJECTS_ROOT="/absolute/projects"
export XINSHI_DSH_PROGRAM="/Applications/DeepSeek Harness.app"
python3 -B collaboration/macos/workflow.py --project-root /absolute/projects/example --state /absolute/projects/example/.work/xinshi-flow init /absolute/generated-graph.json
python3 -B collaboration/macos/workflow.py --project-root /absolute/projects/example --state /absolute/projects/example/.work/xinshi-flow run --max-concurrency 2
```

以上路径必须由主控核实；示例不是要求用户手填任务图。接口、取消、修订、验收与恢复语义沿用 [WORKFLOWS.md](../windows/runtime/WORKFLOWS.md)。DSH 路径必须是 `.app` 根目录，不能填 `Contents/Resources`。配置更改后启动新的 Python 进程。

## 本次改造

- DSH 路径集中到 `platform_paths.py`，同时支持 Windows 安装目录和 Mac `.app`，文本与文件适配器共用。
- 写范围冲突比较使用 Unicode NFD 和大小写折叠，防止默认 APFS 上 `Src` / `sRC` 或组合字符别名被并发写入。在区分大小写的卷上可能保守串行，这是可接受的调度代价。
- CodeBuddy 在 Mac 从 PATH 寻找 `node`，仍允许显式指定 Node 路径；保留 2.169.0 版本审计门禁。本机未安装 CodeBuddy，不能声称可用。
- Mac 入口复用现有 POSIX 文件锁和独立进程组。没有引入新后台服务、额外队列或桥接层。

## 与旧方案的关系

信使是任务入口，workflow 是可选执行引擎，DSH↔Codex bridge 是消息通道；三者职责不同。保留当前桥与 `/Users/xinshi/.local/bin/codexworker-run`，新流程不同时交给两个控制器恢复或重试。旧 Hermes worker 后续可作为适配器接入，但不在本次未经验证地替换。

技能正本继续在仓库 `skills/xinshi`；安装入口使用单一正本指针，避免多份规则逐渐不一致。Mac 现存 `xinshiimprove` 安装副本需备份、检查宿主专有入口再切换，不直接全量同步覆盖。新版信使要求修改某宿主技能时由另一个宿主执行、外部监督；已由 Codex 更新 DSH 与 OpenCode；Codex 安装由 OpenCode 执行一次限定脚本完成。三个宿主均指向同一正本，旧入口归档到 `.sync-backups`。

## 验证边界

离线回归与样例不调用模型或读取账号配置，只证明引擎、锁、协议解析和合成文件任务。真实 ASAR 预检只证明本机 Electron 能读取固定 DSH 入口，不证明登录、模型响应或运行时权限插件有效。

POSIX 进程组清理不是 Windows Job 的同等保障：后代可以主动创建新会话逃离，监督进程被强制结束也没有 kill-on-close 保证。Mac 适配目前是前台受监督试行版，不用于任意后台守护/自更新任务；无法确认清理时继续保留 unknown 和资源占用，不把成功退出当作后代已清理。桌面关闭、监督者崩溃、重启恢复需单独验收。

DSH 与 OpenCode 已完成真实限定目录文件任务及审计，Kimi 已完成桌面模型评议。Codex工作流适配器的本机功能门禁与CodeBuddy仍未做端到端验证。检查失败保留记录，不通过放宽权限、版本或审计来冒充适配成功。

## 第一阶段历史验收记录（2026-10-19，后续正式结果见 ACCEPTANCE.md）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 上游拉取 | 通过 | 本地 HEAD 与拉取时 origin/main 均为 982240a |
| 全套引擎回归 | 通过 | `XINSHI_TEST_REAL_DSH_PREFLIGHT=1 python3 -B -m unittest discover -s collaboration/windows/runtime/tests -q`：90 项，跳过 1 项 Windows 专项；之后独立新增 2 项范围边界测试，专项 8/8 通过 |
| 离线并行与恢复 | 通过 | `python3 -B collaboration/windows/examples/offline_smoke.py`：accepted、parallel_branches=2、resume_no_duplicate_dispatch=true；仅合成执行器 |
| Mac 启动入口 | 通过 | `python3 -B collaboration/macos/workflow.py --help` 正常显示工作流命令 |
| DSH 本机 ASAR 预检 | 通过 | 独立测试实际执行 Electron 固定文件探测；未调用模型 |
| 真实模型与技能切换 | 待验收 | 未进行真实文件任务、未切换任何宿主安装副本 |

委派决策与结果：1 个同宿主子 agent，独立审查并编写平台路径/真实预检/范围边界测试；主控实现与复核。未把子 agent 自报完成当成模型或桌面验收。

## OpenCode 原生与共享路由

限定文件协作用 `python3 collaboration/macos/opencode_adapter.py --directory <absolute-acceptance-dir> --prefix <new-prefix>`，主控先生成对应 `<new-prefix>-brief.json`（含nonce/required_keys）。默认已验收的OpenCode免费模型；`--shared-deepseek` 显式使用共享作用域变量路由至 `deepseek/deepseek-flash`。它不会修改持久账号配置。每次使用新prefix保留历史，不覆盖旧回执；真实结果仍需主控核对。


### Codex HTTP/SSE兼容修复

`python3 collaboration/macos/codex_http_transport.py check` 只显示模型、provider与兼容开关；`apply`保留无关配置并创建本机600权限备份，`rollback --receipt <receipt.json>`在哈希一致时恢复。此操作不读取或修改auth.json、Game/.env或Clash配置。实际验收与当前桌面重载状态见RECONNECT-DIAGNOSIS.md及本机acceptance/reconnect-http-desktop-reload.json。重载脚本是本次维护的单次进程，不安装常驻服务、定时任务或自动升级器。
