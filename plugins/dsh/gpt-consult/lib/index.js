/**
 * @local/dsh-gpt-consult — 主机侧：把 GPT 变成当前 agent 的「第二意见工具」。
 *
 * 定位：与已有 @local/dsh-codex-bridge（人对人的 Codex 聊天桥）互补——本插件让
 *  DeepSeek agent 在干活时主动 consult GPT，审一遍方案/找漏掉的坑。
 *
 * 能力：
 *  - consult_gpt 工具：{question, context?} → OpenAI 兼容 chat/completions。
 *  - /gpt 命令：用户直接问；/gpt status 看累计。
 *  - gpt 投影：折叠官方事件，统计次数/耗时/模型。
 *
 * 会话日志只写官方事件类型（宿主 dsh-session 的 KNOWN_SESSION_EVENT_TYPES）：
 * 本插件不再往日志里 append 任何东西——旧版写的自定义类型 gpt/consult 会让宿主
 * dsh-session-persistence 的 validateStoredEvents 整份拒读，会话从此打不开。
 * 于是统计投影改为折叠官方事件：tool/call(name=consult_gpt) 记一次咨询，配对的
 * tool/result 记成败与耗时/模型（用 event.data.message.source.callId 关联），
 * /gpt 命令注入的 user/message(source.plugin=gpt-consult) 记命令路径；同时继续
 * 折叠老日志里已经存在的 gpt/consult 事件（老日志里工具调用两种记录都有，所以
 * 见到 gpt/consult 就把它覆盖的那一次标记掉，避免同一个会话被算两遍）。
 *
 * 投影里不再可得的字段（view 形状不变，只降级取值）：
 *  - 命令路径（/gpt）的耗时：注入的消息里没有毫秒数，这条记 0；
 *  - 工具结果被裁剪/去重（内容里已无答案头行）时的模型：沿用上一次的值，耗时
 *    退回 tool/call 与 tool/result 两条事件的 time 之差。
 *
 * 安全：密钥只从宿主进程环境变量读（默认 OPENAI_API_KEY），不落盘、不进日志、
 * 不出现在工具展示里；请求只发往配置的 baseURL（默认 OpenAI 官方）。
 *
 * 零依赖（Node 22 全局 fetch）；纯函数导出供测试。
 */

export const name = "@local/dsh-gpt-consult";
export const inject = ["tools", "sessionProjections"];

const MAX_QUESTION = 8000;
const MAX_CONTEXT = 12000;

/* ── 纯逻辑（测试 import） ─────────────────────────────────────────────── */

export function resolveConfig(config = {}) {
  const baseURL = typeof config.baseURL === "string" && config.baseURL.trim() !== "" ? config.baseURL.trim().replace(/\/+$/u, "") : "https://api.openai.com/v1";
  const model = typeof config.model === "string" && config.model.trim() !== "" ? config.model.trim() : "gpt-5";
  const apiKeyEnv = typeof config.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(config.apiKeyEnv) ? config.apiKeyEnv : "OPENAI_API_KEY";
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 60000;
  const maxContextChars = Number.isInteger(config.maxContextChars) && config.maxContextChars >= 0 ? config.maxContextChars : MAX_CONTEXT;
  const systemPrompt = typeof config.systemPrompt === "string" && config.systemPrompt.trim() !== "" ? config.systemPrompt : DEFAULT_SYSTEM;
  return { baseURL, model, apiKeyEnv, timeoutMs, maxContextChars, systemPrompt };
}

/** 从进程环境取 key；绝不在错误信息里回显 key 本体。 */
export function resolveApiKey(config, env) {
  const raw = env?.[config.apiKeyEnv];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `未找到 API key：请在宿主进程环境设置 ${config.apiKeyEnv}（例如 export ${config.apiKeyEnv}=sk-...），或在 profile patch 里改 gpt-consult 的 apiKeyEnv。` };
  }
  const key = raw.trim();
  if (/[\r\n]/u.test(key)) return { ok: false, error: `${config.apiKeyEnv} 含有非法字符（换行）` };
  return { ok: true, key };
}

