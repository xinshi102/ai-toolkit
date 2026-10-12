/**
 * @local/dsh-master-plan — VIEW.
 *
 * Renders the Master Plan as an interactive tree **inside the dsh conversation**,
 * by claiming the keyed `tool.call.toolview` slot for each Master Plan tool. A
 * keyed hit replaces the generic tool row, so the plan appears inline rather
 * than in an external page.
 *
 * This layer is presentation only. It reads the State layer's view model over
 * the same-origin `/master-plan/state` route and writes exclusively through
 * `/master-plan/mutate`, which is the Controller. It owns no plan rules: no
 * ordering, no dependency resolution, no status inference.
 */

window.__ModuleLoader__.load({
  id: "@local/dsh-master-plan",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;

    /** Tool names this view claims. Must match the host tools exactly. */
    var TOOL_NAMES = ["plan_get", "plan_project", "plan_task", "plan_current", "plan_log"];
    var API = "/master-plan";

    /* ── i18n ───────────────────────────────────────────────────────────── */
    var EN = {
      empty: "No Master Plan yet. Ask the model to call plan_project / plan_task, or add a task below.",
      unset: "Untitled project",
      current: "Current",
      none: "No current task",
      refresh: "Refresh",
      collapseAll: "Collapse all",
      expandAll: "Expand all",
      hide: "Hide",
      show: "Show plan",
      tasks: "tasks",
      pending: "pending",
      active: "active",
      done: "done",
      blocked: "blocked",
      filterAll: "All",
      filterOpen: "Open",
      filterBlocked: "Blocked",
      filterDone: "Done",
      deps: "Depends on",
      blocksReady: "waiting on prerequisites",
      blocker: "Blocker",
      note: "Note",
      setCurrent: "Set current",
      markDone: "Mark done",
      reopen: "Reopen",
      blockIt: "Block",
      blockerPlaceholder: "Blocker reason…",
      log: "Mutation log",
      loading: "Loading plan…",
      offline: "Plan route unreachable — the host may still be starting.",
      retry: "Retry",
      notFound: "That task no longer exists.",
    };
    var ZH = {
      empty: "还没有 Master Plan。让模型调用 plan_project / plan_task，或在下方新建任务。",
      unset: "未命名项目",
      current: "当前任务",
      none: "没有当前任务",
      refresh: "刷新",
      collapseAll: "全部折叠",
      expandAll: "全部展开",
      hide: "收起",
      show: "展开计划",
      tasks: "个任务",
      pending: "待办",
      active: "进行中",
      done: "完成",
      blocked: "阻塞",
      filterAll: "全部",
      filterOpen: "未完成",
      filterBlocked: "阻塞",
      filterDone: "已完成",
      deps: "依赖",
      blocksReady: "等待前置任务",
      blocker: "阻塞原因",
      note: "备注",
      setCurrent: "设为当前",
      markDone: "标记完成",
      reopen: "重新打开",
      blockIt: "标记阻塞",
      blockerPlaceholder: "阻塞原因…",
      log: "变更日志",
      loading: "正在读取计划…",
      offline: "计划接口不可达——主机可能仍在启动。",
      retry: "重试",
      notFound: "该任务已不存在。",
    };
    var L = String(navigator.language || "en").toLowerCase().startsWith("zh") ? ZH : EN;

    /* ── presentation constants (no plan logic) ─────────────────────────── */
    var STATUS = {
      pending: { glyph: "○", color: "var(--dsw-alias-label-tertiary, #94a3b8)" },
      active: { glyph: "◐", color: "var(--dsw-alias-state-business-primary, #3b82f6)" },
      done: { glyph: "✓", color: "var(--dsw-alias-state-success-primary, #22c55e)" },
      blocked: { glyph: "▲", color: "var(--dsw-alias-state-error-primary, #ef4444)" },
    };
    var C = {
      bg: "var(--dsw-alias-bg-layer-1, transparent)",
      bgSoft: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))",
      border: "var(--dsw-alias-border-l2, rgba(127,127,127,0.28))",
      text: "var(--dsw-alias-label-primary, inherit)",
      textSoft: "var(--dsw-alias-label-secondary, inherit)",
      textDim: "var(--dsw-alias-label-tertiary, inherit)",
      accent: "var(--dsw-alias-brand-primary, #3b82f6)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))",
      err: "var(--dsw-alias-state-error-primary, #ef4444)",
    };
    var MONO = "var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)";

    /* ── data access (State layer over the host route) ──────────────────── */
    function usePlan() {
      var [snap, setSnap] = React.useState({ status: "loading" });
      var alive = React.useRef(true);

      var load = React.useCallback(function () {
        return fetch(API + "/state", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!alive.current) return;
            if (j && j.ok) setSnap({ status: "ready", view: j.data });
            else setSnap({ status: "error", error: (j && j.error) || "bad response" });
          })
          .catch(function (e) {
            if (alive.current) setSnap({ status: "error", error: String((e && e.message) || e) });
          });
      }, []);

      React.useEffect(function () {
        alive.current = true;
        load();
        // Keep the inline tree live: other conversations may change the plan.
        var timer = setInterval(load, 15000);
        var onFocus = function () { load(); };
        window.addEventListener("focus", onFocus);
        return function () {
          alive.current = false;
          clearInterval(timer);
          window.removeEventListener("focus", onFocus);
        };
      }, [load]);

      var mutate = React.useCallback(function (op, input) {
        return fetch(API + "/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: op, input: input }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) setSnap({ status: "ready", view: j.data });
            return j;
          })
          .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
      }, []);

      return { snap: snap, reload: load, mutate: mutate };
    }

    /* ── tree projection (visibility + flattening is presentation) ──────── */
    function matches(node, filter) {
      if (filter === "open") return node.status !== "done";
      if (filter === "blocked") return node.status === "blocked";
      if (filter === "done") return node.status === "done";
      return true;
    }

    function visibleIn(node, filter) {
      if (matches(node, filter)) return true;
      for (var i = 0; i < node.children.length; i += 1) {
        if (visibleIn(node.children[i], filter)) return true;
      }
      return false;
    }

    function toRows(roots, filter, collapsed) {
      var rows = [];
      (function walk(list) {
        for (var i = 0; i < list.length; i += 1) {
          var node = list[i];
          if (!visibleIn(node, filter)) continue;
          rows.push(node);
          if (!collapsed[node.id] && node.children.length > 0) walk(node.children);
        }
      })(roots);
      return rows;
    }

    /* ── small pieces ───────────────────────────────────────────────────── */
    function Chip(props) {
      return h(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "1px 7px",
            borderRadius: "999px",
            border: "1px solid " + (props.active ? C.accent : C.border),
            background: props.active ? C.hover : "transparent",
            color: props.active ? C.text : C.textSoft,
            fontSize: "11px",
            cursor: props.onClick ? "pointer" : "default",
            userSelect: "none",
            whiteSpace: "nowrap",
          },
          onClick: props.onClick,
          title: props.title,
        },
        props.children,
      );
    }

    function Btn(props) {
      return h(
        "button",
        {
          type: "button",
          onClick: props.onClick,
          disabled: props.disabled,
          title: props.title,
          style: {
            padding: "2px 8px",
            fontSize: "11px",
            borderRadius: "6px",
            border: "1px solid " + C.border,
            background: "transparent",
            color: props.disabled ? C.textDim : C.textSoft,
            cursor: props.disabled ? "default" : "pointer",
            opacity: props.disabled ? 0.5 : 1,
            whiteSpace: "nowrap",
          },
        },
        props.children,
      );
    }

    function Dot(status) {
      var meta = STATUS[status] || STATUS.pending;
      return h(
        "span",
        { style: { color: meta.color, width: "13px", display: "inline-block", textAlign: "center", flex: "0 0 auto" } },
        meta.glyph,
      );
    }

    /* ── detail panel ───────────────────────────────────────────────────── */
    function Detail(props) {
      var node = props.node;
      var [reason, setReason] = React.useState("");
      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState("");

      React.useEffect(function () {
        setReason("");
        setError("");
      }, [node.id]);

      function run(op, input) {
        setBusy(true);
        setError("");
        props.mutate(op, input).then(function (r) {
          setBusy(false);
          if (!r || !r.ok) {
            setError((r && r.error) || "failed");
            // A stale selection is the common cause; refresh so the user sees why.
            props.reload();
          }
        });
      }

      var field = function (label, value, color) {
        if (!value) return null;
        return h(
          "div",
          { style: { marginTop: "6px" } },
          h("span", { style: { color: C.textDim, fontSize: "11px" } }, label + ": "),
          h("span", { style: { color: color || C.textSoft, fontSize: "12px" } }, value),
        );
      };

      return h(
        "div",
        {
          style: {
            marginTop: "8px",
            padding: "9px 10px",
            borderRadius: "8px",
            border: "1px solid " + C.border,
            background: C.bgSoft,
            fontSize: "12px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          Dot(node.status),
          h("strong", { style: { color: C.text } }, node.title),
          h("span", { style: { fontFamily: MONO, color: C.textDim, fontSize: "11px" } }, node.id),
          h("span", { style: { color: C.textDim, fontSize: "11px" } }, "· " + (L[node.status] || node.status)),
          node.isCurrent ? h(Chip, { active: true }, L.current) : null,
        ),
        field(L.blocker, node.blockedReason, C.err),
        node.deps.length > 0
          ? field(
              L.deps,
              node.deps.map(function (d) { return d.title + " (" + d.id + " · " + d.status + ")"; }).join("、") +
                (node.blockedByDeps.length > 0 ? "  ⏳ " + L.blocksReady : ""),
            )
          : null,
        field(L.note, node.note),

        h(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "9px", flexWrap: "wrap", alignItems: "center" } },
          h(
            Btn,
            {
              disabled: busy || node.status === "done" || node.isCurrent,
              onClick: function () { run("current.set", { id: node.id }); },
            },
            L.setCurrent,
          ),
          h(
            Btn,
            { disabled: busy || node.status === "done", onClick: function () { run("task.update", { id: node.id, status: "done" }); } },
            L.markDone,
          ),
          h(
            Btn,
            { disabled: busy || node.status !== "done", onClick: function () { run("task.update", { id: node.id, status: "pending" }); } },
            L.reopen,
          ),
          h("input", {
            value: reason,
            placeholder: L.blockerPlaceholder,
            onChange: function (e) { setReason(e.target.value); },
            style: {
              flex: "1 1 130px",
              minWidth: "110px",
              padding: "2px 7px",
              fontSize: "11px",
              borderRadius: "6px",
              border: "1px solid " + C.border,
              background: "transparent",
              color: C.text,
              outline: "none",
            },
          }),
          h(
            Btn,
            {
              disabled: busy || reason.trim() === "" || node.status === "blocked",
              onClick: function () { run("task.update", { id: node.id, status: "blocked", blocked_reason: reason.trim() }); },
            },
            L.blockIt,
          ),
        ),
        error ? h("div", { style: { color: C.err, fontSize: "11px", marginTop: "6px" } }, error) : null,
      );
    }

    /* ── the inline tree ────────────────────────────────────────────────── */
    function MasterPlanView(props) {
      var plan = usePlan();
      var [collapsed, setCollapsed] = React.useState({});
      var [filter, setFilter] = React.useState("all");
      var [selected, setSelected] = React.useState("");
      var [open, setOpen] = React.useState(true);
      var [showLog, setShowLog] = React.useState(false);

      var view = plan.snap.status === "ready" ? plan.snap.view : null;
      var rows = view ? toRows(view.roots, filter, collapsed) : [];
      var selectedNode = null;
      if (view && selected) {
        (function find(list) {
          for (var i = 0; i < list.length; i += 1) {
            if (list[i].id === selected) { selectedNode = list[i]; return; }
            find(list[i].children);
          }
        })(view.roots);
      }

      var header = h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "7px 10px",
            borderBottom: open ? "1px solid " + C.border : "none",
            flexWrap: "wrap",
          },
        },
        h("span", { style: { color: C.accent, fontSize: "12px" } }, "◆"),
        h("strong", { style: { color: C.text, fontSize: "12px" } }, "Master Plan"),
        view
          ? h(
              "span",
              { style: { color: C.textSoft, fontSize: "12px" } },
              (view.project ? view.project.name : L.unset) + " · " + view.stats.total + " " + L.tasks,
            )
          : null,
        view
          ? h(
              "span",
              { style: { color: C.textDim, fontSize: "11px" } },
              [
                view.stats.pending ? view.stats.pending + " " + L.pending : "",
                view.stats.active ? view.stats.active + " " + L.active : "",
                view.stats.done ? view.stats.done + " " + L.done : "",
                view.stats.blocked ? view.stats.blocked + " " + L.blocked : "",
              ]
                .filter(Boolean)
                .join(" · "),
            )
          : null,
        h("span", { style: { flex: "1 1 auto" } }),
        props.toolName
          ? h("span", { style: { fontFamily: MONO, color: C.textDim, fontSize: "10px" } }, props.toolName)
          : null,
        h(Btn, { onClick: function () { setOpen(!open); } }, open ? L.hide : L.show),
      );

      if (!open) {
        return h("div", { style: wrapperStyle() }, header);
      }

      var body;
      if (plan.snap.status === "loading") {
        body = h("div", { style: { padding: "10px", color: C.textDim, fontSize: "12px" } }, L.loading);
      } else if (plan.snap.status === "error") {
        body = h(
          "div",
          { style: { padding: "10px", color: C.textDim, fontSize: "12px" } },
          h("div", null, L.offline),
          h("div", { style: { fontFamily: MONO, fontSize: "10px", marginTop: "3px" } }, plan.snap.error || ""),
          h("div", { style: { marginTop: "7px" } }, h(Btn, { onClick: plan.reload }, L.retry)),
        );
      } else if (view.stats.total === 0) {
        body = h("div", { style: { padding: "10px", color: C.textDim, fontSize: "12px" } }, L.empty);
      } else {
        body = h(
          "div",
          { style: { maxHeight: "360px", overflow: "auto", padding: "3px 0" } },
          rows.map(function (node) {
            var isCollapsed = collapsed[node.id] === true;
            var hasKids = node.children.length > 0;
            return h(
              "div",
              {
                key: node.id,
                onClick: function () { setSelected(selected === node.id ? "" : node.id); },
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "3px 10px 3px " + (10 + node.depth * 15) + "px",
                  cursor: "pointer",
                  background: selected === node.id ? C.hover : "transparent",
                },
                title: node.blockedReason || node.title,
              },
              h(
                "span",
                {
                  onClick: function (e) {
                    e.stopPropagation();
                    if (!hasKids) return;
                    setCollapsed(Object.assign({}, collapsed, { [node.id]: !isCollapsed }));
                  },
                  style: {
                    width: "11px",
                    flex: "0 0 auto",
                    color: C.textDim,
                    fontSize: "9px",
                    cursor: hasKids ? "pointer" : "default",
                    visibility: hasKids ? "visible" : "hidden",
                  },
                },
                isCollapsed ? "▶" : "▼",
              ),
              Dot(node.status),
              h(
                "span",
                {
                  style: {
                    color: node.status === "done" ? C.textDim : C.text,
                    fontSize: "12px",
                    textDecoration: node.status === "done" ? "line-through" : "none",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                },
                node.title,
              ),
              h("span", { style: { fontFamily: MONO, color: C.textDim, fontSize: "10px" } }, node.id),
              node.isCurrent ? h(Chip, { active: true, title: L.current }, "▶ " + L.current) : null,
              node.status === "blocked" ? h(Chip, { title: node.blockedReason }, L.blocked) : null,
              node.blockedByDeps.length > 0 && node.status !== "done"
                ? h(Chip, { title: node.blockedByDeps.map(function (d) { return d.id; }).join(", ") }, "⏳ " + node.blockedByDeps.length)
                : null,
              node.deps.length > 0 && node.blockedByDeps.length === 0
                ? h(Chip, { title: node.deps.map(function (d) { return d.id; }).join(", ") }, "⇠ " + node.deps.length)
                : null,
            );
          }),
        );
      }

      var toolbar = view
        ? h(
            "div",
            {
              style: {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                padding: "6px 10px",
                borderTop: "1px solid " + C.border,
                flexWrap: "wrap",
              },
            },
            h(Chip, { active: filter === "all", onClick: function () { setFilter("all"); } }, L.filterAll),
            h(Chip, { active: filter === "open", onClick: function () { setFilter("open"); } }, L.filterOpen),
            h(Chip, { active: filter === "blocked", onClick: function () { setFilter("blocked"); } }, L.filterBlocked),
            h(Chip, { active: filter === "done", onClick: function () { setFilter("done"); } }, L.filterDone),
            h("span", { style: { flex: "1 1 auto" } }),
            h(Btn, { onClick: function () { setCollapsed({}); } }, L.expandAll),
            h(
              Btn,
              {
                onClick: function () {
                  var all = {};
                  for (var i = 0; i < rows.length; i += 1) all[rows[i].id] = true;
                  setCollapsed(all);
                },
              },
              L.collapseAll,
            ),
            h(Btn, { onClick: plan.reload }, L.refresh),
            view.log.length > 0 ? h(Chip, { active: showLog, onClick: function () { setShowLog(!showLog); } }, L.log + " (" + view.log.length + ")") : null,
          )
        : null;

      var currentBanner =
        view && view.stats.total > 0
          ? h(
              "div",
              {
                style: {
                  padding: "5px 10px",
                  fontSize: "11px",
                  color: view.currentTask ? C.text : C.textDim,
                  borderBottom: "1px solid " + C.border,
                },
              },
              view.currentTask
                ? L.current + ": " + view.currentTask.title + " (" + view.currentTask.id + ")"
                : L.none,
            )
          : null;

      var logBox =
        view && showLog && view.log.length > 0
          ? h(
              "div",
              {
                style: {
                  borderTop: "1px solid " + C.border,
                  padding: "6px 10px",
                  maxHeight: "120px",
                  overflow: "auto",
                  fontFamily: MONO,
                  fontSize: "10px",
                  color: C.textDim,
                },
              },
              view.log
                .slice()
                .reverse()
                .map(function (e) {
                  return h("div", { key: e.seq + e.op }, "#" + e.seq + " " + e.actor + " " + e.op + " " + (e.taskId || "") + " — " + e.summary);
                }),
            )
          : null;

      return h(
        "div",
        { style: wrapperStyle() },
        header,
        currentBanner,
        body,
        selectedNode ? h("div", { style: { padding: "0 10px 8px" } }, h(Detail, { node: selectedNode, mutate: plan.mutate, reload: plan.reload })) : null,
        toolbar,
        logBox,
      );
    }

    function wrapperStyle() {
      return {
        margin: "6px 0",
        border: "1px solid " + C.border,
        borderRadius: "10px",
        background: C.bg,
        color: C.text,
        overflow: "hidden",
        fontSize: "12px",
      };
    }

    /* ── registration ───────────────────────────────────────────────────── */
    function apply(ctx) {
      ctx.slots.inject("tool.call.toolview", function* () {
        for (var i = 0; i < TOOL_NAMES.length; i += 1) {
          yield ctx.slots.register({ name: "tool.call.toolview", key: TOOL_NAMES[i] }, MasterPlanView);
        }
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.MasterPlanView = MasterPlanView;
    exports._internals = { toRows: toRows, visibleIn: visibleIn, matches: matches };
    return module.exports;
  },
});
