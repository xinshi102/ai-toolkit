# dsh-search-mcp（dshworkspace 适配版）

> **状态：已适配但未启用（2026-09-24 人类决定把 L2 联网增强整体后置）。**
> 本目录的代码是完整可用的适配产物，但**没有**装在 profile 里：运行时不加载它，`web_search` 仍是内置 `deepseek-official`。
> 想启用：`pnpm add` 回 profile + 加回 `dsh.profile.bundles` + 把 `cordis.patch.yml` 的 `searchProvider` 改成 `search-mcp`（再重启）。

用 [MCP 搜索后端](https://github.com/gxpppp/dsh-search-mcp)替换 DSH 内置的 web 搜索执行路径。
**这是第三方插件的 vendored 副本**，来源与改动清单见 `NOTICE.md`；上游文档见 `README.upstream.md`。

## 它做什么

- 注册一个 id 为 `search-mcp` 的 **web search provider**（`ctx.web.registerSearchProvider`）；
- 模型侧的 `web_search` 工具**名字与呈现不变**，只是执行改走配置的 MCP server；
- 支持 Tavily / Brave / Exa / Perplexity / DuckDuckGo / 自定义 HTTP·stdio MCP；设置页里管理 server 列表与 key。

## 本适配版的三处关键差异

1. **不关掉内置搜索**：只把 `web.searchProvider` 指到 `search-mcp`；切回内置 DeepSeek 搜索 = 把那两行删掉/改回 `deepseek-official`。
2. **不关掉 `web_fetch`**：上游 patch 里 `tool-web.fetch: false`，那会让 `web_fetch` 与 web-search-plus 的 `web_read` 一起失效；这里保持 `fetch: true`。
3. **免 key 起步**：默认 server 是 DuckDuckGo（`npx -y duckduckgo-mcp-server`）。它不需要 key，但上游自测记录显示**可能被 DuckDuckGo 反爬拦截**；要稳定结果请换成 Tavily/Brave/Exa/Perplexity 并在设置页或 `$DSH_HOME/.credentials.yaml` 配 key。

## 配置

```yaml
# profile 的 cordis.patch.yml（或本包的 cordis.patch.yml）
- id: search-mcp
  config:
    defaultServer: tavily
    servers:
      - id: tavily
        kind: tavily
        apiKeyEnv: TAVILY_API_KEY   # key 放 $DSH_HOME/.credentials.yaml
```

`maxResults` 的最终数量受三方共同约束：本插件 schema 上限、单 server 的 `maxResults`、
以及 `tool-web.searchMaxResults`（本适配版提到 50，否则会被内置默认 8 截断）。

## 与 web-search-plus 的关系

- `web_search`（发现）走这里配的 MCP 后端；
- `web_read` / `web_fetch`（读正文）仍归 web-search-plus 与内置工具，本插件不碰 `fetch` 路径。

## 测试

```bash
node --test          # 上游自带：url-policy / runtime / compatibility（pin 断言已按适配改）
```

依赖需要先装（`pnpm install`）：上游运行时依赖 undici、`@modelcontextprotocol/sdk`、ipaddr.js。
