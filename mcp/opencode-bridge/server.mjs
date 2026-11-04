#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { createBridge } from "../../plugins/dsh/codex-bridge/lib/index.js";
import os from "node:os";
import path from "node:path";

const bridgeRoot = process.env.CODEX_BRIDGE_ROOT || path.join(os.homedir(), "Documents/deepseek/codex-collab");
const discoveryPath = path.join(bridgeRoot, "bridge-server.json");
const localBridge = createBridge({ root: bridgeRoot });
const safeText = (value, max = 12000) => String(value ?? "").trim().slice(0, max);

async function baseUrl() {
  const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
  if (discovery.host !== "127.0.0.1" || !Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535) {
    throw new Error("Bridge discovery must point to 127.0.0.1 with a valid port");
  }
  return `http://127.0.0.1:${discovery.port}`;
}

async function callAt(path, options = {}) {
  const response = await fetch(`${await baseUrl()}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Bridge HTTP ${response.status}`);
  return value;
}

async function callApi(path, options = {}) {
  return callAt(`/api/codex-bridge${path}`, options);
}

async function requireAuthorized(sessionId) {
  const status = await localBridge.status();
  const session = status.sessions.find((row) => row.id === sessionId && row.authorized);
  if (!session) throw new Error("Choose an existing authorized bridge session");
  return session;
}

const tools = [
  { name: "bridge_list_sessions", description: "List bridge sessions and authorization state. Does not send messages.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "bridge_list_messages", description: "Read the latest messages from one authorized bridge session.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "bridge_send_to_deepseek", description: "Send a message from OpenCode to DeepSeek through an existing authorized session. Requires user confirmation in OpenCode.", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, clientMessageId: { type: "string" }, taskId: { type: "string" }, goal: { type: "string" }, context: { type: "string" }, action: { type: "string" }, boundary: { type: "string" }, returnExpected: { type: "string" } }, required: ["sessionId", "clientMessageId", "taskId", "goal", "action", "boundary", "returnExpected"], additionalProperties: false } },
  { name: "bridge_reply_to_codex", description: "Post an OpenCode contribution or reply for Codex through an existing authorized session. Requires user confirmation in OpenCode.", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, clientMessageId: { type: "string" }, replyToMessageId: { type: "string" }, taskId: { type: "string" }, goal: { type: "string" }, context: { type: "string" }, action: { type: "string" }, workDone: { type: "string" }, toolsUsed: { type: "string" }, result: { type: "string" }, boundary: { type: "string" }, returnExpected: { type: "string" } }, required: ["sessionId", "clientMessageId", "replyToMessageId", "taskId", "goal", "action", "boundary", "returnExpected"], additionalProperties: false } },
];

async function invoke(name, args) {
  if (name === "bridge_list_sessions") {
    const result = await localBridge.status();
    return result.sessions.map(({ id, task, authorized, openedAt, purpose }) => ({ id, task, authorized, openedAt, purpose }));
  }
  if (name === "bridge_list_messages") {
    await requireAuthorized(args.sessionId);
    const result = await localBridge.messages(args.sessionId);
    return result.value.messages.slice(-40).map((row) => ({ id: row.id, timestamp: row.timestamp, sender: row.sender || (row.direction === "codex-to-deepseek" ? "Codex" : "DeepSeek"), recipient: row.recipient || (row.direction === "codex-to-deepseek" ? "DeepSeek" : "Codex"), direction: row.direction, status: row.status, taskId: row.taskId, replyToMessageId: row.replyToMessageId, goal: row.goal, action: row.action, result: row.result }));
  }
  if (name === "bridge_send_to_deepseek" || name === "bridge_reply_to_codex") {
    await requireAuthorized(args.sessionId);
    const toDeepSeek = name === "bridge_send_to_deepseek";
    const payload = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, safeText(value, key === "context" || key === "action" || key === "result" ? 12000 : 2000)]));
    payload.direction = toDeepSeek ? "codex-to-deepseek" : "deepseek-to-codex";
    payload.sender = "OpenCode";
    payload.recipient = toDeepSeek ? "DeepSeek" : "Codex";
    payload.kind = toDeepSeek ? "request" : "result";
    const result = toDeepSeek
      ? await callAt("/codex-collab/message", { method: "POST", body: JSON.stringify(payload) })
      : await localBridge.message(payload);
    const message = result.message || result.value?.message;
    if (!message) throw new Error(result.error || result.value?.error || "Bridge did not return a message");
    return { id: message.id, status: message.status, sender: message.sender, recipient: message.recipient, replyToMessageId: message.replyToMessageId, duplicate: Boolean(result.duplicate || result.value?.duplicate) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opencode-bridge", version: "1.0.0" } };
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    try { return { content: [{ type: "text", text: JSON.stringify(await invoke(message.params.name, message.params.arguments || {}), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: safeText(error.message, 500) }] }; }
  }
  throw new Error(`Unsupported method: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
    const result = await handle(message);
    if (message.id !== undefined && result !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    if (message?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: safeText(error.message, 500) } })}\n`);
    else process.stderr.write(`${safeText(error.message, 500)}\n`);
  }
}
