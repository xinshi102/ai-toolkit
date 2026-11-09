"""Explicit installation layout; no credential or host configuration access."""
import sys
from pathlib import Path


def dsh_layout(program, platform=None):
    root = Path(program)
    if not root.is_absolute():
        raise ValueError("DSH installation path must be absolute")
    platform = sys.platform if platform is None else platform
    if platform == "darwin":
        binary = root / "Contents/MacOS/DeepSeek Harness"
        archive = root / "Contents/Resources/app.asar"
    elif platform == "win32":
        binary = root / "DeepSeek Harness.exe"
        archive = root / "resources/app.asar"
    else:
        raise ValueError("DSH installation layout is supported only on Windows and macOS")
    return binary, archive, archive / "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
