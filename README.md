# AI Toolkit

A collection of reusable AI extensions maintained by Xinshi, including Codex and other harness skills, plugins, and MCP servers.

## Contents

- [`skills/knowledge-vault`](skills/knowledge-vault/SKILL.md): collect, classify, and retrieve work problems in an existing Obsidian vault or a temporary Markdown vault. Version **1.0.1**. Natural requests choose vault-first lookup for internal issues and normal diagnosis for generic tool faults. Cross-AI/device setup: [installation guide](skills/knowledge-vault/references/install.md).
- [`skills/xinshiimprove`](skills/xinshiimprove): cross-harness collaboration workflows and project guidance. Current version: **1.12**.
- [`plan-map`](plan-map): a persistent visual plan tree shown to the user. Two harness builds of the same plan semantics: [`plan-map/dsh`](plan-map/dsh) is the DeepSeek Harness plugin (`plan_import`, `plan_node`, right-sidebar tab), and [`plan-map/codex`](plan-map/codex) is the Codex skill plus its MCP server (`plan_list`, `plan_import`, `plan_node`, `plan_view`, web panel).

Each component lives in its own directory and keeps its own version and documentation. See the component's README or `SKILL.md` for installation and usage.

## Updating installed copies

The current machine's known `xinshiimprove` installations and any AI habit files are listed in [`sync/targets.json`](sync/targets.json). Run `scripts/sync-xinshiimprove.sh --check` to compare them with this repository. Run `scripts/sync-xinshiimprove.sh --apply` to back up and update the registered targets. The apply command is local-only: commit and push this repository separately when you want to publish a release.

When a new release changes shared rules, update the canonical skill under `skills/xinshiimprove/`, then update each tool-specific entry point and habit listed in `sync/targets.json`. Preserve tool-specific wording and behavior. Review the check output before applying, and include the version and affected targets in the release notes.

## Personal repository and forks

This repository is Xinshi's personal upstream. Its `origin` points to `https://github.com/xinshi102/ai-toolkit`; only the owner should push to that repository. If you install or adapt these files for your own use, do not push changes to the owner's repository. Fork it to your own GitHub account, or clone it and change `origin` to a repository you own before pushing. Contributions should be submitted as pull requests from your fork.

## Contributing

This repository is maintained as a personal collection. Changes are organized by component; shared conventions will be documented here as the collection grows.
