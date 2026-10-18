#!/usr/bin/env node
/**
 * bridge-mcp —— DSH ↔ Codex 协作桥的 Codex 侧取件 MCP（stdio）。
 *
 * 设计目标：
 *  - 零依赖：只用 Node 内置模块（node:fs / node:path / node:os / node:readline 等）。
 *  - 纯 stdio JSON-RPC（MCP）：initialize / tools/list / tools/call。
 *  - 入口发现（优先级从高到低）：
 *      1. 环境变量 DSH_WEB_URL
 *      2. ~/Documents/deepseek/codex-collab/bridge-endpoint.json 的 base
 *      3. 插件发布的 ~/Library/Application Support/com.xinshi.deepseek-codex-window/bridge-server.json
 *    只接受 loopback（127.0.0.1 / localhost / ::1），拒绝把桥消息发往外部主机。
 *  - 只读 pending/wait；只有 bridge_reply 会 POST 一条回执。
 *
 * 工具：
 *  - bridge_pending(agent)                列出该会话里「待处理」的 DSH→Codex 消息
 *  - bridge_wait(agent, timeoutSec)       每 1s 轮询，直到出现待处理消息或超时
 *  - bridge_reply({...})                  用 direction=codex-to-deepseek / kind=result 回执
 *
 * 待处理（pending）定义：
 *   direction === "deepseek-to-codex" && status === "received" &&
 *   没有任何 codex-to-deepseek 消息的 replyToMessageId 指向它。
 *   最后一条确保「已回执但 DSH 侧还没改状态」的消息不会被反复取件。
 *
 * 运行：node server.mjs（由 ~/.codex/config.toml 的 [mcp_servers.bridge] 启动）
 * 测试：node test/stdio-smoke.mjs
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "bridge-mcp";
export const SERVER_VERSION = "1.0.0";
export const API_PREFIX = "/api/codex-bridge";
export const DEFAULT_ENDPOINT_FILE = "/Users/xinshi/Documents/deepseek/codex-collab/bridge-endpoint.json";
export const DISCOVERY_FILE = path.join(
  homedir(),
  "Library/Application Support/com.xinshi.deepseek-codex-window/bridge-server.json",
);
export const POLL_INTERVAL_MS = 1000;
export const DEFAULT_TIMEOUT_SEC = 8;
export const MAX_TIMEOUT_SEC = 600;
const FETCH_TIMEOUT_MS = 8000;
const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function log(line) {
  try {
    process.stderr.write("[bridge-mcp " + new Date().toISOString() + "] " + line + "\n");
  } catch {
    // stderr 不可写时保持静默，绝不影响 stdio 协议。
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function endpointFile() {
  return process.env.CODEX_BRIDGE_ENDPOINT_FILE || DEFAULT_ENDPOINT_FILE;
}

/**
 * 归一化桥入口：补 scheme、去尾斜杠、只允许 loopback。
 * 返回 "" 表示该值不可用（调用方跳过）。
 */
export function normalizeBase(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback) return "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function readJson(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 按优先级收集候选入口（已去重）。
 * 注意：每次请求都会重新读文件，这样 DSH 重启换了端口后，
 * 正在 bridge_wait 的调用也能在下一轮轮询里自动跟上。
 */
export async function discoverCandidates() {
  const rows = [];
  const add = (value, source) => {
    const base = normalizeBase(value);
    if (base && !rows.some((row) => row.base === base)) rows.push({ base, source });
  };

  add(process.env.DSH_WEB_URL, "env:DSH_WEB_URL");

  const file = endpointFile();
  const endpoint = await readJson(file);
  add(endpoint?.base, "file:" + file + "#base");

  const discovery = await readJson(DISCOVERY_FILE);
  if (discovery && Number.isInteger(discovery.port) && discovery.port > 0 && discovery.port < 65536) {
    const host = String(discovery.host ?? "127.0.0.1");
    const loopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1" ? host : "127.0.0.1";
    add("http://" + loopbackHost + ":" + discovery.port, "file:" + DISCOVERY_FILE);
  }

  return rows;
}

async function fetchJson(base, pathname, options = {}) {
  const url = base + API_PREFIX + pathname;
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("桥返回非 JSON（HTTP " + response.status + "）");
  }
  return { response, value, url };
}

