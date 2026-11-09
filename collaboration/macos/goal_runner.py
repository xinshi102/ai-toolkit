"""One-file goal runner: `python3 goal_runner.py run goal.json`.

The goal file carries the objective, acceptance text, executable checks and
budget. The runner selects the executor (OpenCode by default), runs the
goal loop, writes a decision package when the loop is blocked, and prints a
three-line progress summary.
"""
from __future__ import annotations

import argparse
import json
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
        "证据：goal.json / events.jsonl（同目录）",
        "",
    ]
    lines += [str(option) for option in options]
    lines += ["", "建议：按当前预算与风险选择；回复 A 或 B 即可。"]
    return "\n".join(lines) + "\n"


def run_goal_file(goal_path, *, home, executor_kind="opencode"):
    goal = json.loads(Path(goal_path).read_text(encoding="utf-8"))
    goal = goal_loop.validate_goal(goal)
    if not goal.get("checks"):
        raise goal_loop.GoalError("goal requires at least one executable check")
    executor = executor_for(goal)
    state = goal_loop.run_goal(goal, executor=executor, judge=command_judge(goal), home=home)
    run_dir = Path(home) / "goals" / state["runId"]
    if state.get("wake"):
        state["decisionPath"] = str(run_dir / "decision.md")
        (run_dir / "decision.md").write_text(decision_markdown(state), encoding="utf-8")
    return state


def show(run_id, home):
    return json.loads((Path(home) / "goals" / run_id / "goal.json").read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description="xinshi goal runner")
    sub = parser.add_subparsers(dest="action", required=True)
    default_home = Path.home() / ".local/share/xinshi-goals"
    run = sub.add_parser("run")
    run.add_argument("goal", type=Path)
    run.add_argument("--home", type=Path, default=default_home)
    run.add_argument("--executor", default="opencode")
    show_parser = sub.add_parser("show")
    show_parser.add_argument("run_id")
    show_parser.add_argument("--home", type=Path, default=default_home)
    args = parser.parse_args()
    if args.action == "run":
        state = run_goal_file(args.goal, home=args.home, executor_kind=args.executor)
        print(f"goal={state['goalId']} status={state['status']} attempts={len(state['attempts'])} wake={(state['wake'] or {}).get('reason')}")
        print(f"run={args.home / 'goals' / state['runId']}")
        if state.get("decisionPath"):
            print(f"decision={state['decisionPath']}")
    else:
        state = show(args.run_id, args.home)
        print(json.dumps({key: state[key] for key in ("runId", "goalId", "status", "attempts", "wake")},
                         ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
