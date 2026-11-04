/**
 * @local/dsh-thinking-chain — 主机侧。
 *
 * 四件事：
 * 1. `chain_note` 工具：模型把「阶段 + 一行要点」记进会话日志——**不写自定义事件**，
 *    而是折叠 harness 自己写的官方 `tool/call` 事件（参数原样落库，压缩后仍可追溯）。
 *    自定义事件类型会让宿主读回会话日志时整份拒读（unknown event type … not marked
 *    ignorable），见 docs/architecture.md §5.1。
 * 2. `chain` 投影：折叠出当前阶段 / 距上次记录的步数 / 记录次数，客户端条形图直接读。
 * 3. 系统提示段（order 460）：极简四阶段纪律，每个请求都计费所以保持短。
 * 4. 惰性提醒：连续 staleAfterSteps 步未记录且未 done 时，把一行提醒追加进系统提示段
 *    （模型可见、用户不可见；不插对话、不写事件）。
 *
 * 向后兼容：0.1.1 及以前的会话日志里已经有 `chain/note` / `chain/nudge` 事件，
 * 折叠逻辑继续认它们（那些老会话要靠 scripts/repair-session-log.mjs 补 ignorable 才能打开）。
 *
 * 零依赖：只用 node: 内置模块与 ctx 注入服务；给测试导出纯函数。
 */

export const name = "@local/dsh-thinking-chain";
export const inject = ["tools", "systemPrompt", "sessionProjections"];

export const PHASES = ["plan", "act", "verify", "done"];
/** 承载思考链记录的官方事件：chain_note 的 `tool/call`（arguments 是 JSON 字符串）。 */
export const CHAIN_TOOL_NAME = "chain_note";
const MAX_NOTE = 120;
const MAX_NEXT = 120;

/* ── 纯逻辑（测试直接 import） ─────────────────────────────────────────── */

export function clipText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r?\n/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function isPhase(value) {
  return typeof value === "string" && PHASES.includes(value);
}

export function initialChainState() {
  return { phase: "plan", note: "", next: "", sinceNote: 0, notes: 0, nudges: 0, lastNudgeSince: -1 };
}

/**
 * 从一条官方 `tool/call` 事件里解析出 chain_note 记录；不是本工具调用、或参数不合法
 * （phase 不在四阶段里 / note 为空 / arguments 不是 JSON）时返回 null。
 * 与 execute 的校验保持一致——折叠与执行用同一套判据，两边才不会分歧。
 */
export function chainNoteOf(event) {
  if (event?.type !== "tool/call") return null;
  const d = event.data ?? {};
  if (d.name !== CHAIN_TOOL_NAME) return null;
  let args = d.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const note = clipText(args.note, MAX_NOTE);
  if (!isPhase(args.phase) || note === "") return null;
  return { phase: args.phase, note, next: clipText(args.next, MAX_NEXT) };
}

/** 把一条记录写进 state（阶段/要点/下一步，步数归零、次数 +1）；legacy 与 tool/call 共用。 */
function recordNote(s, recorded) {
  return {
    phase: recorded.phase,
    note: recorded.note,
    next: recorded.next,
    sinceNote: 0,
    notes: s.notes + 1,
    nudges: s.nudges,
    lastNudgeSince: s.lastNudgeSince,
  };
}

