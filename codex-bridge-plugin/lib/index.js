import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { collaborationWindowHtml } from "./window-page.js";

export const name = "@local/dsh-codex-bridge";
export const inject = ["webServer", "sessionController"];

const DEFAULT_ROOT = "/Users/xinshi/Documents/deepseek/codex-collab";
const DISCOVERY_ROOT = "/Users/xinshi/Library/Application Support/com.xinshi.deepseek-codex-window";
const DEFAULT_APP_PATH = "/Users/xinshi/Applications/DeepSeek-Codex 协作窗口.app";
const DEFAULT_HARNESS_APP_PATH = "/Users/xinshi/Applications/DeepSeek Harness.app";
const DEFAULT_OPENCODE_APP_PATH = "/Applications/OpenCode.app";
const API_PATH = "/api/codex-bridge";
const MAX_BODY_BYTES = 64 * 1024;
const NETWORK_TRACE_URL = "https://chatgpt.com/cdn-cgi/trace";

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isAllowedOrigin(req, port) {
  const origin = req.headers?.origin;
  return origin === undefined || new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]).has(origin);
}

function systemHttpsProxy() {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/sbin/scutil", ["--proxy"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("SYSTEM_PROXY_UNAVAILABLE"));
      const settings = Object.fromEntries([...output.matchAll(/^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort)\s*:\s*(.*?)\s*$/gm)].map((match) => [match[1], match[2]]));
      const useHttps = settings.HTTPSEnable === "1" && settings.HTTPSProxy && Number(settings.HTTPSPort) > 0;
      const useHttp = settings.HTTPEnable === "1" && settings.HTTPProxy && Number(settings.HTTPPort) > 0;
      if (!useHttps && !useHttp) return reject(new Error("SYSTEM_PROXY_DISABLED"));
      const host = useHttps ? settings.HTTPSProxy : settings.HTTPProxy;
      const port = useHttps ? settings.HTTPSPort : settings.HTTPPort;
      resolve(`http://${host}:${port}`);
    });
  });
}

async function codexNetworkStatus() {
  let proxy;
  try {
    proxy = await systemHttpsProxy();
  } catch (error) {
    return { reachable: false, allowed: false, location: null, reason: error.message };
  }
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/curl", [
      "--silent", "--show-error", "--max-time", "12", "--proxy", proxy,
      "--write-out", "\\n__HTTP__:%{http_code}", NETWORK_TRACE_URL,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => resolve({ reachable: false, allowed: false, location: null, reason: "PROXY_CONNECTION_FAILED" }));
    child.on("close", (code) => {
      const marker = output.lastIndexOf("\n__HTTP__:");
      const trace = marker < 0 ? "" : output.slice(0, marker);
      const status = marker < 0 ? 0 : Number.parseInt(output.slice(marker + 10).trim(), 10);
      const location = trace.match(/^loc=([^\r\n]+)$/m)?.[1] || null;
      const reachable = code === 0 && Number.isFinite(status) && status > 0 && status < 500;
      const reason = !reachable
        ? (code === 28 ? "PROXY_CONNECTION_TIMEOUT" : stderr.includes("Connection refused") ? "PROXY_CONNECTION_REFUSED" : "NETWORK_UNAVAILABLE")
        : location === "US" ? null : location ? "CODEX_REGION_NOT_US" : "REGION_UNVERIFIED";
      resolve({ reachable, allowed: reachable && location === "US", location, reason });
    });
  });
}

async function bodyJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanText(value, max = 8000) {
  if (typeof value !== "string") return "";
  return value.replaceAll("\u0000", "").trim().slice(0, max);
}

function cleanSessionId(value) {
  const id = cleanText(value, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id)) return "";
  return id;
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { sessions: {} };
    throw error;
  }
}

async function saveState(file, state) {
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await import("node:fs/promises").then(({ rename }) => rename(temp, file));
}

