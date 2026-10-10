# Local synchronization

`targets.json` lists every skill component this repository ships together with the machine-specific installed copies discovered for this account. Each component carries its own `component`, `canonical` (path inside this repository), `targets`, and `habits`. Paths are local configuration and should be changed on each machine. AI habits belong in a component's `habits` array as explicit file paths with a format (`copy` or `append`).

Run `scripts/sync-skills.sh --check` to compare every registered component with this repository, then `scripts/sync-skills.sh --apply` to back up and update them. `--component NAME` limits a run to one component. `scripts/sync-xinshiimprove.sh` remains as the backward-compatible wrapper for `--component xinshiimprove`.

For `full-copy`, the target is replaced after a timestamped backup under `.sync-backups/`. For `shared-rules`, only `share/` is updated and the tool's own `SKILL.md` is preserved. For habit targets, the file is backed up and replaced only when `format` is `copy`; `append` targets are reported for manual review and are never edited automatically. A component whose canonical directory is missing is reported and skipped.

Use `--check` before `--apply`. Neither mode pushes changes to GitHub.
