"""Deterministic engine-test adapter. This is never a harness acceptance test."""
import json
import sys
import time
from pathlib import Path

if len(sys.argv) > 1 and sys.argv[1] == "--ignore-stdin":
    time.sleep(float(sys.argv[2]))
    print(json.dumps({"type": "local_test.completed", "adapter": "deterministic-nonreader"}), flush=True)
    sys.exit(0)

request = json.load(sys.stdin)
time.sleep(request.get("delay", 0))
for artifact in request.get("artifacts", []):
    path = Path(artifact["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(artifact.get("content", "test artifact"), encoding="utf-8")
print(json.dumps({"type": "local_test.completed", "adapter": "deterministic-local"}), flush=True)
sys.exit(request.get("exit_code", 0))
