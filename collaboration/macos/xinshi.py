"""xinshi one-sentence entry: plan -> confirm -> run -> report.

    python3 xinshi.py plan "写一个 hello.json，包含 ok=true"
    python3 xinshi.py run goal.json --home /tmp/xinshi-goals
    python3 xinshi.py status <runId>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import goal_batch
import goal_draft
import goal_runner

DEFAULT_HOME = Path.home() / "Library/Application Support/xinshi-collaboration"


def cmd_plan(args):
    goal = goal_draft.draft(args.request)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
    checks = len(goal.get("checks") or [])
    print(f"目标：{goal['objective']}")
    print(f"验收：{'；'.join(goal['acceptance'])[:160]}")
    print(f"预算：{goal['budget']['attempts']} 次 / {goal['budget']['maxSeconds']} 秒 · {checks} 条检查")
    print(f"已写 {args.out}；确认后运行：python3 xinshi.py run {args.out} --home {args.home}")
    return 0 if checks else 2


def cmd_run(args):
    state = goal_runner.run_goal_file(args.goal, home=args.home, notify=not getattr(args, 'no_notify', False))
    print(goal_runner.summary_line(state))
    print(f"report={state['reportPath']}")
    if state.get("decisionPath"):
        print(f"decision={state['decisionPath']}")
    return 0 if state["status"] == "done" else 1


def cmd_batch(args):
    report = goal_batch.run_batch(args.plan, home=args.home)
    print(f"batch={report['batchId']} status={report['status']} milestones={report['cost']['milestones']} "
          f"time={report['cost']['wallSeconds']}s tokens={report['cost']['tokens']}")
    print(f"report={report['reportPath']}")
    if report.get('decision'):
        print(f"decision={report['decision'].get('question') or report['decision'].get('reason')}")
    return 0 if report["status"] == "done" else 1


def cmd_status(args):
    state = goal_runner.load_state(args.run_id, args.home)
    print(goal_runner.summary_line(state))
    print(f"report={args.home / 'goals' / args.run_id / 'report.md'}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="xinshi: one entry for goal-driven collaboration")
    sub = parser.add_subparsers(dest="action", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("request")
    plan.add_argument("--out", default="goal.json")
    plan.add_argument("--home", type=Path, default=DEFAULT_HOME)
    run = sub.add_parser("run")
    run.add_argument("goal", type=Path)
    run.add_argument("--home", type=Path, default=DEFAULT_HOME)
    run.add_argument("--no-notify", action="store_true")
    batch = sub.add_parser("batch")
    batch.add_argument("plan", type=Path)
    batch.add_argument("--home", type=Path, default=DEFAULT_HOME)
    status = sub.add_parser("status")
    status.add_argument("run_id")
    status.add_argument("--home", type=Path, default=DEFAULT_HOME)
    args = parser.parse_args()
    return {"plan": cmd_plan, "run": cmd_run, "batch": cmd_batch, "status": cmd_status}[args.action](args)


if __name__ == "__main__":
    raise SystemExit(main())
