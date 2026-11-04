# @local/dsh-xinshi-ledger

**把 xinshiimprove 的「规则观察」写进台账，并且写不坏。** 只加两个工具和一条命令，不动别的插件。

规则演进闭环的第 ① 环要求：**每次任务结束追加规则观察**，台账 `observations.md` 有三条硬规矩——

1. **只追加，不修改、不删除**已有条目（台账是证据，改了就失去追溯价值）；
2. 条目格式固定（日期/任务/涉及规则/状态/四问归类 + 现象/证据/分析/去向）；
3. 新增条目必须**同步更新「频次索引」**——那是闸 0 的判据（`governance.md`：L0/L1 需 3 次同类观察、L2 需 2 次、L3~L5 需 1 次）。

人在编辑器里手抄容易漏字段，agent 手写容易串格式，所以把「格式 + 追加 + 索引 + 门槛判定」做成工具。

## 用法

```jsonc
// 1) 先看现状：条目数、下一编号、哪些问题类别已经够次数提案了
{ "tool": "ledger_status" }

// 2) 把草稿给人类看过、确认之后，再追加（confirmed 必须为 true）
{
  "tool": "ledger_observe",
  "title": "台账靠手抄，漏字段没人拦",
  "category": "执行效果不佳",              // 四问归类（枚举，写进条目正文）
  "problemClass": "规则观察写入无工具把关（靠手抄）", // 频次索引的行键：同类问题复用同一个类名才会累计
  "phenomenon": "写观察时漏了「涉及规则」与「证据」两栏。",
  "evidence": "plugins/xinshi-ledger 的第一次试写。",
  "task": "DSH 生态建设 / xinshi-ledger",
  "rules": "`observations.md` §条目格式",
  "level": "L2",                            // 预计改动层级 → 决定门槛；默认取部署配置
  "confirmed": true
}
```

追加后返回：`{ id, category, problemClass, count, need, reached, verdict }`。
`reached: true` 就是**闸 0 达标**，可以走 `proposals.md` 提案了。

人看的入口：`/ledger`（一行式结论，不进模型上下文）。

## 为什么强制 `confirmed: true`

台账 §写入规则明确：「AI 在每次任务结束时产出观察结论，**经人类确认后**才追加到此处」。
这条纪律没法在技术上验证，但可以让它在调用面显形——没带就拒绝，并在错误里把规矩说清楚。

## 安全边界（写在代码里，也有测试守着）

- **只追加守卫**：写回前比对，原条目的编号与标题被动过 → 整笔拒绝（`assertAppendOnly`）。
- **认错文件就停手**：文件里没有 `# 规则观察记录` / `## 频次索引` / 表头 → 直接报错，不瞎建不瞎写。
- **未改动的索引行逐字保留**：不会因为新增一条就把别人那行的加粗、括注抹掉。
- **覆盖前留 `.bak`**；落盘走临时文件 + rename（原子）。
- **默认落在 skill 的 share 目录**（`$DSH_HOME/skills/xinshiimprove/share/observations.md`），可用 `dir`/`file` 覆盖。

## 验收

- **格式**：追加后的条目字段顺序、全角空格标题、分析三问缺省值都与 `observations.md` §条目格式一致（单测逐行断言）。
- **只追加**：原条目一字不动、条目数 +1、新条目只能在文件末尾；改动/删除旧条目会被守卫拦下（有反向验证）。
- **频次索引**：同类别累加、新类别新增行、达标整行加粗（沿用台账里 `**立规后…**` 那行的写法），未达标写「还差几次」。
- **闸 0**：`L0/L1=3、L2=2、L3~L5=1` 与 `governance.md` 对齐；`/ledger` 与 `ledger_status` 都能一眼看出哪些类别达标。
- **真文件兼容**：`scripts/verify.mjs` ⑬ 会拿**真实台账的临时副本**跑一遍追加，校验格式与只追加不变式。

22 个单测（内核 11 + 接线 11）。

## 文件地图

| 文件 | 职责 |
|---|---|
| `lib/ledger.js` | 解析/渲染/追加/门槛判定的纯函数：`parseLedger`、`formatEntry`、`upsertRow`、`applyObservation`、`assertAppendOnly`、`ledgerStatus` |
| `lib/index.js` | 插件体：`ledger_observe` / `ledger_status` 工具、`/ledger` 命令、系统提示段、原子写 + `.bak` |

## 已知边界

- 只做第 ① 环（观察→台账）。**提案**（`proposals.md`）、六环闭环的试验与固化仍走人工 + skill 里的流程。
- 「经人类确认」是流程约束，工具只能要求 `confirmed: true`，代替不了人的判断。
- 不自动改规则：`ledger_observe` 只写台账，一个字都不碰 `governance.md` / `CHANGELOG.md`。
- 任务卡 / 阶段门 → 计划树是这条计划线的另一半，见计划树 `xinshi-dsh-integration` 下的另一个节点。
