/**
 * @local/dsh-thinking-chain — 浏览器侧。
 * 会话头 utilities 座放一个阶段条：当前 phase（plan/act/verify/done）+ 记录次数 +
 * 距上次记录步数；title 提示当前要点与下一步。数据来自主机 `chain` 投影的 wire view。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-thinking-chain",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var NS = "thinking-chain";

    var ZH = {
      "chip.label": "思考链",
      "chip.title": "思考链状态（指示器，非按钮）：{phase}（第 {notes} 次记录，{since} 步未记录）",
      "phase.plan": "计划",
      "phase.act": "执行",
      "phase.verify": "验证",
      "phase.done": "收尾",
      "chip.note": "要点：{note}",
      "chip.next": "下一步：{next}",
      "chip.empty": "尚未记录思考链路（指示器）；计划树请见右侧边栏 Plan Map",
      "chip.hint": "右侧边栏 → Plan Map 查看计划树",
    };
    var EN = {
      "chip.label": "chain",
      "chip.title": "thinking-chain status (indicator, not a button): {phase} ({notes} notes, {since} steps since last)",
      "phase.plan": "plan",
      "phase.act": "act",
      "phase.verify": "verify",
      "phase.done": "done",
      "chip.note": "note: {note}",
      "chip.next": "next: {next}",
      "chip.empty": "no chain notes yet (indicator); see the Plan Map tab in the right sidebar",
      "chip.hint": "right sidebar -> Plan Map for the plan tree",
    };

    var PHASE_COLOR = { plan: "#6366f1", act: "#0ea5e9", verify: "#f59e0b", done: "#22c55e" };

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, function (_m, k) {
        return Object.hasOwn(vars, k) ? String(vars[k]) : "";
      });
    }

    /** 读一个会话投影的 wire view（会话头座位不提供 useProjection prop）。 */
    function useFaceView(ctx, sessionId, key) {
      var React = require("react");
      var face = React.useMemo(function () {
        try {
          var sessions = ctx && ctx.sessions;
          if (!sessions || typeof sessions.binding !== "function" || sessionId === undefined || sessionId === null) return undefined;
          var binding = sessions.binding(sessionId);
          var projections = binding && binding.session ? binding.session.projections : undefined;
          return projections && typeof projections.faceOf === "function" ? projections.faceOf(key) : undefined;
        } catch (error) {
          return undefined;
        }
      }, [ctx, sessionId, key]);
      var subscribe = React.useCallback(function (listener) {
        if (face && typeof face.subscribe === "function") return face.subscribe(listener);
        return function () {};
      }, [face]);
      var read = React.useCallback(function () {
        try {
          return face && typeof face.getSnapshot === "function" ? face.getSnapshot() : undefined;
        } catch (error) {
          return undefined;
        }
      }, [face]);
      var snapshot = React.useSyncExternalStore(subscribe, read, read);
      // faceOf(key).getSnapshot() 返回的**就是这个 key 的 view 本身**（不是整张 projections 表）。
      // 官方 view 常写成 { goal: … } 形状，所以读起来像表；我们的 view 是 { nodes, progress }，直接用。
      return { face: face, value: snapshot === undefined || snapshot === null ? undefined : snapshot };
    }

    function ChainChip(props) {
      var t = typeof props.t === "function" ? props.t : function (k) { return ZH[k] ?? k; };
      var read = useFaceView(props.ctx, props.sessionId, "chain");
      var chain = read.value;
      if (props.sessionId === undefined || props.sessionId === null) return null; // 没有会话就没有链路可显示
      var phase = chain && chain.phase ? chain.phase : "plan";
      var color = PHASE_COLOR[phase] ?? "#94a3b8";
      var title = chain
        ? fill(t("chip.title"), { phase: t("phase." + phase), notes: chain.notes ?? 0, since: chain.sinceNote ?? 0 }) +
          (chain.note ? "\n" + fill(t("chip.note"), { note: chain.note }) : "") +
          (chain.next ? "\n" + fill(t("chip.next"), { next: chain.next }) : "") +
          "\n" + t("chip.hint")
        : t("chip.empty");
      return React.createElement(
        "span",
        {
          title: title,
          style: {
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "2px 8px", borderRadius: 999, fontSize: 11, lineHeight: "18px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.4))",
            background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit",
            cursor: "default", userSelect: "none", whiteSpace: "nowrap",
          },
        },
        React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" } }),
        React.createElement("span", null, t("chip.label") + " · " + t("phase." + phase)),
        React.createElement("span", { style: { opacity: 0.65 } }, "#" + (chain ? chain.notes ?? 0 : 0))
      );
    }

    var apply = function (ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: ZH, en: EN }); }, "thinking-chain: dictionaries");
      ctx.effect(function () {
        return ctx.slots.inject("conversation.session.header.utilities", function () {
          return ctx.slots.register({
            name: "conversation.session.header.utilities",
            id: "thinking-chain",
            order: 30,
            locale: NS,
            inject: function () { return { ctx: ctx }; },
          }, ChainChip);
        });
      }, "thinking-chain: header chip");
    };

    exports.apply = apply;
    exports.inject = ["slots", "sessions", "locale"];
    return module.exports;
  },
});