/** 组装 chat/completions 请求体。 */
export function buildRequestBody(config, args) {
  const question = String(args?.question ?? "").slice(0, MAX_QUESTION);
  const context = String(args?.context ?? "").slice(0, config.maxContextChars);
  const user = context === "" ? question : `${question}\n\n---\n上下文（由调用方提供）：\n${context}`;
  return { model: config.model, messages: [{ role: "system", content: config.systemPrompt }, { role: "user", content: user }] };
}

/** 解析响应；返回 {ok, answer, model, usage?} 或 {ok:false, error}。 */
export function extractAnswer(payload) {
  if (payload === null || typeof payload !== "object") return { ok: false, error: "响应不是 JSON 对象" };
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    const err = payload.error?.message;
    return { ok: false, error: typeof err === "string" && err !== "" ? `上游错误：${err.slice(0, 300)}` : "响应缺少 choices[0].message.content" };
  }
  return {
    ok: true,
    answer: content,
    model: typeof payload.model === "string" ? payload.model : "",
    usage: payload.usage !== undefined && payload.usage !== null ? payload.usage : undefined,
  };
}

/* ── 事件常量：每个 type 都必须在宿主 KNOWN_SESSION_EVENT_TYPES 里 ──────── */

export const TOOL_CALL_EVENT = "tool/call";
export const TOOL_RESULT_EVENT = "tool/result";
export const USER_MESSAGE_EVENT = "user/message";
/** 本插件注册的工具名与插件 id：用来把官方事件认成「一次 GPT 咨询」。 */
export const CONSULT_TOOL_NAME = "consult_gpt";
export const PLUGIN_ID = "gpt-consult";
/**
 * 历史自定义类型：2.0.13 起不再写入（宿主不认识自定义类型，读回日志时会整份
 * 拒读），但投影必须继续折叠老日志里已有的这些事件。
 */
export const LEGACY_CONSULT_EVENT = "gpt/consult";
/** 答案头行：与下方 output.render 的格式一一对应（工具路径带 ms，命令路径不带）。 */
const ANSWER_HEADER = /^【GPT · ([^·】]*?)(?: · (\d+)ms)?】/u;

export function initialGptState() {
  return {
    count: 0,
    fails: 0,
    totalMs: 0,
    lastModel: "",
    lastAt: 0,
    lastOk: null,
    /** 已记过 tool/call、还在等 tool/result 的那次工具调用：{callId, at, covered}。 */
    pendingCall: null,
    /** 老日志里命令路径的 gpt/consult 条数：等它们的 user/message 通知到了就不再重复计数。 */
    legacyNoticeBacklog: 0,
  };
}

/** 折叠一条会话事件；未知事件原样返回。 */
export function foldGpt(state, event) {
  const s = state ?? initialGptState();
  const data = event.data ?? {};
  switch (event.type) {
    case LEGACY_CONSULT_EVENT:
      return foldLegacyConsult(s, data, eventTime(event));
    case TOOL_CALL_EVENT:
      if (data.name !== CONSULT_TOOL_NAME) return s;
      return { ...s, count: s.count + 1, pendingCall: { callId: data.callId, at: eventTime(event), covered: false } };
    case TOOL_RESULT_EVENT: {
      const pending = s.pendingCall;
      if (pending === null || data.message?.source?.callId !== pending.callId) return s;
      const cleared = { ...s, pendingCall: null };
      // 老日志里这次咨询已经由自己的 gpt/consult 事件记过账了，只清掉待配对状态
      return pending.covered ? cleared : applyResultStats(cleared, data.message, pending.at, eventTime(event), s.lastModel);
    }
    case USER_MESSAGE_EVENT: {
      const source = data.source;
      if (source?.kind !== "plugin" || source.plugin !== PLUGIN_ID) return s;
      if (s.legacyNoticeBacklog > 0) return { ...s, legacyNoticeBacklog: s.legacyNoticeBacklog - 1 };
      const header = parseAnswerHeader(data.content);
      return { ...s, count: s.count + 1, lastModel: header?.model || s.lastModel, lastAt: eventTime(event), lastOk: true };
    }
    default:
      return s;
  }
}

