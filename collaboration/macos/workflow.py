"""macOS entry point over the shared upstream workflow implementation."""
import runpy
import sys
from pathlib import Path

if sys.platform != "darwin":
    raise SystemExit("This entry point requires macOS")
runtime = Path(__file__).resolve().parents[1] / "windows/runtime"
sys.path.insert(0, str(runtime))
runpy.run_path(str(runtime / "workflow.py"), run_name="__main__")
