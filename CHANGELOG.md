## 2026-10-27 — xinshi 3.1.4 + 协作看板（静）

- `skills/xinshi` 升到 3.1.4：正文精简；执行者默认用便宜模型；秘书模式（里程碑自验通过后直接继续，只在需要用户决定时停）；新增 `references/pitfalls.md`，按场景整理踩过的坑，包括部署、自动停止机制、宿主/技能升级、界面类任务、Windows 写文件、跨渠道成本。
- 新增 `collaboration/windows/dashboard/`：本地只读协作看板。布局按“有没有事找我 → 任务进度 → AI 用量”排序；视觉以灰阶为主，只用一种强调色；深色/浅色可切换；「正在进行」按任务归组；点开有详情抽屉。设计依据是 Calm Technology、Linear、Vercel Geist、Grafana 等资料的调研结论。
- 公开版中，私有执行渠道和宿主用 `ExecA` / `ExecB` / `HostC` 占位，本机数据配置只提供空模板；工作区根目录通过 `XINSHI_WORKSPACE` 指定。

## 2026-10-21 — 本地 token 计量（Codex/GPT）

- 新增 `runtime/token_meter.py`：读取 `~/.codex/sessions/**/rollout-*.jsonl` 的 `token_count`，输出每次调用、近 5 小时 / 今日 / 7 天、按会话与按小时的 input / cached / uncached / output / reasoning，以及日志里的 5h/周额度百分比。
- 新增 `TOKEN_METER.md`：字段含义、缓存口径、与百分比的关系、边界（不读账号、不换算金额）。
- 看板新增 `/api/usage` 与标题栏一行 token 计量；CLI 提供 `--json` / `--watch`。
- 4 个离线单测覆盖解析、去重、total 差值回退与格式化。

## 2026-10-20 — 事件门禁与预算熔断（token 控制）

- 新增 `runtime/events.py`：SQLite 本地事件总线，追加式、零模型；事件消费与 `wait` 订阅。
- 新增 `runtime/state.py`：任务权威状态文件与 <=4 KiB 快照裁剪；Plan 外置、带 `plan_hash`。
- 新增 `runtime/gate.py`：确定性规则过滤（忽略/告警/命中）+ 冷却 + Gate 1/2/升级；每次只调用一次控制器，记录 verdict。
- 新增 `runtime/budget.py`：按任务限制 token/时长/轮询次数，超限标 `blocked` 并发一次 `budget_exceeded`。
- 新增 `COLLAB_EVENTS.md` 与 `WORKFLOWS.md` 集成说明；11 个离线单测覆盖事件、预算、门禁与快照。
- 只加旁路模块，不改 `task_runner.py` / `workflow.py` 执行语义；发布版不包含作者本机路径和真实日志。

## 2026-10-19 — xinshi 3.0.0-trial.3 + 协作运行器 Windows 版

- 技能引用改为仓库位置和用户本机配置，不携带作者工作区布局；协作和授权规则沿用 trial.2。
- 发布 `collaboration/windows/`：持久队列、依赖图、资源互斥、验收、部分修订、取消和恢复；Codex / DSH / CodeBuddy 适配器与 Windows owned process tree。
- 包含 CodeBuddy 恢复会话的 SkillManage 显式禁用修复，保持工具白名单与严格校验不变。
- 本机安装路径改为明确配置；公司网络、账号、SSH配置、真实项目资料、日志和会话回执均不打包；公开测试数据全为合成数据。
- 明确 Windows 支持范围；Linux/macOS、企业接口、IDE既有聊天继承与桌面退出持续运行不据此宣称验收通过。

## 2026-10-19 — xinshi 3.0.0-trial.2（按用户反馈）

- 自进化/沉淀频率：每 5 个完成任务汇总一次（原 10 个任务或每月）。
- 跨项目知识沉淀落到 `E:\AI-Workspace\Knowledge`（projects / experience / patterns / inbox），个人笔记仍走 Obsidian 与 knowledge-vault。
- 跨模型默认走 Codex CLI；已实测 `codex exec` 会话内技能列表包含 `xinshi`。
- 交接路径写成完整绝对路径：`Agent-Conventions/.work/handoff/STATE.md` + `inbox/`。
- 新增 `scripts/install-xinshi.sh` / `install-xinshi.ps1`（5 行指针，不覆盖非指针目录）；Windows 临时目录试装通过。
- 新增 `skills/xinshi/README.md`：安装（全量副本/指针）、路径适配、安装后确认与更新步骤；根 README 改为链接该说明。

## 2026-10-19 — xinshi 3.0.0-trial.1（改名 + 重构）

- `xinshiimprove` 更名为 `xinshi`（信使）：正本目录、宿主入口指针、用户规则入口一并改名，旧名不再加载。
- 正文压到约 50 行：任务判断（单对话 / 原生子 agent / 跨 harness / 运行器）、升级条件、监督者、验证、持续推进、学习。
- 删除 `codex-runtime.md`、`windows-runtime.md`、`task-handoff.md`：有效内容并入 `references/coordination.md`，宿主差异按当前机器写。
- 新增 `references/learning.md`（事件触发的自进化与沉淀）与 `references/runtime.md`（何时用 `runtime/workflow.py`）。
- 合并 2.0.0-trial.4 的有效内容：环境判断三行模板、委派决策一行、验收证据表。
- 运行器与仓库名不改；历史证据、备份和旧运行状态保留原路径。

