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