/** 找到第一个可达的桥入口（用 GET /status 探测），POST 之前先走这一步。 */
async function findBase() {
  const candidates = await discoverCandidates();
  if (!candidates.length) {
    throw new Error(
      "找不到桥入口：DSH_WEB_URL 未设置，bridge-endpoint.json 与插件发现文件也不可用",
    );
  }
  const errors = [];
  for (const candidate of candidates) {
    try {
      const { response, value } = await fetchJson(candidate.base, "/status");
      if (!response.ok || value?.ok === false) throw new Error(value?.error || "HTTP " + response.status);
      return { base: candidate.base, source: candidate.source };
    } catch (error) {
      errors.push(candidate.base + ": " + error.message);
    }
  }
  throw new Error("桥不可达（已尝试 " + candidates.length + " 个入口）：" + errors.join(" | "));
}

/* ------------------------------------------------------------------ */
/* 桥读写                                                              */
/* ------------------------------------------------------------------ */

export function assertSessionId(value) {
  const id = String(value ?? "").trim();
  if (!SESSION_RE.test(id)) {
    throw new Error("agent 必须是桥会话 id（字母/数字开头，仅含字母、数字、. _ -，1-80 字符）");
  }
  return id;
}

function assertMessageId(value) {
  const id = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new Error("replyToMessageId 必须是桥消息 id（形如 20261018103000-ab12cd）");
  }
  return id;
}

async function getAllMessages(sessionId) {
  const candidates = await discoverCandidates();
  if (!candidates.length) throw new Error("找不到桥入口：DSH_WEB_URL 未设置且发现文件不可用");
  const errors = [];
  for (const candidate of candidates) {
    try {
      const { response, value } = await fetchJson(
        candidate.base,
        "/messages?sessionId=" + encodeURIComponent(sessionId),
      );
      if (!response.ok || value?.ok === false) throw new Error(value?.error || "HTTP " + response.status);
      return Array.isArray(value?.messages) ? value.messages : [];
    } catch (error) {
      errors.push(candidate.base + ": " + error.message);
    }
  }
  throw new Error("桥不可达（已尝试 " + candidates.length + " 个入口）：" + errors.join(" | "));
}

/**
 * 待处理 = DSH→Codex 且 status=received 且尚未被任何回执 replyToMessageId 引用。
 * 按时间从旧到新排序。
 */
export function pendingFrom(messages) {
  const replied = new Set(
    messages
      .filter((row) => row && row.direction === "codex-to-deepseek" && typeof row.replyToMessageId === "string")
      .map((row) => row.replyToMessageId),
  );
  return messages
    .filter(
      (row) =>
        row &&
        row.direction === "deepseek-to-codex" &&
        row.status === "received" &&
        !replied.has(row.id),
    )
    .sort(
      (a, b) =>
        String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)),
    );
}

function clampTimeout(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TIMEOUT_SEC;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("timeoutSec 必须是正数（单位：秒）");
  return Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.round(number)));
}

