# thinking-chain · 思考链优化

把模型的 reasoning 从「黑盒长思考」变成**可追溯的四阶段链路**，token 成本接近于零
（一个 ~90 token 的系统提示段；提醒只在过期时追加一行，且只进系统提示、不进你的对话）。

## 它做什么

| 机制 | 说明 |
|---|---|
| 系统提示段 | `plan（拆解）→ act（执行）→ verify（验证）→ done（收尾）`，order 460，可部署侧覆盖 |
| `chain_note` 工具 | 模型在阶段开始/切换时记录 `phase + 一行要点 + 下一步`。记录本身落在 harness 写的官方 `tool/call` 事件里（**不写自定义事件类型**，见「0.1.1 → 0.1.2」），**压缩后仍可追溯** |
| `chain` 投影 | 折叠出当前阶段、距上次记录步数、记录次数；客户端阶段条直接读 |
| 惰性提醒 | 连续 `staleAfterSteps`（默认 3）步未记录时，把一行提醒**追加进系统提示段**——模型可见、**你的对话里看不到**，记完即自愈 |
| 会话头阶段条 | 彩色圆点 + 阶段名 + 记录次数，悬停看要点/下一步（**状态指示器，不是按钮**） |

## 0.1.0 → 0.1.1：修掉「已连续 250 步」的打扰

0.1.0 有两个真问题，都是实际使用中暴露的：

1. **提醒插进了对话**：走 `agent/pre-step` 注入 user 消息，你每一步都能看到一条
   `[thinking-chain] 已连续 N 步未记录…`。→ 改为只写系统提示段（模型可见、用户不可见），
   并**移除 pre-step 中间件**（少一个会干扰请求装配的钩子）。
2. **把历史步数当欠账**：`sinceNote` 折叠整个会话日志，长会话一恢复就立刻提醒；而
   `lastNudgeSince` 只能防「同一个值」重复，于是**每步都提醒一次**。
   → 规则改为**只有用过 `chain_note` 的会话才提醒**（没用过 = 不打扰），
   显示也做了限幅（超过 9 步显示 `9+`，不再出现「250 步」）。

## 0.1.1 → 0.1.2：不再写自定义事件类型（这条会让会话打不开）

**症状**：会话在历史里打不开，报
`contains event type "chain/note"/"chain/nudge" (seq N) unknown to this harness and not marked ignorable`。

**原因**：0.1.1 及以前用 `session.append("chain/note" | "chain/nudge", …)` 把链路写进会话日志。
宿主**读回**日志时会走 `validateStoredEvents`：未知事件类型且没有 `"ignorable": true` ⇒
**整份日志拒读**；插件侧的 `append` 又无法附加该字段（细节见 `docs/architecture.md` §5.1）。

**修法**：`chain_note` 不再 append 任何东西——它的参数本来就被 harness 原样写进官方
`tool/call` 事件里，投影改为折叠那条 `tool/call`（`chainNoteOf()`）。于是：

- 链路记录仍在会话日志里，压缩后仍可追溯，客户端阶段条行为不变；
- 插件**零自定义事件**，会话能否打开不再取决于插件是否加载；
- 老日志里的 `chain/note` / `chain/nudge` 仍被折叠（历史不丢），但已被写坏的会话
  需要用 `node scripts/repair-session-log.mjs --apply` 补上 `ignorable` 才能打开。

## 为什么不掉性能

- 提示段极简；不替换、不改写任何请求内容，过期时只多一行提醒文本。
- 提醒有阈值 + 采纳门槛（用过 chain_note 才提醒），不会刷屏。
- 全部状态走投影折叠，无外部存储、无 LLM 调用。

## 安装

```bash
dsh plugin --profile web add file:/Users/xinshi/Documents/deepseek/work/dshworkspace/plugins/thinking-chain
```

## 配置（profile `cordis.patch.yml` 覆盖）

```yaml
- id: thinking-chain
  config:
    staleAfterSteps: 4          # 0 = 关闭提醒
    section: |-
      你的自定义提示段
```

## 测试

```bash
cd plugins/thinking-chain && node --test test/
```