/** 老日志的 gpt/consult：工具路径的那条由 tool/call 记过数，命令路径的那条自己记数。 */
function foldLegacyConsult(s, d, time) {
  const ok = d.ok === true;
  const stats = {
    ...s,
    fails: s.fails + (ok ? 0 : 1),
    totalMs: s.totalMs + (Number.isFinite(d.ms) ? Math.round(d.ms) : 0),
    lastModel: typeof d.model === "string" ? d.model : s.lastModel,
    lastAt: Number.isFinite(d.at) ? d.at : s.lastAt,
    lastOk: ok,
  };
  if (s.pendingCall !== null) return { ...stats, pendingCall: { ...s.pendingCall, covered: true } };
  return { ...stats, count: stats.count + 1, legacyNoticeBacklog: s.legacyNoticeBacklog + 1 };
}

/** 用配对的 tool/result 结算一次工具路径的咨询。 */
function applyResultStats(s, message, calledAt, resultAt, fallbackModel) {
  const result = message?.content?.[0];
  const ok = result?.isError !== true;
  const header = parseAnswerHeader(result?.content);
  const ms = header !== null && header.ms !== null ? header.ms : Math.max(0, resultAt - calledAt);
  return {
    ...s,
    fails: s.fails + (ok ? 0 : 1),
    totalMs: s.totalMs + ms,
    lastModel: header?.model || fallbackModel,
    lastAt: resultAt,
    lastOk: ok,
  };
}

/** 解析内容块头部的【GPT · model · msms】；认不出来返回 null。 */
function parseAnswerHeader(blocks) {
  const text = Array.isArray(blocks) ? blocks.find((b) => b?.type === "text")?.text : undefined;
  const m = typeof text === "string" ? ANSWER_HEADER.exec(text) : null;
  if (m === null) return null;
  return { model: (m[1] ?? "").trim(), ms: m[2] === undefined ? null : Number(m[2]) };
}

function eventTime(event) {
  return Number.isFinite(event?.time) ? event.time : 0;
}

/* ── 请求执行（导出但测试不触网） ───────────────────────────────────────── */

export async function consult(config, args, env = process.env, fetchImpl = fetch) {
  const key = resolveApiKey(config, env);
  if (!key.ok) return key;
  const url = `${config.baseURL}/chat/completions`;
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
      body: JSON.stringify(buildRequestBody(config, args)),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const name = error?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, error: `请求超时（${config.timeoutMs}ms）` };
    return { ok: false, error: `网络错误：${String(error?.message ?? error).slice(0, 200)}` };
  }
  const ms = Date.now() - started;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, error: `上游 HTTP ${response.status}：${body.slice(0, 200)}`, ms };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "上游返回的不是 JSON", ms };
  }
  const parsed = extractAnswer(payload);
  return parsed.ok ? { ...parsed, ms } : { ...parsed, ms };
}

/* ── 插件体 ───────────────────────────────────────────────────────────── */

