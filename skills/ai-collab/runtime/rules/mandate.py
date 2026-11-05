"""Immutable authorization records (Mandates), stored append-only.

A mandate is a JSON object appended as a single line to ``mandates.jsonl``.
Records are never edited or removed: that is the meaning of "immutable" here,
and the reason the file is append-only.  ``rules_version`` binds each mandate
to the exact rules file content that produced it, so a changed rules file
invalidates old authorizations used for continuations.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import store


def rules_version(raw_bytes: bytes) -> str:
    import hashlib
    return hashlib.sha256(raw_bytes).hexdigest()


def build_mandate(decision, version: str, *, now=None) -> dict:
    stamp = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "mandate_id": uuid.uuid4().hex,
        "rules_version": version,
        "rule_name": decision.rule_name,
        "allowed_models": list(decision.allowed_models),
        "allowed_permission": decision.allowed_permission,
        "allowed_paths": list(decision.allowed_paths),
        "time": stamp,
    }


def append_mandate(mandate: dict, base=None) -> Path:
    """Append one mandate line; never rewrites existing content."""
    path = store.mandates_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(mandate, ensure_ascii=False, sort_keys=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    return path


def read_mandates(base=None) -> list:
    path = store.mandates_path(base)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def find_mandate(mandate_id: str, base=None):
    for item in read_mandates(base):
        if item.get("mandate_id") == mandate_id:
            return item
    return None


def verify_mandate(mandate, current_version: str) -> bool:
    """Old authorization reused for a continuation is valid only while the
    rules file content (hence its rules_version) is unchanged."""
    if not isinstance(mandate, dict):
        return False
    return (bool(mandate.get("rules_version"))
            and mandate.get("rules_version") == current_version)
