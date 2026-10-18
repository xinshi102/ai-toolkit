# DeepSeek Harness · Codex 协作桥

版本：1.5.0  
维护与最终验收：Codex  
通信对端：DeepSeek Harness

## 用户看到什么

打开 DeepSeek Harness，点击插件坞中的 `⇄ Codex 协作入口`：

- Harness 内只保留“打开独立协作窗口”和“打开 Codex”两个快捷入口。
- 完整消息时间线统一放在独立窗口，Codex 与 DeepSeek 页面不再嵌入第二份聊天框。
- 收到新回复时仍会出现页面标题提示和右下角提醒，点击提醒会打开独立窗口。

## 独立窗口

- 原生 macOS 应用：`/Users/xinshi/Applications/DeepSeek-Codex 协作窗口.app`。
- 桌面入口：`打开 DeepSeek-Codex 协作窗口.command`。
- 窗口具有系统标准的关闭、最小化、全屏与任意缩放能力，不依附 Codex 或 DeepSeek 浏览器窗口。
- 独立窗口使用同一 localhost 服务和同一份聊天记录；关闭窗口不会停止 Harness 或删除记录。
- 窗口内分别提供“DeepSeek 桌面版”“浏览器版”和“打开 Codex”按钮；桌面版为主要入口。
- 消息以协作任务卡展示发起者、接收者、请求/回复内容、实际过程、所用工具、结果和时间；状态侧栏可随时隐藏并记住选择。

## 两侧入口

- DeepSeek：打开 `⇄ Codex 协作入口`，点击“打开独立协作窗口”或“打开 Codex”。
- Harness 入口使用紧凑小菜单，只承担启动功能，不重复展示聊天内容或状态面板。
- Codex：个人插件 `DeepSeek ↔ Codex 协作窗口` 提供打开独立窗口、默认切换到 DeepSeek 桌面版，以及显式打开浏览器版的技能入口。
- DeepSeek 打开 Codex 前会检查经 macOS 系统代理访问 `chatgpt.com` 的网络状态与出口地区；探测不会修改任何网络设置。

> **打开 Codex 的网络前置条件：必须使用美国（US）出口节点，并启用 Clash 规则模式。** 插件通过 macOS `scutil --proxy` 读取系统代理地址和端口，再经该代理请求 `https://chatgpt.com/cdn-cgi/trace`；只有 HTTP 网络探针成功且返回 `loc=US` 才允许启动 Codex。系统代理未开启、代理端口不可达或出口地区无法确认时都会阻止启动。

## 安全与协作边界

- 默认无权协作；每个协作任务必须先显式授权。
- 授权同时绑定一个明确的 DeepSeek Harness 会话。
- Codex 负责插件实现、维护和最终验收；DeepSeek 只能作为通信对端和联调测试者。
- 消息默认进入下一轮队列，不打断 DeepSeek 当前工具调用。
- 新任务消息可携带 `taskId`、`taskCardRef`、`taskStatus` 和 `workspaceRef`；这些字段可省略，旧消息仍可读取。
- 插件不读取或传递 API 密钥，不修改 Harness 官方 `dist` 或官方包文件。

## 机器协议与可读记录

- 磁盘记录保留完整字段，供协作窗口展示目标、背景、动作、边界、结果和状态；发送给 DSH 的提示只包含必要字段，省略空的可选字段和重复协作说明。
- 跨 harness 任务可选携带稳定 `taskId`、`taskCardRef`、`taskStatus`、`workspaceRef`，字段约定见 `dshworkspace/docs/cross-harness-task-contract.md`。
- 每条消息有唯一 ID。DSH 回复可设置 `replyToMessageId` 指向原请求；此字段向后兼容，未关联的旧回复仍可读取。
- 会话可通过授权参数 `purpose: "work" | "test"` 标记用途；旧会话默认显示为工作会话，联调会话在窗口列表中标为“[联调]”。
- `delivered` 只表示已进入 DSH 队列；`read`、`processing`、`completed` 分别表示已读、处理中和处理完成。投递失败时界面展示错误原因。

## 可靠性

发送顺序是“先落盘，后投递”：

1. 消息先写入 `codex-collab/inbox` 或 `outbox`。
2. Codex→DeepSeek 消息通过宿主注入的 `ctx.sessionController.prompt(request, signal)` 队列投递。
3. 投递成功后记录为 `delivered`；失败时记录为 `delivery-failed`，聊天界面提供重试按钮。
4. 客户端消息带唯一编号，重复提交会返回原消息，不会产生重复对话。
5. 所有关键动作追加到 JSONL 与 Markdown 日志，服务重启后仍可恢复。

支持状态：

- `persisted`：已保存，尚未投递。
- `delivered`：已送入 DeepSeek 官方队列。
- `read`：DeepSeek 已读。
- `processing`：DeepSeek 正在处理。
- `completed`：处理完成。
- `delivery-failed` / `failed`：投递或处理失败。
- `received`：Codex 已收到 DeepSeek 回复。

## 本机位置

- 正式源码：`/Users/xinshi/Documents/deepseek/codex-bridge-plugin`
- 通信记录：`/Users/xinshi/Documents/deepseek/codex-collab`
- Harness 配置：`/Users/xinshi/.dsh/profiles/web/package.json` 与 `cordis.patch.yml`
- 重复旧插件隔离区：`/Users/xinshi/Documents/deepseek/codex-collab/quarantine/2026-08-22`

## 验证

在源码目录运行：

```sh
npm test
node --check lib/index.js
node --check lib/client.js
```

正式验收还必须包含：Harness 配置解析、HTTP API、官方队列真实投递、DeepSeek 已读回执、DeepSeek→Codex 回复以及浏览器可视界面检查。

## 恢复

如果插件异常：

1. 从 `cordis.patch.yml` 暂时移除 `codex-bridge` 条目并重启 Harness，可禁用插件。
2. 通信记录不会随插件禁用而删除。
3. 不要修改官方 `dsh-web-frontend/dist/index.html`。
4. 不要把隔离区里的旧 `codex-consumer` 或旧桥接副本重新加入 profile。
