"""Pre-spawn authorization gate shared by every CLI adapter.

The coordinator validates task manifests, but each adapter can also be used
directly (the `__main__` entry points and the registration tests do). Rules
that must hold for *any* launch live here and are evaluated inside the adapter
before it touches the workspace or starts a subprocess, so bypassing the
manifest validation cannot widen the model, timeout or directory.

This is an application-level gate, not OS isolation; see CLI-COLLABORATION.md.
"""
from __future__ import annotations

from pathlib import Path

FREE_MODEL = 'opencode/deepseek-v4.1-flash-free'
SHARED_DEEPSEEK_MODEL = 'deepseek/deepseek-flash'
DSH_MODELS = ('DeepSeek-Flash', 'deepseek-official/deepseek-flash')
HARNESSES = ('opencode', 'dsh')
MAX_TIMEOUT_SECONDS = 300


class LaunchDenied(ValueError):
    """A launch rule failed; no subprocess may be started."""


def check_timeout(timeout):
    if type(timeout) is not int or not 1 <= timeout <= MAX_TIMEOUT_SECONDS:
        raise LaunchDenied(f'timeout must be an integer between 1 and {MAX_TIMEOUT_SECONDS}')
    return timeout


def check_model(harness, model, *, shared_deepseek=False):
    if harness == 'opencode':
        allowed = {FREE_MODEL}
        if shared_deepseek:
            allowed.add(SHARED_DEEPSEEK_MODEL)
    elif harness == 'dsh':
        allowed = set(DSH_MODELS)
    else:
        raise LaunchDenied(f'unsupported harness {harness!r}')
    if model not in allowed:
        raise LaunchDenied(f'{harness} permits only {sorted(allowed)}; got {model!r}')
    return model


def check_directory(directory):
    directory = Path(directory)
    try:
        resolved = directory.resolve(strict=True)
    except OSError as error:
        raise LaunchDenied('workspace directory is missing') from error
    if not resolved.is_dir():
        raise LaunchDenied('workspace must be an existing directory')
    if resolved == Path('/') or resolved == Path.home().resolve():
        raise LaunchDenied('workspace must not be root or the home directory')
    return resolved


def check_filename(name, label):
    if not isinstance(name, str) or not name or name in ('.', '..'):
        raise LaunchDenied(f'{label} must be a plain filename')
    if Path(name).name != name or '\\' in name or any(char in name for char in '*?'):
        raise LaunchDenied(f'{label} must be a plain filename')
    return name


def check(harness, *, model, timeout, directory, brief, output, shared_deepseek=False):
    """Validate every launch rule and return the resolved workspace directory."""
    check_model(harness, model, shared_deepseek=shared_deepseek)
    check_timeout(timeout)
    resolved = check_directory(directory)
    check_filename(brief, 'brief')
    check_filename(output, 'output')
    if brief == output:
        raise LaunchDenied('brief and output must be different files')
    return resolved
