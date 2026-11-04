#!/usr/bin/env node
/**
 * codex-bridge-cli — 把一次 codex exec 会话原样记进协作桥。
 *
 * 用法：
 *   node scripts/codex-bridge-cli.mjs --task "验收桥" --cwd /path --sandbox read-only "给 Codex 的提示"
 *   node scripts/codex-bridge-cli.mjs --record <文件> --task "补录"
 *
 * 原则：不摘要、不改写；原始输出原样入桥，超长时保留首尾并在 workDone 给出完整原文路径。
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CODEX = process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const ROOT = path.join(homedir(), "Documents/deepseek/codex-collab");
const LOGS = path.join(ROOT, "logs");
mkdirSync(LOGS, { recursive: true });

const argv = process.argv.slice(2);
function take(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}
const task = take("--task", "");
const cwd = take("--cwd", process.cwd());
const sandbox = take("--sandbox", "read-only");
const recordFile = take("--record", "");
const sessionId = take("--session", "");
const promptFile = take("--prompt-file", "");

function bridgeBase() {
  const fromEnv = process.env.DSH_WEB_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  try {
    const info = JSON.parse(readFileSync(path.join(ROOT, "bridge-server.json"), "utf8"));
    return "http://127.0.0.1:" + info.port;
  } catch {
    return "http://127.0.0.1:19387";
  }
}
const BASE = bridgeBase();
// 把当前入口写给 Codex 侧取件器（端口每次重启会变）
try {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(ROOT, "bridge-endpoint.json"), JSON.stringify({ base: BASE, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
} catch {}

async function call(op, body) {
  const res = await fetch(BASE + "/api/codex-bridge/" + op, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, value: await res.json().catch(() => null) };
}

function clip(text, limit) {
  const value = String(text == null ? "" : text);
  const cap = limit || 7500;
  if (value.length <= cap) return value;
  const half = Math.floor(cap / 2);
  return value.slice(0, half) + "\n…（中段省略，完整原文见 workDone）…\n" + value.slice(-half);
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function main() {
  const id = sessionId || "cli-" + stamp();
  const title = task || "Codex CLI 会话";
  const auth = await call("authorize", { sessionId: id, task: "[CLI] " + title, purpose: "work" });
  if (auth.status !== 200) {
    console.error("bridge authorize failed", auth.status, auth.value);
    process.exit(2);
  }

  if (recordFile) {
    const raw = readFileSync(recordFile, "utf8");
    const name = path.basename(recordFile);
    const msg = await call("message", {
      sessionId: id,
      direction: "deepseek-to-codex",
      kind: "request",
      taskId: "cli-record-" + name,
      goal: "补录既有 CLI 原文：" + name,
      context: clip(raw),
      action: "原样入桥，不加工",
      boundary: "仅记录，不执行",
      returnExpected: "无（补录）",
    });
    console.log("recorded " + recordFile + " -> " + id + " (" + msg.status + ")");
    return;
  }

  const prompt = promptFile ? readFileSync(promptFile, "utf8") : argv.join(" ");
  if (!prompt.trim()) {
    console.error("empty prompt");
    process.exit(2);
  }

  const request = await call("message", {
    sessionId: id,
    direction: "deepseek-to-codex",
    kind: "request",
    taskId: "cli-" + stamp(),
    goal: clip(title, 200),
    context: prompt,
    action: "codex exec（原始输出入桥）",
    boundary: "sandbox=" + sandbox + "; cwd=" + cwd + "; 不改写输出",
    returnExpected: "原始输出回执",
  });
  const messageId = request.value && request.value.message ? request.value.message.id : "";
  console.log("[bridge] request " + messageId + " session=" + id);

  const logFile = path.join(LOGS, "cli-" + id + ".log");
  const out = createWriteStream(logFile, { mode: 0o600 });
  out.write("$ " + CODEX + " exec --skip-git-repo-check -s " + sandbox + " -C " + cwd + "\n\n");

  const child = spawn(CODEX, ["exec", "--skip-git-repo-check", "-s", sandbox, "-C", cwd, prompt], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const collect = (chunk) => {
    const text = chunk.toString();
    buffer += text;
    out.write(text);
  };
  if (messageId) await call("update", { sessionId: id, messageId, status: "processing" });
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise((resolve) => child.on("close", resolve));
  out.end();

  if (messageId) await call("update", { sessionId: id, messageId, status: "completed" });

  const result = await call("message", {
    sessionId: id,
    direction: "codex-to-deepseek",
    kind: "result",
    taskId: "cli-" + stamp(),
    goal: clip(title, 200),
    context: "exit=" + code + "; log=" + logFile,
    action: "codex exec 完成",
    boundary: "原始输出，未二次加工",
    returnExpected: "—",
    workDone: "exit=" + code + "; 完整原文：" + logFile,
    toolsUsed: "codex exec",
    result: clip(buffer),
  });
  console.log("[bridge] result " + (result.value && result.value.message ? result.value.message.id : result.status));
  console.log("[bridge] log " + logFile);
  process.exit(code === 0 ? 0 : (code == null ? 1 : code));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
