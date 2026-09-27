# Local synchronization

`targets.json` records machine-specific installed copies discovered for this account. Paths are local configuration and should be changed on each machine. AI habits belong in the `habits` array as explicit file paths with a format (`copy` or `append`); no habits file was found during initial setup.

The sync script compares the canonical skill with registered targets. For `full-copy`, it replaces the target after creating a timestamped backup. For `shared-rules`, it updates only the `share/` directory and preserves the tool's own `SKILL.md`. For habit targets, it backs up the file and copies the canonical skill to the configured target only when `format` is `copy`. `append` targets are reported for manual review and are never edited automatically.

Use `--check` before `--apply`. Neither mode pushes changes to GitHub.
