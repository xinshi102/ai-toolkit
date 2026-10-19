// Single-invocation protection. No direct reads of configuration or credentials.
export const inject = ['tools', 'sandboxPolicy', 'approval'];
export const name = 'runtime-dsh-text-guard';
export function apply(ctx) {
  const emit = (record) => process.stderr.write('DSH_TEXT_AUDIT ' + JSON.stringify(record) + '\n');
  ctx.tools.guard((exec) => {
    emit({type: 'blocked_tool', name: exec.name, sessionId: exec.agent?.session.id});
    return 'Every tool is denied in dsh-text. Analyze only the supplied prompt.';
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const sandbox = ctx.sandboxPolicy.resolve({session}).mode;
      const approval = ctx.approval.effectivePolicy(session);
      const valid = sandbox === 'read-only' && approval === 'never';
      emit({type: 'effective_policy', sessionId: session.id, sandbox, approval,
        allToolsDenied: true, valid});
      if (!valid) throw new Error('dsh-text refuses an unverified effective policy');
    }
  });
  emit({type: 'guard_ready', allToolsDenied: true});
  ctx.provide('runtimeDshTextGuard', {allToolsDenied: true});
}
