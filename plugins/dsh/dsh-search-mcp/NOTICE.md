# NOTICE — 第三方代码来源与改动

本目录是第三方插件 **dsh-search-mcp**（MIT）的 vendored 副本，由 dshworkspace 适配到本机宿主版本。

- 上游：<https://github.com/gxpppp/dsh-search-mcp>
- 上游提交：`ae3a247aa104c952f720736cb4dfa3f024f01551`
- 上游版本：0.2.0 ｜ 上游许可证：MIT（见 `LICENSE`，未改动）
- 上游 README 原样保留为 `README.upstream.md`

## 我们改了什么（每条都可对拍）

| # | 改动 | 原因 |
|---|---|---|
| 1 | `package.json` 的 host 依赖 `0.1.1-rc.2` → `0.1.5-rc.2`，schemastery `3.18.1` → `3.18.2` | 本机宿主是 0.1.5-rc.2；装了 0.1.1 的副本会与宿主行为不一致 |
| 2 | 去掉 `@deepseek-ai/dsh-web` 依赖，provider 改用本地 `lib/web-error.js` | profile 会把自己声明的 host 包装成第二份副本，`instanceof WebError` 必然失手；宿主 `ctx.web.search()` 不 try/catch provider 异常，形状一致即可 |
| 3 | `cordis.patch.yml`：不再 `disabled: true` 内置 `web-search-deepseek`；且**默认不切换**（`searchProvider: deepseek-official`） | 只改一行就能替换搜索、也能改回来；默认不切是因为本机唯一免 key 后端（DuckDuckGo）可能被反爬拦，切过去有把现有搜索弄坏的风险 |
| 4 | `cordis.patch.yml`：`tool-web` 保持 `fetch: true` | 上游顺手关掉了 `web_fetch`，会连带让 `web_fetch` 与 web-search-plus 的 `web_read` 失效 |
| 5 | `cordis.patch.yml`：默认 server 用免 key 的 DuckDuckGo | 本机没有 Tavily/Brave/Exa/Perplexity 的 key；DuckDuckGo 免 key（但可能被上游反爬拦，见上游 README 的自测记录） |
| 6 | `test/compatibility.test.js`：pin 断言 + patch 语义断言 | 跟着 1/2/3/4/5 改（原用例断言的是上游「disabled 内置搜索 + fetch:false」的语义，与本适配版相反） |
| 7 | `package.json` 加 `private: true`、版本号 `0.2.0-xinshi.1` | 本副本只在本工作区安装，不发布；版本号标出适配来源 |
| 8 | `lib/client.js`（主机侧 MCP 客户端）也改用本地 `lib/web-error.js` | 与第 2 条同因；否则主机侧还残留一份 dsh-web 依赖 |
| 9 | `lib/index.js` 的 settings 助手改从本地 `lib/host-shims.js` 导入，并去掉 `@deepseek-ai/dsh-settings` 依赖 | **发布版** `dsh-settings@0.1.5-rc.2` 没有导出 `installSettingsSection`/`settingsNamespace`（app 自带构建里有）：同版本不同内容，pin 版本并不能解决 |

## 未改动

`lib/` 下的业务逻辑（provider / catalog / client / extract / url-policy）与 `test/` 的运行时用例除上述两处外一律保持上游原样，便于日后按上游提交重新对拍。
