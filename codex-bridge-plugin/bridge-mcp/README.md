# bridge-mcp —— Codex 侧桥取件 MCP

给 Codex 用的本机 stdio MCP 服务器：让 Codex 主动从 DSH ↔ Codex 协作桥里**取件**并**回执**，
不再依赖 Codex 侧手工 curl 或读 SKILL.md。

- 零依赖：只用 Node 内置模块（node:fs / node:path / node:os / node:readline），没有 package-lock、没有 node_modules。
- 纯 stdio JSON-RPC：实现 MCP 的 initialize / notifications/initialized / ping / tools/list / tools/call。
- 只连本机：入口必须是 127.0.0.1 / localhost / ::1，否则拒绝。
- 只读取件；只有 bridge_reply 会往桥里 POST 一条 result 回执。

## 文件

| 文件 | 作用 |
|---|---|
| server.mjs | MCP 服务器本体（入口，零依赖） |
| test/stdio-smoke.mjs | 真实 stdio 客户端的冒烟测试（18 项断言） |
| test/last-run.log | 最近一次测试输出（证据） |
| test/config-launch.log | 用 config.toml 里的确切命令 + 空环境启动的验证（证据） |
| test/config-check.log | python3 tomllib 解析 ~/.codex/config.toml 的结果（证据） |
| package.json | type=module、scripts（无 dependencies） |

## 工具

### bridge_pending(agent)

读取桥会话里**待处理**的 DSH→Codex 消息，返回原始消息对象数组（不裁剪字段）。

参数：

- agent（必填）：桥会话 id，例如 bridge-e2e-20261018。注意不是 DSH 会话的 UUID。

返回：

    {
      "ok": true,
      "sessionId": "…",
      "pendingCount": 1,
      "messages": [ { 桥消息原始字段 … } ]
    }

### bridge_wait(agent, timeoutSec)

阻塞等待取件。每 1 秒轮询一次 GET /api/codex-bridge/messages?sessionId=…，
一旦出现待处理消息，立即返回**最旧的一条**原始消息；超时返回 timedOut=true。

参数：

- agent（必填）：桥会话 id。
- timeoutSec（可选）：1–600 秒，默认 8（要小于 MCP 客户端 timeout，例如 OpenCode 配置里的 10000ms）。

返回（取到件）：

    {
      "ok": true,
      "sessionId": "…",
      "timedOut": false,
      "waitedMs": 2024,
      "pendingCount": 1,
      "message": { 桥消息原始字段 … }
    }

返回（超时）：

    { "ok": true, "sessionId": "…", "timedOut": true, "waitedMs": 120000, "pendingCount": 0, "message": null }

### bridge_reply({...})

向桥 POST 一条回执：direction=codex-to-deepseek、kind=result，并带 replyToMessageId。

必填：replyToMessageId、goal、action、boundary、returnExpected
可选：workDone、toolsUsed、result、context、taskId、clientMessageId、agent

agent（桥会话 id）可省略；省略时服务器会扫描 /status 的会话，自动定位 replyToMessageId 所属会话。
返回里 persisted 表示已落盘、delivered 表示已投递进 DSH 会话、duplicate 表示命中幂等键。

注意：新会话若没有绑定 DSH 会话，桥会返回 HTTP 409 SESSION_NOT_BOUND，但消息**已经写进**
inbox/<messageId>.json。此时本工具返回 ok=true、persisted=true、delivered=false，并给 warning，
避免 Codex 重试造成重复回执。

## 待处理（pending）定义

同时满足：

1. direction == "deepseek-to-codex"
2. status == "received"
3. 没有任何 direction=codex-to-deepseek 的消息用 replyToMessageId 指向它

第 3 条保证「已回执、但 DSH 侧还没把状态改成 completed」的消息不会被反复取件。
结果按 timestamp / id 从旧到新排序。

## 入口发现（每次请求都重新解析）

优先级从高到低：

1. 环境变量 DSH_WEB_URL，例如 http://127.0.0.1:62965
2. ~/Documents/deepseek/codex-collab/bridge-endpoint.json 的 base
3. ~/Library/Application Support/com.xinshi.deepseek-codex-window/bridge-server.json 的 host/port
   （codex-bridge 插件每次启动发布，端口变化时最可靠）

只接受 loopback 入口。bridge_wait 每轮轮询都会重新读文件，所以 DSH 重启换端口后，
正在等待的调用能在下一轮自动切到新端口；环境变量优先级仍然最高。

测试钩子：CODEX_BRIDGE_ENDPOINT_FILE 可把第 2 项的路径指向临时文件（仅测试用）。

## 安装（~/.codex/config.toml）

已追加（追加前备份为 /Users/xinshi/.codex/config.toml.bak-bridge-mcp-20261018-104549，原文件 sha256 与备份一致）：

    [mcp_servers.bridge]
    command = "/Users/xinshi/.hermes/node/bin/node"
    args = ["/Users/xinshi/Documents/deepseek/codex-collab/bridge-mcp/server.mjs"]

改完 config.toml 后需要**下一次启动 Codex** 才会加载；本次没有重启 Codex / DSH。

校验：

    python3 -c 'import tomllib; print(tomllib.load(open("/Users/xinshi/.codex/config.toml","rb"))["mcp_servers"]["bridge"])'

## 手动运行 / 测试

    cd /Users/xinshi/Documents/deepseek/codex-collab/bridge-mcp

    # 真实 stdio 冒烟测试（需要桥在线）
    DSH_WEB_URL=http://127.0.0.1:62965 /Users/xinshi/.hermes/node/bin/node test/stdio-smoke.mjs

    # 用 config.toml 里的确切命令 + 无 DSH_WEB_URL 环境启动
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
      | env -u DSH_WEB_URL /Users/xinshi/.hermes/node/bin/node server.mjs

测试会在真实桥上创建 mcp-selftest-* 临时会话：wait / reply 两类会话各 2 条消息（请求 + 回执），
pending / timeout 两类不写消息。它们作为验收证据留在 codex-collab/inbox 与 outbox 里，不影响其它会话。
最近一次通过运行的会话 id：mcp-selftest-20261018024522-{wait,reply}。

## 验收结果

见 test/last-run.log：18 项断言全部 PASS，覆盖 initialize、tools/list、ping、
bridge_pending（空 / 有 / 回执后清零）、bridge_wait（超时 / 1s 轮询取件）、
bridge_reply（自动定位会话 / 显式 agent / 409 未绑定会话）、错误路径、
以及入口三级发现与回退。

## 边界与剩余风险

- 桥未启动或端口全错时：bridge_pending / bridge_reply 返回 isError 的明确错误；
  bridge_wait 若整个等待期都不可达会报错（不会假装超时）。
- bridge-endpoint.json 当前可能指向旧端口（由 DSH_WEB_URL 更新者负责刷新）；
  本服务器会继续回退到插件发现文件，所以 Codex 侧仍可用。若两者都过期，需要人刷新。
- 没有鉴权，仅靠 loopback + 桥自身的同源/本地限制；不要把它暴露到非本机。
- 回执的投递依赖会话绑定 dshSessionId（由 DSH 侧建会话时写入）。未绑定时只落盘、不投递，
  工具会明确 warning。
- 测试会留下 mcp-selftest-* 会话数据；需要清理时按 id 删除 inbox/outbox 对应 JSON 并改 bridge-state.json（本任务未做，避免越界写）。