const TOOL_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string", description: "要问 GPT 的问题（具体、可决策）。" },
    context: { type: "string", description: "可选：相关代码/方案/约束的摘录，帮助给出第二意见。" },
  },
  required: ["question"],
};

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);

  ctx.sessionProjections.register({
    key: "gpt",
    // 折叠口径从自定义事件换成官方事件（见文件头），旧 checkpoint 必须作废重算
    stateVersion: 2,
    stateSchema: { parse: (v) => normalizeGpt(v) },
    init: () => initialGptState(),
    apply: (state, event) => foldGpt(state, event),
    wire: { viewSchema: { parse: (v) => v }, view: (s) => ({ count: s.count, fails: s.fails, totalMs: s.totalMs, lastModel: s.lastModel, lastAt: s.lastAt, lastOk: s.lastOk }) },
  });

  ctx.tools.register({
    name: "consult_gpt",
    description:
      "Ask GPT (or any OpenAI-compatible endpoint) for a second opinion: a design review, a bug hypothesis, or an alternative approach. Provide the question and, when useful, a short context excerpt. The answer comes back as the tool result; the API key is read from the host process environment and never logged.",
    parameters: TOOL_PARAMS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", const: true },
          answer: { type: "string" },
          model: { type: "string" },
          ms: { type: "integer" },
        },
        required: ["ok", "answer", "model"],
      },
      render: (args, value) => [{ type: "text", text: `【GPT · ${value.model} · ${value.ms}ms】\n${value.answer}` }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent;
      if (agent === undefined) throw new Error("consult_gpt requires a calling agent (no session to attribute the call to)");
      const bad = validateArgs(args);
      if (bad.length > 0) throw new Error(`consult_gpt: invalid arguments: ${bad.join("; ")}`);
      const result = await consult(cfg, args);
      if (!result.ok) throw new Error(`consult_gpt: ${result.error}`);
      return { ok: true, answer: result.answer, model: result.model || cfg.model, ms: result.ms ?? 0 };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "consult_gpt",
      kind: "other",
      content: [{ type: "text", text: String(args?.question ?? "") }],
    }),
  });

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "gpt",
      description: "问 GPT（/gpt <问题>）或看统计（/gpt status）",
      input: { hint: "<问题|status>", attachments: true },
      handler: async ({ agent, rawInput }) => {
        const input = rawInput.trim();
        if (input === "") {
          return { kind: "success", text: ["用法：", "  /gpt <问题>   直接问 GPT，答案注入当前会话", "  /gpt status   累计统计"].join("\n") };
        }
        if (input === "status" || input === "--status") {
          const s = ctx.sessionProjections.stateOf(agent.session, "gpt") ?? initialGptState();
          if (s.count === 0) return { kind: "success", text: "gpt-consult：本会话还没有咨询记录。" };
          return {
            kind: "success",
            text: [
              `gpt-consult 累计：${s.count} 次（失败 ${s.fails}）`,
              `最近模型：${s.lastModel || cfg.model}`,
              `累计耗时：${(s.totalMs / 1000).toFixed(1)}s`,
            ].join("\n"),
          };
        }
        const result = await consult(cfg, { question: input });
        if (!result.ok) return { kind: "error", text: `consult 失败：${result.error}` };
        const text = `【GPT · ${result.model || cfg.model}】\n${result.answer}`;
        const message = { role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "gpt-consult", form: "notice", summary: "GPT 第二意见" } };
        try {
          agent.inject(message);
        } catch {
          agent.steer(message);
        }
        return { kind: "success", text: `已咨询 GPT（${result.ms ?? 0}ms），答案已注入会话。` };
      },
    });
  });
}

const DEFAULT_SYSTEM = "You are a rigorous second-opinion reviewer. Answer in Chinese. Be concise, concrete, and flag risks the caller may have missed.";

function validateArgs(args) {
  const errs = [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  for (const key of Object.keys(args)) if (!Object.hasOwn(TOOL_PARAMS.properties, key)) errs.push(`unknown argument "${key}"`);
  if (typeof args.question !== "string" || args.question.trim() === "") errs.push("question must be a non-empty string");
  if (args.context !== undefined && typeof args.context !== "string") errs.push("context must be a string");
  return errs;
}

function normalizeGpt(v) {
  const s = initialGptState();
  if (v === null || typeof v !== "object") return s;
  return {
    count: Number.isFinite(v.count) ? Math.round(v.count) : 0,
    fails: Number.isFinite(v.fails) ? Math.round(v.fails) : 0,
    totalMs: Number.isFinite(v.totalMs) ? Math.round(v.totalMs) : 0,
    lastModel: typeof v.lastModel === "string" ? v.lastModel : "",
    lastAt: Number.isFinite(v.lastAt) ? v.lastAt : 0,
    lastOk: v.lastOk === null || typeof v.lastOk === "boolean" ? v.lastOk : null,
    pendingCall: normalizePendingCall(v.pendingCall),
    legacyNoticeBacklog: Number.isFinite(v.legacyNoticeBacklog) ? Math.max(0, Math.round(v.legacyNoticeBacklog)) : 0,
  };
}

/** checkpoint 里的待配对状态：形状不对就当没有。 */
function normalizePendingCall(v) {
  if (v === null || typeof v !== "object" || typeof v.callId !== "string") return null;
  return { callId: v.callId, at: Number.isFinite(v.at) ? v.at : 0, covered: v.covered === true };
}