function textField(value, name, options = {}) {
  const { required = false, max = 8000 } = options;
  const text = typeof value === "string" ? value.replaceAll("\u0000", "").trim() : "";
  if (required && !text) throw new Error(name + " 必填且必须是非空字符串");
  return text.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* 三个工具                                                            */
/* ------------------------------------------------------------------ */

async function toolBridgePending(args) {
  const sessionId = assertSessionId(args?.agent);
  const messages = await getAllMessages(sessionId);
  const pending = pendingFrom(messages);
  return { ok: true, sessionId, pendingCount: pending.length, messages: pending };
}

async function toolBridgeWait(args) {
  const sessionId = assertSessionId(args?.agent);
  const timeoutSec = clampTimeout(args?.timeoutSec);
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  let polled = false;
  let lastError = null;

  for (;;) {
    try {
      const messages = await getAllMessages(sessionId);
      polled = true;
      lastError = null;
      const pending = pendingFrom(messages);
      if (pending.length > 0) {
        return {
          ok: true,
          sessionId,
          timedOut: false,
          waitedMs: Date.now() - started,
          pendingCount: pending.length,
          message: pending[0],
        };
      }
    } catch (error) {
      lastError = error;
      log("bridge_wait 轮询失败：" + error.message);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  if (!polled) {
    throw new Error("等待 " + timeoutSec + "s 内桥始终不可达：" + (lastError?.message || "unknown"));
  }
  return {
    ok: true,
    sessionId,
    timedOut: true,
    waitedMs: Date.now() - started,
    pendingCount: 0,
    message: null,
  };
}

/** messageId → sessionId 缓存，避免每次回执都全量扫描会话。 */
const sessionByMessage = new Map();

async function resolveSessionForMessage(messageId) {
  const cached = sessionByMessage.get(messageId);
  if (cached) return cached;

  const candidates = await discoverCandidates();
  let lastError = null;
  for (const candidate of candidates) {
    let status;
    try {
      const result = await fetchJson(candidate.base, "/status");
      if (!result.response.ok || result.value?.ok === false) {
        throw new Error(result.value?.error || "HTTP " + result.response.status);
      }
      status = result.value;
    } catch (error) {
      lastError = error;
      continue;
    }
    const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
    for (const session of sessions) {
      const id = String(session?.id ?? "");
      if (!SESSION_RE.test(id)) continue;
      try {
        const result = await fetchJson(
          candidate.base,
          "/messages?sessionId=" + encodeURIComponent(id),
        );
        if (!result.response.ok || !Array.isArray(result.value?.messages)) continue;
        if (result.value.messages.some((row) => row?.id === messageId)) {
          sessionByMessage.set(messageId, id);
          return id;
        }
      } catch {
        // 单个会话读失败不阻断其它会话的扫描。
      }
    }
  }
  throw new Error(
    "找不到 replyToMessageId=" + messageId + " 所属的桥会话，请显式传 agent（桥会话 id）" +
      (lastError ? "；" + lastError.message : ""),
  );
}

async function toolBridgeReply(args) {
  const replyToMessageId = assertMessageId(args?.replyToMessageId);
  const goal = textField(args?.goal, "goal", { required: true });
  const action = textField(args?.action, "action", { required: true });
  const boundary = textField(args?.boundary, "boundary", { required: true });
  const returnExpected = textField(args?.returnExpected, "returnExpected", { required: true });
  const workDone = textField(args?.workDone, "workDone");
  const toolsUsed = textField(args?.toolsUsed, "toolsUsed");
  const resultText = textField(args?.result, "result");
  const context = textField(args?.context, "context");
  const taskId = textField(args?.taskId, "taskId", { max: 120 });
  const clientMessageId = textField(args?.clientMessageId, "clientMessageId", { max: 100 });

  const explicit = args?.agent ?? args?.sessionId;
  const sessionId = explicit ? assertSessionId(explicit) : await resolveSessionForMessage(replyToMessageId);

  const payload = {
    sessionId,
    direction: "codex-to-deepseek",
    kind: "result",
    replyToMessageId,
    goal,
    action,
    boundary,
    returnExpected,
    ...(workDone ? { workDone } : {}),
    ...(toolsUsed ? { toolsUsed } : {}),
    ...(resultText ? { result: resultText } : {}),
    ...(context ? { context } : {}),
    ...(taskId ? { taskId } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
  };

  const { base } = await findBase();
  const { response, value } = await fetchJson(base, "/message", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const message = value?.message;
  if (message?.id) {
    sessionByMessage.set(message.id, sessionId);
    sessionByMessage.set(replyToMessageId, sessionId);
  }

  if (response.ok && value?.ok !== false && message?.id) {
    return {
      ok: true,
      sessionId,
      persisted: true,
      delivered: message.status === "delivered",
      duplicate: Boolean(value?.duplicate),
      message,
    };
  }

  // 桥会把消息先写进 inbox/，只有会话未绑定 DSH 会话时才返回 409。
  // 此时如实报告「已落盘、未投递」，避免 Codex 重试造成重复回执。
  if (response.status === 409 && message?.id) {
    return {
      ok: true,
      sessionId,
      persisted: true,
      delivered: false,
      duplicate: false,
      warning:
        "回执已写入桥（inbox/" + message.id + ".json），但该会话未绑定 DSH 会话，未自动投递：" +
        (value?.error || "SESSION_NOT_BOUND"),
      message,
    };
  }

  throw new Error(
    "桥拒绝回执（HTTP " + response.status + "）：" + (value?.error || "UNKNOWN") +
      (message?.id ? "；消息 " + message.id + " 已落盘但未成功投递" : ""),
  );
}

/* ------------------------------------------------------------------ */
/* MCP 协议                                                            */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "bridge_pending",
    description:
      "读取桥会话里待处理的 DSH→Codex 消息（direction=deepseek-to-codex 且 status=received 且尚未回执）。agent 是桥会话 id。只读。",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "桥会话 id，例如 bridge-e2e-20261018（不是 DSH 会话的 UUID）。",
        },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_wait",
    description:
      "阻塞等待 DSH→Codex 的待处理消息：每 1 秒轮询一次，出现待处理消息立即返回该原始消息；超时返回 timedOut=true。agent 是桥会话 id。只读。",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "桥会话 id。" },
        timeoutSec: {
          type: "number",
          description: "最长等待秒数（1-600，默认 8；需小于 MCP 客户端超时）。",
          minimum: 1,
          maximum: 600,
        },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_reply",
    description:
      "通过桥给 DSH 发一条 result 回执（direction=codex-to-deepseek, kind=result）。replyToMessageId 必须指向本会话已有的消息；agent/sessionId 可省略（服务器会自动定位该消息所属会话）。",
    inputSchema: {
      type: "object",
      properties: {
        replyToMessageId: { type: "string", description: "要回复的桥消息 id。" },
        goal: { type: "string", description: "这条回执对应/完成的目标。" },
        action: { type: "string", description: "实际做了什么（桥协议必填）。" },
        boundary: { type: "string", description: "边界：没做什么、限制是什么（桥协议必填）。" },
        returnExpected: { type: "string", description: "期望对方下一步做什么；无则写「无」。" },
        workDone: { type: "string", description: "实际完成的步骤或产物，不写计划。" },
        toolsUsed: { type: "string", description: "实际使用的工具、命令、文件类型；没有写「无」。" },
        result: { type: "string", description: "可验证结果、路径、状态或失败原因。" },
        context: { type: "string", description: "可选补充上下文。" },
        taskId: { type: "string", description: "可选任务编号。" },
        clientMessageId: { type: "string", description: "可选幂等键；重复调用不会产生重复消息。" },
        agent: {
          type: "string",
          description: "可选：桥会话 id。省略时按 replyToMessageId 自动定位会话。",
        },
      },
      required: ["replyToMessageId", "goal", "action", "boundary", "returnExpected"],
      additionalProperties: false,
    },
  },
];

function initializeResult(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: typeof requested === "string" && requested ? requested : "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function invokeTool(name, args) {
  if (name === "bridge_pending") return toolBridgePending(args);
  if (name === "bridge_wait") return toolBridgeWait(args);
  if (name === "bridge_reply") return toolBridgeReply(args);
  throw new Error("未知工具：" + name + "（可用：bridge_pending / bridge_wait / bridge_reply）");
}

async function processLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error: 不是合法 JSON");
    return;
  }
  if (Array.isArray(message)) {
    sendError(null, -32600, "Batch 请求不受支持");
    return;
  }
  if (!message || typeof message !== "object" || typeof message.method !== "string") {
    if (message?.id !== undefined) sendError(message.id, -32600, "Invalid Request：缺少 method");
    return;
  }

  const id = message.id;
  const method = message.method;

  // 通知（无 id）：不回复。
  if (id === undefined) {
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    log("忽略通知：" + method);
    return;
  }

  try {
    if (method === "initialize") {
      sendResult(id, initializeResult(message.params));
      return;
    }
    if (method === "ping") {
      sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      const params = message.params;
      if (!params || typeof params.name !== "string") throw new Error("tools/call 缺少 name");
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const value = await invokeTool(params.name, args);
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          isError: false,
        });
      } catch (error) {
        sendResult(id, {
          content: [{ type: "text", text: "错误：" + error.message }],
          isError: true,
        });
      }
      return;
    }
    throw rpcError(-32601, "Method not found: " + method);
  } catch (error) {
    sendError(id, error.code || -32603, error.message);
  }
}

async function main() {
  log(SERVER_NAME + " " + SERVER_VERSION + " 启动；node=" + process.version);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Set();

  for await (const line of input) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 不 await：bridge_wait 可以阻塞很久，不能挡住 ping / 其它 tools/call。
    const task = processLine(trimmed)
      .catch((error) => log("处理请求失败：" + (error?.message || String(error))))
      .finally(() => inflight.delete(task));
    inflight.add(task);
  }

  await Promise.allSettled([...inflight]);
  log("stdin 已关闭，退出");
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    log("致命错误：" + (error?.stack || error?.message || String(error)));
    process.exitCode = 1;
  });
}