function exchangeMarkdown(record) {
  const lines = [
    `\n## ${record.id} · ${record.timestamp}`,
    `- direction: ${record.direction}`,
    `- session: ${record.sessionId}`,
    ...(record.taskId ? [`- task: ${record.taskId}`] : []),
    ...(record.taskCardRef ? [`- task card: ${record.taskCardRef}`] : []),
    ...(record.workspaceRef ? [`- workspace: ${record.workspaceRef}`] : []),
    ...(record.replyToMessageId ? [`- reply to: ${record.replyToMessageId}`] : []),
    `- status: ${record.status}`,
    `- GOAL: ${record.goal}`,
    `- CONTEXT: ${record.context}`,
    `- ACTION: ${record.action}`,
    `- WORK_DONE: ${record.workDone || ""}`,
    `- TOOLS_USED: ${record.toolsUsed || ""}`,
    `- RESULT: ${record.result || ""}`,
    `- BOUNDARY: ${record.boundary}`,
    `- RETURN: ${record.returnExpected}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function buildDeliveryPrompt(record) {
  return [
    `[Bridge ${record.id}]`,
    ...(record.taskId ? [`TASK_ID: ${record.taskId}`] : []),
    ...(record.taskCardRef ? [`TASK_CARD: ${record.taskCardRef}`] : []),
    ...(record.taskStatus ? [`TASK_STATUS: ${record.taskStatus}`] : []),
    ...(record.workspaceRef ? [`WORKSPACE: ${record.workspaceRef}`] : []),
    `GOAL: ${record.goal}`,
    ...(record.context ? [`CONTEXT: ${record.context}`] : []),
    `ACTION: ${record.action}`,
    ...(record.workDone ? [`WORK: ${record.workDone}`] : []),
    ...(record.toolsUsed ? [`TOOLS: ${record.toolsUsed}`] : []),
    ...(record.result ? [`RESULT: ${record.result}`] : []),
    `BOUNDARY: ${record.boundary}`,
    `EXPECT: ${record.returnExpected}`,
    `REPLY: bridge message direction=deepseek-to-codex, replyToMessageId=${record.id}.`,
  ].join("\n");
}

export function createBridge({ root = DEFAULT_ROOT, now = () => new Date(), dispatch = undefined } = {}) {
  const stateFile = path.join(root, "bridge-state.json");
  const exchangeFile = path.join(root, "logs", "bridge-exchanges.md");
  const eventFile = path.join(root, "logs", "bridge-events.jsonl");

  async function ensure() {
    await Promise.all([
      mkdir(path.join(root, "inbox"), { recursive: true }),
      mkdir(path.join(root, "outbox"), { recursive: true }),
      mkdir(path.join(root, "handoffs"), { recursive: true }),
      mkdir(path.join(root, "logs"), { recursive: true }),
    ]);
  }

  async function event(type, details) {
    const row = { timestamp: now().toISOString(), type, ...details };
    await appendFile(eventFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  async function status() {
    await ensure();
    const state = await readState(stateFile);
    return {
      ok: true,
      sessions: Object.values(state.sessions).map(({ id, task, authorized, openedAt, closedAt, dshSessionId, purpose }) => ({
        id, task, authorized, openedAt, closedAt, dshSessionId, purpose: purpose === "test" ? "test" : "work",
      })),
    };
  }

  async function authorize(input) {
    await ensure();
    const sessionId = cleanSessionId(input.sessionId);
    const task = cleanText(input.task, 500);
    const dshSessionId = cleanText(input.dshSessionId, 120);
    const purpose = input.purpose === "test" || input.purpose === "work" ? input.purpose : undefined;
    // 默认授权（信使 2026-10-18 决定）：不再要求调用方逐条传 authorized: true，
    // 只有显式 authorized: false 才拒绝。
    if (!sessionId || !task || input.authorized === false) {
      return { status: 400, value: { ok: false, error: "INVALID_AUTHORIZATION" } };
    }
    const state = await readState(stateFile);
    const openedAt = now().toISOString();
    state.sessions[sessionId] = {
      ...state.sessions[sessionId],
      id: sessionId,
      task,
      purpose: purpose || state.sessions[sessionId]?.purpose || "work",
      authorized: true,
      openedAt: state.sessions[sessionId]?.openedAt || openedAt,
      ...(dshSessionId ? { dshSessionId } : {}),
    };
    await saveState(stateFile, state);
    await event("session-authorized", { sessionId, task });
    return { status: 200, value: { ok: true, session: state.sessions[sessionId] } };
  }

  async function close(input) {
    await ensure();
    const sessionId = cleanSessionId(input.sessionId);
    const state = await readState(stateFile);
    const session = state.sessions[sessionId];
    if (!session) return { status: 404, value: { ok: false, error: "SESSION_NOT_FOUND" } };
    session.authorized = false;
    session.closedAt = now().toISOString();
    await saveState(stateFile, state);
    await event("session-closed", { sessionId });
    return { status: 200, value: { ok: true, session } };
  }

  async function message(input) {
    await ensure();
    const sessionId = cleanSessionId(input.sessionId);
    const direction = input.direction === "deepseek-to-codex" ? input.direction : "codex-to-deepseek";
    const state = await readState(stateFile);
    if (!sessionId) return { status: 400, value: { ok: false, error: "INVALID_SESSION" } };
    const clientMessageId = cleanText(input.clientMessageId, 100);
    const replyToMessageId = cleanText(input.replyToMessageId, 100);
    const allowedAgents = new Set(["Codex", "DeepSeek", "OpenCode"]);
    const senderInput = cleanText(input.sender, 40);
    const sender = allowedAgents.has(senderInput) ? senderInput : direction === "codex-to-deepseek" ? "Codex" : "DeepSeek";
    const recipientInput = cleanText(input.recipient, 40);
    const routeRecipient = direction === "codex-to-deepseek" ? "DeepSeek" : "Codex";
    const recipient = allowedAgents.has(recipientInput) ? recipientInput : routeRecipient;
    if (replyToMessageId) {
      const conversation = await readMessages(sessionId);
      if (!conversation.value.messages.some((row) => row.id === replyToMessageId)) {
        return { status: 400, value: { ok: false, error: "INVALID_REPLY_REFERENCE" } };
      }
    }
    const record = {
      id: `${now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now().toISOString(),
      sessionId,
      direction,
      sender,
      recipient,
      status: direction === "codex-to-deepseek" ? "persisted" : "received",
      taskId: cleanText(input.taskId, 120),
      taskCardRef: cleanText(input.taskCardRef, 1000),
      taskStatus: cleanText(input.taskStatus, 40),
      workspaceRef: cleanText(input.workspaceRef, 1000),
      goal: cleanText(input.goal),
      context: cleanText(input.context),
      action: cleanText(input.action),
      kind: input.kind === "result" ? "result" : input.kind === "request" ? "request" : "",
      workDone: cleanText(input.workDone),
      toolsUsed: cleanText(input.toolsUsed),
      result: cleanText(input.result),
      boundary: cleanText(input.boundary),
      returnExpected: cleanText(input.returnExpected),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };
    if (!record.goal || !record.action || !record.boundary || !record.returnExpected) {
      return { status: 400, value: { ok: false, error: "MISSING_PROTOCOL_FIELD" } };
    }
    if (clientMessageId) {
      const existing = await readMessages(sessionId);
      const duplicate = existing.value.messages.find((row) => row.clientMessageId === clientMessageId);
      if (duplicate) {
        if (duplicate.direction === "codex-to-deepseek" && !state.sessions[sessionId]?.dshSessionId) {
          return { status: 409, value: { ok: false, error: "SESSION_NOT_BOUND", duplicate: true, message: duplicate } };
        }
        return { status: 200, value: { ok: true, duplicate: true, message: duplicate } };
      }
    }
    // 默认授权：新会话自动建为已授权，已关闭的会话收到新消息自动重开。
    // 协作窗口因此可以直接开新对话，不再需要逐条授权。
    let session = state.sessions[sessionId];
    if (!session) {
      session = {
        id: sessionId,
        task: cleanText(input.task, 500) || "临时协作会话",
        purpose: input.purpose === "test" ? "test" : "work",
        authorized: true,
        openedAt: now().toISOString(),
        ...(cleanText(input.dshSessionId, 120) ? { dshSessionId: cleanText(input.dshSessionId, 120) } : {}),
      };
      state.sessions[sessionId] = session;
      await saveState(stateFile, state);
      await event("session-authorized", { sessionId, task: session.task, source: "auto" });
    } else if (!session.authorized) {
      session.authorized = true;
      delete session.closedAt;
      await saveState(stateFile, state);
      await event("session-authorized", { sessionId, task: session.task, source: "auto-reopen" });
    }
    const box = direction === "codex-to-deepseek" ? "inbox" : "outbox";
    const recordFile = path.join(root, box, `${record.id}.json`);
    await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await appendFile(exchangeFile, exchangeMarkdown(record), { mode: 0o600 });
    await event("message-persisted", { sessionId, messageId: record.id, direction, ...(replyToMessageId ? { replyToMessageId } : {}) });
    if (direction === "codex-to-deepseek" && !session.dshSessionId) {
      return { status: 409, value: { ok: false, error: "SESSION_NOT_BOUND", message: record } };
    }
    if (direction === "codex-to-deepseek" && session.dshSessionId && dispatch) {
      try {
        await dispatch(record, session);
        record.status = "delivered";
        record.deliveredAt = now().toISOString();
        await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await event("message-delivered", { sessionId, messageId: record.id, dshSessionId: session.dshSessionId });
      } catch (error) {
        record.status = "delivery-failed";
        record.deliveryError = cleanText(error instanceof Error ? error.message : String(error), 500);
        await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await event("message-delivery-failed", { sessionId, messageId: record.id, reason: record.deliveryError });
      }
    }
    return { status: 201, value: { ok: true, message: record } };
  }

  async function update(input) {
    await ensure();
    const sessionId = cleanSessionId(input.sessionId);
    const messageId = cleanText(input.messageId, 100);
    const allowed = new Set(["read", "processing", "completed", "failed"]);
    if (!sessionId || !messageId || !allowed.has(input.status)) {
      return { status: 400, value: { ok: false, error: "INVALID_STATUS_UPDATE" } };
    }
    for (const box of ["inbox", "outbox"]) {
      const file = path.join(root, box, `${messageId}.json`);
      try {
        const record = JSON.parse(await readFile(file, "utf8"));
        if (record.sessionId !== sessionId) return { status: 403, value: { ok: false, error: "SESSION_MISMATCH" } };
        record.status = input.status;
        record.statusAt = now().toISOString();
        if (input.note) record.statusNote = cleanText(input.note, 1000);
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await event("message-status", { sessionId, messageId, status: input.status });
        return { status: 200, value: { ok: true, message: record } };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return { status: 404, value: { ok: false, error: "MESSAGE_NOT_FOUND" } };
  }

  async function retry(input) {
    await ensure();
    const sessionId = cleanSessionId(input.sessionId);
    const messageId = cleanText(input.messageId, 100);
    const state = await readState(stateFile);
    const session = state.sessions[sessionId];
    if (!session?.authorized) return { status: 403, value: { ok: false, error: "SESSION_NOT_AUTHORIZED" } };
    if (!session.dshSessionId || !dispatch) return { status: 409, value: { ok: false, error: "SESSION_NOT_BOUND" } };
    const file = path.join(root, "inbox", `${messageId}.json`);
    try {
      const record = JSON.parse(await readFile(file, "utf8"));
      if (record.sessionId !== sessionId) return { status: 403, value: { ok: false, error: "SESSION_MISMATCH" } };
      if (!["persisted", "delivery-failed"].includes(record.status)) {
        return { status: 409, value: { ok: false, error: "MESSAGE_NOT_RETRYABLE" } };
      }
      try {
        await dispatch(record, session);
        record.status = "delivered";
        record.deliveredAt = now().toISOString();
        delete record.deliveryError;
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await event("message-redelivered", { sessionId, messageId, dshSessionId: session.dshSessionId });
        return { status: 200, value: { ok: true, message: record } };
      } catch (error) {
        record.status = "delivery-failed";
        record.deliveryError = cleanText(error instanceof Error ? error.message : String(error), 500);
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await event("message-delivery-failed", { sessionId, messageId, reason: record.deliveryError, retry: true });
        return { status: 502, value: { ok: false, message: record, error: "DELIVERY_FAILED" } };
      }
    } catch (error) {
      if (error?.code === "ENOENT") return { status: 404, value: { ok: false, error: "MESSAGE_NOT_FOUND" } };
      throw error;
    }
  }

  async function readMessages(sessionIdInput) {
    await ensure();
    const sessionId = cleanSessionId(sessionIdInput);
    if (!sessionId) return { status: 400, value: { ok: false, error: "INVALID_SESSION" } };
    const rows = [];
    for (const box of ["inbox", "outbox"]) {
      const files = (await readdir(path.join(root, box))).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        try {
          const row = JSON.parse(await readFile(path.join(root, box, file), "utf8"));
          if (row.sessionId === sessionId) rows.push(row);
        } catch {
          // A malformed historical row must not make the whole conversation disappear.
        }
      }
    }
    rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));
    return { status: 200, value: { ok: true, messages: rows } };
  }

  async function messages(sessionIdInput, options = {}) {
    const after = cleanText(options.after, 120);
    const wait = Math.min(30, Math.max(0, Number(options.wait) || 0));
    const deadline = Date.now() + wait * 1000;
    let result = await readMessages(sessionIdInput);
    const hasNew = () => {
      if (!after) return true;
      if (!result.value.ok) return false;
      const index = result.value.messages.findIndex((row) => row.id === after);
      // 同秒内 id 的随机后缀不保证字典序，按「after 在已排序列表中的位置」判断是否还有更新的消息。
      return index === -1 ? false : index < result.value.messages.length - 1;
    };
    while (wait > 0 && result.value.ok && !hasNew() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await readMessages(sessionIdInput);
    }
    if (result.value.ok) result.value.messages = result.value.messages.slice(-200);
    return result;
  }

  return { status, authorize, close, message, messages, update, retry };
}

