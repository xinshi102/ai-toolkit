"""Deterministic authorization gate.

`gate(spec, rules)` is a pure function: it reads no clock, calls no model and
performs no I/O.  It decides allow/deny using only the work-package spec and
the loaded rules document.  A rules document that does not match any rule is
handled conservatively: read-only is allowed, anything stronger is refused.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass

DEFAULT_MODELS = ("deepseek-v4.1-flash", "deepseek-v4.1-flash")
REQUIRES_HUMAN_DEFAULT = ("deploy", "prod_write", "delete", "push", "external_send")

# Permission is an ordered capability ceiling, not a free-form label.
PERMISSION_LEVELS = {
    "read-only": 0,
    "shell-read-only": 0,
    "workspace-write": 1,
    "full-access": 2,
}


@dataclass(frozen=True)
class Decision:
    allow: bool
    reason: str
    rule_name: str = ""
    matched: bool = False
    allowed_models: tuple = ()
    allowed_permission: str = "read-only"
    allowed_paths: tuple = ()
    requires_human: tuple = ()
    mode: str = "deny"  # 'allow' | 'deny' | 'default-readonly'

    def as_dict(self) -> dict:
        return {
            "allow": self.allow,
            "reason": self.reason,
            "rule_name": self.rule_name,
            "matched": self.matched,
            "allowed_models": list(self.allowed_models),
            "allowed_permission": self.allowed_permission,
            "allowed_paths": list(self.allowed_paths),
            "requires_human": list(self.requires_human),
            "mode": self.mode,
        }


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def _norm(value) -> str:
    return str(value or "").replace("\\", "/").rstrip("/").lower()


def _deny(reason: str) -> Decision:
    return Decision(allow=False, reason=reason, mode="deny")


def _match_rule(rule: dict, spec: dict) -> bool:
    match = rule.get("match")
    if not isinstance(match, dict):
        match = {}
    patterns = _as_list(match.get("task_id"))
    if patterns:
        task_id = str(spec.get("task_id") or "")
        if not any(fnmatch.fnmatchcase(task_id, str(p)) for p in patterns):
            return False
    prefixes = _as_list(match.get("project_path"))
    if prefixes:
        target = _norm(spec.get("project_path") or spec.get("cwd") or "")
        if not any(target == _norm(p) or target.startswith(_norm(p) + "/")
                   for p in prefixes):
            return False
    tags = _as_list(match.get("tags"))
    if tags:
        spec_tags = {str(t) for t in _as_list(spec.get("tags"))}
        if not spec_tags.intersection(str(t) for t in tags):
            return False
    return True  # empty match is a catch-all rule


def _select_rule(spec: dict, rules: dict):
    items = rules.get("rules")
    if not isinstance(items, list):
        return None
    for rule in items:
        if isinstance(rule, dict) and _match_rule(rule, spec):
            return rule  # first matching rule wins (deterministic order)
    return None


def _default_decision(spec: dict) -> Decision:
    """Conservative fallback when nothing matches: read-only only."""
    eff_perm = str(spec.get("permission") or "read-only")
    writes = _as_list(spec.get("write_paths"))
    actions = {str(a) for a in _as_list(spec.get("actions"))}
    gated = actions.intersection(REQUIRES_HUMAN_DEFAULT)
    elevated = eff_perm in PERMISSION_LEVELS and PERMISSION_LEVELS[eff_perm] > 0
    if writes or gated or elevated or eff_perm not in PERMISSION_LEVELS:
        return _deny("no rule matched; conservative default denies writes, "
                     "elevated permission and human-gated actions")
    return Decision(
        allow=True,
        reason="no rule matched; conservative read-only default",
        rule_name="", matched=False,
        allowed_models=tuple(DEFAULT_MODELS),
        allowed_permission="read-only",
        allowed_paths=(),
        requires_human=tuple(REQUIRES_HUMAN_DEFAULT),
        mode="default-readonly",
    )


def gate(spec, rules) -> Decision:
    """Pure allow/deny decision for one work package.

    `rules` is the parsed rules document.  The loader attaches the file's
    ``rules_version`` (sha256 hex) to a copy before calling this function.
    A ``spec['continuation_mandate']`` reuses a prior authorization and is
    re-verified here against the current rules_version.
    """
    if not isinstance(spec, dict):
        return _deny("spec must be an object")
    if not isinstance(rules, dict):
        return _deny("rules must be an object")

    current_version = str(rules.get("rules_version") or "")
    continuation = spec.get("continuation_mandate")
    if isinstance(continuation, dict):
        old_version = str(continuation.get("rules_version") or "")
        if (not current_version or not old_version
                or old_version != current_version):
            return _deny("rules version changed; re-authorization required for continuation")
        if not str(continuation.get("mandate_id") or ""):
            return _deny("continuation mandate is missing mandate_id")

    rule = _select_rule(spec, rules)
    if rule is None:
        return _default_decision(spec)

    name = str(rule.get("name") or "")
    executor = rule.get("executor") if isinstance(rule.get("executor"), dict) else {}
    allowed_models = tuple(_as_list(executor.get("models"))) or DEFAULT_MODELS
    ceiling = str(rule.get("permission") or "read-only")
    allowed_paths = tuple(_norm(p) for p in _as_list(rule.get("write_paths")))
    requires_human = tuple(_as_list(rule.get("requires_human"))) or REQUIRES_HUMAN_DEFAULT

    model = str(spec.get("model") or "")
    if model and model not in allowed_models:
        return _deny(f"model {model!r} is not in the allowed models for rule {name!r}")

    exec_spec = str(spec.get("executor") or "")
    exec_rule = str(executor.get("adapter") or "")
    if exec_rule and exec_spec and _norm(exec_spec) != _norm(exec_rule):
        return _deny(f"executor adapter {exec_spec!r} is not allowed by rule {name!r}")

    eff_perm = str(spec.get("permission") or "read-only")
    if eff_perm not in PERMISSION_LEVELS:
        return _deny(f"unknown permission {eff_perm!r}")
    if PERMISSION_LEVELS[eff_perm] > PERMISSION_LEVELS.get(ceiling, 0):
        return _deny(f"permission {eff_perm!r} exceeds rule {name!r} ceiling {ceiling!r}")

    for raw_path in _as_list(spec.get("write_paths")):
        path = _norm(raw_path)
        if not allowed_paths or not any(
                path == ap or path.startswith(ap + "/") for ap in allowed_paths):
            return _deny(f"write path {raw_path!r} is outside the allowlist of rule {name!r}")

    actions = {str(a) for a in _as_list(spec.get("actions"))}
    needed = [a for a in requires_human if a in actions]
    if needed and not spec.get("human_approved"):
        return _deny(f"action(s) {needed} require human approval before dispatch")

    return Decision(
        allow=True, reason="allowed", rule_name=name, matched=True,
        allowed_models=allowed_models, allowed_permission=ceiling,
        allowed_paths=allowed_paths, requires_human=requires_human, mode="allow",
    )
