/**
 * @local/dsh-session-guard — 会话日志**写入守卫**（fail-closed）。
 *
 * 为什么需要它（2026-09-24 实际踩雷）：
 *   `session.append(type, data)` 不做词汇校验，但宿主**读回**时会走
 *   `dsh-session-persistence` 的 `validateStoredEvents`：
 *     未知事件类型 && `ignorable !== true` ⇒ **整份日志拒读**
 *     （"contains event type … unknown to this harness and not marked ignorable;
 *       refusing to interpret the log"）。
 *   而 `append(type, data, ...opts)` 的 opts 只承载 `surfaceOp` / `sourceEventSeqs`
 *   —— **插件根本没有渠道**给事件信封加 `ignorable`（见 dsh-session 的 append 实现）。
 *   于是本地插件只要有一次写了一笔自定义类型，那个会话就永久打不开；
 *   如果它落在启动时要读的日志上，还会拖累 DSH 启动。
 *
 * 守卫做什么：
 *   在每个真实 `Session` 实例上包一层 `append`：写入前把事件类型和**宿主自己的**
 *   `KNOWN_SESSION_EVENT_TYPES`（从应用内 `@deepseek-ai/dsh-session` 导入，
 *   与宿主同一份词表）比对；未知类型 ⇒ 抛错阻止写入（fail-closed），
 *   日志因此永远不会被写坏，DSH 永远能重启。
 *
 * 安全约束（守卫自身绝不能成为新的故障源）：
 *   - 所有钩子（`session/created` 监听器）内部 **绝不抛错**——`SessionStore.announce()`
 *     不隔离监听器异常，抛出会把会话 attach 回滚；
 *   - 定位不到宿主词表 ⇒ 自动降级为「只告警」模式，不阻断任何写入；
 *   - 每次判定都套 try/catch，守卫自身的异常一律放行原调用；
 *   - 幂等：同一会话重复安装只包一层，disposer 可完整还原；
 *   - `enforce: false` 可一键切成只告警；`disabled: true` 可整个插件停用。
 *
 * 零依赖；纯函数导出供测试。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const name = "@local/dsh-session-guard";
export const inject = ["sessions"];

/** 安装标记（跨模块实例稳定；挂在 session 实例上，避免重复包装）。 */
const WRAP_MARK = Symbol.for("@local/dsh-session-guard#wrapped");
/**
 * 宿主 app 目录在 `process.resourcesPath` 下的候选布局（按优先级）。
 *   - `app.asar/dsh`：官方桌面版（DeepSeek Harness.app）把宿主运行时连同自己的
 *     依赖打进 asar，`dsh-session` 在 `app.asar/dsh/node_modules/` 下；
 *   - `app.asar`：假设依赖被提升到 asar 顶层；
 *   - `app`：社区版 DSH Desktop 的未打包布局。
 * 三者都从**正在运行的这个宿主**派生，因此不会读到别的安装的旧词表。
 */
const HOST_APP_SUBDIRS = ["app.asar/dsh", "app.asar", "app"];
/** 宿主词表所在模块（相对应用目录）。 */
const HOST_MODULE = ["node_modules", "@deepseek-ai", "dsh-session", "lib", "index.js"];

/* ── 纯逻辑（测试 import） ─────────────────────────────────────────────── */

/**
 * 候选宿主模块路径（去重、保序）。
 * 优先级：显式配置 → `DSH_DESKTOP_APP` → `process.resourcesPath` 下的三种布局
 * （`app.asar/dsh`、`app.asar`、`app`）。
 *
 * ⚠️ 这里**不设**任何写死的 `/Applications/...` 兜底（2026-09-26 的教训）：
 * 曾经兜底到社区版 `DSH Desktop.app` 的 app 目录，于是官方桌面版（宿主把代码打进
 * `app.asar`、`resourcesPath/app` 不存在）会静默用**另一个安装**的旧词表做判定，
 * 把宿主自己合法的 `developer/message` 当成未知类型拦住。宁可定位不到而降级为
 * 「只告警」，也绝不用别的应用/别的版本的词表去 fail-closed。
 */
