import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply, buildDeliveryPrompt, createBridge } from "../lib/index.js";
import { collaborationWindowHtml, selectCollaborationSession } from "../lib/window-page.js";

test("rejects messages until the session is explicitly authorized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  const bridge = createBridge({ root });
  const result = await bridge.message({
    sessionId: "s1", goal: "g", action: "a", boundary: "b", returnExpected: "r",
  });
  assert.equal(result.status, 403);
});

test("writes an authorized exchange to the inbox and append-only logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  const bridge = createBridge({ root, now: () => new Date("2026-08-21T16:00:00.000Z") });
  assert.equal((await bridge.authorize({ sessionId: "bridge-mvp", task: "MVP", authorized: true })).status, 200);
  const sent = await bridge.message({
    sessionId: "bridge-mvp", taskId: "daily-office-20260927", taskCardRef: "tasks/daily_office.md", taskStatus: "in_progress", workspaceRef: "dshworkspace", goal: "协作", context: "并行", action: "检查队列", workDone: "读取队列", toolsUsed: "桥接 API", result: "队列正常", boundary: "不重启", returnExpected: "回复状态",
  });
  assert.equal(sent.status, 201);
  const inbox = JSON.parse(await readFile(path.join(root, "inbox", `${sent.value.message.id}.json`), "utf8"));
  assert.equal(inbox.action, "检查队列");
  assert.equal(inbox.sender, "Codex");
  assert.equal(inbox.recipient, "DeepSeek");
  assert.equal(inbox.workDone, "读取队列");
  assert.equal(inbox.toolsUsed, "桥接 API");
  assert.equal(inbox.result, "队列正常");
  assert.equal(inbox.taskId, "daily-office-20260927");
  assert.equal(inbox.taskCardRef, "tasks/daily_office.md");
  assert.equal(inbox.taskStatus, "in_progress");
  assert.equal(inbox.workspaceRef, "dshworkspace");
  const conversation = await bridge.messages("bridge-mvp");
  assert.equal(conversation.status, 200);
  assert.equal(conversation.value.messages.length, 1);
  assert.equal(conversation.value.messages[0].direction, "codex-to-deepseek");
  const log = await readFile(path.join(root, "logs", "bridge-exchanges.md"), "utf8");
  assert.match(log, /GOAL: 协作/);
  assert.match(log, /task: daily-office-20260927/);
  assert.match(log, /task card: tasks\/daily_office\.md/);
  await bridge.close({ sessionId: "bridge-mvp" });
  assert.equal((await bridge.message({ sessionId: "bridge-mvp", goal: "g", action: "a", boundary: "b", returnExpected: "r" })).status, 403);
});

test("rejects unsafe session identifiers and incomplete protocol messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  const bridge = createBridge({ root });
  assert.equal((await bridge.authorize({ sessionId: "../escape", task: "x", authorized: true })).status, 400);
  await bridge.authorize({ sessionId: "safe", task: "x", authorized: true });
  assert.equal((await bridge.message({ sessionId: "safe", goal: "g" })).status, 400);
});

test("delivers to a bound Harness session and records status transitions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  const dispatched = [];
  const bridge = createBridge({ root, dispatch: async (record, session) => dispatched.push({ record, session }) });
  await bridge.authorize({ sessionId: "linked", task: "test", authorized: true, dshSessionId: "session-real" });
  const sent = await bridge.message({
    sessionId: "linked", goal: "g", action: "a", boundary: "b", returnExpected: "r",
  });
  assert.equal(sent.value.message.status, "delivered");
  assert.equal(dispatched[0].session.dshSessionId, "session-real");
  const updated = await bridge.update({ sessionId: "linked", messageId: sent.value.message.id, status: "read" });
  assert.equal(updated.value.message.status, "read");
});

