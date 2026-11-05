"""Locations and loading for the rules and mandate files.

Default data directory is ``~/.ai-collab``; ``AI_COLLAB_DATA`` overrides it.
When ``rules.json`` is missing (or unreadable/invalid) ``load_rules`` returns
``None`` so callers keep their legacy behaviour completely unchanged.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

RULES_FILE = "rules.json"
MANDATES_FILE = "mandates.jsonl"
EXAMPLE_FILE = Path(__file__).with_name("rules.example.json")


def data_dir() -> Path:
    override = os.environ.get("AI_COLLAB_DATA")
    return Path(override) if override else (Path.home() / ".ai-collab")


def rules_path(base=None) -> Path:
    return (Path(base) if base else data_dir()) / RULES_FILE


def mandates_path(base=None) -> Path:
    return (Path(base) if base else data_dir()) / MANDATES_FILE


def load_rules(base=None):
    """Return ``(raw_bytes, parsed_dict, version_hex)`` or ``None``.

    ``version_hex`` is the sha256 of the rules file content, so any edit to the
    file changes it.  A missing/blank/invalid file yields ``None``.
    """
    path = rules_path(base)
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if not raw.strip():
        return None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return raw, parsed, hashlib.sha256(raw).hexdigest()


def example_rules() -> dict:
    """The checked-in example rules document (for docs/tests)."""
    return json.loads(EXAMPLE_FILE.read_text(encoding="utf-8"))
