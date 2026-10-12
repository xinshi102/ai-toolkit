/**
 * @local/dsh-prompt-snippets — 主机侧：提示词 snippet 库。
 *
 * 存储：<root>/snippets.json（默认 ~/.dsh/snippets），原子写（tmp + rename），
 * 进程内串行化避免并发写丢更新。
 *
 * 命令族（会话作用域）：
 *   /snippet                     列出全部
 *   /snippet --json              机器可读列表（侧边栏面板用）
 *   /snippet <name>              把 snippet 正文作为用户消息注入会话
 *   /snippet save <name> <正文…>  新建/更新
 *   /snippet rm <name>           删除
 *
 * 零依赖；纯函数导出供测试。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const name = "@local/dsh-prompt-snippets";
export const inject = [];

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

/* ── 纯逻辑（测试 import） ─────────────────────────────────────────────── */

export function parseStore(text) {
  const empty = { version: 1, snippets: {} };
  if (typeof text !== "string" || text.trim() === "") return empty;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (raw === null || typeof raw !== "object" || raw.snippets === null || typeof raw.snippets !== "object") return empty;
  const snippets = {};
  for (const [name, value] of Object.entries(raw.snippets)) {
    if (!NAME_PATTERN.test(name)) continue;
    if (typeof value === "string") snippets[name] = { body: value, updatedAt: 0 };
    else if (value !== null && typeof value === "object" && typeof value.body === "string") snippets[name] = { body: value.body, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 };
  }
  return { version: 1, snippets };
}

export function serializeStore(store) {
  const names = Object.keys(store.snippets).sort();
  const ordered = {};
  for (const name of names) ordered[name] = store.snippets[name];
  return `${JSON.stringify({ version: 1, snippets: ordered }, null, 2)}\n`;
}

export function upsertSnippet(store, name, body, limits = {}) {
  if (!NAME_PATTERN.test(name)) return { ok: false, error: "name 只能包含字母数字-_（1-32 字符）" };
  const maxBody = Number.isInteger(limits.maxBodyChars) ? limits.maxBodyChars : 4000;
  if (typeof body !== "string" || body.trim() === "") return { ok: false, error: "正文不能为空" };
  const clipped = body.trim().slice(0, maxBody);
  if (Object.keys(store.snippets).length >= (Number.isInteger(limits.maxSnippets) ? limits.maxSnippets : 100) && !Object.hasOwn(store.snippets, name)) {
    return { ok: false, error: "snippet 数量已达上限" };
  }
  return {
    ok: true,
    store: { version: 1, snippets: { ...store.snippets, [name]: { body: clipped, updatedAt: Date.now() } } },
  };
}

export function removeSnippet(store, name) {
  if (!Object.hasOwn(store.snippets, name)) return { ok: false, error: `snippet "${name}" 不存在` };
  const snippets = { ...store.snippets };
  delete snippets[name];
  return { ok: true, store: { version: 1, snippets } };
}

export function listSnippets(store) {
  return Object.keys(store.snippets).sort().map((name) => ({
    name,
    body: store.snippets[name].body,
    updatedAt: store.snippets[name].updatedAt,
  }));
}

export function resolveRoot(config = {}) {
  const raw = typeof config.root === "string" && config.root.trim() !== "" ? config.root.trim() : "~/.dsh/snippets";
  return raw.startsWith("~") ? path.join(homedir(), raw.slice(1).replace(/^[/\\]/u, "")) : path.resolve(raw);
}

/* ── 插件体 ───────────────────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const root = resolveRoot(config);
  const limits = {
    maxSnippets: Number.isInteger(config.maxSnippets) ? config.maxSnippets : 100,
    maxBodyChars: Number.isInteger(config.maxBodyChars) ? config.maxBodyChars : 4000,
  };
  const storePath = path.join(root, "snippets.json");
  let chain = Promise.resolve();

  const withStore = (mutate) => chain = chain.then(async () => {
    let store;
    try {
      store = parseStore(await readFile(storePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      store = parseStore("");
    }
    const result = await mutate(store);
    if (result?.ok === true && result.store !== undefined) {
      await mkdir(root, { recursive: true });
      const tmp = `${storePath}.${process.pid}.tmp`;
      await writeFile(tmp, serializeStore(result.store), "utf8");
      await rename(tmp, storePath);
    }
    return result;
  }).catch((error) => ({ ok: false, error: `存储失败：${String(error?.message ?? error).slice(0, 160)}` }));

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "snippet",
      description: "提示词库：/snippet 列表 · /snippet <name> 插入 · save/rm 管理",
      input: { hint: "[name|save <name> <正文>|rm <name>|--json]", attachments: false },
      handler: async ({ agent, rawInput }) => {
        const input = rawInput.trim();
        if (input === "" || input === "--json") {
          const result = await withStore(async (store) => ({ ok: true, list: listSnippets(store) }));
          if (!result.ok) return { kind: "error", text: result.error };
          if (input === "--json") return { kind: "success", text: JSON.stringify(result.list) };
          if (result.list.length === 0) return { kind: "success", text: "snippet 库为空。用 /snippet save <name> <正文> 添加。" };
          return {
            kind: "success",
            text: [`snippet 库（${result.list.length}）：`, ...result.list.map((s) => `  ${s.name} — ${s.body.replace(/\s+/gu, " ").slice(0, 40)}${s.body.length > 40 ? "…" : ""}`)].join("\n"),
          };
        }
        if (input === "save" || input.startsWith("save ")) {
          const rest = input.slice(4).trim();
          const space = rest.search(/\s/u);
          if (space <= 0) return { kind: "error", text: "用法：/snippet save <name> <正文>" };
          const name = rest.slice(0, space);
          const body = rest.slice(space + 1).trim();
          const result = await withStore((store) => upsertSnippet(store, name, body, limits));
          return result.ok ? { kind: "success", text: `已保存 snippet「${name}」` } : { kind: "error", text: result.error };
        }
        if (input === "rm" || input.startsWith("rm ")) {
          const name = input.slice(2).trim();
          if (name === "") return { kind: "error", text: "用法：/snippet rm <name>" };
          const result = await withStore((store) => removeSnippet(store, name));
          return result.ok ? { kind: "success", text: `已删除 snippet「${name}」` } : { kind: "error", text: result.error };
        }
        const name = input.split(/\s+/u)[0];
        const result = await withStore(async (store) => {
          const snippet = store.snippets[name];
          if (snippet === undefined) return { ok: false, error: `snippet "${name}" 不存在；/snippet 查看全部` };
          return { ok: true, body: snippet.body };
        });
        if (!result.ok) return { kind: "error", text: result.error };
        const message = { role: "user", content: [{ type: "text", text: result.body }], source: { kind: "user" } };
        try {
          agent.inject(message);
        } catch {
          agent.steer(message);
        }
        return { kind: "success", text: `已插入 snippet「${name}」` };
      },
    });
  });
}