test("uses the injected Harness prompt method with a request id, queue mode, and AbortSignal", async () => {
  const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(source, /ctx\.sessionController\.prompt\([\s\S]*?requestId: randomUUID\(\)[\s\S]*?mode: "queue"[\s\S]*?new AbortController\(\)\.signal/);
  assert.doesNotMatch(source, /ctx\.sessionController\.session\.prompt\(/);
  const prompt = buildDeliveryPrompt({ id: "m-1", taskId: "task-1", taskCardRef: "tasks/task.md", taskStatus: "active", workspaceRef: "shared", goal: "g", context: "", action: "a", workDone: "", toolsUsed: "", result: "", boundary: "b", returnExpected: "r" });
  assert.match(prompt, /^\[Bridge m-1\]/);
  assert.match(prompt, /TASK_ID: task-1/);
  assert.match(prompt, /TASK_CARD: tasks\/task\.md/);
  assert.match(prompt, /WORKSPACE: shared/);
  assert.match(prompt, /REPLY:.*replyToMessageId=m-1/);
  assert.doesNotMatch(prompt, /CONTEXT:|WORK:|TOOLS:|RESULT:|协作约束/);
});

test("defaults to an authorized session and preserves an explicit history selection", () => {
  const sessions = [
    { id: "api-regression-0926", authorized: false },
    { id: "verify-0926", authorized: true },
  ];
  assert.equal(selectCollaborationSession(sessions, "api-regression-0926").id, "verify-0926");
  assert.equal(selectCollaborationSession(sessions, "api-regression-0926", true).id, "api-regression-0926");
  assert.equal(selectCollaborationSession([{ id: "closed", authorized: false }], "missing").id, "closed");
  const html = collaborationWindowHtml();
  assert.match(html, /let userSelectedSession=false/);
  assert.match(html, /const current=userSelectedSession\?session\.value:''/);
  assert.match(html, /selectCollaborationSession\(rows,current,userSelectedSession\)/);
  assert.match(html, /const apiRoot='\/codex-collab'/);
  assert.match(html, /apiRoot\+'\/network'/);
  assert.match(html, /window-data/);
  assert.match(html, /session\.onchange=\(\)=>\{userSelectedSession=true;refresh\(\)\}/);
  assert.match(html, /多 Harness 协作对话/);
  assert.match(html, /sender\+' → '\+receiver/);
  assert.match(html, /s\.purpose==='test'\?'\[联调\] '/);
  assert.match(html, /回复 #/);
  assert.match(html, /投递错误：/);
  assert.match(html, /任务 ID \/ 任务卡/);
});

test("serves standalone collaboration data from a loopback-only route outside authenticated /api", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-window-"));
  const routes = new Map();
  const dispatched = [];
  const ctx = {
    webServer: { host: "127.0.0.1", port: 19387, register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    sessionController: { prompt: async (request) => dispatched.push(request) },
    effect(fn) { return fn(); },
  };
  apply(ctx, { root });
  const route = routes.get("/codex-collab");
  assert.ok(route);
  const bridge = createBridge({ root });
  await bridge.authorize({ sessionId: "visible", task: "Visible session", authorized: true, dshSessionId: "session-real" });
  const response = { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = "") { this.body = body; } };
  await route.handler({ method: "GET", url: "/codex-collab/window", socket: { remoteAddress: "127.0.0.1" } }, response);
  assert.equal(response.status, 200);
  assert.match(response.body, /多 Harness 协作对话/);
  const dataResponse = { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = "") { this.body = body; } };
  await route.handler({ method: "GET", url: "/codex-collab/window-data", socket: { remoteAddress: "127.0.0.1" } }, dataResponse);
  assert.equal(dataResponse.status, 200);
  assert.ok(JSON.parse(dataResponse.body).sessions.some((row) => row.id === "visible"));
  const denied = { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = "") { this.body = body; } };
  await route.handler({ method: "GET", url: "/codex-collab/window-data", socket: { remoteAddress: "203.0.113.4" } }, denied);
  assert.equal(denied.status, 403);
  const messageResponse = { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = "") { this.body = body; } };
  const payload = { sessionId: "visible", clientMessageId: "opencode-mock-1", taskId: "task-mock", goal: "Mock dispatch", action: "No model call", boundary: "Mock only", returnExpected: "Captured by test" };
  const request = { method: "POST", url: "/codex-collab/message", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload)); } };
  await route.handler(request, messageResponse);
  assert.equal(messageResponse.status, 201);
  const delivered = JSON.parse(messageResponse.body).message;
  assert.equal(delivered.sender, "OpenCode");
  assert.equal(delivered.recipient, "DeepSeek");
  assert.equal(delivered.status, "delivered");
  assert.equal(dispatched.length, 1);
  const rejectedMessage = { ...request, headers: { origin: "https://example.com" } };
  const originDenied = { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = "") { this.body = body; } };
  await route.handler(rejectedMessage, originDenied);
  assert.equal(originDenied.status, 403);
});

