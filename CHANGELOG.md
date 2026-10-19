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
