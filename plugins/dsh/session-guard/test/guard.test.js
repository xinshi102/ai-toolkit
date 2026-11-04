/**
 * 守卫纯逻辑单测：判定、包装、幂等、还原、会话枚举、候选路径。
 * 全部离线（不依赖 DSH 安装）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  blockMessage,
  classifyAppend,
  guardSession,
  hostModuleCandidates,
  liveSessions,
  normalizeSession,
  resolveKnownTypes,
  resolveVocabulary,
} from "../lib/index.js";

const KNOWN = new Set(["tool/call", "tool/result", "user/message", "compaction/prune"]);

/**
 * 真机测试用的宿主模块候选：优先正在运行的这个宿主（`process.resourcesPath`），
 * 其次社区版 DSH Desktop 的未打包布局。都不在则相关用例跳过。
 */
const REAL_HOST_FILES = [
  ...(typeof process.resourcesPath === "string" ? hostModuleCandidates({}, {}, process.resourcesPath) : []),
  "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js",
];

/** 逐个候选尝试 import 真实宿主模块；都不可达返回 undefined。 */
async function loadRealHostModule() {
  for (const file of REAL_HOST_FILES) {
    if (!existsSync(file)) continue;
    try {
      return { mod: await import(pathToFileURL(file).href), file };
    } catch {
      /* 换下一个候选（官方桌面版的 asar 在纯 node 下本来就读不到） */
    }
  }
  return undefined;
}

function fakeSession() {
  const calls = [];
  return {
    calls,
    append(type, data, ...opts) {
      calls.push({ type, data, opts });
      return { type };
    },
  };
}

/* ── classifyAppend ───────────────────────────────────────────────────── */

test("classifyAppend：词表内放行、词表外拒绝", () => {
  assert.deepEqual(classifyAppend(KNOWN, "tool/call"), { safe: true });
  const bad = classifyAppend(KNOWN, "plan/node");
  assert.equal(bad.safe, false);
  assert.match(bad.reason, /plan\/node/u);
  assert.match(bad.reason, /不在宿主事件词表内/u);
});

test("classifyAppend：非字符串/空类型一律拒绝（宿主信封要求 string）", () => {
  for (const value of [undefined, null, 42, {}, [], true, ""]) {
    const verdict = classifyAppend(KNOWN, value);
    assert.equal(verdict.safe, false, `${String(value)} 应被拒`);
  }
});

test("classifyAppend：没有词表时不判定（unchecked，放行）", () => {
  assert.deepEqual(classifyAppend(undefined, "whatever/type"), { safe: true, unchecked: true });
  assert.deepEqual(classifyAppend(new Set(), "whatever/type"), { safe: true, unchecked: true });
  assert.deepEqual(classifyAppend(null, "whatever/type"), { safe: true, unchecked: true });
});

/* ── guardSession ─────────────────────────────────────────────────────── */

test("guardSession：官方类型正常透传（含 opts 与 this）", () => {
  const session = fakeSession();
  guardSession(session, KNOWN);
  const opts = { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 } };
  const returned = session.append("tool/result", { a: 1 }, opts);
  assert.deepEqual(returned, { type: "tool/result" });
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].type, "tool/result");
  assert.equal(session.calls[0].opts[0], opts);
});

test("guardSession：未知类型 fail-closed —— 抛错且**不触达**原 append", () => {
  const session = fakeSession();
  const blocked = [];
  guardSession(session, KNOWN, { onBlock: (type, message) => blocked.push({ type, message }) });
  assert.throws(() => session.append("plan/node", { action: "add" }), /session-guard 拒绝写入/u);
  assert.equal(session.calls.length, 0, "被拦截的写入绝不能落到原 append");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].type, "plan/node");
  assert.match(blocked[0].message, /整份拒读/u);
});

test("guardSession：enforce:false 只告警不阻断", () => {
  const session = fakeSession();
  const blocked = [];
  guardSession(session, KNOWN, { enforce: false, onBlock: (type) => blocked.push(type) });
  session.append("chain/note", { phase: "act" });
  assert.equal(session.calls.length, 1);
  assert.deepEqual(blocked, ["chain/note"]);
});

test("guardSession：无词表时透传（守卫自身降级，绝不阻断）", () => {
  const session = fakeSession();
  guardSession(session, undefined);
  session.append("whatever/type", {});
  assert.equal(session.calls.length, 1);
});

