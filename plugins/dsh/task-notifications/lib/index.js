import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';

export const name = '@local/dsh-task-notifications';
export const inject = ['sessions', 'commands'];
const run = promisify(execFile);

// Never include task content, titles or file paths in lock-screen notifications.
export function notificationFor(event, hadStep) {
  if (event?.type !== 'turn/end' || !hadStep) return undefined;
  switch (event.data?.reason?.kind) {
    case 'completed': return ['DeepSeek 已完成本轮任务', '返回 DeepSeek 查看结果。'];
    case 'error': return ['DeepSeek 任务遇到错误', '返回 DeepSeek 查看错误和下一步。'];
    case 'blocked': return ['DeepSeek 需要你处理', '返回 DeepSeek 查看待处理事项。'];
    case 'max-tokens': return ['DeepSeek 本轮达到限制', '返回 DeepSeek 检查任务是否需要继续。'];
    default: return undefined;
  }
}

export function createHandler(send, getEnabled, onError = () => {}) {
  const active = new Map();
  const seen = new Set();
  return (session, event) => {
    try {
      if (event?.type === 'step/start') {
        active.set(session.id, true);
        if (active.size > 1000) active.delete(active.keys().next().value);
        return;
      }
      if (event?.type !== 'turn/end') return;
      const hadStep = active.get(session.id) === true;
      active.delete(session.id);
      const message = notificationFor(event, hadStep);
      if (!message || !getEnabled()) return;
      const key = `${session.id}:${event.seq}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      // The listener cannot throw into SessionStore or stall the agent.
      Promise.resolve().then(() => send(message)).catch(onError);
    } catch (error) { onError(error); }
  };
}

export async function apply(ctx, config = {}) {
  const helper = config.helper ?? path.join(homedir(), 'Applications/DeepSeek Notifications.app/Contents/MacOS/DeepSeekNotifications');
  const stateFile = config.stateFile ?? path.join(homedir(), '.dsh/notifications/settings.json');
  let enabled = true;
  let channel = 'desktop';
  try { const saved = JSON.parse(await readFile(stateFile, 'utf8')); enabled = saved.enabled !== false; channel = ['desktop', 'system', 'both'].includes(saved.channel) ? saved.channel : 'desktop'; }
  catch (error) { if (error.code !== 'ENOENT') enabled = false; }
  const invoke = async (args) => {
    const { stdout } = await run(helper, args, { timeout: 20000, maxBuffer: 8192 });
    return JSON.parse(stdout);
  };
  const warn = () => { try { ctx.logger?.warn?.('task-notifications: 通知未送出；/notify status 检查权限。'); } catch {} };
  const send = async (message) => {
    if (channel === 'system' || channel === 'both') await invoke(['--notify', ...message]);
    if (channel === 'desktop' || channel === 'both') await invoke(['--toast', ...message]);
  };
  const eventHandler = createHandler(send, () => enabled, warn);
  ctx.on('session/event', eventHandler, { global: true });
  ctx.commands.register({
    name: 'notify',
    description: '任务通知：status、on、off、desktop、system、both、permission、settings、test',
    input: { hint: '[status|on|off|permission|settings|test]', attachments: false },
    handler: async ({ rawInput }) => {
      const action = rawInput.trim() || 'status';
      try {
        if (['on', 'off', 'desktop', 'system', 'both'].includes(action)) {
          const next = ['on', 'off'].includes(action) ? action === 'on' : enabled;
          const nextChannel = ['desktop', 'system', 'both'].includes(action) ? action : channel;
          await mkdir(path.dirname(stateFile), { recursive: true });
          const temporary = `${stateFile}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify({ enabled: next, channel: nextChannel }) + '\n', { mode: 0o600 });
          await rename(temporary, stateFile);
          enabled = next;
          channel = nextChannel;
          return { kind: 'success', text: `任务通知已${enabled ? '开启' : '关闭'}，方式：${channel}。` };
        }
        if (action === 'test' && channel !== 'system') {
          await send(['DeepSeek 通知测试', '这是一条桌面右下角提醒，切换软件后仍可看到。']);
          return { kind: 'success', text: JSON.stringify({ enabled, channel, shown: true }) };
        }
        const flags = { status: '--status', permission: '--request', settings: '--settings', test: '--test' };
        if (!flags[action]) return { kind: 'error', text: '用法：/notify status|on|off|permission|settings|test' };
        const result = await invoke([flags[action]]);
        return { kind: 'success', text: JSON.stringify({ enabled, channel, ...result }) };
      } catch {
        return { kind: 'error', text: '通知操作未完成；确认原生通知组件已安装，并在系统设置→通知→DeepSeek 通知中开启权限。' };
      }
    },
  });
}
