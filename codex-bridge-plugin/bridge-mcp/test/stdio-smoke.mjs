#!/usr/bin/env node
/**
 * bridge-mcp 真实 stdio 冒烟测试。
 *
 * 用子进程 + JSON-RPC 行协议充当 MCP 客户端，覆盖：
 *   initialize / notifications/initialized / tools/list / tools/call
 *   bridge_pending（空 / 有消息 / 回执后清零）
 *   bridge_wait（超时 / 每秒轮询到新消息）
 *   bridge_reply（显式 agent / 自动定位会话 / 409 未绑定会话）
 *   错误路径（非法 agent、缺字段、未知工具、未知方法）
 *   入口发现优先级（DSH_WEB_URL > bridge-endpoint.json > 插件发现文件）
 *
 * 会在真实桥上创建 3 个 mcp-selftest-* 临时会话和 4 条消息作为证据。
 * 运行：DSH_WEB_URL=http://127.0.0.1:<port> node test/stdio-smoke.mjs
 * 不传 DSH_WEB_URL 时按默认入口发现。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENDPOINT_FILE, DISCOVERY_FILE, discoverCandidates, normalizeBase } from "../server.mjs";

const SERVER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const API = "/api/codex-bridge";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
function pass(name, detail = "") {
  passed += 1;
  console.log("PASS  " + name + (detail ? "  [" + detail + "]" : ""));
}

function fail(name, error) {
  console.error("FAIL  " + name);
  console.error(error && error.stack ? error.stack : String(error));
}

async function getJson(base, pathname) {
  const response = await fetch(base + API + pathname);
  const value = await response.json();
  return { response, value };
}

async function postJson(base, pathname, body) {
  const response = await fetch(base + API + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  return { response, value };
}

async function alive(base) {
  try {
    const { response, value } = await getJson(base, "/status");
    return response.ok && value?.ok === true;
  } catch {
    return false;
  }
}

/** 与 server.mjs 相同的优先级，找一个真实在线的桥入口。 */
async function resolveLiveBase() {
  const rows = await discoverCandidates();
  for (const row of rows) {
    if (await alive(row.base)) return { base: row.base, source: row.source };
  }
  throw new Error("找不到在线的桥入口：" + rows.map((row) => row.base).join(", "));
}

class McpClient {
  constructor(envOverrides = {}, unset = []) {
    const env = { ...process.env, ...envOverrides };
    for (const key of unset) delete env[key];
    this.child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.nextId = 0;
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000);
    });
    this.child.stdout.setEncoding("utf8");
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.onLine(line));
    this.exited = new Promise((resolve) => this.child.on("exit", resolve));
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("stdout 出现非 JSON 行：" + line);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error("JSON-RPC " + message.error.code + ": " + message.error.message));
    else waiter.resolve(message.result);
  }

  request(method, params, timeoutMs = 25000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP 请求超时：" + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close() {
    this.rl.close();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited;
    clearTimeout(timer);
  }
}

async function callTool(client, name, args, timeoutMs) {
  const result = await client.request("tools/call", { name, arguments: args }, timeoutMs);
  const text = result?.content?.[0]?.text ?? "";
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  return { isError: Boolean(result?.isError), text, value, raw: result };
}

async function postDeepSeekRequest(base, sessionId, goal) {
  const { response, value } = await postJson(base, "/message", {
    sessionId,
    direction: "deepseek-to-codex",
    kind: "request",
    goal,
    context: "bridge-mcp stdio 冒烟测试自动生成",
    action: "请 Codex 取件并按桥协议回执",
    boundary: "只允许测试回执，不改任何文件",
    returnExpected: "一条 kind=result 的回执",
  });
  assert.equal(response.status, 201, "POST 请求失败：" + JSON.stringify(value));
  assert.ok(value?.message?.id, "POST 未返回消息 id");
  return value.message;
}

function replyPayload(replyToMessageId, extra = {}) {
  return {
    replyToMessageId,
    goal: "bridge-mcp 冒烟测试回执",
    action: "通过 bridge-mcp 的 bridge_reply 工具回执",
    boundary: "只发桥消息，不动文件",
    returnExpected: "无",
    workDone: "跑通 stdio MCP 的 pending / wait / reply",
    toolsUsed: "node:test stdio client + bridge-mcp",
    result: "stdio MCP 工具可用",
    ...extra,
  };
}

