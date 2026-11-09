"""Per-provider real quota fetchers for the AI 资源 panel.

Each provider module exposes fetch() -> dict and (where useful) a pure
parse(data) -> dict for unit testing. Only numbers/labels are ever returned;
credentials are read into memory and never stored, logged, or returned.
"""
