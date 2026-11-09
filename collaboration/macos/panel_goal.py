"""Panel entry: draft a goal from one line, then run it (or resume a goal file).

Spawned by the collaboration bridge when the user clicks 开始/继续 in the panel.
Writes its own log next to the goals directory so the bridge can detach.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

import goal_draft
import goal_runner


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--objective")
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--executor", default="")
    parser.add_argument("--resume", type=Path)
    args = parser.parse_args()
    home = args.home
    (home / "goals").mkdir(parents=True, exist_ok=True)
    log_path = home / "goals" / ("panel-" + str(abs(hash((args.objective, args.resume))))[-10:] + ".log")
    with log_path.open("a", encoding="utf-8") as log:
        try:
            if args.resume is not None:
                goal_path = args.resume
                log.write("resume " + str(goal_path) + "\n")
            else:
                if not args.objective or not args.objective.strip():
                    raise SystemExit("objective is required")
                goal = goal_draft.draft(args.objective.strip())
                if args.executor:
                    goal["executor"] = args.executor
                goal_path = home / "goals" / (".draft-" + goal["goalId"] + ".json")
                goal_path.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
                log.write("drafted " + goal["goalId"] + " checks=" + str(len(goal.get("checks") or [])) + "\n")
                if not goal.get("checks") and not goal.get("subjective"):
                    raise SystemExit("draft produced no executable checks")
            state = goal_runner.run_goal_file(goal_path, home=home)
            log.write(goal_runner.summary_line(state) + "\n")
            log.write("report=" + state.get("reportPath", "") + "\n")
        except SystemExit as error:
            log.write("stopped: " + str(error) + "\n")
        except Exception:
            log.write(traceback.format_exc())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