async function main() {
  const live = await resolveLiveBase();
  const base = live.base;
  console.log("桥入口：" + base + "（来源 " + live.source + "）");

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const sessionPending = "mcp-selftest-" + stamp + "-pending";
  const sessionTimeout = "mcp-selftest-" + stamp + "-timeout";
  const sessionWait = "mcp-selftest-" + stamp + "-wait";
  const sessionReply = "mcp-selftest-" + stamp + "-reply";

  const tempEndpoint = path.join("/tmp", "bridge-mcp-endpoint-" + stamp + ".json");
  const deadEndpoint = path.join("/tmp", "bridge-mcp-dead-" + stamp + ".json");
  const clients = [];

  try {
    /* ---------------- 1. MCP 握手与工具清单 ---------------- */
    const client = new McpClient({ DSH_WEB_URL: base });
    clients.push(client);

    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge-mcp-smoke", version: "1.0.0" },
    });
    assert.equal(init.serverInfo.name, "bridge-mcp", "serverInfo.name 不正确");
    assert.equal(init.protocolVersion, "2025-06-18", "initialize 未回显客户端协议版本");
    assert.ok(init.capabilities.tools, "capabilities.tools 缺失");
    pass("initialize", "serverInfo=" + init.serverInfo.name + "@" + init.serverInfo.version);

    client.notify("notifications/initialized", {});
    await sleep(50);

    const list = await client.request("tools/list", {});
    const names = (list.tools || []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["bridge_pending", "bridge_reply", "bridge_wait"], "工具清单不正确：" + names.join(","));
    for (const tool of list.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name + " 缺少 object inputSchema");
    }
    pass("tools/list", "3 tools: " + names.join(", "));

    const ping = await client.request("ping", {});
    assert.deepEqual(ping, {}, "ping 应返回空对象");
    pass("ping");

    /* ---------------- 2. bridge_pending ---------------- */
    const empty = await callTool(client, "bridge_pending", { agent: sessionPending });
    assert.equal(empty.isError, false, "空会话 bridge_pending 不应报错：" + empty.text);
    assert.equal(empty.value.pendingCount, 0);
    assert.deepEqual(empty.value.messages, []);
    pass("bridge_pending 空会话", "session=" + sessionPending);

    /* ---------------- 3. bridge_wait 超时 ---------------- */
    const timeoutStart = Date.now();
    const timedOut = await callTool(client, "bridge_wait", { agent: sessionTimeout, timeoutSec: 2 }, 15000);
    const timeoutElapsed = Date.now() - timeoutStart;
    assert.equal(timedOut.isError, false, "bridge_wait 超时不应报错：" + timedOut.text);
    assert.equal(timedOut.value.timedOut, true);
    assert.equal(timedOut.value.message, null);
    assert.ok(timeoutElapsed >= 1900 && timeoutElapsed < 8000, "超时时长异常：" + timeoutElapsed + "ms");
    pass("bridge_wait 超时", timeoutElapsed + "ms");

    /* ---------------- 4. bridge_wait 轮询到新消息 ---------------- */
    const waitStart = Date.now();
    const waitPromise = callTool(client, "bridge_wait", { agent: sessionWait, timeoutSec: 10 }, 20000);
    await sleep(1200);
    const waitRequest = await postDeepSeekRequest(base, sessionWait, "MCP 自测：wait 取件");
    const waited = await waitPromise;
    const waitElapsed = Date.now() - waitStart;
    assert.equal(waited.isError, false, "bridge_wait 报错：" + waited.text);
    assert.equal(waited.value.timedOut, false);
    assert.equal(waited.value.message.id, waitRequest.id, "bridge_wait 返回了错误的消息");
    assert.equal(waited.value.message.goal, "MCP 自测：wait 取件");
    assert.equal(waited.value.message.status, "received");
    assert.ok(waitElapsed >= 900 && waitElapsed < 9000, "轮询时长异常：" + waitElapsed + "ms");
    pass("bridge_wait 轮询取件", "elapsed=" + waitElapsed + "ms id=" + waitRequest.id);

    /* ---------------- 5. pending 能看到未回执消息 ---------------- */
    const pending = await callTool(client, "bridge_pending", { agent: sessionWait });
    assert.equal(pending.value.pendingCount, 1, "应恰好有 1 条待处理");
    assert.equal(pending.value.messages[0].id, waitRequest.id);
    pass("bridge_pending 未回执消息", "id=" + waitRequest.id);

    /* ---------------- 6. bridge_reply 自动定位会话 ---------------- */
    const reply = await callTool(client, "bridge_reply", replyPayload(waitRequest.id), 40000);
    assert.equal(reply.isError, false, "bridge_reply 报错：" + reply.text);
    assert.equal(reply.value.ok, true);
    assert.equal(reply.value.sessionId, sessionWait, "自动定位会话失败：" + reply.value.sessionId);
    assert.equal(reply.value.persisted, true);
    assert.equal(reply.value.message.replyToMessageId, waitRequest.id);
    assert.equal(reply.value.message.direction, "codex-to-deepseek");
    assert.equal(reply.value.message.kind, "result");
    assert.ok(reply.value.message.id, "回执缺少消息 id");
    assert.match(reply.text, /workDone|toolsUsed|result/);
    if (reply.value.delivered === false) {
      assert.match(String(reply.value.warning), /SESSION_NOT_BOUND/, "未绑定会话时应给出 SESSION_NOT_BOUND 警告");
    }
    pass("bridge_reply 自动定位", "session=" + reply.value.sessionId + " delivered=" + reply.value.delivered);

    /* ---------------- 7. 回执后 pending 清零 ---------------- */
    const afterReply = await callTool(client, "bridge_pending", { agent: sessionWait });
    assert.equal(afterReply.value.pendingCount, 0, "已回执消息不应再次 pending");
    pass("回执后 pending 清零");

    /* ---------------- 8. bridge_reply 显式 agent ---------------- */
    const explicitRequest = await postDeepSeekRequest(base, sessionReply, "MCP 自测：显式 agent 回执");
    const explicitReply = await callTool(
      client,
      "bridge_reply",
      replyPayload(explicitRequest.id, { agent: sessionReply }),
      30000,
    );
    assert.equal(explicitReply.isError, false, "显式 agent 回执报错：" + explicitReply.text);
    assert.equal(explicitReply.value.sessionId, sessionReply);
    assert.equal(explicitReply.value.message.replyToMessageId, explicitRequest.id);
    pass("bridge_reply 显式 agent", "session=" + sessionReply);

    /* ---------------- 9. 错误路径 ---------------- */
    const badAgent = await callTool(client, "bridge_pending", { agent: "bad id!" });
    assert.equal(badAgent.isError, true, "非法 agent 应报错");
    assert.match(badAgent.text, /agent/);
    pass("错误路径 bridge_pending 非法 agent");

    const missingField = await callTool(client, "bridge_reply", { replyToMessageId: explicitRequest.id, goal: "x" });
    assert.equal(missingField.isError, true, "缺字段应报错");
    assert.match(missingField.text, /action/);
    pass("错误路径 bridge_reply 缺字段");

    const unknownTool = await callTool(client, "bridge_nope", {});
    assert.equal(unknownTool.isError, true, "未知工具应报错");
    assert.match(unknownTool.text, /未知工具/);
    pass("错误路径 未知工具");

    let rpcError = null;
    try {
      await client.request("no/such/method", {});
    } catch (error) {
      rpcError = error;
    }
    assert.ok(rpcError, "未知 JSON-RPC 方法应返回错误");
    assert.match(String(rpcError.message), /-32601/, "未知方法应使用 -32601");
    pass("错误路径 未知 JSON-RPC 方法", rpcError.message);

    const badReplyRef = await callTool(
      client,
      "bridge_reply",
      replyPayload("20990101000000-zzzzzz", { agent: sessionReply }),
      15000,
    );
    assert.equal(badReplyRef.isError, true, "不存在的 replyToMessageId 应报错");
    assert.match(badReplyRef.text, /INVALID_REPLY_REFERENCE|400/);
    pass("错误路径 不存在的 replyToMessageId");

    /* ---------------- 10. 入口发现优先级 ---------------- */
    await writeFile(tempEndpoint, JSON.stringify({ base }) + "\n", { mode: 0o600 });
    await writeFile(deadEndpoint, JSON.stringify({ base: "http://127.0.0.1:1" }) + "\n", { mode: 0o600 });

    const previousEnv = {
      DSH_WEB_URL: process.env.DSH_WEB_URL,
      CODEX_BRIDGE_ENDPOINT_FILE: process.env.CODEX_BRIDGE_ENDPOINT_FILE,
    };
    try {
      process.env.DSH_WEB_URL = base;
      process.env.CODEX_BRIDGE_ENDPOINT_FILE = deadEndpoint;
      const primary = await discoverCandidates();
      assert.equal(primary[0].base, normalizeBase(base), "DSH_WEB_URL 必须是第一优先级");
      assert.match(primary[0].source, /^env:/);

      process.env.DSH_WEB_URL = "http://127.0.0.1:1";
      process.env.CODEX_BRIDGE_ENDPOINT_FILE = tempEndpoint;
      const secondary = await discoverCandidates();
      assert.equal(secondary[0].base, "http://127.0.0.1:1", "第一优先级应是环境变量");
      assert.ok(
        secondary.some((row) => row.base === normalizeBase(base) && row.source === "file:" + tempEndpoint + "#base"),
        "bridge-endpoint.json 必须是第二优先级",
      );

      assert.equal(normalizeBase("http://example.com:1234"), "", "必须拒绝非 loopback 入口");
      assert.equal(normalizeBase("127.0.0.1:62965"), "http://127.0.0.1:62965", "无 scheme 时应补 http://");
    } finally {
      if (previousEnv.DSH_WEB_URL === undefined) delete process.env.DSH_WEB_URL;
      else process.env.DSH_WEB_URL = previousEnv.DSH_WEB_URL;
      if (previousEnv.CODEX_BRIDGE_ENDPOINT_FILE === undefined) delete process.env.CODEX_BRIDGE_ENDPOINT_FILE;
      else process.env.CODEX_BRIDGE_ENDPOINT_FILE = previousEnv.CODEX_BRIDGE_ENDPOINT_FILE;
    }
    pass("入口发现优先级", "env > bridge-endpoint.json(base)");

    /* ---------------- 11. 无环境变量走 endpoint 文件 + 插件发现回退 ---------------- */
    const endpointClient = new McpClient({ CODEX_BRIDGE_ENDPOINT_FILE: tempEndpoint }, ["DSH_WEB_URL"]);
    clients.push(endpointClient);
    const viaEndpoint = await callTool(endpointClient, "bridge_pending", { agent: sessionPending });
    assert.equal(viaEndpoint.isError, false, "仅靠 bridge-endpoint.json 时 bridge_pending 失败：" + viaEndpoint.text);
    assert.equal(viaEndpoint.value.pendingCount, 0);
    pass("入口发现 bridge-endpoint.json（无 DSH_WEB_URL）");

    const discoveryClient = new McpClient({ CODEX_BRIDGE_ENDPOINT_FILE: deadEndpoint }, ["DSH_WEB_URL"]);
    clients.push(discoveryClient);
    const viaDiscovery = await callTool(discoveryClient, "bridge_pending", { agent: sessionPending });
    assert.equal(viaDiscovery.isError, false, "endpoint 指向死端口时应回退到插件发现文件：" + viaDiscovery.text);
    assert.equal(viaDiscovery.value.pendingCount, 0);
    pass("入口回退 插件发现文件", DISCOVERY_FILE);

    console.log("\nALL " + passed + " CHECKS PASSED");
    console.log("测试会话：" + [sessionPending, sessionTimeout, sessionWait, sessionReply].join(", "));
  } finally {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        // 忽略子进程关闭错误。
      }
    }
    await unlink(tempEndpoint).catch(() => {});
    await unlink(deadEndpoint).catch(() => {});
  }
}

main().catch((error) => {
  fail("stdio-smoke", error);
  process.exitCode = 1;
});
