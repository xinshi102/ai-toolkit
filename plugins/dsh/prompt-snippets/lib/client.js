/**
 * @local/dsh-prompt-snippets — 浏览器侧：右侧边栏「提示词」面板。
 * 全部动作经远端命令（/snippet …）完成，面板本身无状态：
 *   - 进入 tab 时拉 /snippet --json
 *   - 点「插入」→ /snippet <name>（主机把正文注入会话）
 *   - 删除 → /snippet rm <name>；新建 → /snippet save <name> <body>
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-prompt-snippets",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var NS = "prompt-snippets";
    var KEY = "prompt-snippets";

    var ZH = {
      "title": "提示词",
      "insert": "插入",
      "remove": "删除",
      "new": "新建",
      "namePlaceholder": "名称（字母数字-_）",
      "bodyPlaceholder": "正文……",
      "save": "保存",
      "empty": "还没有 snippet。在下方新建，或用 /snippet save <name> <正文>。",
      "status.inserted": "已插入「{name}」",
      "status.removed": "已删除「{name}」",
      "status.saved": "已保存「{name}」",
      "status.failed": "操作失败：{msg}",
      "hint": "点「插入」把提示词送入当前会话",
      "guideDesc": "提示词 snippet 库：一键插入常用提示词",
    };
    var EN = {
      "title": "Snippets",
      "insert": "Insert",
      "remove": "Delete",
      "new": "New",
      "namePlaceholder": "name (a-z0-9-_)",
      "bodyPlaceholder": "body…",
      "save": "Save",
      "empty": "No snippets yet. Create one below, or /snippet save <name> <body>.",
      "status.inserted": "inserted \"{name}\"",
      "status.removed": "removed \"{name}\"",
      "status.saved": "saved \"{name}\"",
      "status.failed": "failed: {msg}",
      "hint": "Insert sends the snippet into this session",
      "guideDesc": "Snippet library: insert a saved prompt in one click",
    };

    function fill(tpl, vars) {
      return String(tpl).replace(/\{(\w+)\}/g, function (_m, k) { return Object.hasOwn(vars, k) ? String(vars[k]) : ""; });
    }

    function runCommand(ctx, sessionId, text) {
      return ctx.remote.commands.execute(sessionId, text, []).then(function (result) {
        if (!result.ok) throw new Error((result.error && result.error.message) || "command failed");
        return result.value;
      });
    }

    function parseList(value) {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") { try { return JSON.parse(value); } catch (e) { return []; } }
      if (value && Array.isArray(value.list)) return value.list;
      if (value && typeof value.text === "string") { try { return JSON.parse(value.text); } catch (e) { return []; } }
      return [];
    }

    function SnippetsBody(props) {
      var t = typeof props.t === "function" ? props.t : function (k) { return ZH[k] || k; };
      var ctx = props.ctx;
      var sessionId = props.sessionId;
      var itemsState = React.useState([]);
      var items = itemsState[0];
      var setItems = itemsState[1];
      var statusState = React.useState("");
      var status = statusState[0];
      var setStatus = statusState[1];
      var nameState = React.useState("");
      var name = nameState[0];
      var setName = nameState[1];
      var bodyState = React.useState("");
      var body = bodyState[0];
      var setBody = bodyState[1];
      var loadingState = React.useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      function refresh() {
        if (ctx === undefined || sessionId === undefined) return;
        setLoading(true);
        runCommand(ctx, sessionId, "/snippet --json")
          .then(function (value) { setItems(parseList(value)); })
          .catch(function (e) { setStatus(fill(t("status.failed"), { msg: String(e && e.message || e) })); })
          .then(function () { setLoading(false); });
      }

      React.useEffect(function () { refresh(); }, [sessionId]);

      function act(label, text) {
        if (ctx === undefined || sessionId === undefined) return;
        runCommand(ctx, sessionId, text)
          .then(function () { setStatus(label); refresh(); })
          .catch(function (e) { setStatus(fill(t("status.failed"), { msg: String(e && e.message || e) })); });
      }

      var h = React.createElement;
      var btn = {
        padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.4))",
        background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit",
      };
      var input = {
        width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: 12,
        borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.4))",
        background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit",
      };

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 12 } },
        h("div", { style: { padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25))", flex: "none" } },
          h("span", { style: { fontWeight: 600 } }, t("title")),
          h("span", { style: { opacity: 0.6, marginLeft: 8 } }, t("hint"))
        ),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: 10 } },
          loading ? h("div", { style: { opacity: 0.6 } }, "…") : null,
          !loading && items.length === 0 ? h("div", { style: { opacity: 0.7, lineHeight: 1.7 } }, t("empty")) : null,
          items.map(function (s) {
            return h(
              "div",
              {
                key: s.name,
                style: {
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", marginBottom: 6,
                  borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25))",
                },
              },
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontWeight: 600 } }, s.name),
                h("div", { style: { opacity: 0.65, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(s.body || "").slice(0, 60))
              ),
              h("button", { type: "button", style: btn, onClick: function () { act(fill(t("status.inserted"), { name: s.name }), "/snippet " + s.name); } }, t("insert")),
              h("button", { type: "button", style: btn, onClick: function () { act(fill(t("status.removed"), { name: s.name }), "/snippet rm " + s.name); } }, t("remove"))
            );
          })
        ),
        h("div", { style: { flex: "none", padding: 10, borderTop: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25))" } },
          h("div", { style: { display: "flex", gap: 6, marginBottom: 6 } },
            h("input", {
              style: Object.assign({}, input, { flex: 1 }), value: name, placeholder: t("namePlaceholder"),
              onChange: function (e) { setName(e.target.value); },
            }),
            h("button", {
              type: "button", style: btn,
              onClick: function () {
                var n = name.trim();
                if (n === "" || body.trim() === "") { setStatus(fill(t("status.failed"), { msg: "name/body required" })); return; }
                runCommand(ctx, sessionId, "/snippet save " + n + " " + body.trim())
                  .then(function () { setStatus(fill(t("status.saved"), { name: n })); setName(""); setBody(""); refresh(); })
                  .catch(function (e) { setStatus(fill(t("status.failed"), { msg: String(e && e.message || e) })); });
              },
            }, t("save"))
          ),
          h("textarea", {
            style: Object.assign({}, input, { minHeight: 64, resize: "vertical" }), value: body, placeholder: t("bodyPlaceholder"),
            onChange: function (e) { setBody(e.target.value); },
          }),
          status ? h("div", { style: { marginTop: 6, opacity: 0.75 } }, status) : null
        )
      );
    }

    function SnippetsTitle() {
      return React.createElement("span", null, ZH.title);
    }

    var apply = function (ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: ZH, en: EN }); }, "prompt-snippets: dictionaries");
      // Tab 类型登记（否则「+」/指南列表里看不到）
      ctx.effect(function () {
        var t = ctx.locale.bind(NS);
        return ctx.sidebarRightTabs.register({
          id: KEY,
          kind: KEY,
          title: function () { return t("title"); },
          guide: [{
            order: 30,
            title: function () { return t("title"); },
            description: function () { return t("guideDesc"); },
          }],
        });
      }, "prompt-snippets: tab type");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: KEY,
            locale: NS,
            inject: function () { return { ctx: ctx }; },
          }, SnippetsBody);
        });
      }, "prompt-snippets: sidebar tab body");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({
            name: "sidebar.right.pane.tab.title",
            key: KEY,
          }, SnippetsTitle);
        });
      }, "prompt-snippets: sidebar tab title");
    };

    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote", "remote.commands", "sidebarRightTabs"];
    return module.exports;
  },
});
