MAX_LEN = 12000
REDACTED = '[REDACTED]'
_SENSITIVE = frozenset({
    'apikey', 'token', 'accesstoken', 'refreshtoken',
    'password', 'authorization', 'secret', 'clientsecret',
})

def _key_token(key):
    return key.lower().replace('-', '').replace('_', '').replace(' ', '')

def _clip(value):
    if isinstance(value, str) and len(value) > MAX_LEN:
        return value[:MAX_LEN]
    return value

def _sanitize(value):
    if isinstance(value, dict):
        clean = {}
        for key, item in value.items():
            raw = key if isinstance(key, str) else str(key)
            safe = _clip(raw)
            if _key_token(raw) in _SENSITIVE:
                clean[safe] = REDACTED
            else:
                clean[safe] = _sanitize(item)
        return clean
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    if isinstance(value, str):
        return _clip(value)
    return value

def _row(kind, provider, session_id=None):
    result = {'kind': kind, 'provider': provider}
    if session_id is not None:
        result['session_id'] = session_id
    return result

def _opencode(event, provider):
    event_type = event.get('type')
    session_id = event.get('sessionID')
    if event_type == 'tool_use':
        part = event.get('part')
        if not isinstance(part, dict):
            return []
        row = _row('tool', provider, session_id)
        tool = part.get('tool')
        if tool is not None:
            row['tool'] = tool
        state = part.get('state')
        if isinstance(state, dict):
            status = state.get('status')
            if status is not None:
                row['state'] = status
            input_value = state.get('input')
            if input_value is not None:
                row['input'] = input_value
            output_value = state.get('output')
            if output_value is not None:
                row['output'] = output_value
        return [row]
    if event_type == 'text':
        part = event.get('part')
        if not isinstance(part, dict) or part.get('text') is None:
            return []
        row = _row('response', provider, session_id)
        row['text'] = part.get('text')
        return [row]
    if event_type == 'error':
        error = event.get('error')
        message = None
        if isinstance(error, dict):
            data = error.get('data')
            if isinstance(data, dict) and data.get('message') is not None:
                message = data.get('message')
            elif error.get('message') is not None:
                message = error.get('message')
        if message is None:
            return []
        row = _row('error', provider, session_id)
        row['text'] = message
        return [row]
    return []

def _dsh(event, provider):
    event_type = event.get('type')
    if event_type == 'session':
        session_id = event.get('sessionId')
        if session_id is None:
            return []
        return [{'kind': 'session', 'provider': provider, 'session_id': session_id}]
    if event_type == 'tool_call':
        call_id = event.get('callId')
        if call_id is None:
            return []
        row = {'kind': 'tool', 'provider': provider, 'call_id': call_id, 'state': 'running'}
        tool = event.get('tool')
        if tool is not None:
            row['tool'] = tool
        input_value = event.get('input')
        if input_value is not None:
            row['input'] = input_value
        return [row]
    if event_type == 'tool_result':
        call_id = event.get('callId')
        if call_id is None:
            return []
        row = {'kind': 'tool', 'provider': provider, 'call_id': call_id}
        status = event.get('status')
        if status is not None:
            row['state'] = status
        output_value = event.get('result')
        if output_value is not None:
            row['output'] = output_value
        return [row]
    if event_type == 'final':
        text = event.get('text')
        if text is None:
            return []
        return [{'kind': 'response', 'provider': provider, 'text': text}]
    if event_type == 'error':
        text = event.get('text')
        if text is None:
            text = event.get('message')
        if text is None:
            return []
        return [{'kind': 'error', 'provider': provider, 'text': text}]
    return []

def normalize_native_event(provider, event):
    if not isinstance(provider, str) or not isinstance(event, dict):
        return []
    name = provider.strip().lower()
    if name == 'opencode':
        rows = _opencode(event, provider)
    elif name == 'dsh':
        rows = _dsh(event, provider)
    else:
        return []
    return [_sanitize(row) for row in rows]
