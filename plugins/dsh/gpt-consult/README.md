# gpt-consult · 与 GPT 协作

让**当前 DeepSeek agent** 把 GPT 当第二意见工具——审方案、找漏洞、要替代思路。
与已有的 `@local/dsh-codex-bridge`（你对 Codex 聊天）互补：那是人对人，这是 agent 对人。

## 两个入口

```
/ gpt status                    累计统计
consult_gpt(question, context?) 模型在干活途中主动咨询
```

- 工具结果以 `【GPT · <model> · <ms>ms】` 展示，答案全文入会话；
- 不再往会话日志写自定义事件（自定义类型会让宿主整份拒读）：`gpt` 投影改为折叠
  官方的 `tool/call` + `tool/result`（命令路径折叠注入的 `user/message`），并兼容
  折叠老日志里已有的 `gpt/consult` 事件 → `/gpt status`；
- 端点、模型、密钥环境变量全部可在 profile patch 覆盖（见下）。

## 安全边界

- 密钥**只从宿主进程环境变量读**（默认 `OPENAI_API_KEY`），不落盘、不进日志、不出现在工具展示；
- 请求只发往配置的 `baseURL`（默认 OpenAI 官方；任何 OpenAI 兼容服务都可填）；
- 错误信息不回显 key 本体；超时默认 60s。

## 配置（profile `cordis.patch.yml` 覆盖）

```yaml
- id: gpt-consult
  config:
    baseURL: 'https://api.openai.com/v1'   # 或任何兼容端点
    model: 'gpt-5'
    apiKeyEnv: 'OPENAI_API_KEY'            # 宿主进程环境变量名
    timeoutMs: 60000
    maxContextChars: 12000
    systemPrompt: 'You are a rigorous second-opinion reviewer...'
```

设置 key（写进启动 DSH 的环境，例如 `~/.zshrc`）：

```bash
export OPENAI_API_KEY="sk-..."
```

## 安装

```bash
dsh plugin --profile web add file:/Users/xinshi/Documents/deepseek/work/dshworkspace/plugins/gpt-consult
```

## 测试

```bash
cd plugins/gpt-consult && node --test   # 10 项：配置/密钥/请求体/解析/折叠/网络错误映射
```

## 与 codex-bridge 的分工

| | codex-bridge（已有） | gpt-consult（本插件） |
|---|---|---|
| 形态 | 独立 macOS 窗口 + 授权队列 | 会话内工具 + 斜杠命令 |
| 发起者 | 你（人类） | DeepSeek agent 或你 |
| 密钥 | 不需要（走 Codex 桌面端登录） | 进程环境变量 |
| 适合 | 长对话、任务交接 | 一句话第二意见 |