## 2026-10-18 — xinshiimprove 2.0.0-trial.4 execution loop

- 委派检查点（硬性）：非简单任务必须在计划/任务卡写「委派决策：派 N 个（谁、为什么）/ 不派（理由）」，收尾自检回答；防止主控独自做完。
- 环境判断三行模板：任务类型 / 资源与缺口 / 组织方式。
- 新增「验收证据」节：项目 / 结果 / 证据表格；子 agent 自报完成不算验收。
- 交接文件：工作区已建 `.work/handoff/STATE.md` 与 `inbox/`。trial.4 提到的 `docs/templates/handoff-*.md`、`scripts/check-handoff.mjs` 在仓库和本机均不存在，3.0.0 只引用实际存在的路径。

## 2026-10-16 — xinshiimprove 2.0.0-trial.3 unified entry

- Replace the v1.13 `share/` rules library (ROUTER/collaboration phase gates) with the 2.0.0 unified entry; the skill is now `SKILL.md` + `references/`, and `share/` is retired (still available in git history).
- The entry requires an environment judgment before non-trivial work, master-controlled task tracking, tiered same-harness/cross-harness collaboration, and a shared `.work/handoff/STATE.md` for cross-harness handoff.
- Runtime adoption was verified in DSH only; other harnesses, real cross-harness handoff and persistent scheduling remain unproven.

## 2026-10-15 — Plan Map 0.6.0 (Codex) + DSH ptc-dispatch fix

- Codex 0.6.0: v8 MCP App resource (v3–v7 compatible), `plan_batch`/`plan_history`/`plan_dashboard`, isolated planning/maintenance tests, embedded-resource compile fix, and the PostToolUse maintenance hook bridging native `update_plan`.
- DSH 0.1.1: plan tools dispatched through `tool/ptc-dispatch` now fold into the plan tree like `tool/call`.
- Local verification: Codex 23/23 and DSH 56/56 isolated tests. Host reconnection, the real chat embedded view and real `update_plan` events are not proven by these tests alone.

## 2026-10-13 — Plan Map 0.5.0 interaction parity

- Add free positioning/reset, drag reparenting, canvas pan, inline rename and ancestor-path highlighting.
- Match rounded orthogonal connectors, status glyphs, root/card/note/CSS states; retain readable fit and collapse badges.
- v7 UI, legacy v3-v6 compatible; 18/18 isolated tests and real 425px/360px page checks.
- User-host MCP reconnection remains separate and unverified; local view offsets do not change plan storage.

## 2026-10-13 — Plan Map 0.4.0 readable fit

- Width-only fit at 0.7–1, SVG viewBox scaling, 0.7–2 manual zoom, deep-branch automatic collapse and scrolling within 280px.
- v6 MCP App resource with v3/v4/v5 compatibility.
- Restore embedded direction/manual folding preferences and preserve scrolling on status-only updates.
- 11 isolated acceptance tests pass; original 425px/360px screenshots reviewed.

## 2026-10-12 — Personal Skill / plugin / MCP collection

- Publish the reviewed personal DSH plugin ecosystem and collaboration bridge, with tests and upstream notices.
- Publish Codex/ChatGPT-local skills and Plan Map 0.3.2 MCP/App source, including compact embedded viewport changes.
- Preserve experimental Master Plan separately; add the capability catalog, MCP bridge and Workspace controller source.
- Exclude credentials, private runtime state, chats, screenshots and installed vendor binaries.

# Changelog

## 2026-10-10 — sync tooling: multi-component manifest

- `sync/targets.json` now groups entries by component (`xinshiimprove`, `knowledge-vault`) instead of describing a single skill.
- Added `scripts/sync-skills.sh` (`--check`/`--apply`, optional `--component NAME`); `scripts/sync-xinshiimprove.sh` is now a wrapper for the `xinshiimprove` component.
- Registered the `knowledge-vault` 1.0.1 installs for the Codex, DeepSeek Harness, OpenCode, and Hermes skill roots.

## 2026-10-10 - knowledge-vault 1.0.1

- Accept natural requests without requiring the user to name a skill.
- Internal issues usually consult the vault first; generic tool faults follow normal diagnosis with optional vault references.
- Explicit vault searches take priority; mixed internal/tool cases are handled by layer.


## 2026-10-10 — knowledge-vault 1.0.0

- Added a portable work-problem knowledge skill, evidence-aware case template, vault locator and protected installer.
- Reuses existing vault schemas; supports a temporary Markdown vault and Obsidian installation reminder.
- Device-local vault configuration and private notes are excluded from the skill package.
- Publication makes the package available to all devices; runtime loading and note synchronization require separate verification.

## 2026-09-28

- Added `skills/xinshiimprove` version 1.12 as the initial repository release.
