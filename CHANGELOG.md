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