test("covers both message directions, all status updates, retry, close, and missing session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  let attempts = 0;
  const bridge = createBridge({ root, dispatch: async () => { attempts++; } });
  assert.equal((await bridge.messages()).value.error, "INVALID_SESSION");
  await bridge.authorize({ sessionId: "api", task: "API regression", authorized: true, dshSessionId: "session-real", purpose: "test" });
  assert.equal((await bridge.status()).sessions.find((s) => s.id === "api").purpose, "test");
  const codex = await bridge.message({ sessionId: "api", goal: "g", action: "a", boundary: "b", returnExpected: "r" });
  assert.equal(codex.value.message.status, "delivered");
  const mismatchedReply = await bridge.message({ sessionId: "api", direction: "deepseek-to-codex", goal: "g", action: "reply", boundary: "b", returnExpected: "r", replyToMessageId: "missing" });
  assert.equal(mismatchedReply.value.error, "INVALID_REPLY_REFERENCE");
  assert.equal((await bridge.retry({ sessionId: "api", messageId: codex.value.message.id })).value.error, "MESSAGE_NOT_RETRYABLE");
  const dsh = await bridge.message({ sessionId: "api", direction: "deepseek-to-codex", sender: "OpenCode", recipient: "Codex", kind: "result", goal: "g", action: "reply", boundary: "b", returnExpected: "r", replyToMessageId: codex.value.message.id });
  assert.equal(dsh.value.message.status, "received");
  assert.equal(dsh.value.message.sender, "OpenCode");
  assert.equal(dsh.value.message.recipient, "Codex");
  assert.equal(dsh.value.message.replyToMessageId, codex.value.message.id);
  for (const status of ["read", "processing", "completed"]) {
    assert.equal((await bridge.update({ sessionId: "api", messageId: dsh.value.message.id, status })).value.message.status, status);
  }
  assert.equal(attempts, 1);
  assert.equal((await bridge.close({ sessionId: "api" })).value.session.authorized, false);
  assert.equal((await bridge.message({ sessionId: "api", goal: "g", action: "a", boundary: "b", returnExpected: "r" })).status, 403);
});

test("keeps a durable failed-delivery record for retry and diagnosis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  const bridge = createBridge({ root, dispatch: async () => { throw new Error("offline"); } });
  await bridge.authorize({ sessionId: "linked", task: "test", authorized: true, dshSessionId: "session-real" });
  const sent = await bridge.message({
    sessionId: "linked", goal: "g", action: "a", boundary: "b", returnExpected: "r",
  });
  assert.equal(sent.value.message.status, "delivery-failed");
  assert.match(sent.value.message.deliveryError, /offline/);
  assert.equal((await bridge.messages("linked")).value.messages[0].status, "delivery-failed");
});

test("deduplicates client retries and can redeliver a persisted failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  let fail = true;
  let attempts = 0;
  const bridge = createBridge({ root, dispatch: async () => { attempts++; if (fail) throw new Error("offline"); } });
  await bridge.authorize({ sessionId: "linked", task: "test", authorized: true, dshSessionId: "session-real" });
  const payload = { clientMessageId: "client-1", sessionId: "linked", goal: "g", action: "a", boundary: "b", returnExpected: "r" };
  const first = await bridge.message(payload);
  const duplicate = await bridge.message(payload);
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(duplicate.value.message.id, first.value.message.id);
  assert.equal(attempts, 1);
  fail = false;
  const retried = await bridge.retry({ sessionId: "linked", messageId: first.value.message.id });
  assert.equal(retried.value.message.status, "delivered");
  assert.equal(attempts, 2);
});

test("keeps retry failures persisted and retryable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-"));
  let fail = true;
  const bridge = createBridge({ root, dispatch: async () => { if (fail) throw new Error("still offline"); } });
  await bridge.authorize({ sessionId: "linked", task: "test", authorized: true, dshSessionId: "session-real" });
  const sent = await bridge.message({ sessionId: "linked", goal: "g", action: "a", boundary: "b", returnExpected: "r" });
  const retry = await bridge.retry({ sessionId: "linked", messageId: sent.value.message.id });
  assert.equal(retry.status, 502);
  assert.equal(retry.value.message.status, "delivery-failed");
  assert.match(retry.value.message.deliveryError, /still offline/);
  fail = false;
  assert.equal((await bridge.retry({ sessionId: "linked", messageId: sent.value.message.id })).status, 200);
});
