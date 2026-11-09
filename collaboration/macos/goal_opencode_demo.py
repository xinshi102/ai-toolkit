"""Live simulation: OpenCode free model behind the v4 goal loop.

Run from collaboration/macos:

    python3 goal_opencode_demo.py --home /tmp/xinshi-goal-opencode

The judge is independent and code-based: it reads the brief nonce and the
artifact, then returns pass / reject-with-defects. Attempt 1 deliberately
lacks a key the acceptance requires; the defect is fed into attempt 2.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import goal_loop
from goal_executor_opencode import executor_for


def judge(context):
    workspace = Path(context["workspace"])
    result = context["result"]
    if result.get("error"):
        return {"verdict": "reject", "defects": ["executor error: " + result["error"]]}
    artifact = result.get("artifact")
    if not artifact or not Path(artifact).is_file():
        return {"verdict": "reject", "defects": ["artifact goal-design.json is missing"]}
    try:
        data = json.loads(Path(artifact).read_text(encoding="utf-8"))
    except ValueError:
        return {"verdict": "reject", "defects": ["artifact is not valid JSON"]}
    brief = json.loads((workspace / "goal-brief.json").read_text(encoding="utf-8"))
    if data.get("nonce") != brief["nonce"]:
        return {"verdict": "reject", "defects": ["nonce does not match the brief"]}
    if data.get("answer") != 42:
        return {"verdict": "reject", "defects": ["answer must be 42"]}
    if data.get("verified") is not True:
        return {"verdict": "reject", "defects": ["verified must be true"]}
    return {"verdict": "pass", "defects": []}


def main():
    parser = argparse.ArgumentParser(description="Live OpenCode goal-loop simulation")
    parser.add_argument("--home", type=Path, default=Path("/tmp/xinshi-goal-opencode"))
    args = parser.parse_args()
    goal = {
        "goalId": "opencode-free-sim",
        "objective": "Write a JSON object with nonce and answer equal to 42.",
        "acceptance": ["nonce matches the brief", "answer == 42", "verified == true"],
        "required_keys": ["nonce", "answer"],
        "robust_keys": ["verified"],
        "retry_note": "Also include verified set to true.",
        "budget": {"attempts": 3, "maxSeconds": 600},
    }
    state = goal_loop.run_goal(goal, executor=executor_for(goal), judge=judge, home=args.home)
    print(json.dumps({
        "runId": state["runId"],
        "status": state["status"],
        "wake": state["wake"],
        "attempts": [
            {"attempt": item["attempt"], "verdict": item.get("verdict"), "artifact": item["artifact"]}
            for item in state["attempts"]
        ],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