test("guardSession：幂等 —— 重复安装只包一层", () => {
  const session = fakeSession();
  guardSession(session, KNOWN);
  const once = session.append;
  guardSession(session, KNOWN);
  assert.equal(session.append, once, "第二次安装不应再包一层");
  assert.throws(() => session.append("plan/import", {}), /session-guard/u);
});

test("guardSession：disposer 完整还原原型方法", () => {
  const session = fakeSession();
  const original = session.append;
  const dispose = guardSession(session, KNOWN);
  assert.notEqual(session.append, original);
  assert.throws(() => session.append("plan/node", {}), /session-guard/u);
  dispose();
  assert.equal(session.append, original);
  session.append("plan/node", {}); // 还原后不再拦截
  assert.equal(session.calls.length, 1);
});

test("guardSession：目标被冻结时安全 no-op（不抛错）", () => {
  const session = Object.freeze({ append() {} });
  assert.doesNotThrow(() => guardSession(session, KNOWN));
});

test("guardSession：非会话对象安全 no-op", () => {
  for (const value of [undefined, null, 42, {}, { append: "not-a-function" }]) {
    const dispose = guardSession(value, KNOWN);
    assert.equal(typeof dispose, "function");
    assert.doesNotThrow(() => dispose());
  }
});

test("guardSession：onBlock 自身抛错不影响判定", () => {
  const session = fakeSession();
  guardSession(session, KNOWN, { onBlock: () => { throw new Error("observer boom"); } });
  assert.throws(() => session.append("plan/node", {}), /session-guard 拒绝写入/u);
});

test("blockMessage：说明后果与替代做法", () => {
  const text = blockMessage('事件类型 "x" 不在宿主事件词表内');
  assert.match(text, /tool\/call/u);
  assert.match(text, /ignorable/u);
  assert.match(text, /DSH 重启/u);
});

/* ── 会话枚举 / 候选路径 ──────────────────────────────────────────────── */

test("normalizeSession：吃 entry({session}) 与裸 session", () => {
  const session = fakeSession();
  assert.equal(normalizeSession({ id: "s", session }), session);
  assert.equal(normalizeSession(session), session);
  assert.equal(normalizeSession({ id: "s" }), undefined);
});

test("liveSessions：从 ctx.sessions.store 取出并解包", () => {
  const a = fakeSession();
  const b = fakeSession();
  const ctx = { sessions: { store: new Map([["a", { id: "a", session: a }], ["b", { id: "b", session: b }], ["junk", 42]]) } };
  assert.deepEqual(liveSessions(ctx), [a, b]);
});

test("liveSessions：没有 sessions 服务 / store 形状异常时返回空数组", () => {
  assert.deepEqual(liveSessions(undefined), []);
  assert.deepEqual(liveSessions({}), []);
  assert.deepEqual(liveSessions({ sessions: {} }), []);
  assert.deepEqual(liveSessions({ sessions: { store: 42 } }), []);
});

test("hostModuleCandidates：显式配置优先，其余全部来自正在运行的宿主", () => {
  const files = hostModuleCandidates(
    { appDir: "/custom/app" },
    { DSH_DESKTOP_APP: "/env/app" },
    "/res",
  );
  assert.equal(files[0], "/custom/app/node_modules/@deepseek-ai/dsh-session/lib/index.js");
  assert.equal(files[1], "/env/app/node_modules/@deepseek-ai/dsh-session/lib/index.js");
  // 官方桌面版：宿主运行时连依赖一起在 app.asar/dsh 里，优先于 asar 顶层与社区版 app/
  assert.equal(files[2], "/res/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js");
  assert.equal(files[3], "/res/app.asar/node_modules/@deepseek-ai/dsh-session/lib/index.js");
  assert.equal(files[4], "/res/app/node_modules/@deepseek-ai/dsh-session/lib/index.js");
  assert.equal(new Set(files).size, files.length, "不应有重复候选");
});

test("hostModuleCandidates：不得写死任何跨应用的 /Applications 兜底（2026-09-26 故障根因）", () => {
  // 没有显式配置、没有 DSH_DESKTOP_APP 时，候选只能来自 resourcePath；
  // 尤其不能再出现「另一个 app 安装」的路径——那会拿旧版本词表去 fail-closed。
  const files = hostModuleCandidates({}, {}, "/res");
  assert.ok(files.every((file) => file.startsWith("/res/")), `候选必须都锚在当前宿主：${files.join(", ")}`);
  assert.ok(
    !files.some((file) => file.includes("/Applications/")),
    "候选里不该出现写死的应用路径",
  );
  // resourcesPath 不可用（如纯 node 环境）时不猜、返回空 → 调用方降级为只告警。
  // ⚠️ 必须传 `null` 而不是 `undefined`：后者会触发默认参数 `= process.resourcesPath`，
  //    在 Electron 里跑测试时宿主路径是存在的，断言就会假失败。
  assert.deepEqual(hostModuleCandidates({}, {}, null), []);
});

