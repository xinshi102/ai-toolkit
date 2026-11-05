"""Three-layer cost budget for controllers.

Layers (all defined in the rules ``budget`` section):
  * per_package  - usage of one work package
  * per_day      - usage of one day
  * per_agent    - total usage of one AI

Only controller AIs are budget-bound.  Executors (cheap models such as
deepseek-v4.1-flash) are recorded but never blocked because
they are effectively free.  ``budget_check`` returns ok / warn / stop; warn at
80% and stop at 100% of a cap.
"""
from __future__ import annotations

from datetime import datetime

from . import usage as _usage

LAYERS = ("per_package", "per_day", "per_agent")
_STATUS_ORDER = {"ok": 0, "warn": 1, "stop": 2}


def status_for(used, cap, warn_ratio: float = 0.8, stop_ratio: float = 1.0) -> str:
    """Map a used/cap ratio to ok | warn | stop (None cap => no limit)."""
    if cap is None:
        return "ok"
    try:
        used = float(used or 0)
        cap = float(cap)
    except (TypeError, ValueError):
        return "ok"
    if cap <= 0:
        return "stop" if used > 0 else "ok"
    ratio = used / cap
    if ratio >= stop_ratio:
        return "stop"
    if ratio >= warn_ratio:
        return "warn"
    return "ok"


def _rules_or_load(rules, base):
    if rules is not None:
        return rules or {}
    from rules import store  # late import to avoid package import cycles
    loaded = store.load_rules(base)
    return loaded[1] if loaded else {}


def _budget_config(rules) -> dict:
    if not isinstance(rules, dict):
        return {}
    cfg = rules.get("budget")
    return cfg if isinstance(cfg, dict) else {}


def _cap_for(ai: str, layer: str, cfg: dict):
    caps = cfg.get("caps") or {}
    per_agent = (cfg.get("per_agent_caps") or {}).get(ai) or {}
    value = per_agent.get(layer, caps.get(layer))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def budget_detail(agent, scope, *, rules=None, base=None, usage=None) -> dict:
    """Full per-layer breakdown for one AI."""
    ai = _usage.canonical(agent)
    role = _usage.classify(ai)
    cfg = _budget_config(_rules_or_load(rules, base))
    warn = cfg.get("warn_ratio", 0.8)
    stop = cfg.get("stop_ratio", 1.0)

    if usage is None:
        usage = _usage.read_usage(base=base)
    records = [r for r in (usage.get("records") or [])
               if isinstance(r, dict) and _usage.canonical(r.get("agent")) == ai]

    scope = scope if isinstance(scope, dict) else {"package": str(scope)}
    package = str(scope.get("package") or "*")
    day = str(scope.get("day") or _usage.today())

    used_by_layer = {
        "per_package": sum(_usage._num(r.get("used")) for r in records
                           if str(r.get("package") or "*") == package),
        "per_day": sum(_usage._num(r.get("used")) for r in records
                       if str(r.get("day") or "") == day),
        "per_agent": sum(_usage._num(r.get("used")) for r in records),
    }

    layers = {}
    worst = "ok"
    for layer in LAYERS:
        cap = _cap_for(ai, layer, cfg)
        # Executors are never blocked: their status is always ok.
        st = ("ok" if role != "controller"
              else status_for(used_by_layer[layer], cap, warn, stop))
        layers[layer] = {"used": used_by_layer[layer], "cap": cap, "status": st}
        if _STATUS_ORDER[st] > _STATUS_ORDER[worst]:
            worst = st
    return {"agent": ai, "role": role, "status": worst, "layers": layers}


def budget_check(agent, scope, *, rules=None, base=None, usage=None) -> str:
    """Return 'ok' | 'warn' | 'stop' for one AI at one scope."""
    return budget_detail(agent, scope, rules=rules, base=base, usage=usage)["status"]


def check_dispatch(spec, rules, *, base=None, usage=None) -> dict:
    """One budget check before dispatch.

    Active only when the spec declares a controller; otherwise it is a no-op
    (status ok), which keeps legacy executor-only dispatch untouched.
    """
    controller = _usage.canonical(spec.get("controller") or spec.get("controller_ai") or "")
    if not controller or _usage.classify(controller) != "controller":
        return {"status": "ok", "reason": "", "controller": controller}
    scope = {
        "package": str(spec.get("task_id") or spec.get("package") or "*"),
        "day": str(spec.get("day") or _usage.today()),
    }
    detail = budget_detail(controller, scope, rules=rules, base=base, usage=usage)
    reason = "controller %s budget %s" % (controller, detail["status"])
    return {"status": detail["status"], "reason": reason,
            "controller": controller, "detail": detail}


def api_payload(*, base=None, rules=None, usage=None) -> dict:
    """Payload for GET /api/budget: per-AI used / limit / status."""
    doc = _rules_or_load(rules, base)
    cfg = _budget_config(doc)
    controllers = list(cfg.get("controllers") or _usage.CONTROLLERS)
    if usage is None:
        usage = _usage.read_usage(base=base)

    controllers_out = {}
    for ai in controllers:
        detail = budget_detail(ai, {"package": "*", "day": _usage.today()},
                               rules=doc, base=base, usage=usage)
        per_agent = detail["layers"]["per_agent"]
        controllers_out[ai] = {
            "used": per_agent["used"],
            "limit": per_agent["cap"],
            "status": detail["status"],
            "role": detail["role"],
            "layers": detail["layers"],
        }

    executors = {}
    for rec in (usage.get("records") or []):
        if not isinstance(rec, dict):
            continue
        name = str(rec.get("agent") or "")
        if _usage.canonical(name) not in _usage.CONTROLLERS and name:
            executors[name] = round(executors.get(name, 0.0)
                                    + _usage._num(rec.get("used")), 4)

    return {
        "unit": cfg.get("unit") or "usage-units",
        "warn_ratio": cfg.get("warn_ratio", 0.8),
        "stop_ratio": cfg.get("stop_ratio", 1.0),
        "controllers": controllers_out,
        "executors": executors,
        "note": usage.get("note") or {},
        "source": "agent_usage / controller_usage (existing statistics)",
        "generated_at": usage.get("generated_at") or datetime.now().isoformat(timespec="seconds"),
    }