/** 折叠一条会话事件；返回新 state（不修改入参）。 */
export function foldChain(state, event) {
  const s = state ?? initialChainState();
  // 主路径：官方 tool/call（chain_note 的参数原样落库，压缩后仍在）
  const recorded = chainNoteOf(event);
  if (recorded !== null) return recordNote(s, recorded);
  if (event.type === "step/start") return { ...s, sinceNote: s.sinceNote + 1 };
  // 兼容老日志：0.1.1 及以前自己写的自定义事件（现已停写）
  if (event.type === "chain/note") {
    const d = event.data ?? {};
    const recorded = {
      phase: isPhase(d.phase) ? d.phase : s.phase,
      note: clipText(d.note, MAX_NOTE),
      next: clipText(d.next, MAX_NEXT),
    };
    // 过渡期去重：老插件下每次 chain_note 会**同时**留下 tool/call 和 chain/note 两条，
    // 若这条老事件与刚折叠进来的那条一模一样（且中间没有新 step），就只算一次。
    const twin = s.sinceNote === 0 && s.notes > 0 && recorded.phase === s.phase && recorded.note === s.note && recorded.next === s.next;
    return twin ? s : recordNote(s, recorded);
  }
  if (event.type === "chain/nudge") {
    return { ...s, nudges: s.nudges + 1, lastNudgeSince: Number.isInteger(event.data?.sinceNote) ? event.data.sinceNote : s.lastNudgeSince };
  }
  return s;
}

/**
 * 是否需要在系统提示段里提醒。规则：
 * - 只有**已经用过 chain_note** 的会话才提醒（否则长会话的历史步数会被当成欠账，
 *   一恢复就反复打扰用户——这正是 0.1.0 的 bug）；
 * - 连续 staleAfterSteps 步未记录、且当前不是 done；
 * - 步数显示限幅（超过 9 显示 9+），避免出现「已连续 250 步」这种噪音。
 */
export function nudgeDecision(state, staleAfterSteps) {
  if (!Number.isInteger(staleAfterSteps) || staleAfterSteps <= 0) return null;
  if (state.notes <= 0) return null;
  if (state.phase === "done") return null;
  if (state.sinceNote < staleAfterSteps) return null;
  const shown = Math.min(state.sinceNote, 9);
  const suffix = state.sinceNote > 9 ? "+" : "";
  const text = `已连续 ${shown}${suffix} 步未记录思考链路（当前阶段 ${state.phase}）。用 chain_note 记录当前 phase 与一行要点。`;
  return { text, sinceNote: state.sinceNote };
}

/** 手写 JSON Schema 参数校验（原生注册不过 defineTool 的校验器）。 */
export function validateArgs(schema, args) {
  const errs = [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const props = schema.properties ?? {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(props, key)) errs.push(`unknown argument "${key}"`);
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) errs.push(`missing "${key}"`);
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(args, key)) continue;
    const v = args[key];
    if (spec.type === "string") {
      if (typeof v !== "string") { errs.push(`"${key}" must be a string`); continue; }
      if (spec.enum !== undefined && !spec.enum.includes(v)) errs.push(`"${key}" must be one of ${spec.enum.join("|")}`);
    } else if (spec.type === "boolean") {
      if (typeof v !== "boolean") errs.push(`"${key}" must be a boolean`);
    } else if (spec.type === "integer") {
      if (!Number.isInteger(v)) errs.push(`"${key}" must be an integer`);
    } else if (spec.type === "array") {
      if (!Array.isArray(v)) errs.push(`"${key}" must be an array`);
    } else if (spec.type === "object") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) errs.push(`"${key}" must be an object`);
    }
  }
  return errs;
}

