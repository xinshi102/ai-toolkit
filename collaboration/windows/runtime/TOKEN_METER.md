# Local token meter (Codex / GPT)

Codex's UI shows only a percentage. The session log already contains the exact
numbers: every model response writes `last_token_usage` (input, cached input,
output, reasoning) and the rate-limit percentages at that moment. `token_meter.py`
reads those logs locally and turns them into a visible ledger.

It does not read the provider account, does not estimate money, and does not
claim the plan's absolute token limit.

## What it reads

`~/.codex/sessions/**/rollout-*.jsonl`

- `event_msg` / `token_count`: per-response usage and `rate_limits.primary` / `secondary`.
- `session_meta` / `turn_context`: session id, cwd, model.
- Duplicate token events with the same timestamp+total are ignored.
- If `last_token_usage` is missing, the delta of `total_token_usage` is used.
- Parsed sessions are cached in `~/.codex/token_meter_cache.json` keyed by file
  mtime+size, so repeated scans only re-read changed files. Delete the cache or
  pass `--no-cache` to force a full parse.

## CLI

```powershell
python -B runtime/token_meter.py
python -B runtime/token_meter.py --days 2 --recent 15
python -B runtime/token_meter.py --json
python -B runtime/token_meter.py --watch 30
```

Text output:

```
Codex token usage  (2026-10-21T09:35:09+08:00)
Quota: 5h 22.0%  weekly 19.0%  (5h resets 10-21 14:08, weekly resets 10-27 14:33)

period     calls     input    cached  uncached   output  reason
last 5h       50     6.46M     6.02M    442.3k    35.8k    9.9k
today         50     6.46M     6.02M    442.3k    35.8k    9.9k
last 7d     1527   231.42M   224.72M     6.71M   783.6k  261.0k
```

Also includes the newest calls (time, input, cache, output, quota %, cwd),
per-session totals, and hourly totals for the last 24 h.

Fields:

- `input` — total input tokens reported for the response (includes cached).
- `cached` — subset of `input` that hit the prompt cache.
- `uncached` — `input - cached`; the part that is not a cache hit.
- `output` / `reasoning` — output and reasoning tokens.
- `quota` — the last `rate_limits` percentage in the log; not the plan limit.

## Dashboard

The local dashboard (`collab_dashboard.py`) exposes `/api/usage` and prints a
one-line meter in the header:

```
token 5h 55 次 / 7.31M in (6.86M cached) / 38.5k out · 5h 23%
```

It refreshes every 10 s and scans only local logs. The CLI is the full view.

## Interpretation

- 5.96 M input with 5.52 M cached is not the same bill as 5.96 M uncached.
  Watch `uncached` for the expensive share.
- A percentage drop is plan-level; token counts are local. The two are shown
  side by side instead of converting one into the other.
- Different sessions (main chat, `codex exec`, another project) are aggregated;
  use `--json` / per-session output to attribute them.
- Codex only for now. CodeBuddy/WorkBuddy/DSH have different usage schemas and
  can be added as separate readers without changing this one.
- Logs are local runtime data; the meter never uploads them.