export function hostModuleCandidates(config = {}, env = process.env, resourcesPath = process.resourcesPath) {
  const dirs = [];
  const push = (dir) => {
    if (typeof dir !== "string") return;
    const trimmed = dir.trim();
    if (trimmed === "" || dirs.includes(trimmed)) return;
    dirs.push(trimmed);
  };
  if (typeof config.appDir === "string") push(config.appDir);
  if (typeof env?.DSH_DESKTOP_APP === "string") push(env.DSH_DESKTOP_APP);
  if (typeof resourcesPath === "string" && resourcesPath.trim() !== "") {
    for (const sub of HOST_APP_SUBDIRS) push(path.join(resourcesPath.trim(), sub));
  }
  const out = [];
  for (const dir of dirs) {
    const file = path.join(dir, ...HOST_MODULE);
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

/**
 * 定位宿主词表，同时回报**它来自哪个文件**（可观测性：状态命令里能看到，
 * 再出现「词表来自另一个安装」时一眼可辨）。
 * 逐个候选路径尝试 import；拿到非空 Set 即返回；全部失败返回 `{known: undefined}`。
 * `config.candidates`（字符串数组）可**完全覆盖**候选列表——用于自检里模拟「宿主不可达」，
 * 也方便排查时钉死某个模块路径。
 */
export async function resolveVocabulary(config = {}) {
  const explicit = Array.isArray(config.candidates) ? config.candidates.filter((file) => typeof file === "string" && file !== "") : [];
  const files = explicit.length > 0 ? explicit : hostModuleCandidates(config);
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const mod = await import(pathToFileURL(file).href);
      const known = mod?.KNOWN_SESSION_EVENT_TYPES;
      if (known instanceof Set && known.size > 0) return { known, file };
    } catch {
      /* 换下一个候选：定位失败由调用方降级，绝不抛给加载器 */
    }
  }
  return { known: undefined, file: undefined };
}

/**
 * 取宿主的已知事件类型集合（`resolveVocabulary` 的薄封装）。
 * 全部候选失败返回 undefined（调用方降级为只告警）。
 */
export async function resolveKnownTypes(config = {}) {
  return (await resolveVocabulary(config)).known;
}

/**
 * 判定一次 append 是否安全。
 * @returns {safe:true} | {safe:true, unchecked:true}（没有词表，不判定）| {safe:false, reason}
 */
export function classifyAppend(known, type) {
  if (typeof type !== "string" || type === "") {
    return { safe: false, reason: `事件类型必须是非空字符串（实际 ${type === "" ? "空字符串" : typeof type}）` };
  }
  if (!(known instanceof Set) || known.size === 0) return { safe: true, unchecked: true };
  if (known.has(type)) return { safe: true };
  return { safe: false, reason: `事件类型 "${type}" 不在宿主事件词表内` };
}

/** 会话对象 → 归一化后的 session（store 里放的是 entry；也容忍直接给 session）。 */
export function normalizeSession(value) {
  if (value === null || typeof value !== "object") return undefined;
  const inner = value.session;
  if (inner !== null && typeof inner === "object" && typeof inner.append === "function") return inner;
  if (typeof value.append === "function") return value;
  return undefined;
}

/** 从 `ctx.sessions.store`（`SessionStore`）枚举当前已 enter 的会话。 */
export function liveSessions(ctx) {
  const store = ctx?.sessions?.store;
  if (store === undefined || store === null || typeof store.values !== "function") return [];
  const out = [];
  try {
    for (const entry of store.values()) {
      const session = normalizeSession(entry);
      if (session !== undefined) out.push(session);
    }
  } catch {
    return out;
  }
  return out;
}

/** 守卫错误文案（也是最终抛出的错误信息。 */
export function blockMessage(reason) {
  return [
    `session-guard 拒绝写入：${reason}。`,
    "自定义事件类型没有渠道标记 ignorable，会让这份会话日志被宿主整份拒读",
    "（历史里打不开，落在启动路径上还会拖累 DSH 重启）。",
    "请改用官方事件承载信息（tool/call、tool/result、compaction/prune…）或插件自己的存储。",
  ].join("");
}

/**
 * 给一个会话实例装上 append 守卫（幂等）。返回 disposer（可完整还原）。
 * @param options.enforce  false = 只告警不阻断
 * @param options.onBlock  (type, message) => void，拦截时回调（内部会 try/catch）
 */
