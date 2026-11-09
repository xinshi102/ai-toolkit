"""Audited-version gate shared by the native adapters.

User decision for v1.1 M2: a version that differs from the audited one is
accepted when every capability the profile needs is still present in
``--help``; the preflight and the receipt then record
``版本 X 未审核，参数校验通过``.  A missing flag is still a hard refusal and the
missing flags are named.  ``*_AUDITED_VERSION`` environment variables override
the built-in audited value for a deliberate re-audit.
"""
from __future__ import annotations

import os

NOTE_TEMPLATE = '\u7248\u672c %s \u672a\u5ba1\u6838\uff0c\u53c2\u6570\u6821\u9a8c\u901a\u8fc7'


def audited_version(env_name, default):
    """Audited value, optionally overridden by ``*_AUDITED_VERSION``."""
    value = os.environ.get(env_name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def version_gate(version, audited, help_text, required, label):
    """Return audited/unreviewed evidence or raise for missing capabilities.

    The capability check comes first: an unreviewed version is only acceptable
    while the command line the profile depends on is still offered.
    """
    missing = [flag for flag in required if flag not in help_text]
    if missing:
        raise ValueError('%s lacks required profile flags: %s'
                         % (label, ', '.join(missing)))
    evidence = {'version': version, 'audited_version': audited,
                'version_audited': version == audited,
                'version_unreviewed': version != audited}
    if version != audited:
        evidence['version_note'] = NOTE_TEMPLATE % version
    return evidence
