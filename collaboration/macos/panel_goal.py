"""Panel entry: draft/run a goal, answer a decision, drain the queue, publish output.

Spawned by the collaboration bridge when the user clicks 开始/继续/作答 in the panel.
Each run takes the shared goal lock; queued requests run after the current one.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import traceback
from pathlib import Path

import goal_draft
import goal_runner


def log(home, message):
    path = Path(home) / "goals" / "panel.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")


def queue_path(home):
    return Path(home) / "goals" / "queue.jsonl"


def pop_queue(home):
    path = queue_path(home)
    try:
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except OSError:
        return None
    if not lines:
        return None
    entry = json.loads(lines[0])
    path.write_text("\n".join(lines[1:]) + ("\n" if len(lines) > 1 else ""), encoding="utf-8")
    return entry


def publish(state, publish_dir):
    if not publish_dir or state.get("status") != "done":
        return None
    target = Path(publish_dir)
    if not target.is_dir():
        return None
    artifacts = [item.get("artifact") for item in (state.get("attempts") or []) if item.get("artifact")]
    if not artifacts:
        return None
    source = Path(artifacts[-1])
    destination = target / (state["goalId"] + "-" + source.name)
    destination.write_bytes(source.read_bytes())
    return str(destination)


def run_once(home, *, objective=None, resume=None, answer=None, publish_dir=None, lock=True):
    home = Path(home)
    if lock:
        with goal_runner.goal_lock(home, blocking=True):
            return run_once(home, objective=objective, resume=resume, answer=answer,
                            publish_dir=publish_dir, lock=False)
    if resume is not None:
        goal_path = Path(resume)
        goal = json.loads(goal_path.read_text(encoding="utf-8"))
        if answer == "B":
            goal["status"] = "closed"
            goal["decisionAnswer"] = "B"
            goal_path.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
            log(home, "closed by answer B: " + goal_path.parent.name)
            return None
        goal["status"] = "answered"
        goal["decisionAnswer"] = "A"
        goal_path.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
        goal["objective"] = goal.get("objective", "") + "\n用户已选择 A（继续）：按原目标继续，必要时调整方案。"
        goal["source"] = "panel"
        goal.pop("status", None)
        goal.pop("attempts", None)
        goal.pop("wake", None)
        goal.pop("cost", None)
        budget = goal.get("budget") or {}
        budget["attempts"] = min(20, int(budget.get("attempts", 3)) + 2)
        budget["maxSeconds"] = min(86_400, int(budget.get("maxSeconds", 900)) + 600)
        goal["budget"] = budget
        goal_path = home / "goals" / (".resume-" + goal["goalId"] + ".json")
        goal_path.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
        log(home, "resume A: " + goal["goalId"])
    else:
        if not objective or not objective.strip():
            raise SystemExit("objective is required")
        goal = goal_draft.draft(objective.strip())
        goal["source"] = "panel"
        goal_path = home / "goals" / (".draft-" + goal["goalId"] + ".json")
        goal_path.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
        log(home, "drafted " + goal["goalId"] + " checks=" + str(len(goal.get("checks") or [])))
        if not goal.get("checks") and not goal.get("subjective"):
            raise SystemExit("draft produced no executable checks")
    log(home, "publish_dir=" + str(publish_dir or ""))
    state = goal_runner.run_goal_file(goal_path, home=home, notify=True, lock=False)
    log(home, goal_runner.summary_line(state))
    if state.get("reportPath"):
        log(home, "report=" + str(state["reportPath"]))
    copied = publish(state, publish_dir)
    if copied:
        log(home, "published=" + copied)
    return state


def drain(home):
    home = Path(home)
    while True:
        with goal_runner.goal_lock(home, blocking=True):
            entry = pop_queue(home)
            if not entry:
                return
            try:
                run_once(home, objective=entry.get("objective"), publish_dir=entry.get("publishDir"), lock=False)
            except Exception:
                log(home, "queue item failed:\n" + traceback.format_exc())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--objective")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--answer", choices=["A", "B"])
    parser.add_argument("--publish-dir")
    parser.add_argument("--drain", action="store_true")
    args = parser.parse_args()
    home = args.home
    (home / "goals").mkdir(parents=True, exist_ok=True)
    try:
        if args.drain:
            drain(home)
            return 0
        run_once(home, objective=args.objective, resume=args.resume, answer=args.answer,
                 publish_dir=args.publish_dir)
        drain(home)
    except Exception:
        log(home, traceback.format_exc())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
