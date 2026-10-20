# xinshi 协作运行器 — Windows 版

此目录是 **Windows 源代码版本**，不是全平台安装包。需要 Windows 10/11、Python 3.10+；各 AI CLI 另外安装并用自己的账号原生登录。技能规则本身不限定操作系统。

主控负责理解目标、环境判断、拆分、选择执行者、动态修订、检查产物与向用户汇报。运行器负责持久队列、依赖和文件绑定、同资源互斥、并行执行、取消、失败记录及恢复。用户用自然语言交办，不维护任务 JSON，也不搬运窗口消息。

## 与 xinshi 配合

先安装或使用仓库 `skills/xinshi/`。普通单任务直接完成，可独立并行的工作优先用宿主原生子 agent。需要跨执行器、多写入依赖或可恢复长流程时，主控按本机实际路径调用本目录 `runtime/workflow.py`。技能不捆绑 CLI、账号或这个运行器，单独复制技能不会自动部署这些组件。

## 本机配置

路径由接手的 AI 核实后配置，不照搬作者电脑目录。配置属于本机，不提交到仓库；修改配置后使用新的 Python 进程。

```powershell
# 示例路径，替换为本机实际目录。只启用需要的执行器。
$env:XINSHI_PROJECTS_ROOT = 'C:/AI/Projects'
# CodeBuddy：官方 CLI 2.169.0（当前精确锁定的已审计版本），Node.js 原生程序。
$env:XINSHI_NODE_EXE = 'C:/Program Files/nodejs/node.exe'
$env:XINSHI_CODEBUDDY_ENTRY = 'C:/Apps/CodeBuddy-Code/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'
# DSH：包含 DeepSeek Harness.exe 与 resources/app.asar 的安装目录。
$env:XINSHI_DSH_PROGRAM = 'C:/Apps/DSH'
```

Codex 适配器从 PATH 寻找原生 `codex.exe`，拒绝批处理启动器。CodeBuddy/DSH 的配置仅在使用对应适配器时要求；缺失配置或预检失败会拒绝执行，不回退到开发者的路径。配置中不保存账号令牌；各执行器使用其原生登录。本目录不安装、升级或破解任何 CLI，也不复制账号配置。

DSH overlay 从随包固定模板渲染到本目录 `.work/generated-overlays/`，以内容指纹命名并原子写入；其中插件路径是本机字面量，不修改源模板或宿主全局配置。该本机临时目录被 Git 排除，发布目录需可写。

工作流状态目录必须位于目标项目内部，目标项目位于 `XINSHI_PROJECTS_ROOT` 下。未配置时仅默认允许本发布目录的父目录，适合离线样例；真实项目应显式配置自己的项目根。不要为每个 agent 复制一份独立项目。

## 调用

以下由主控按任务生成和执行，`graph.json` 不是要求用户手填的配置。

```powershell
$runner = '<repo>/collaboration/windows/runtime/workflow.py'
$project = 'C:/AI/Projects/example'
$state = "$project/.work/xinshi-flow"
python -B $runner --project-root $project --state $state init '<generated-graph.json>'
python -B $runner --project-root $project --state $state run --max-concurrency 2
python -B $runner --project-root $project --state $state status
```

接口、显式验收、依赖绑定和局部修订见 [WORKFLOWS.md](runtime/WORKFLOWS.md)。运行器不自行生成语义计划，失败或等待返回给主控决定下一步，不无限重试。

适配器：

| 名称 | 能力与边界 |
| --- | --- |
| `codex` / `codex-workspace` | 原生 CLI，只读 / 项目制作；启动前校验能力和 MCP 禁用 |
| `dsh-text` | 只传提示词，固定保护插件拒绝工具调用 |
| `dsh-workspace` | DSH 项目读取/制作，固定 overlay 与逐调用审计；安装布局和策略需预检 |
| `codebuddy-workspace` | 原生 CLI 读取/制作，空 MCP、关闭 hooks、工具白名单与显式禁用、会话与终端校验；包含恢复会话时的 SkillManage 禁用修复 |
| `local-test` | 仅显式离线引擎测试，不代表真实模型效果 |

## 验证与发布范围

无需模型、账号或网络的回归与并行样例：

```powershell
python -B -m unittest discover -s collaboration/windows/runtime/tests -v
python -B collaboration/windows/examples/offline_smoke.py
```

公开协议 fixture 全为合成数据。真实机器上的原生 CLI 文件任务与会话接续已验证过，但账号、公司主机、真实项目资料、聊天/运行日志、数据库和回执不随包分发。目标机器必须重新验证登录、能力和端到端任务，离线测试不替代真实模型验收。

Windows 任务进程树使用 owned Job：先挂起、分配、恢复；确认停止后才释放资源，无法确认时保留 unknown。资源锁只协调同一队列里的协作者，不是全局文件锁。CodeBuddy 的工具限制不是 OS 文件隔离，Bash 使用当前账号权限；主控必须保留任务授权与文件归属约束。

本次不宣称支持 Linux/macOS，也不宣称安装即能接管 IDE 既有聊天、连接企业业务接口、在关闭桌面/重启后持续运行。SSH 属于单独配置的通道；本包没有内网主机、账号、端口或默认远端命令。特定项目的 Gate、生产写入及危险操作仍须遵循其已有授权。

## 事件门禁与预算（token 控制）

`runtime/` 新增四个旁路模块，不改变执行器语义：

- `events.py`：SQLite 本地事件总线（零模型）；
- `state.py`：任务权威状态与 <=4 KiB 快照；
- `gate.py`：确定性规则过滤 + Gate 1/2/升级，每次只调用一次控制器；
- `budget.py`：按任务限制 token/时长/轮询，超限熔断。

使用方式与集成示例见 `runtime/COLLAB_EVENTS.md`。默认数据库 `.work/collab-events/collab.db` 属于本机运行状态，不提交。