export function guardSession(session, known, options = {}) {
  const target = normalizeSession(session);
  if (target === undefined) return () => {};
  if (target[WRAP_MARK] === true) return () => {};
  const original = target.append;
  if (typeof original !== "function") return () => {};
  const enforce = options.enforce !== false;
  const onBlock = typeof options.onBlock === "function" ? options.onBlock : () => {};

  function guardedAppend(type, data, ...opts) {
    let verdict = { safe: true };
    try {
      verdict = classifyAppend(known, type);
    } catch {
      verdict = { safe: true }; // 守卫自身异常绝不阻断合法写入
    }
    if (verdict.safe !== true) {
      const message = blockMessage(verdict.reason);
      try {
        onBlock(type, message);
      } catch {
        /* 观测回调失败不能影响判定 */
      }
      if (enforce) throw new Error(message);
    }
    return original.call(this, type, data, ...opts);
  }
  try {
    Object.defineProperty(guardedAppend, "name", { value: typeof original.name === "string" && original.name !== "" ? original.name : "append", configurable: true });
  } catch {
    /* name 只是可读性，改不动就算了 */
  }

  try {
    Object.defineProperty(target, WRAP_MARK, { value: true, configurable: true, enumerable: false });
    target.append = guardedAppend;
  } catch {
    // 实例被冻结/密封时无法包装：返回 no-op，绝不抛给调用方
    try {
      delete target[WRAP_MARK];
    } catch {
      /* ignore */
    }
    return () => {};
  }
  if (target.append !== guardedAppend) {
    // 静默失败（非严格模式下的 setter 或代理）：视为未安装
    try {
      delete target[WRAP_MARK];
    } catch {
      /* ignore */
    }
    return () => {};
  }

  return () => {
    try {
      if (target.append === guardedAppend) target.append = original;
      delete target[WRAP_MARK];
    } catch {
      /* ignore */
    }
  };
}

/* ── 插件体 ───────────────────────────────────────────────────────────── */

export async function apply(ctx, config = {}) {
  const enforce = config.enforce !== false;
  // 定位宿主词表：失败即降级，绝不阻止插件加载 / 应用启动
  let known;
  let vocabularyFile;
  try {
    const resolved = await resolveVocabulary(config);
    known = resolved.known;
    vocabularyFile = resolved.file;
  } catch {
    known = undefined;
    vocabularyFile = undefined;
  }
  const stats = {
    guarded: 0,
    blocked: 0,
    enforcement: known === undefined ? "warn-only" : enforce ? "enforce" : "warn-only",
    vocabulary: known instanceof Set ? known.size : 0,
    vocabularyFile,
  };
  const logger = ctx.logger;

  const onBlock = (type, message) => {
    stats.blocked += 1;
    logger?.warn?.(`session-guard: ${message} [type=${type}]`);
  };

  const wrap = (candidate) => {
    try {
      guardSession(candidate, known, { enforce, onBlock });
      stats.guarded += 1;
    } catch (error) {
      logger?.warn?.("session-guard: 会话守卫安装失败（已忽略）：%o", error);
    }
  };

  if (known === undefined) {
    logger?.warn?.(
      "session-guard: 定位不到宿主 dsh-session 词表，守卫以「只告警」模式运行（不会阻断任何写入）。可用 config.appDir 指到宿主 app 目录（官方桌面版为 '<DeepSeek Harness.app>/Contents/Resources/app.asar/dsh'）。",
    );
  }

  // ① 插件晚加载 / 热重载：把已经活着的会话先补上
  for (const session of liveSessions(ctx)) wrap(session);

  // ② 之后创建的会话。
  // ⚠️ SessionStore.announce() 不隔离监听器异常（抛错会回滚会话 attach），
  //    所以这个监听器**永远不抛**。
  ctx.on("session/created", (session) => {
    try {
      wrap(session);
    } catch (error) {
      logger?.warn?.("session-guard: session/created 处理失败（已忽略）：%o", error);
    }
  });

  // ③ `/session-guard` 状态（commands 服务可选，缺失不影响守卫）
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "session-guard",
      description: "会话日志写入守卫状态（防插件写坏会话日志）",
      input: { hint: "", attachments: false },
      handler: () => ({
        kind: "success",
        text: [
          `session-guard：已守卫 ${stats.guarded} 个会话，拦截 ${stats.blocked} 次非法写入`,
          `模式：${stats.enforcement}${stats.vocabulary > 0 ? `（宿主词表 ${stats.vocabulary} 个事件类型）` : ""}`,
          stats.vocabularyFile === undefined ? "词表来源：未定位到（只告警）" : `词表来源：${stats.vocabularyFile}`,
        ].join("\n"),
      }),
    });
  });
}
