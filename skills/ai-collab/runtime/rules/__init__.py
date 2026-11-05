"""Data-driven authorization: deterministic gate + immutable mandates.

Public surface:
  * ``gate(spec, rules) -> Decision``  (pure; see engine.py)
  * ``apply(spec, agent) -> dict|None``  (the one admission hook called from
    dispatch_guard.admit; loads rules, runs the gate once, checks the budget
    once, appends a mandate and returns receipt fields)
  * mandate helpers: build/append/read/find/verify, rules_version
"""
from __future__ import annotations

from .engine import (
    gate, Decision, DEFAULT_MODELS, REQUIRES_HUMAN_DEFAULT, PERMISSION_LEVELS,
)
from . import store, mandate as _mandate

rules_version = _mandate.rules_version
build_mandate = _mandate.build_mandate
append_mandate = _mandate.append_mandate
read_mandates = _mandate.read_mandates
find_mandate = _mandate.find_mandate
verify_mandate = _mandate.verify_mandate
load_rules = store.load_rules
example_rules = store.example_rules
data_dir = store.data_dir


def _resolve_continuation(spec: dict, base=None) -> dict:
    """If a prior mandate is referenced for a continuation, load it and inject
    it as ``continuation_mandate`` so the pure gate can re-verify its version.
    """
    mandate_id = str(spec.get("mandate_id") or "")
    if not mandate_id:
        return spec
    found = _mandate.find_mandate(mandate_id, base=base)
    if found is None:
        return dict(spec, continuation_mandate={"mandate_id": "", "rules_version": ""})
    return dict(spec, continuation_mandate=found)


def _refuse(reason: str):
    # Late import avoids a circular import at module load time: dispatch_guard
    # imports this package at the top, and we only need its refusal type here.
    from dispatch_guard import WorkPackageRejected
    raise WorkPackageRejected(reason)


def apply(spec, agent, *, base=None, usage=None):
    """Single admission hook, called once at the end of ``admit()``.

    Returns ``None`` when ``rules.json`` does not exist (behaviour unchanged),
    otherwise a dict of receipt fields to merge into the admit() result.
    Denials raise the existing ``WorkPackageRejected`` type so the error
    format matches today's refusals.
    """
    loaded = store.load_rules(base)
    if loaded is None:
        return None
    raw, parsed, version = loaded
    rule_doc = dict(parsed)
    rule_doc["rules_version"] = version

    decision = gate(_resolve_continuation(spec, base=base), rule_doc)
    if not decision.allow:
        _refuse(decision.reason)

    receipt = {}
    # One budget check before dispatch (controllers only when declared).
    from budget2 import check_dispatch  # late import: keeps package import cheap
    budget_result = check_dispatch(spec, rule_doc, base=base, usage=usage)
    if budget_result.get("status") == "stop":
        _refuse("预算用完，需要用户放行：%s"
                % (budget_result.get("reason") or "controller budget exhausted"))
    if budget_result.get("status") == "warn":
        receipt["budget_warning"] = budget_result.get("reason") or "controller budget at 80%"

    new_mandate = _mandate.build_mandate(decision, version)
    _mandate.append_mandate(new_mandate, base=base)
    receipt["mandate_id"] = new_mandate["mandate_id"]
    receipt["rules_version"] = version
    receipt["rule_name"] = decision.rule_name
    return receipt
