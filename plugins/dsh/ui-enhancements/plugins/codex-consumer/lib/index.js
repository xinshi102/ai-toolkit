/**
 * @local/dsh-codex-consumer — DSH 侧 Codex 协作桥消费端（主机插件）
 *
 * 与 Codex 的桥（@local/dsh-codex-bridge）共用同一队列，不修改其代码：
 *   - /codex-inbox           列出 Codex 发来的消息（codex-collab/inbox/*.json）
 *   - /codex-inbox 10        最近 10 条
 *   - /codex-send 内容       回复 Codex（写入 outbox，需先有已授权会话）
 *   - 看门狗：新消息到达时写 log.sh 日志（与桥事件流互补）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

export const name = "@local/dsh-codex-consumer";

const COLLAB = "/Users/xinshi/Documents/deepseek/codex-collab";
const IN = join(COLLAB, "inbox");
const OUT = join(COLLAB, "outbox");
const STATE = join(COLLAB, "bridge-state.json");
const EVENTS = join(COLLAB, "logs", "bridge-events.jsonl");
const EXCHANGES = join(COLLAB, "logs", "bridge-exchanges.md");

function now() { return new Date(); }
function id() { return now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 8); }
function clean(v, max) { return typeof v === "string" ? v.replaceAll("\u0000", "").trim().slice(0, max || 8000) : ""; }

function ensure() {
  for (const d of [IN, OUT, join(COLLAB, "logs")]) mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

function readMessages(dir, limit) {
  ensure();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => readJson(join(dir, f), { file: f, error: "parse-failed" }));
}

function render(msgs) {
  if (!msgs.length) return "📭 队列为空（codex-collab/inbox/）。";
  return msgs.map((m, i) =>
    `#${msgs.length - i} [${m.id || m.file}] ${m.direction || ""} ${m.status || ""}\n` +
    `  会话: ${m.sessionId || "-"}\n` +
    `  GOAL: ${m.goal || "-"}\n` +
    `  ACTION: ${m.action || "-"}\n` +
    `  BOUNDARY: ${m.boundary || "-"}\n` +
    `  RETURN: ${m.returnExpected || "-"}\n` +
    `  CONTEXT: ${(m.context || "").slice(0, 300)}`
  ).join("\n\n---\n\n");
}

/** 找到最近一个仍授权的会话（无则 undefined） */
function latestAuthorizedSession() {
  const state = readJson(STATE, { sessions: {} });
  const sessions = Object.values(state.sessions || {});
  return sessions.filter((s) => s.authorized).sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))[0];
}

async function appendEvent(type, details) {
  try { await appendFile(EVENTS, `${JSON.stringify({ timestamp: now().toISOString(), type, ...details })}\n`, { mode: 0o600 }); } catch (e) {}
}

async function appendExchange(record) {
  try {
    const lines = [
      `\n## ${record.id} · ${record.timestamp}`,
      `- direction: ${record.direction}`,
      `- session: ${record.sessionId}`,
      `- status: ${record.status}`,
      `- GOAL: ${record.goal}`,
      `- CONTEXT: ${record.context}`,
      `- ACTION: ${record.action}`,
      `- BOUNDARY: ${record.boundary}`,
      `- RETURN: ${record.returnExpected}`,
    ];
    await appendFile(EXCHANGES, `${lines.join("\n")}\n`, { mode: 0o600 });
  } catch (e) {}
}

function logExchange(summary) {
  try { execFileSync(join(COLLAB, "log.sh"), ["dsh", "message", summary], { stdio: "ignore" }); } catch (e) {}
}

/** 以与桥一致的记录格式写入 outbox（deepseek-to-codex） */
async function sendToCodex(text, session) {
  ensure();
  const content = clean(text, 8000);
  if (!content) return { error: "内容为空" };
  const record = {
    id: id(),
    timestamp: now().toISOString(),
    sessionId: session.id,
    direction: "deepseek-to-codex",
    status: "queued",
    goal: content.split("\n")[0].slice(0, 200),
    context: session.task || "",
    action: content,
    boundary: "no production restart",
    returnExpected: "ack"
  };
  writeFileSync(join(OUT, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await appendEvent("message-queued", { sessionId: session.id, messageId: record.id, direction: record.direction });
  await appendExchange(record);
  return { record };
}

function watchInbox() {
  let seen = new Set();
  const scan = () => {
    ensure();
    let files = [];
    try { files = readdirSync(IN).filter((f) => f.endsWith(".json")); } catch (e) { return; }
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      const m = readJson(join(IN, f), null);
      if (m && m.direction === "codex-to-deepseek") {
        logExchange(`收到 Codex 消息 ${m.id}: ${m.goal || ""}`);
      }
    }
  };
  scan();
  const timer = setInterval(scan, 3000);
  return () => clearInterval(timer);
}

export function apply(ctx) {
  ensure();
  const disposers = [];

  ctx.inject(["commands"], (c) => {
    disposers.push(c.commands.register({
      name: "codex-inbox",
      description: "查看 Codex 发来的消息（/codex-inbox [数量]）",
      handler: (invocation) => {
        const n = Number(invocation.rawInput) || 8;
        return { kind: "text", text: render(readMessages(IN, n)) };
      }
    }));
    disposers.push(c.commands.register({
      name: "codex-send",
      description: "回复 Codex（/codex-send 内容；需已通过 ⇄ 面板授权会话）",
      input: { hint: "要发送给 Codex 的消息内容" },
      handler: async (invocation) => {
        const session = latestAuthorizedSession();
        if (!session) {
          return { kind: "error", text: "没有已授权的会话。请先在网页端插件坞「⇄ Codex 协作桥」面板授权（会话编号+任务），或用 /codex-authorize 命令。" };
        }
        const out = await sendToCodex(String(invocation.rawInput || "").trim(), session);
        if (out.error) return { kind: "error", text: out.error };
        logExchange(`向 Codex 发送消息 ${out.record.id}`);
        return { kind: "text", text: `✅ 已入队 → codex-collab/outbox/${out.record.id}.json（会话 ${session.id}）` };
      }
    }));
    disposers.push(c.commands.register({
      name: "codex-authorize",
      description: "授权一个 Codex 协作会话（/codex-authorize 会话编号 任务描述）",
      input: { hint: "会话编号 任务描述" },
      handler: (invocation) => {
        const parts = String(invocation.rawInput || "").split(/\s+(.+)/);
        const sessionId = (parts[0] || "").trim();
        const task = (parts[1] || "").trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(sessionId) || !task) {
          return { kind: "error", text: "用法：/codex-authorize 会话编号 任务描述" };
        }
        const state = readJson(STATE, { sessions: {} });
        state.sessions = state.sessions || {};
        state.sessions[sessionId] = { id: sessionId, task, authorized: true, openedAt: now().toISOString() };
        writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        appendEvent("session-authorized", { sessionId, task });
        return { kind: "text", text: `✅ 已授权会话 ${sessionId}（任务：${task}）` };
      }
    }));
  });

  const stopWatch = watchInbox();
  ctx.effect(() => stopWatch, "dsh-codex-consumer: inbox watcher");
  ctx.on("dispose", () => disposers.forEach((d) => { try { d(); } catch (e) {} }));
}
