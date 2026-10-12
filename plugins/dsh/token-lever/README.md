# token-lever · 省 token，不掉性能

在**不损失性能**的前提下修剪发给模型的「请求面」：重复工具结果折叠、陈旧结果中段裁剪。
原文永久留在会话日志，随时可恢复；模型正在用的最近几条绝不动。

## 三个策略

| 策略 | 规则 | 为什么不掉性能 |
|---|---|---|
| 去重 | 与更新某条**内容完全相同**的旧结果 → 折叠成一行「与第 N 步相同」标记 | 信息零损失（后文就有完整副本） |
| 老化裁剪 | 最近 `keepRecent`（默认 4）条之外、超过 `thresholdChars`（默认 4096）的结果 → 保头 `headChars` 尾 `tailChars`，中段换标记 | 头部通常是结构/结论、尾部通常是报错/总结；标记说明可重跑工具恢复 |
| 限流 | 单步最多 `maxOpsPerStep`（默认 16）次重写 | pre-step 耗时可控 |

## 验收发现的两个缺陷（已修）

宿主日志里曾出现 `[W] [@local/dsh-token-lever] tokenMeter service unavailable — surface rewriting disabled`，
也就是说插件**加载了但永久自禁用**。根因两条，都是验收才暴露的：

1. **加载期一次性取服务**：`apply()` 里 `ctx.get("tokenMeter")` 时 token-meter 行还没注册 → 拿到 undefined
   就 `return`，之后服务到位也不会再检查。**改成用到时再取**（`meterOf()`），
   写路径拿不到 meter 就跳过（shadow-price 契约不能打折），投影里的估算退回固定启发式（只影响展示数字）。
   回归测试：`meter 晚到也能生效（不再在 apply 时一次性自禁用）`。
2. **`input: { hint: "" }`**：宿主 `dsh-commands` 明确拒绝空 hint（`hint must not be empty`，
   另一个插件 session-guard 正是栽在这条），会让 `/lever` 注册直接抛错。已改为**省略 `input`**（该命令无参数）。

## 正确性契约（重要）

重写严格遵循官方 token-meter 的 **shadow-price 协议**：每次 `surface replace` 之前紧邻追加
`compaction/prune` 事件，用 `tokenMeter.estimateMessage(原消息)` 定价——与 meter 同源估算器，
投影计数不漂移。若 `tokenMeter` 服务不可用，插件**整体禁用重写**并打警告（不会违约）。

会话里随时可查累计节省：

```
/lever
→ token-lever 累计：7 处重写（去重 3 / 裁剪 4）
  字符 51200 → 9800
  估算 token 16800 → 3200（省 ~13600）
```

## 配置（profile `cordis.patch.yml` 覆盖）

```yaml
- id: token-lever
  config:
    keepRecent: 6          # 保护最近 N 条
    thresholdChars: 4096   # 裁剪触发线
    headChars: 1536
    tailChars: 512
    dedupe: true
    maxOpsPerStep: 16
```

## 安装

```bash
dsh plugin --profile web add file:/Users/xinshi/Documents/deepseek/work/dshworkspace/plugins/token-lever
```

## 测试

```bash
cd plugins/token-lever && node --test    # 12 项：裁剪/哈希/规划/配置
```

## 与官方组件的关系

官方 `compaction-basic` 做整段摘要压缩（需要 LLM），`compaction-tool-result-pruner` 做无差别
超阈值裁剪。token-lever 是**增量层**：加了内容去重、年龄保护、限流与 `/lever` 统计，
机制与 pruner 完全同源，可同时启用。