test("hostModuleCandidates：重复的 appDir / env 会被去重", () => {
  const files = hostModuleCandidates({ appDir: "/same/app" }, { DSH_DESKTOP_APP: "/same/app" }, "/same");
  assert.equal(new Set(files).size, files.length);
});

test("resolveVocabulary：回报词表来自哪个文件（可观测性）", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "session-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "dsh-session-stub.js");
  writeFileSync(file, "export const KNOWN_SESSION_EVENT_TYPES = new Set(['tool/call']);\n");
  const resolved = await resolveVocabulary({ candidates: [file] });
  assert.equal(resolved.file, file);
  assert.ok(resolved.known?.has("tool/call"));
});

test("resolveVocabulary：候选都不可达时回报 undefined（调用方降级）", async () => {
  const resolved = await resolveVocabulary({ candidates: ["/definitely/not/here"] });
  assert.equal(resolved.known, undefined);
  assert.equal(resolved.file, undefined);
});

test("resolveKnownTypes：候选都不可达时返回 undefined（调用方降级）", async () => {
  assert.equal(await resolveKnownTypes({ candidates: ["/definitely/not/here", "/also/not/here"] }), undefined);
});

test("resolveKnownTypes：candidates 为空数组时回落到自动探测", async () => {
  // 只断言不抛错且形状正确（有/无本机可读的宿主都成立）
  const known = await resolveKnownTypes({ candidates: [] });
  assert.ok(known === undefined || known instanceof Set);
});

test("resolveKnownTypes：candidates 直接钉死宿主模块路径", async (t) => {
  const host = await loadRealHostModule();
  if (host === undefined) {
    t.skip("本机宿主模块不可读（官方桌面版在纯 node 下读不到 asar），跳过");
    return;
  }
  const known = await resolveKnownTypes({ candidates: [host.file] });
  assert.ok(known?.has("tool/call"), `${host.file} 应导出含 tool/call 的词表`);
});

test("resolveKnownTypes：本机宿主可读时能读到足量词表", async (t) => {
  const host = await loadRealHostModule();
  if (host === undefined) {
    t.skip("本机宿主模块不可读（官方桌面版在纯 node 下读不到 asar），跳过");
    return;
  }
  const known = await resolveKnownTypes({ candidates: [host.file] });
  assert.ok(known instanceof Set);
  assert.ok(known.size > 50, `词表偏小（${known.size}），可能读错模块`);
  assert.ok(known.has("tool/call"));
  assert.ok(!known.has("plan/node"), "plan/node 是历史自定义类型，不该在词表里");
});

/* ── 真机契约：真实 Session 类必须能被包装 ─────────────────────────────── */

test("真机：真实 Session 实例可被包装，未知类型在触达内部状态前就被拦下", async (t) => {
  const host = await loadRealHostModule();
  const mod = host?.mod;
  if (mod === undefined) {
    t.skip("本机宿主模块不可读（官方桌面版在纯 node 下读不到 asar），跳过");
    return;
  }
  const { Session, KNOWN_SESSION_EVENT_TYPES } = mod;
  assert.equal(typeof Session?.prototype?.append, "function", "Session.prototype.append 必须存在（守卫靠遮蔽它工作）");

  const session = Object.create(Session.prototype);
  const original = session.append;
  const dispose = guardSession(session, KNOWN_SESSION_EVENT_TYPES);
  assert.notEqual(session.append, original, "实例上的 append 应被 own property 遮蔽");
  assert.throws(() => session.append("plan/node", { action: "add" }), /session-guard 拒绝写入/u);

  // 官方类型必须放行到原方法（这个裸实例没有内部状态，会以**非守卫**的错因失败，
  // 正好证明它确实走到了真正的 Session.append，而不是被守卫吞掉）
  let reachedOriginal = false;
  try {
    session.append("tool/call", { name: "x" });
    reachedOriginal = true;
  } catch (error) {
    reachedOriginal = !/session-guard/u.test(String(error?.message));
  }
  assert.ok(reachedOriginal, "官方类型必须被放行到原 append");

  dispose();
  assert.equal(session.append, original);
});
