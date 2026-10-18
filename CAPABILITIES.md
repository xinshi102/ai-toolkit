# 个人 AI 能力总清单

2026-10-16源码快照。ChatGPT桌面任务入口中的本机扩展主要通过Codex Skill/MCP部署；本仓库没有宣称ChatGPT网页原生支持这些本地插件。所有源码发布到GitHub，不等于目标设备已安装或通过真实模型/界面验收。

| 组件 | 类型 | 路径 | 来源 | 边界 |
|---|---|---|---|---|
| dsh-search-mcp | plugin | [plugins/dsh/dsh-search-mcp](plugins/dsh/dsh-search-mcp) | adapted upstream (MIT) | source snapshot |
| gpt-consult | plugin | [plugins/dsh/gpt-consult](plugins/dsh/gpt-consult) | personal | source snapshot |
| prompt-snippets | plugin | [plugins/dsh/prompt-snippets](plugins/dsh/prompt-snippets) | personal | source snapshot |
| session-guard | plugin | [plugins/dsh/session-guard](plugins/dsh/session-guard) | personal | source snapshot |
| sidebar-plugin-management | plugin | [plugins/dsh/sidebar-plugin-management](plugins/dsh/sidebar-plugin-management) | personal | source snapshot |
| task-notifications | plugin | [plugins/dsh/task-notifications](plugins/dsh/task-notifications) | personal | source snapshot |
| thinking-chain | plugin | [plugins/dsh/thinking-chain](plugins/dsh/thinking-chain) | personal | source snapshot |
| token-lever | plugin | [plugins/dsh/token-lever](plugins/dsh/token-lever) | personal | source snapshot |
| web-search-plus | plugin | [plugins/dsh/web-search-plus](plugins/dsh/web-search-plus) | personal | source snapshot |
| xinshi-ledger | plugin | [plugins/dsh/xinshi-ledger](plugins/dsh/xinshi-ledger) | personal | source snapshot |
| plan-map-dsh | plugin | [plan-map/dsh](plan-map/dsh) | personal | source snapshot |
| plan-map-codex | plugin+mcp+skill | [plan-map/codex](plan-map/codex) | personal | source snapshot |
| master-plan | plugin draft | [experimental/dsh-master-plan](experimental/dsh-master-plan) | personal | incomplete; not installable |
| codex-bridge | plugin | [plugins/dsh/codex-bridge](plugins/dsh/codex-bridge) | personal | source snapshot |
| ui-enhancements | plugin collection | [plugins/dsh/ui-enhancements](plugins/dsh/ui-enhancements) | personal | legacy builder; explicit deployment only |
| novel-writing | skill | [skills/novel-writing](skills/novel-writing) | personal | source snapshot |
| obsidian-knowledge-base | skill | [skills/obsidian-knowledge-base](skills/obsidian-knowledge-base) | personal | source snapshot |
| personal-note-capture | skill | [skills/personal-note-capture](skills/personal-note-capture) | personal | source snapshot |
| supervise-hermes | skill | [skills/supervise-hermes](skills/supervise-hermes) | personal | source snapshot |
| generate-images-with-comfyui | skill | [skills/generate-images-with-comfyui](skills/generate-images-with-comfyui) | personal | source snapshot |
| visual-director | skill | [skills/visual-director](skills/visual-director) | personal | source snapshot |
| hatch-pet | skill | [skills/hatch-pet](skills/hatch-pet) | personal adaptation; Apache-2.0 license retained | source snapshot |
| daily-office-work | skill | [skills/daily-office-work](skills/daily-office-work) | personal | source snapshot |
| xinshiimprove | skill | [skills/xinshiimprove](skills/xinshiimprove) | personal | source snapshot |
| knowledge-vault | skill | [skills/knowledge-vault](skills/knowledge-vault) | personal | source snapshot |
| ai-workspace-manager | skill | [skills/ai-workspace-manager](skills/ai-workspace-manager) | personal | source snapshot |
| workspace-manager-tools | tools | [tools/workspace-manager](tools/workspace-manager) | personal | source; target setup required |
| opencode-bridge | mcp | [mcp/opencode-bridge](mcp/opencode-bridge) | personal | protocol source; requires live local bridge |

## 维护方式

Skill正文与references/agents/assets保存在skills；DSH运行组件保存在plugins/dsh；Plan Map两种适配保存在plan-map；其他MCP保存在mcp。保留本机正在运行的安装位置，修改仓库后按组件说明验证再部署。已借用的第三方代码保留NOTICE/LICENSE，未改造的官方/第三方安装包不冒称个人作品。

仓库不含聊天记录、Obsidian笔记、Registry个人盘点、桥接队列/发现状态、密钥、模型权重或应用二进制。hatch-pet是保留Apache许可证的本机适配版本；master-plan只有草稿源码。