/* ── 插件体 ───────────────────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const section = typeof config.section === "string" && config.section.trim() !== "" ? config.section : DEFAULT_SECTION;
  const staleAfterSteps = Number.isInteger(config.staleAfterSteps) ? config.staleAfterSteps : 3;

  const chainProjection = {
    key: "chain",
    stateVersion: 1,
    stateSchema: { parse: (v) => normalizeChain(v) },
    init: () => initialChainState(),
    apply: (state, event) => foldChain(state, event),
    wire: {
      viewSchema: { parse: (v) => v },
      view: (s) => ({ phase: s.phase, note: s.note, next: s.next, sinceNote: s.sinceNote, notes: s.notes, nudges: s.nudges }),
    },
  };

  ctx.sessionProjections.register(chainProjection);

  ctx.systemPrompt.section({
    name: "thinking-chain:policy",
    order: 460,
    text: (context) => {
      // 动态提醒走系统提示段（模型可见、用户不可见），不往对话里插消息。
      const agent = context?.agent;
      if (agent === undefined) return section;
      let state;
      try {
        state = ctx.sessionProjections.stateOf(agent.session, "chain");
      } catch (error) {
        ctx.logger?.warn?.("thinking-chain: state read failed: %o", error);
        return section;
      }
      if (state === undefined) return section;
      const nudge = nudgeDecision(state, staleAfterSteps);
      return nudge === null ? section : `${section}\n- ${nudge.text}`;
    },
  });

  ctx.tools.register({
    name: "chain_note",
    description:
      "Record one thinking-chain checkpoint into the session log: the current phase and a one-line gist. Call it when you start or switch a phase (plan/act/verify/done), and at least every few steps on long tasks, so the reasoning chain stays traceable after context compaction.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        phase: { type: "string", enum: PHASES, description: "Current engineering phase." },
        note: { type: "string", description: `One-line gist of the current reasoning step (<= ${MAX_NOTE} chars).` },
        next: { type: "string", description: `Optional: the next concrete action (<= ${MAX_NEXT} chars).` },
      },
      required: ["phase", "note"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", const: true },
          phase: { type: "string" },
          notes: { type: "integer" },
        },
        required: ["ok", "phase", "notes"],
      },
      render: (args, value) => [{ type: "text", text: `思考链已记录：${value.phase}（第 ${value.notes} 次）` }],
    },
    execute: async (args, exec) => {
      const agent = exec.agent;
      if (agent === undefined) throw new Error("chain_note requires a calling agent (no session to record into)");
      const violations = validateArgs(TOOL_PARAMS, args);
      if (violations.length > 0) throw new Error(`chain_note: invalid arguments: ${violations.join("; ")}`);
      const note = clipText(args.note, MAX_NOTE);
      if (note === "") throw new Error("chain_note: note must be a non-empty line");
      // 不写事件：本次调用的 `tool/call` 事件由 harness 在 execute 之前就已落库，
      // 投影已折叠它（折叠判据与这里一致），所以这里的 notes 已经包含本次记录。
      return { ok: true, phase: args.phase, notes: chainStateOf(ctx, agent.session).notes };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `chain_note · ${String(args?.phase ?? "")}`,
      kind: "other",
      content: [{ type: "text", text: String(args?.note ?? "") }],
    }),
  });

}

const DEFAULT_SECTION = [
  "工程思考链（thinking-chain）：",
  "- 阶段：plan（拆解目标）→ act（最小动作）→ verify（验证结果）→ done（收尾确认）。",
  "- 开始或切换阶段时调用 chain_note 记录 phase 与一行要点。",
  "- 连续多步未记录会被提醒；链路记录在会话日志中，压缩后仍可追溯。",
].join("\n");

const TOOL_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    phase: { type: "string", enum: PHASES },
    note: { type: "string" },
    next: { type: "string" },
  },
  required: ["phase", "note"],
};

function normalizeChain(v) {
  const s = initialChainState();
  if (v === null || typeof v !== "object") return s;
  return {
    phase: isPhase(v.phase) ? v.phase : s.phase,
    note: typeof v.note === "string" ? v.note : "",
    next: typeof v.next === "string" ? v.next : "",
    sinceNote: Number.isInteger(v.sinceNote) ? v.sinceNote : 0,
    notes: Number.isInteger(v.notes) ? v.notes : 0,
    nudges: Number.isInteger(v.nudges) ? v.nudges : 0,
    lastNudgeSince: Number.isInteger(v.lastNudgeSince) ? v.lastNudgeSince : -1,
  };
}

function chainStateOf(ctx, session) {
  const state = ctx.sessionProjections.stateOf(session, "chain");
  return state === undefined ? initialChainState() : state;
}
