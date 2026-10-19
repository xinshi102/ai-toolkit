// Audit-only DSH plugin for the workspace file adapter.
//
// It never denies a legitimate task tool. It records the real effective policy
// for every session that starts a turn, plus tool names/call IDs and whether a
// result was an error. No prompt, tool input, tool output, configuration or
// credential value is emitted. The headless runner's required injection makes a
// missing or failed instance prevent startup instead of silently running
// unaudited. Audit-only means these records are evidence for parse_log(); the
// loader/runner remains the enforcement point for the fixed patch.
export const inject = ['sandboxPolicy', 'approval'];
export const name = 'runtime-dsh-workspace-audit';

const PREFIX = 'DSH_WORKSPACE_AUDIT ';
const EXPECTED = process.env.DSH_WORKSPACE_EXPECTED_PERMISSION;
const ALLOWED = new Set(['read-only', 'workspace-write']);

if (!ALLOWED.has(EXPECTED)) {
  throw new Error('runtime-dsh-workspace-audit: DSH_WORKSPACE_EXPECTED_PERMISSION must be read-only or workspace-write');
}

const emit = (record) => process.stderr.write(PREFIX + JSON.stringify(record) + '\n');
const keyOf = (sessionId, callId) => sessionId + '\u0000' + callId;

export function apply(ctx) {
  const toolNames = new Map();

  emit({
    type: 'guard_ready',
    expected: EXPECTED,
    approval: 'never',
    audits: ['effective_policy', 'tool_call', 'tool_result'],
  });

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const sandbox = ctx.sandboxPolicy.resolve({session}).mode;
      const approval = ctx.approval.effectivePolicy(session);
      const valid = sandbox === EXPECTED && approval === 'never';
      emit({
        type: 'effective_policy',
        sessionId: session.id,
        sandbox,
        approval,
        expected: EXPECTED,
        valid,
      });
      if (!valid) {
        throw new Error('runtime-dsh-workspace-audit: refusing an unverified effective policy');
      }
      return;
    }

    if (event.type === 'tool/call') {
      const callId = event.data?.callId;
      const tool = event.data?.name;
      if (typeof callId !== 'string' || typeof tool !== 'string') return;
      toolNames.set(keyOf(session.id, callId), tool);
      emit({type: 'tool_call', sessionId: session.id, callId, name: tool});
      return;
    }

    if (event.type === 'tool/result') {
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
      const message = event.data?.message;
      const callId = message?.toolCallId;
      if (typeof callId !== 'string') return;
      emit({
        type: 'tool_result',
        sessionId: session.id,
        callId,
        name: toolNames.get(keyOf(session.id, callId)) ?? null,
        error: message?.isError === true,
      });
    }
  });

  ctx.provide('runtimeDshWorkspaceAudit', {expected: EXPECTED, approval: 'never'});
}
