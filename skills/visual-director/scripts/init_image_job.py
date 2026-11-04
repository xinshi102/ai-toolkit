#!/usr/bin/env python3
"""Initialize a non-destructive, reproducible image-generation job folder."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


def valid_slug(value: str) -> str:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", value):
        raise argparse.ArgumentTypeError(
            "slug must use lowercase letters, digits, and hyphens (1-63 chars)"
        )
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--slug", required=True, type=valid_slug)
    parser.add_argument(
        "--resume", action="store_true", help="allow an existing job directory"
    )
    args = parser.parse_args()

    job = args.root.expanduser().resolve() / args.slug
    if job.exists() and not args.resume:
        parser.error(f"job already exists: {job}; use --resume to keep it intact")

    for name in ("refs", "candidates", "selected", "context"):
        (job / name).mkdir(parents=True, exist_ok=True)

    assets = Path(__file__).resolve().parent.parent / "assets"
    for source_name, target_name in (
        ("brief-template.md", "brief.md"),
        ("iterations-template.md", "ITERATIONS.md"),
    ):
        target = job / target_name
        if not target.exists():
            shutil.copyfile(assets / source_name, target)

    print(job)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
