# OpenCode / Codex / DSH 协作 MCP

源码来自个人DSH工作区opencode-bridge，按MCP stdio JSON-RPC提供会话/消息查询与明确授权后的投递。运行：`node /absolute/path/to/ai-toolkit/mcp/opencode-bridge/server.mjs`。目标机必须已启动协作桥，并通过CODEX_BRIDGE_ROOT指定其本机目录（默认~/Documents/deepseek/codex-collab）。仅读取本机127.0.0.1发现记录；仓库不包含该记录、聊天或凭据。查询不发送消息；发送仍须用户明确授权。

Plan Map MCP位于../../plan-map/codex/server.js，依赖与注册说明见该组件README。
