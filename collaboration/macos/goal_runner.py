"""One-file goal runner: `python3 goal_runner.py run goal.json`.

The goal file carries the objective, acceptance text, executable checks and
budget. The runner selects the executor (OpenCode by default), runs the goal
loop, writes report.md / decision.md, and prints a three-line summary with
time and token cost.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import goal_loop
from goal_executor_opencode import executor_for
from goal_judge import command_judge

DECISION_DEFAULTS = {
    "budget_exhausted": ["A. 追加预算继续", "B. 停止并交付现状"],
    "irreversible_action": ["A. 授权执行", "B. 换可逆方案或停止"],
    "business_tradeoff": ["A. 方案 A", "B. 方案 B"],
    "repeated_failure": ["A. 换方案继续", "B. 停止并保留现状"],
    "user_decision": ["A. 同意", "B. 不同意"],
}


def decision_markdown(state):
    wake = state["wake"] or {}
    reason = wake.get("reason") or "user_decision"
    options = wake.get("options") or DECISION_DEFAULTS.get(reason, ["A. 继续", "B. 停止"])
    lines = [
        f"【需要你决定】D-{state['goalId']}-{len(state['attempts'])}-01｜{wake.get('question') or state['objective'][:40]}",
        "",
        f"原因：{reason}",
        f"目标：{state['objective']}",
        f"已尝试：{len(state['attempts'])} 次",
        f"成本：{_cost_line(state)}",
        "证据：goal.json / events.jsonl（同目录）",
        "",
    ]
    lines += [str(option) for option in options]
    lines += ["", "建议：按当前预算与风险选择；回复 A 或 B 即可。"]
    return "\n".join(lines) + "\n"


def _cost_line(state):
    cost = state.get("cost") or {}
    tokens = cost.get("tokens") or {}
    token_text = f"{tokens.get('total')} tok" if tokens else "token 未记录"
    return f"总 {cost.get('wallSeconds', 0)}s（执行 {cost.get('executorSeconds', 0)}s / 判断 {cost.get('judgeSeconds', 0)}s），{token_text}"


def report_markdown(state):
    cost = state.get("cost") or {}
    attempts = state.get("attempts") or []
    last_verdict = attempts[-1].get("verdict") if attempts else None
    artifact = next((item.get("artifact") for item in reversed(attempts) if item.get("artifact")), None)
    return "\n".join([
        f"# 结果：{state['status']}（{state['goalId']}）",
        f"- 目标：{state['objective']}",
        f"- 尝试：{cost.get('attempts', len(attempts))} 次；最后结论：{last_verdict}",
        f"- 成本：{_cost_line(state)}",
        f"- 产物：{artifact or '无'}",
        "- 证据：goal.json、events.jsonl（同目录）",
        "",
    ])


def summary_line(state):
    cost = state.get("cost") or {}
    tokens = (cost.get("tokens") or {}).get("total")
    token_text = f"{tokens}tok" if tokens else "tok=n/a"
    return (f"goal={state['goalId']} status={state['status']} attempts={cost.get('attempts', 0)} "
            f"time={cost.get('wallSeconds', 0)}s {token_text} wake={(state['wake'] or {}).get('reason')}")


def notify_state(state):
    """Deliver a one-line macOS notification for completion or a decision."""
    wake = state.get("wake") or {}
    if state.get("status") == "done":
        title, body = "信使：目标完成", state.get("objective", "")[:90]
    elif wake:
        title = "信使：需要你决定"
        body = (wake.get("question") or state.get("objective", ""))[:120]
    else:
        return
    def esc(value):
        return str(value).replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(["osascript", "-e",
                        'display notification "' + esc(body) + '" with title "' + esc(title) + '"'],
                       check=False, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        pass


def run_goal_file(goal_path, *, home, executor_kind="opencode", notify=True):
    goal = json.loads(Path(goal_path).read_text(encoding="utf-8"))
    goal = goal_loop.validate_goal(goal)
    if not goal.get("checks"):
        raise goal_loop.GoalError("goal requires at least one executable check")
    executor = executor_for(goal)
    state = goal_loop.run_goal(goal, executor=executor, judge=command_judge(goal), home=home)
    run_dir = Path(home) / "goals" / state["runId"]
    state["reportPath"] = str(run_dir / "report.md")
    (run_dir / "report.md").write_text(report_markdown(state), encoding="utf-8")
    if state.get("wake"):
        state["decisionPath"] = str(run_dir / "decision.md")
        (run_dir / "decision.md").write_text(decision_markdown(state), encoding="utf-8")
    if notify:
        notify_state(state)
    return state


def load_state(run_id, home):
    return json.loads((Path(home) / "goals" / run_id / "goal.json").read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description="xinshi goal runner")
    sub = parser.add_subparsers(dest="action", required=True)
    default_home = Path.home() / "Library/Application Support/xinshi-collaboration"
    run = sub.add_parser("run")
    run.add_argument("goal", type=Path)
    run.add_argument("--home", type=Path, default=default_home)
    run.add_argument("--no-notify", action="store_true")
    show_parser = sub.add_parser("show")
    show_parser.add_argument("run_id")
    show_parser.add_argument("--home", type=Path, default=default_home)
    args = parser.parse_args()
    if args.action == "run":
        state = run_goal_file(args.goal, home=args.home, notify=not args.no_notify)
        print(summary_line(state))
        print(f"report={state['reportPath']}")
        if state.get("decisionPath"):
            print(f"decision={state['decisionPath']}")
    else:
        state = load_state(args.run_id, args.home)
        print(summary_line(state))
        print(f"report={Path(args.home) / 'goals' / args.run_id / 'report.md'}")


if __name__ == "__main__":
    main()
