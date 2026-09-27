# DSH（DeepSeek Harness）适配

> **触发场景**：在 DSH 中执行协议｜**不用读的情况**：使用其他工具时｜**行数**：48

版本：v1.3
更新日期：2026-09-26

公共约定见 ./_common.md，协作规则见 ../collaboration.md。本文件只写本工具差异。

## 入口文件
无固定入口文件，会话开始时手动指定项目目录并读取其 `AGENTS.md`。
`AGENTS.md`「必须先读」以 `<SHARE_ROOT>/ROUTER.md` 为首项，其余 share 文件按 ROUTER 路由表按需读取（见 `./_common.md` 第 3~4 条）。

## 权限与沙箱
- 写操作受文件沙箱约束：会话工作区之外的写入需人类批准
- 被拒绝即停下报告，不绕路

## 能力缺口
- 暂无已知的协议级能力缺口；如发现，按 ../new_tool.md 更新本节

## 降级方案
- 不适用（无缺口时保留本节并写"不适用"）

## 宿主契约反查（缺文档时）

- 宿主为 Electron + `app.asar` 打包时，包与方法的**声明原文**可直接在 asar 里做纯文本检索（无需解包）：
  搜 `service: "<服务名>"` 即可拿到 `namespace` / `method` / `parameters` / `cancellation` / `sourceLocation`
- 反例（2026-09-26）：协作桥投递持续报 `Cannot read properties of undefined (reading 'throwIfAborted')`，三轮猜测均未命中；
  从 asar 检索到 `cancellation: { parameter: "signal" }` 后**一次定位**——方法需要第二个 `signal` 参数，且挂在命名空间下（`ctx.<服务>.<命名空间>.<方法>`）
- 执行要求：契约类问题**先反查产物再改代码**，并把原文片段（含 `sourceLocation`）抄进证据

## 进程内服务优先于 HTTP 自调

- 插件/扩展与宿主交互，**优先注入并使用进程内服务**；不要 `fetch` 宿主自己的 HTTP API
- 反例（2026-09-26）：插件用 `fetch("http://<host>:<port>/api/...")` 投递消息，而宿主该 API 采用**签名 cookie 鉴权**
  （cookie 只能由打开 `dsh web` 打印的 URL 种下）→ 进程内调用既拿不到也种不了，**结构性 401**；宿主换端口即断
- 执行要求：需要宿主能力时先查有无对应服务（`ctx.<服务>`）；确需 HTTP 时，必须同时验证**鉴权**与**端口发现**两条

## curl 与系统代理（本机环境差异）

- macOS 的 `/usr/bin/curl` **不读系统代理设置**，只认环境变量与 `~/.curlrc`
- 反例（2026-09-24）：网络闸门 `spawn("/usr/bin/curl", …)` 探测 `chatgpt.com`；系统代理开着、规则模式正确，探针仍返回不可达 → 闸门**静默失败**
- 执行要求：探针要么显式传 `--proxy`（端口从 `scutil --proxy` 读），要么明确依赖 `~/.curlrc`，并在报告中写明依赖哪一种

## 本工具特有能力
- **goal**：长任务的目标记录。跨多轮的任务应记入 goal，便于中断后恢复
- **subagent / workflow**：批量或独立子任务可并行下发；并行任务不得并发修改同一文件
- 使用上述能力不改变阶段门与验收要求，子任务产出同样纳入本次自评报告