export function apply(ctx, config = {}) {
  const root = cleanText(config.root, 1000) || DEFAULT_ROOT;
  const discoveryFile = path.join(DISCOVERY_ROOT, "bridge-server.json");
  const discoveryTemp = `${discoveryFile}.${process.pid}.tmp`;
  const serverHost = ["127.0.0.1", "localhost", "::1"].includes(ctx.webServer.host) ? ctx.webServer.host : "127.0.0.1";
  const discovery = JSON.stringify({ version: 1, host: serverHost, port: ctx.webServer.port, pid: process.pid, updatedAt: new Date().toISOString() });
  ctx.effect(() => {
    void mkdir(path.dirname(discoveryFile), { recursive: true })
      .then(() => writeFile(discoveryTemp, `${discovery}\n`, { mode: 0o600 }))
      .then(() => rename(discoveryTemp, discoveryFile))
      .catch((error) => ctx.logger?.warn?.("codex bridge discovery publication failed", error));
    return () => {
      void readFile(discoveryFile, "utf8").then(async (contents) => {
        if (JSON.parse(contents).pid === process.pid) await unlink(discoveryFile);
      }).catch(() => {});
      void unlink(discoveryTemp).catch(() => {});
    };
  }, "codex-bridge: server discovery");
  const bridge = createBridge({
    root,
    async dispatch(record, session) {
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId: session.dshSessionId,
        mode: "queue",
        content: [{ type: "text", text: buildDeliveryPrompt(record) }],
        clientTimeZone: "Asia/Shanghai",
      }, new AbortController().signal);
    },
  });
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PATH,
    async handler(req, res) {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      try {
        if (req.method === "POST") {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          if (!isAllowedOrigin(req, ctx.webServer.port)) return json(res, 403, { ok: false, error: "ORIGIN_NOT_ALLOWED" });
        }
        if (req.method === "GET" && pathname === `${API_PATH}/window`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(collaborationWindowHtml());
        }
        if (req.method === "GET" && pathname === `${API_PATH}/network`) {
          const network = await codexNetworkStatus();
          return json(res, 200, { ok: true, ...network });
        }
        if (req.method === "GET" && pathname === `${API_PATH}/window-data`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const sessionId = new URL(req.url, "http://127.0.0.1").searchParams.get("sessionId");
          if (!sessionId) return json(res, 200, await bridge.status());
          const status = await bridge.status();
          const session = status.sessions.find((row) => row.id === sessionId);
          if (!session) return json(res, 404, { ok: false, error: "SESSION_NOT_FOUND" });
          const conversation = await bridge.messages(sessionId);
          return json(res, conversation.status, {
            ok: true,
            session: { id: session.id, task: session.task, authorized: session.authorized, openedAt: session.openedAt, closedAt: session.closedAt, purpose: session.purpose },
            messages: conversation.value.messages,
          });
        }
        if (req.method === "POST" && pathname === `${API_PATH}/open-codex`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const network = await codexNetworkStatus();
          if (!network.allowed) return json(res, 503, { ok: false, error: network.reason || "CODEX_REGION_UNVERIFIED", location: network.location });
          const child = spawn("/usr/bin/open", ["-b", "com.openai.codex"], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true });
        }
        if (req.method === "POST" && pathname === `${API_PATH}/open-window`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const child = spawn("/usr/bin/open", [cleanText(config.appPath, 1000) || DEFAULT_APP_PATH], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true });
        }
        if (req.method === "POST" && (pathname === `${API_PATH}/open-deepseek` || pathname === `${API_PATH}/open-deepseek-desktop`)) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const child = spawn("/usr/bin/open", [cleanText(config.harnessAppPath, 1000) || DEFAULT_HARNESS_APP_PATH], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true, surface: "desktop" });
        }
        if (req.method === "POST" && pathname === `${API_PATH}/open-deepseek-browser`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const child = spawn("/usr/bin/open", [`http://${ctx.webServer.host}:${ctx.webServer.port}/`], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true, surface: "browser" });
        }
        if (req.method === "GET" && pathname === `${API_PATH}/status`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          return json(res, 200, await bridge.status());
        }
        if (req.method === "GET" && pathname === `${API_PATH}/messages`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const params = new URL(req.url, "http://127.0.0.1").searchParams;
          const result = await bridge.messages(params.get("sessionId"), {
            after: params.get("after") || "",
            wait: params.get("wait") || 0,
          });
          return json(res, result.status, result.value);
        }
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
        const input = await bodyJson(req);
        const result = pathname === `${API_PATH}/authorize`
          ? await bridge.authorize(input)
            : pathname === `${API_PATH}/message`
            ? await bridge.message(input)
            : pathname === `${API_PATH}/update`
              ? await bridge.update(input)
              : pathname === `${API_PATH}/retry`
                ? await bridge.retry(input)
            : pathname === `${API_PATH}/close`
              ? await bridge.close(input)
              : { status: 404, value: { ok: false, error: "NOT_FOUND" } };
        return json(res, result.status, result.value);
      } catch (error) {
        ctx.logger?.warn?.("codex bridge request failed", error);
        return json(res, error?.message === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, error: "BAD_REQUEST" });
      }
    },
  }), "codex-bridge: api");
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/codex-collab",
    async handler(req, res) {
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
      if (req.method === "POST" && !isAllowedOrigin(req, ctx.webServer.port)) {
        return json(res, 403, { ok: false, error: "ORIGIN_NOT_ALLOWED" });
      }
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      try {
        if (req.method === "GET" && pathname === "/codex-collab/window") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(collaborationWindowHtml());
        }
        if (req.method === "GET" && pathname === "/codex-collab/window-data") {
          const sessionId = new URL(req.url, "http://127.0.0.1").searchParams.get("sessionId");
          const status = await bridge.status();
          if (!sessionId) {
            return json(res, 200, {
              ok: true,
              sessions: status.sessions.map(({ dshSessionId, ...session }) => session),
            });
          }
          const session = status.sessions.find((row) => row.id === sessionId);
          if (!session) return json(res, 404, { ok: false, error: "SESSION_NOT_FOUND" });
          const conversation = await bridge.messages(sessionId);
          return json(res, conversation.status, {
            ok: true,
            session: { id: session.id, task: session.task, authorized: session.authorized, openedAt: session.openedAt, closedAt: session.closedAt, purpose: session.purpose },
            messages: conversation.value.messages,
          });
        }
        if (req.method === "GET" && pathname === "/codex-collab/network") {
          const network = await codexNetworkStatus();
          return json(res, 200, { ok: true, ...network });
        }
        if (req.method === "POST" && pathname === "/codex-collab/message") {
          const input = await bodyJson(req);
          const result = await bridge.message({ ...input, direction: "codex-to-deepseek", sender: "OpenCode", recipient: "DeepSeek", kind: "request" });
          return json(res, result.status, result.value);
        }
        if (req.method === "POST" && pathname === "/codex-collab/open-codex") {
          const network = await codexNetworkStatus();
          if (!network.allowed) return json(res, 503, { ok: false, error: network.reason || "CODEX_REGION_UNVERIFIED", location: network.location });
          const child = spawn("/usr/bin/open", ["-b", "com.openai.codex"], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true });
        }
        if (req.method === "POST" && pathname === "/codex-collab/open-opencode") {
          const child = spawn("/usr/bin/open", [cleanText(config.opencodeAppPath, 1000) || DEFAULT_OPENCODE_APP_PATH], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true });
        }
        if (req.method === "POST" && pathname === "/codex-collab/open-window") {
          const child = spawn("/usr/bin/open", [cleanText(config.appPath, 1000) || DEFAULT_APP_PATH], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true });
        }
        if (req.method === "POST" && pathname === "/codex-collab/open-deepseek-desktop") {
          const child = spawn("/usr/bin/open", [cleanText(config.harnessAppPath, 1000) || DEFAULT_HARNESS_APP_PATH], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true, surface: "desktop" });
        }
        if (req.method === "POST" && pathname === "/codex-collab/open-deepseek-browser") {
          const child = spawn("/usr/bin/open", [`http://${ctx.webServer.host}:${ctx.webServer.port}/`], { detached: true, stdio: "ignore" });
          child.unref();
          return json(res, 200, { ok: true, opened: true, surface: "browser" });
        }
        return json(res, 404, { ok: false, error: "NOT_FOUND" });
      } catch (error) {
        ctx.logger?.warn?.("codex bridge local window request failed", error);
        return json(res, 400, { ok: false, error: "BAD_REQUEST" });
      }
    },
  }), "codex-bridge: local collaboration window");
}
