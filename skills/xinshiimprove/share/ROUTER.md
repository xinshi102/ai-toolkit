# ROUTER —— 读什么文件的唯一索引

版本：v1.4
更新日期：2026-09-24

**唯一需要常驻**的 share 文件。其余一律按需加载。

---

## 加载原则

**不要全量读 share。** 按路由表判定任务类型，只读对应文件。

- 每个文件头部有「触发场景 / 不用读的情况 / 行数」标签，扫标签即可判断
- 行数标注仅供**量级参考**，不保证与实际完全一致
- 判不准 → 读目标文件头部标签（前 6 行）确认 → 仍不确定按 `collaboration.md` §未知处理 提问
- **禁止**为"保险起见"批量读取多个流程文件

---

## 红线（常驻，违反即停）

- 不跳阶段；方案未确认前不写完整实现代码
- 信息不足先提问，不猜测；不强杀进程；不自行 resolve 冲突
- 无验收的产物视为未完成
- 不写 `share/` 目录
- 档位只能自主升级，降级必须人类批准；XL 不配 A；含不可逆操作不配 A
- 任务结束**反问**「规则观察」四问（一句话，不逐条成文；没人认就不写台账）
- 任务结束**另出一份「人类验收版报告」**（平实语言：做了什么 / 证据在哪 / 遗留什么 / 需要你决定什么）
- 任务/项目**归档时**必须执行 `distill.md` 蒸馏协议（经验蒸馏 + 规则提纯一起做，**不得只做加法**）
- 不自行发起规则改动、不自行删除规则或技能、不自行判定试验有效

细则见 `collaboration.md` 对应章节。

---

## 路由表（判定任务类型 → 读这些）

| 任务类型 | 读什么 |
|---|---|
| **日常任务 S 档**（≤1h，改 ≤2 文件） | `collaboration.md` 的 4 个执行型章节（见下） |
| **日常任务 M/L/XL 档** | `collaboration.md` 全文 + `task_card_template.md` |
| **XL 档跨会话** | 上行 + 项目 `progress.md` 的「当前状态」「下一步动作」「阻塞点」三节（**不读全文**） |
| **新建项目 / 初始化环境**（全新） | `_project_common.md` + `new_project.md` + `agents_template.md` + `project_files_template.md` |
| **存量项目接入**（已有项目文件） | `_project_common.md` + `adopt_project.md` |
| **旧对话标准化**（只有对话记录） | `_project_common.md` + `standardize_legacy.md` + `agents_template.md` + `project_files_template.md` |
| **沉淀已知经验为技能** | `new_skill.md` + `skill_template.md` |
| **任务/项目归档 → 蒸馏**（**必做**） | `distill.md` |
| **改规则 / 清理规则** | `governance.md` + `observations.md` + `proposals.md` |
| **接入新 AI 工具** | `new_tool.md` + `tools/_common.md` |
| **查某个工具的限制** | `tools/_common.md` + `tools/<工具名>.md` |

**项目 `AGENTS.md`「必须先读」中列出的技能文件**，无论哪种任务都要读——那是项目主动声明的依赖。

**三个入口怎么选**：什么都没有 → `new_project.md`；有项目文件 → `adopt_project.md`；只有对话记录 → `standardize_legacy.md`（完成后再走 `adopt_project.md`）。

---

## 协议怎么读（`collaboration.md` 按节取用）

| 章节 | 类型 | 什么时候读 |
|---|---|---|
| §术语 | 查阅 | 遇到"副作用操作""不可逆操作""一次失败"拿不准时 |
| §裁决优先级 | 查阅 | 发现两份文件说法冲突时 |
| §阶段定义与阶段门 | **执行型** | 每次任务开始 |
| §任务规模与干预档 | 半执行型 | 定档时；档位已在任务卡写明则可跳过 |
| §自评报告格式 | **执行型** | 每次输出报告前 |
| §验收原则 | **执行型** | 进入验收阶段前 |
| §未知处理 | **执行型** | 每次任务开始（红线） |
| §人机接口 | 查阅 | 需要找人时 |
| §知识库规则 | 查阅 | 任务结束写知识库时 |
| §share 目录的写权限 | 查阅 | 涉及写 share 时 |
| §红线速查 | 索引 | 已并入本文件「红线」节，不必单独读 |

**S 档最小读取集** = 四个执行型章节。

---

## 文件地图（按层）

| 层 | 文件 | 何时碰 |
|---|---|---|
| L0/L1 | `collaboration.md` | 按上表分节取用 |
| L0/L2 | `governance.md` | 只在改规则时 |
| L2 公共 | `_project_common.md` | 三个项目入口流程共用，与流程文件配套读 |
| L2 流程 | `new_project.md`、`adopt_project.md`、`standardize_legacy.md`、`new_skill.md`、`new_tool.md`、`distill.md` | 对应流程触发时 |
| L3 模板 | `agents_template.md`、`project_files_template.md`、`task_card_template.md`、`progress_template.md`、`skill_template.md` | 建对应文件时读一次 |
| L4 | `skills/*.md` | 项目 `AGENTS.md` 声明引用的才读 |
| L5 | `tools/_common.md` + `tools/<工具名>.md` | 只读当前所用工具那一个 |
| 台账 | `observations.md`、`proposals.md`、`CHANGELOG.md` | 改规则时；日常不读 |
| 归档 | `*_archive.md`、`CHANGELOG_ARCHIVE.md` | 追溯历史时才读 |
| 索引 | `README.md` | **给人看的**，AI 日常不读，读本文件即可 |

---

## 模板对照（要建什么文件 → 用哪个模板）

| 要创建 | 模板 |
|---|---|
| `AGENTS.md` | `agents_template.md`（骨架版 / 成熟版两形态） |
| `knowledge_base.md`、`pending_question.md`、`pending_archive.md` | `project_files_template.md` |
| `tasks/<任务名>.md` | `task_card_template.md` |
| `progress.md` | `progress_template.md` |
| `skills/<技能名>.md` | `skill_template.md` |
