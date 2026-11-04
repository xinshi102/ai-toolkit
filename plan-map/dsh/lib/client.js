/**
 * @local/dsh-plan-map — 浏览器侧：右侧边栏「Plan Map」思维导图。
 * 数据源：主机 planTree 投影的 wire view —— 侧边栏 Tab 的组件拿不到 conversation 的
 * useProjection prop，所以自己用会话绑定读：ctx.sessions.binding(id).session.projections.faceOf(key)。
 * 布局：横向树，叶子顺序占位、父节点居中；折叠的节点显示 +n 徽标。
 * 注意：layoutTree 与 lib/layout.js 保持同步（ tested there ）。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-plan-map",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var h = React.createElement;

    var NS = "plan-map";
    /** apply(ctx) 时捕获；座位若没把 inject 结果传进来也能拿到通道（比依赖 props 稳）。 */
    var pluginCtx = null;
    var KEY = "plan-map";
    var NODE_H = 34;
    var GAP_X = 44;
    var GAP_Y = 12;
    var PAD_X = 14;
    var DOT_W = 18;
    var NOTE_W = 14;
    var BADGE_W = 30;
    var COMPACT = { nodeHeight: 28, gapX: 26, gapY: 7, padX: 10, font: 11 };
    var MIN_ZOOM = 0.7;
    var MAX_ZOOM = 2;

    var ZH = {
      "title": "计划树",
      "empty": "计划树为空。让 AI 用 plan_import 登记你的计划（缩进大纲或 markdown），或批准一个 plan mode 计划（会自动解析入图）。",
      "noface": "投影未连接：plan-map 主机插件可能未加载，或该会话还没建立客户端绑定。重开一个会话再试。",
      "expand": "全部展开",
      "collapse": "全部折叠",
      "planMode": "计划模式",
      "detail.none": "点击节点查看细化内容",
      "status.pending": "待办",
      "status.active": "进行中",
      "status.done": "完成",
      "status.blocked": "阻塞",
      "count": "{n} 个节点",
      "progress": "已完成 {done}/{total}",
      "guideDesc": "你的计划树：节点进度、分支细化",
      "fitWidth": "适宽",
      "zoomIn": "放大",
      "zoomOut": "缩小",
      "compact": "紧凑",
      "compactHint": "紧凑：更窄的卡片与更小间距（重排，不缩字）",
      "directionHorizontal": "左右",
      "directionVertical": "上下",
      "directionHint": "切换布局方向：左右（左根右枝）/ 上下（上根下枝）",
      "view": "视图",
      "popDirection": "方向",
      "popScale": "缩放",
      "popBranches": "分支",
      "close": "取消选中",
      "noChannel": "命令通道不可用：plan-map 可能未正确加载（检查插件是否在运行、页面是否已刷新）",
      "cmdError": "命令失败：",
      "viewHint": "方向 / 缩放 / 紧凑 / 折叠",
      "autoLayout": "自动布局",
      "autoLayoutHint": "清掉所有手工位置，回到自动 tidy tree 布局",
      "resetNode": "复位此节点",
      "resetNodeHint": "只清掉选中节点的手工位置",
    };
    var EN = {
      "title": "Plan Map",
      "empty": "The plan tree is empty. Ask the AI to register your plan with plan_import (indented outline or markdown), or approve a plan-mode plan (parsed automatically).",
      "noface": "Projection not connected: the plan-map host plugin may not be loaded, or this session has no client binding yet.",
      "expand": "Expand all",
      "collapse": "Collapse all",
      "planMode": "Plan mode",
      "detail.none": "Click a node to see its detail",
      "status.pending": "pending",
      "status.active": "active",
      "status.done": "done",
      "status.blocked": "blocked",
      "count": "{n} nodes",
      "progress": "{done}/{total} done",
      "guideDesc": "Your plan tree: node progress and branches",
      "fitWidth": "Fit width",
      "zoomIn": "Zoom in",
      "zoomOut": "Zoom out",
      "compact": "Compact",
      "compactHint": "Compact: narrower cards and tighter gaps (re-layout, no font shrink)",
      "directionHorizontal": "Left→right",
      "directionVertical": "Top→down",
      "directionHint": "Switch layout direction: left→right / top→down",
      "view": "View",
      "popDirection": "Direction",
      "popScale": "Zoom",
      "popBranches": "Branches",
      "close": "Clear selection",
      "noChannel": "Command channel unavailable: plan-map may not be loaded (check the plugin and refresh the page)",
      "cmdError": "Command failed: ",
      "viewHint": "Direction / zoom / compact / collapse",
      "autoLayout": "Auto layout",
      "autoLayoutHint": "Clear all manual positions and return to the tidy tree",
      "resetNode": "Reset node",
      "resetNodeHint": "Clear the selected node's manual position only",
    };

    var STATUS_COLOR = { pending: "#94a3b8", active: "#3b82f6", done: "#22c55e", blocked: "#ef4444" };
    // 极浅的状态底纹：让「已完成/进行中/阻塞」在卡片上也能一眼扫出来
    var STATUS_TINT = {
      pending: "rgba(148,163,184,.07)",
      active: "rgba(59,130,246,.10)",
      done: "rgba(34,197,94,.10)",
      blocked: "rgba(239,68,68,.10)",
    };

    function fill(tpl, vars) {
      return String(tpl).replace(/\{(\w+)\}/g, function (_m, k) { return Object.hasOwn(vars, k) ? String(vars[k]) : ""; });
    }

    /* ── 布局（与 lib/layout.js 同步：可变宽度 tidy tree，支持左右/上下两种方向） ── */

    /** 标题实测宽度：CJK 按字号 1.0、其余按 0.55 估。 */
    function measureTitle(title, font) {
      var units = 0;
      for (var ch of String(title == null ? "" : title)) units += /[\u2E80-\uFFFD]/.test(ch) ? 1 : 0.55;
      return Math.ceil(units * font);
    }

    /** 卡片宽度（含状态点、内边距、备注点、折叠徽标）。 */
    function nodeWidthOf(node, options) {
      options = options || {};
      var compact = options.compact === true;
      var font = compact ? COMPACT.font : 12;
      var padX = compact ? COMPACT.padX : PAD_X;
      var text = measureTitle(node && node.title, font);
      var extra = DOT_W + padX * 2 + (node && node.note ? NOTE_W : 0) + (node && node.collapsedChildren ? BADGE_W : 0);
      return Math.max(compact ? 76 : 88, Math.min(compact ? 220 : 280, text + extra));
    }

    function layoutTree(nodes, options) {
      options = options || {};
      var compact = options.compact === true;
      var vertical = options.direction === "vertical";
      var nodeH = options.nodeHeight || (compact ? COMPACT.nodeHeight : NODE_H);
      var gapX = options.gapX == null ? (compact ? COMPACT.gapX : GAP_X) : options.gapX;
      var gapY = options.gapY == null ? (compact ? COMPACT.gapY : GAP_Y) : options.gapY;
      var collapsed = new Set(options.collapsed || []);
      var byId = new Map();
      var list = [];
      for (var raw of nodes || []) {
        var node = { id: raw.id, parent: raw.parent || "", title: raw.title, status: raw.status, note: raw.note, kids: [], _p: 0, _depth: 0, _visible: false };
        byId.set(node.id, node);
        list.push(node);
      }
      function parentOf(node) {
        var p0 = node.parent;
        if (p0 === "" || !byId.has(p0)) return undefined;
        var seen = new Set([node.id]);
        var cur = p0;
        while (cur !== "") {
          if (seen.has(cur)) return undefined;
          seen.add(cur);
          cur = (byId.get(cur) || {}).parent || "";
        }
        return byId.get(p0);
      }
      var roots = [];
      for (var n of list) {
        var par = parentOf(n);
        if (par === undefined) roots.push(n);
        else par.kids.push(n);
      }
      function visibleKids(node) { return collapsed.has(node.id) ? [] : node.kids; }
      function widthOf(node) {
        return nodeWidthOf({ title: node.title, note: node.note, collapsedChildren: collapsed.has(node.id) }, { compact: compact });
      }
      function extent(node) { return vertical ? widthOf(node) : nodeH; }
      var gapPrimary = vertical ? gapX : gapY;
      function shift(node, delta) {
        node._p += delta;
        for (var kid of visibleKids(node)) shift(kid, delta);
      }
      function place(node, depth) {
        node._depth = depth;
        node._visible = true;
        var kids = visibleKids(node);
        var size = extent(node);
        if (kids.length === 0) {
          node._p = size / 2;
          return { top: 0, bottom: size };
        }
        var cursor = 0;
        for (var kid of kids) {
          var kidBox = place(kid, depth + 1);
          shift(kid, cursor - kidBox.top);
          cursor += kidBox.bottom - kidBox.top + gapPrimary;
        }
        var first = kids[0];
        var last = kids[kids.length - 1];
        node._p = (first._p + last._p) / 2;
        var boxTop = Math.min(node._p - size / 2, 0);
        var boxBottom = Math.max(node._p + size / 2, cursor - gapPrimary);
        if (boxTop !== 0) { shift(node, -boxTop); boxBottom -= boxTop; }
        return { top: 0, bottom: boxBottom };
      }
      // 多个根之间留 3 倍间距，让不同根的子树读起来是分开的"带"
      var ROOT_GAP = gapPrimary * 3;
      var rootCursor = 0;
      for (var ri = 0; ri < roots.length; ri += 1) {
        var rootNode = roots[ri];
        var rootBox = place(rootNode, 0);
        shift(rootNode, rootCursor - rootBox.top);
        rootCursor += rootBox.bottom - rootBox.top + (ri === roots.length - 1 ? 0 : ROOT_GAP);
      }
      var depthExtent = [];
      var sized = list.filter(function (node) { return node._visible; }).map(function (node) {
        var w = widthOf(node);
        var along = vertical ? nodeH : w;
        depthExtent[node._depth] = Math.max(depthExtent[node._depth] || 0, along);
        return { node: node, w: w };
      });
      var depthPos = [];
      var cursorDepth = 0;
      for (var d = 0; d < depthExtent.length; d += 1) {
        depthPos[d] = cursorDepth;
        cursorDepth += (depthExtent[d] || 0) + (vertical ? gapY : gapX);
      }
      var positions = {};
      for (var item of sized) {
        var x = vertical ? item.node._p - item.w / 2 : (depthPos[item.node._depth] || 0);
        var y = vertical ? (depthPos[item.node._depth] || 0) : item.node._p - nodeH / 2;
        positions[item.node.id] = { x: x, y: y, w: item.w, h: nodeH, depth: item.node._depth, collapsed: collapsed.has(item.node.id) };
      }
      // 防御：同一层若重叠就依次推开（异常输入也不让它叠在一起）
      var minGap = vertical ? gapX : gapY;
      var columns = new Map();
      for (var pid of Object.keys(positions)) {
        var rect = positions[pid];
        if (!columns.has(rect.depth)) columns.set(rect.depth, []);
        columns.get(rect.depth).push(pid);
      }
      columns.forEach(function (ids) {
        ids.sort(function (a, b) { return vertical ? positions[a].x - positions[b].x : positions[a].y - positions[b].y; });
        for (var i = 1; i < ids.length; i += 1) {
          var prev = positions[ids[i - 1]];
          var cur = positions[ids[i]];
          if (vertical) cur.x = Math.max(cur.x, prev.x + prev.w + minGap);
          else cur.y = Math.max(cur.y, prev.y + prev.h + minGap);
        }
      });
      var spanDepth = 0;
      var spanPrimary = 0;
      var minPrimary = 0;
      for (var qid of Object.keys(positions)) {
        var r2 = positions[qid];
        spanDepth = Math.max(spanDepth, vertical ? r2.y + nodeH : r2.x + r2.w);
        spanPrimary = Math.max(spanPrimary, vertical ? r2.x + r2.w : r2.y + r2.h);
        minPrimary = Math.min(minPrimary, vertical ? r2.x : r2.y);
      }
      if (minPrimary < 0) {
        for (var sid of Object.keys(positions)) {
          if (vertical) positions[sid].x -= minPrimary; else positions[sid].y -= minPrimary;
        }
        spanPrimary -= minPrimary;
      }
      var edges = [];
      for (var node2 of list) {
        var parent2 = parentOf(node2);
        if (parent2 !== undefined && visibleKids(parent2).indexOf(node2) >= 0) edges.push({ from: parent2.id, to: node2.id });
      }
      var subtree = {};
      for (var node3 of list) {
        if (!collapsed.has(node3.id)) continue;
        var count = 0;
        var stack = node3.kids.slice();
        var seenSet = new Set(stack.map(function (k) { return k.id; }));
        while (stack.length > 0) {
          var cur2 = stack.pop();
          count += 1;
          for (var kid2 of cur2.kids) if (!seenSet.has(kid2.id)) { seenSet.add(kid2.id); stack.push(kid2); }
        }
        subtree[node3.id] = count;
      }
      return {
        width: vertical ? Math.max(120, spanPrimary) : Math.max(120, spanDepth),
        height: vertical ? Math.max(nodeH, spanDepth) : Math.max(nodeH, spanPrimary),
        nodeH: nodeH,
        direction: vertical ? "vertical" : "horizontal",
        positions: positions,
        edges: edges,
        roots: roots.map(function (r) { return r.id; }),
        subtree: subtree,
        depthPos: depthPos,
      };
    }

    /** 横向圆角折线：父右中 → 短横 → 竖 → 短横 → 子左中。 */
    function elbowPath(parent, child, radius) {
      radius = radius == null ? 9 : radius;
      var x1 = parent.x + parent.w;
      var y1 = parent.y + parent.h / 2;
      var x2 = child.x;
      var y2 = child.y + child.h / 2;
      var dy = y2 - y1;
      if (Math.abs(dy) < 1.5) return "M " + x1 + " " + y1 + " H " + x2;
      var gap = x2 - x1;
      if (gap <= radius * 2 + 2) {
        var ddx = Math.max(8, gap * 0.5);
        return "M " + x1 + " " + y1 + " C " + (x1 + ddx) + " " + y1 + ", " + (x2 - ddx) + " " + y2 + ", " + x2 + " " + y2;
      }
      var mid = x1 + Math.min(gap / 2, Math.max(radius + 4, 18));
      var r = Math.min(radius, Math.abs(dy) / 2, Math.abs(x1 - mid), Math.abs(x2 - mid));
      var sign = dy > 0 ? 1 : -1;
      return "M " + x1 + " " + y1 + " H " + (mid - r) +
        " Q " + mid + " " + y1 + " " + mid + " " + (y1 + sign * r) +
        " V " + (y2 - sign * r) +
        " Q " + mid + " " + y2 + " " + (mid + r) + " " + y2 +
        " H " + x2;
    }

    /** 竖向圆角折线：父下中 → 短竖 → 横 → 短竖 → 子上中。 */
    function elbowPathVertical(parent, child, radius) {
      radius = radius == null ? 9 : radius;
      var x1 = parent.x + parent.w / 2;
      var y1 = parent.y + parent.h;
      var x2 = child.x + child.w / 2;
      var y2 = child.y;
      var dx = x2 - x1;
      if (Math.abs(dx) < 1.5) return "M " + x1 + " " + y1 + " V " + y2;
      var gap = y2 - y1;
      if (gap <= radius * 2 + 2) {
        var ddy = Math.max(8, gap * 0.5);
        return "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + ddy) + ", " + x2 + " " + (y2 - ddy) + ", " + x2 + " " + y2;
      }
      var mid = y1 + Math.min(gap / 2, Math.max(radius + 4, 16));
      var r = Math.min(radius, Math.abs(dx) / 2, Math.abs(y1 - mid), Math.abs(y2 - mid));
      var sign = dx > 0 ? 1 : -1;
      return "M " + x1 + " " + y1 + " V " + (mid - r) +
        " Q " + x1 + " " + mid + " " + (x1 + sign * r) + " " + mid +
        " H " + (x2 - sign * r) +
        " Q " + x2 + " " + mid + " " + x2 + " " + (mid + r) +
        " V " + y2;
    }

    function linkPath(parent, child, direction) {
      return direction === "vertical" ? elbowPathVertical(parent, child) : elbowPath(parent, child);
    }

    /** 单字符渲染宽度（CJK 1.0、其余 0.55）。 */
    function charWidth(ch, font) {
      return (/[\u2E80-\uFFFD]/.test(ch) ? 1 : 0.55) * font;
    }

    /** 按像素宽度逐字截断（不能用「字符数 × 平均字宽」估，中文会冲出边框）。 */
    function truncateToWidth(title, maxPx, font, ellipsis) {
      ellipsis = ellipsis == null ? "…" : ellipsis;
      var text = String(title == null ? "" : title);
      if (maxPx <= 0) return "";
      if (measureTitle(text, font) <= maxPx) return text;
      var budget = Math.max(0, maxPx - charWidth(ellipsis, font));
      var width = 0;
      var out = "";
      for (var ch2 of text) {
        var w = charWidth(ch2, font);
        if (width + w > budget) break;
        out += ch2;
        width += w;
      }
      while (out.length > 0 && measureTitle(out + ellipsis, font) > maxPx) out = out.slice(0, -1);
      if (out.length > 0) return out + ellipsis;
      return measureTitle(ellipsis, font) <= maxPx ? ellipsis : "";
    }

    /** 相互重叠的节点 id（与 lib/layout.js 的同名函数逐字一致，⑩ 会比对两份）。 */
    function collidingIds(positions) {
      var entries = Object.entries(positions || {});
      var hit = new Set();
      for (var i = 0; i < entries.length; i += 1) {
        for (var j = i + 1; j < entries.length; j += 1) {
          var a = entries[i][1];
          var b = entries[j][1];
          if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
            hit.add(entries[i][0]);
            hit.add(entries[j][0]);
          }
        }
      }
      return [...hit];
    }

    /** 面板尺寸（ResizeObserver；不可用时回落到 0 = 不缩放）。 */
    function useContainerSize(ref) {
      var React = require("react");
      var state = React.useState(function () { return { w: 0, h: 0 }; });
      var size = state[0];
      var setSize = state[1];
      React.useEffect(function () {
        var el = ref.current;
        if (!el) return function () {};
        var measure = function () { setSize({ w: el.clientWidth, h: el.clientHeight }); };
        measure();
        if (typeof ResizeObserver === "undefined") {
          if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", measure);
          return function () { if (typeof window !== "undefined" && window.removeEventListener) window.removeEventListener("resize", measure); };
        }
        var observer = new ResizeObserver(measure);
        observer.observe(el);
        return function () { observer.disconnect(); };
      }, [ref]);
      return size;
    }

    /**
     * 读一个会话投影的 wire view。
     * 侧边栏 Tab 座位只给 sessionId / tab 等 prop，不给 useProjection，
     * 所以这里用官方客户端 API 自己订阅：binding.session.projections.faceOf(key)。
     * @returns {face, value} face=undefined 表示会话绑定/投影能力不可用（要能区分"没数据"和"没连上"）
     */
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

    /** 视图偏好（方向/折叠/紧凑）按会话存在 localStorage —— 浏览器侧偏好，不动会话日志。 */
    function prefsFor(sessionId) {
      var key = "dsh-plan-map:" + String(sessionId == null ? "default" : sessionId);
      return {
        read: function () {
          try {
            var raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
            return raw === null ? {} : JSON.parse(raw);
          } catch (error) { return {}; }
        },
        write: function (patch) {
          try {
            if (typeof localStorage === "undefined") return;
            var next = Object.assign({}, prefsFor(sessionId).read(), patch);
            localStorage.setItem(key, JSON.stringify(next));
          } catch (error) { /* 隐私模式/配额：忽略 */ }
        },
      };
    }

    /** 状态 → 前置字形（取代原来那条左侧色条：更轻、信息量一样）。 */
    var STATUS_GLYPH = { pending: "○", active: "●", done: "✓", blocked: "!" };

    function PlanMapBody(props) {
      var t = typeof props.t === "function" ? props.t : function (k) { return ZH[k] || k; };
      var read = useFaceView(props.ctx, props.sessionId, "planTree");
      var view = read.value || { nodes: [], planMode: false, updatedSeq: 0, progress: { done: 0, total: 0 } };
      var nodes = view.nodes || [];

      var prefs = React.useMemo(function () { return prefsFor(props.sessionId); }, [props.sessionId]);
      var initial = React.useMemo(function () { return prefs.read(); }, [prefs]);
      var dirState = React.useState(initial.direction === "vertical" ? "vertical" : "horizontal");
      var direction = dirState[0];
      var setDirection = dirState[1];
      var collapsedState = React.useState(function () { return new Set(Array.isArray(initial.collapsed) ? initial.collapsed : []); });
      // 用户是否手动动过折叠：动过之后不再自动折叠（尊重用户的展开状态）
      var touchedState = React.useState(initial.collapsedTouched === true);
      var collapsedTouched = touchedState[0];
      var setCollapsedTouched = touchedState[1];
      var collapsed = collapsedState[0];
      var setCollapsed = collapsedState[1];
      var compactState = React.useState(initial.compact === true);
      var compact = compactState[0];
      var setCompact = compactState[1];
      // 自由布局：每个节点的手工偏移（拖到哪儿就是哪儿），按会话持久化
      var offsetsState = React.useState(function () {
        return initial.offsets !== null && typeof initial.offsets === "object" ? Object.assign({}, initial.offsets) : {};
      });
      var offsets = offsetsState[0];
      var setOffsets = offsetsState[1];
      // 乐观状态：点了立刻变（宿主投影回来后被真实值覆盖）
      var optimisticState = React.useState(null);
      var optimistic = optimisticState[0];
      var setOptimistic = optimisticState[1];
      // 拖动结束后会紧跟一个 click；不抑制的话"拖一下就弹出详情面板"
      var suppressClick = React.useRef(false);
      var editingState = React.useState(null);   // {id, text}
      var editing = editingState[0];
      var setEditing = editingState[1];
      var noticeState = React.useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var viewOpenState = React.useState(false);
      var viewOpen = viewOpenState[0];
      var setViewOpen = viewOpenState[1];
      var selectedState = React.useState(null);
      var selected = selectedState[0];
      var setSelected = selectedState[1];
      var containerRef = React.useRef(null);
      var size = useContainerSize(containerRef);
      var fitState = React.useState(true);
      var fit = fitState[0];
      var setFit = fitState[1];
      var zoomState = React.useState(1);
      var zoom = zoomState[0];
      var setZoom = zoomState[1];
      var dragState = React.useState(null);   // {kind:"pan"|"node", id?, x, y, left, top, moved}
      var drag = dragState[0];
      var setDrag = dragState[1];
      var dropState = React.useState(null);   // 拖拽悬停的目标节点 id（"" 表示移到根）
      var drop = dropState[0];
      var setDrop = dropState[1];

      // 完整树（不折叠）先量一次宽度：面板放不下时，默认给"两列总览"而不是让你横向找节点
      var fullLayout = React.useMemo(
        function () { return layoutTree(nodes, { compact: compact, direction: direction }); },
        [nodes, compact, direction]
      );
      var shownCollapsed = React.useMemo(
        function () {
          if (collapsedTouched) return collapsed;
          if (size.w <= 0) return collapsed;
          if (fullLayout.width * MIN_ZOOM <= size.w - 24) return collapsed;
          // 放不下：折叠所有「有子节点的非根节点」（深度 >= 1），根与第一层保持可见
          var index = new Map(nodes.map(function (n) { return [n.id, n]; }));
          var hasChild = new Set(nodes.map(function (n) { return n.parent; }).filter(Boolean));
          var auto = new Set();
          for (var node of nodes) {
            if (!hasChild.has(node.id)) continue;
            var cur = node;
            var depth = 0;
            while (cur !== undefined && cur.parent) { cur = index.get(cur.parent); depth += 1; }
            if (depth >= 1) auto.add(node.id);
          }
          return auto;
        },
        [nodes, collapsed, collapsedTouched, size.w, fullLayout.width]
      );
      var layout = React.useMemo(
        function () { return layoutTree(nodes, { collapsed: shownCollapsed, compact: compact, direction: direction }); },
        [nodes, shownCollapsed, compact, direction]
      );
      // 渲染矩形 = 自动布局位置 + 手工偏移。连线和画布范围都用它，
      // 所以拖节点时连线跟着走、拖到负坐标也不会被裁掉。
      var rects = React.useMemo(
        function () {
          var out = new Map();
          for (var node of nodes) {
            var base = layout.positions[node.id];
            if (base === undefined) continue;
            var off = offsets[node.id] || { dx: 0, dy: 0 };
            out.set(node.id, { x: base.x + off.dx, y: base.y + off.dy, w: base.w, h: base.h, depth: base.depth, collapsed: base.collapsed });
          }
          return out;
        },
        [nodes, layout, offsets]
      );
      var bounds = React.useMemo(
        function () {
          var list = Array.from(rects.values());
          if (list.length === 0) return { minX: 0, minY: 0, width: layout.width, height: layout.height };
          var minX = Math.min.apply(null, list.map(function (r) { return r.x; }));
          var minY = Math.min.apply(null, list.map(function (r) { return r.y; }));
          var maxX = Math.max.apply(null, list.map(function (r) { return r.x + r.w; }));
          var maxY = Math.max.apply(null, list.map(function (r) { return r.y + r.h; }));
          var pad = 10;
          return { minX: minX - pad, minY: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
        },
        [rects, layout]
      );
      // 手工位置没有防重叠：载入/结构变化后若发现互压，就把参与冲突的手工位置复位回自动布局。
      // 只在非拖拽时执行（不和用户手势打架），且只动"有手工位置"的那些节点。
      React.useEffect(
        function () {
          if (drag !== null) return;
          var manual = Object.keys(offsets);
          if (manual.length === 0) return;
          var rectMap = {};
          rects.forEach(function (rect, id) { rectMap[id] = rect; });
          var hit = collidingIds(rectMap);
          if (hit.length === 0) return;
          var touched = hit.filter(function (id) { return manual.indexOf(id) >= 0; });
          if (touched.length === 0) return;
          if (typeof console !== "undefined" && console.info) console.info("[plan-map] 手工位置互压，已复位：", touched.join(", "));
          setOffsets(function (prev) {
            var next = Object.assign({}, prev);
            for (var k = 0; k < touched.length; k += 1) delete next[touched[k]];
            return next;
          });
        },
        [rects, offsets, drag]
      );

      var clearOffsets = function () { setOffsets({}); };
      var resetOne = function (id) {
        setOffsets(function (prev) {
          var out = Object.assign({}, prev);
          delete out[id];
          return out;
        });
      };
      var hasOffsets = Object.keys(offsets).length > 0;

      var availW = size.w > 0 ? size.w - 24 : bounds.width;
      var widthFit = Math.min(1, availW / Math.max(1, bounds.width));
      var scale = fit ? Math.max(MIN_ZOOM, widthFit) : zoom;
      var percent = Math.max(10, Math.round(scale * 100));
      var step = function (delta) {
        var base = fit ? scale : zoom;
        setFit(false);
        setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((base + delta) * 100) / 100)));
      };
      // 记住用户的选择（下次打开同一会话就是这个样子）
      React.useEffect(function () {
        prefs.write({ direction: direction, collapsed: Array.from(collapsed), collapsedTouched: collapsedTouched, compact: compact, offsets: offsets });
      }, [prefs, direction, collapsed, collapsedTouched, compact, offsets]);

      var pathSet = React.useMemo(
        function () {
          if (selected === null) return null;
          var index = new Map(nodes.map(function (n) { return [n.id, n]; }));
          var set = new Set();
          var cur = index.get(selected);
          while (cur !== undefined) {
            set.add(cur.id);
            cur = cur.parent ? index.get(cur.parent) : undefined;
          }
          return set;
        },
        [nodes, selected]
      );
      var faded = function (id) { return pathSet !== null && !pathSet.has(id); };

      var toggleCollapse = function (id) {
        setCollapsedTouched(true);
        setCollapsed(function (prev) {
          var base = collapsedTouched ? prev : shownCollapsed;
          var next = new Set(base);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      /** 执行一条 /planmap 命令：结果与错误都显示出来（静默失败最难查）。 */
      var runCommand = function (text, optimistic) {
        var ctx = props.ctx || pluginCtx;
        if (!ctx || props.sessionId === undefined || props.sessionId === null) {
          setNotice(t("noChannel"));
          return;
        }
        setNotice(null);
        if (optimistic !== undefined) setOptimistic(optimistic);
        var pending;
        try {
          pending = ctx.remote.commands.execute(props.sessionId, text, []);
        } catch (error) {
          setOptimistic(null);
          setNotice(t("cmdError") + String(error && error.message ? error.message : error));
          return;
        }
        Promise.resolve(pending).then(function (result) {
          if (result && result.ok === false) {
            setOptimistic(null);
            var err = result.error || {};
            setNotice(t("cmdError") + (err.message || err.code || "unknown"));
          }
        }).catch(function (error) {
          setOptimistic(null);
          setNotice(t("cmdError") + String(error && error.message ? error.message : error));
        });
      };

      if (nodes.length === 0) {
        return h("div", { style: { padding: 16, lineHeight: 1.7, opacity: 0.75 } }, read.face === undefined ? t("noface") : t("empty"));
      }

      // 乐观状态叠加（只影响显示；真实值由宿主投影回来覆盖）
      var shownNodes = optimistic === null
        ? nodes
        : nodes.map(function (n) { return n.id === optimistic.id ? Object.assign({}, n, optimistic.patch) : n; });
      var allParents = nodes.filter(function (n) { return nodes.some(function (c) { return c.parent === n.id; }); }).map(function (n) { return n.id; });
      var parentSet = new Set(nodes.map(function (n) { return n.parent; }).filter(function (id) { return id !== ""; }));
      var selectedNode = selected !== null ? shownNodes.find(function (n) { return n.id === selected; }) : undefined;

      var btnStyle = {
        padding: "3px 8px", borderRadius: 6, fontSize: 11, cursor: "pointer", lineHeight: "16px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.4))",
        background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit",
      };
      var onBtn = Object.assign({}, btnStyle, { background: "rgba(99,102,241,.16)", borderColor: "transparent", color: "#6366f1" });

      var containerStyle = { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 12, color: "inherit" };
      var toolbarStyle = { display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25))", flex: "none", flexWrap: "wrap" };

      // 拖拽：卡片拖到另一张卡上 = 改父子（走 /planmap move，官方 command/run 落库）；拖空白 = 平移
      var pointOf = function (ev) { return { x: ev.clientX, y: ev.clientY }; };
      var startPan = function (ev) {
        var el = containerRef.current;
        if (el === null) return;
        var p = pointOf(ev);
        setDrag({ kind: "pan", x: p.x, y: p.y, left: el.scrollLeft, top: el.scrollTop });
        if (el.setPointerCapture !== undefined && ev.pointerId !== undefined) el.setPointerCapture(ev.pointerId);
      };
      var startNodeDrag = function (ev, id) {
        var p = pointOf(ev);
        setDrag({ kind: "node", id: id, x: p.x, y: p.y, moved: false, base: offsets[id] || { dx: 0, dy: 0 } });
        setDrop(null);
      };
      /** 把屏幕位移换成 SVG 坐标位移（缩放后要除以 scale）。 */
      var toLocal = function (delta) { return delta / (scale === 0 ? 1 : scale); };
      var onPointerMove = function (ev) {
        if (drag === null) return;
        var p = pointOf(ev);
        var moved = Math.abs(p.x - drag.x) > 3 || Math.abs(p.y - drag.y) > 3;
        if (drag.kind === "pan") {
          var el = containerRef.current;
          if (el === null) return;
          el.scrollLeft = drag.left - (p.x - drag.x);
          el.scrollTop = drag.top - (p.y - drag.y);
          return;
        }
        if (!drag.moved && moved) {
          setDrag(Object.assign({}, drag, { moved: true }));
          return;
        }
        // 自由拖拽：节点跟着指针走（写进 offsets，松手后持久化）
        var base = drag.base || { dx: 0, dy: 0 };
        var next = { dx: Math.round(base.dx + toLocal(p.x - drag.x)), dy: Math.round(base.dy + toLocal(p.y - drag.y)) };
        setOffsets(function (prev) {
          var out = Object.assign({}, prev);
          out[drag.id] = next;
          return out;
        });
      };
      var onPointerUp = function () {
        if (drag === null) return;
        suppressClick.current = drag.moved === true;
        if (drag.kind === "node" && drag.moved) {
          var target = drop === null ? undefined : drop;
          if (target !== undefined && target !== "" && target !== drag.id) {
            // 落在别的节点上 = 挂到它下面：清掉该节点的手工位置，交给自动布局
            runCommand("/planmap move " + drag.id + " " + target);
            setOffsets(function (prev) {
              var out = Object.assign({}, prev);
              delete out[drag.id];
              return out;
            });
          }
          // 落在空白 = 就地自由摆放（offset 已写入，无需再做什么）
        }
        setDrag(null);
        setDrop(null);
      };

      return h(
        "div",
        { style: containerStyle },
        h(
          "div",
          { style: toolbarStyle },
          h("span", { style: { fontWeight: 600 } }, t("title")),
          view.progress
            ? h("span", { style: { opacity: 0.5, fontVariantNumeric: "tabular-nums" } },
                (view.progress.done == null ? 0 : view.progress.done) + "/" + (view.progress.total == null ? nodes.length : view.progress.total))
            : null,
          h("span", { style: { flex: 1 } }),
          h("button", {
            type: "button",
            className: "pm-icon-btn",
            "data-open": viewOpen ? "true" : "false",
            title: t("viewHint"),
            onClick: function () { setViewOpen(!viewOpen); },
            style: { width: 24, height: 22, lineHeight: "18px", padding: 0, borderRadius: 6, fontSize: 13, cursor: "pointer", border: "1px solid transparent", background: "transparent", color: "inherit" },
          }, "⋯")
        ),
        viewOpen
          ? h(
              "div",
              { className: "pm-pop" },
              h("div", { className: "pm-pop-row" },
                h("span", { className: "pm-pop-label" }, t("popDirection")),
                h("button", { type: "button", style: btnStyle, onClick: function () { setDirection("horizontal"); } }, direction === "horizontal" ? "· " + t("directionHorizontal") : t("directionHorizontal")),
                h("button", { type: "button", style: btnStyle, onClick: function () { setDirection("vertical"); } }, direction === "vertical" ? "· " + t("directionVertical") : t("directionVertical"))
              ),
              h("div", { className: "pm-pop-row" },
                h("span", { className: "pm-pop-label" }, t("popScale")),
                fit ? h("span", { style: onBtn }, t("fitWidth")) : h("button", { type: "button", style: btnStyle, onClick: function () { setFit(true); } }, t("fitWidth")),
                h("button", { type: "button", style: btnStyle, onClick: function () { step(-0.1); } }, "−"),
                h("span", { style: { opacity: 0.55, minWidth: 34, textAlign: "center", fontVariantNumeric: "tabular-nums" } }, percent + "%"),
                h("button", { type: "button", style: btnStyle, onClick: function () { step(0.1); } }, "＋"),
                h("button", { type: "button", style: compact ? onBtn : btnStyle, title: t("compactHint"), onClick: function () { setCompact(!compact); } }, t("compact"))
              ),
              h("div", { className: "pm-pop-row" },
                h("span", { className: "pm-pop-label" }, t("popBranches")),
                h("button", { type: "button", style: btnStyle, onClick: function () {
                  var every = allParents.length > 0 && allParents.every(function (id) { return shownCollapsed.has(id); });
                  setCollapsed(every ? new Set() : new Set(allParents));
                } }, allParents.length > 0 && allParents.every(function (id) { return shownCollapsed.has(id); }) ? t("expand") : t("collapse")),
                hasOffsets ? h("button", { type: "button", style: btnStyle, title: t("autoLayoutHint"), onClick: clearOffsets }, t("autoLayout")) : null,
                selectedNode !== undefined ? h("button", { type: "button", style: btnStyle, title: t("resetNodeHint"), onClick: function () { resetOne(selectedNode.id); } }, t("resetNode")) : null
              ),
              h("div", { className: "pm-pop-row pm-pop-info" },
                h("span", null, fill(t("count"), { n: nodes.length })),
                view.planMode ? h("span", { style: { color: "#6366f1" } }, t("planMode")) : null
              ),
            )
          : null,
        viewOpen
          ? h("div", { className: "pm-pop-backdrop", onClick: function () { setViewOpen(false); } })
          : null,
        h(
          "div",
          {
            ref: containerRef,
            className: "pm-canvas",
            "data-panning": drag !== null && drag.kind === "pan" ? "true" : "false",
            style: { position: "relative", flex: 1, minHeight: 0, overflow: "auto", padding: 12, touchAction: "none" },
            onPointerDown: function (ev) { if (ev.target === ev.currentTarget || ev.target.tagName === "svg") startPan(ev); },
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
            onPointerLeave: onPointerUp,
            onPointerEnter: function () { if (drag !== null && drag.kind === "node" && drag.moved) setDrop(""); },
          },
          h(
            "svg",
            {
              viewBox: bounds.minX + " " + bounds.minY + " " + bounds.width + " " + bounds.height,
              width: Math.max(80, Math.round(bounds.width * scale)),
              height: Math.max(60, Math.round(bounds.height * scale)),
              preserveAspectRatio: "xMidYMin meet",
              style: { display: "block", margin: "0 auto" },
            },
            layout.edges.map(function (e) {
              var onPath = pathSet !== null && pathSet.has(e.to) && pathSet.has(e.from);
              return h("path", {
                key: e.from + "->" + e.to,
                className: "pm-link",
                d: linkPath(rects.get(e.from), rects.get(e.to), direction),
                fill: "none",
                stroke: onPath ? "#6366f1" : "var(--dsw-alias-border-l1, rgba(148,163,184,.7))",
                strokeWidth: onPath ? 1.8 : 1.3,
                strokeLinecap: "round",
                opacity: faded(e.to) ? 0.22 : 1,
              });
            }),
            shownNodes.map(function (n) {
              var pos = rects.get(n.id);
              if (pos === undefined) return null;
              var color = STATUS_COLOR[n.status] || STATUS_COLOR.pending;
              var isRoot = n.parent === "";
              var badge = layout.subtree[n.id];
              var isSel = selected === n.id;
              var dim = faded(n.id);
              var font = compact ? COMPACT.font : 12;
              var padX = compact ? COMPACT.padX : PAD_X;
              // 文本可用宽度：按像素算，保证不冲出卡片
              var titlePx = Math.max(0, pos.w - DOT_W - padX + 6 - (badge === undefined ? 0 : 20) - (n.note ? NOTE_W : 0));
              var cy = pos.h / 2;
              var isDropTarget = drop === n.id && drag !== null && drag.kind === "node" && drag.id !== n.id;
              return h(
                "g",
                {
                  key: n.id,
                  className: "pm-card",
                  "data-status": n.status || "pending",
                  "data-selected": isSel ? "true" : "false",
                  "data-drop": isDropTarget ? "true" : "false",
                  transform: "translate(" + pos.x + "," + pos.y + ")",
                  opacity: dim ? 0.3 : 1,
                  onPointerDown: function (ev) { ev.stopPropagation(); startNodeDrag(ev, n.id); },
                  onPointerEnter: function () { if (drag !== null && drag.kind === "node" && drag.moved) setDrop(n.id); },
                  onClick: function () {
                    if (suppressClick.current) { suppressClick.current = false; return; }
                    setSelected(isSel ? null : n.id);
                  },
                  onDblClick: function (ev) {
                    ev.stopPropagation();
                    setSelected(n.id);
                    setEditing({ id: n.id, text: n.title });
                  },
                },
                h("rect", { className: "pm-bg", x: 0, y: 0, width: pos.w, height: pos.h, rx: isRoot ? 10 : 8, fill: isRoot ? "rgba(99,102,241,.05)" : "var(--dsw-alias-bg-layer-1, #fff)", stroke: color, strokeOpacity: isRoot ? 0.5 : 0.38, strokeWidth: 1 }),
                h("text", {
                  x: padX, y: cy + font * 0.36, fontSize: font * 0.95, fill: color, fillOpacity: 0.95,
                  style: { userSelect: "none" },
                }, STATUS_GLYPH[n.status] || STATUS_GLYPH.pending),
                editing !== null && editing.id === n.id
                  ? h("foreignObject", { x: DOT_W + padX - 8, y: cy - 11, width: Math.max(60, pos.w - DOT_W - padX - 6), height: 22 },
                      h("input", {
                        className: "pm-input",
                        defaultValue: editing.text,
                        autoFocus: true,
                        onPointerDown: function (ev) { ev.stopPropagation(); },
                        onKeyDown: function (ev) {
                          if (ev.key === "Enter") {
                            var value = String(ev.target.value || "").trim();
                            if (value !== "" && value !== n.title) {
                              runCommand("/planmap rename " + n.id + " " + value, { id: n.id, patch: { title: value } });
                            }
                            setEditing(null);
                          } else if (ev.key === "Escape") {
                            setEditing(null);
                          }
                        },
                        onBlur: function (ev) {
                          var value = String(ev.target.value || "").trim();
                          if (value !== "" && value !== n.title) {
                            runCommand("/planmap rename " + n.id + " " + value, { id: n.id, patch: { title: value } });
                          }
                          setEditing(null);
                        },
                      }))
                  : h("text", {
                      x: DOT_W + padX - 6, y: cy + font * 0.36, fontSize: font, fontWeight: isRoot ? 600 : 400,
                      fill: "currentColor", fillOpacity: n.status === "done" ? 0.55 : 1, style: { userSelect: "none" },
                    }, truncateToWidth(n.title, titlePx, font)),
                n.note ? h("circle", { cx: pos.w - padX - (badge === undefined ? 0 : 20) - 3, cy: cy, r: 2.2, fill: "currentColor", fillOpacity: 0.4 }) : null,
                parentSet.has(n.id) && badge === undefined
                  ? h("g", {
                      className: "pm-toggle",
                      transform: "translate(" + (pos.w - 8) + "," + cy + ")",
                      onClick: function (ev) { ev.stopPropagation(); toggleCollapse(n.id); },
                      style: { cursor: "pointer" },
                    },
                      h("text", { x: 0, y: 4, fontSize: 11, textAnchor: "middle", fill: "currentColor", fillOpacity: 0.45 }, "−"))
                  : null,
                badge === undefined
                  ? null
                  : h("g", {
                      className: "pm-toggle",
                      transform: "translate(" + (pos.w - 16) + "," + cy + ")",
                      onClick: function (ev) { ev.stopPropagation(); toggleCollapse(n.id); },
                      style: { cursor: "pointer" },
                    },
                      h("text", { x: 0, y: 4, fontSize: 10, textAnchor: "middle", fill: "#6366f1", fillOpacity: 0.9 }, "+" + badge))
              );
            })
          )
        ),
        notice !== null
          ? h("div", { className: "pm-notice" }, notice)
          : null,
        selectedNode === undefined
          ? null
          : h(
              "div",
              { className: "pm-detail" },
              h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
                h("span", { style: { color: STATUS_COLOR[selectedNode.status] || STATUS_COLOR.pending, flex: "none" } }, STATUS_GLYPH[selectedNode.status] || STATUS_GLYPH.pending),
                h("span", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, selectedNode.title),
                h("span", { style: { flex: 1 } }),
                ["pending", "active", "done", "blocked"].map(function (status) {
                  return h("button", {
                    key: status, type: "button",
                    style: Object.assign({}, btnStyle, selectedNode.status === status ? onBtn : { border: "1px solid transparent", background: "transparent" }),
                    onClick: function () { runCommand("/planmap status " + selectedNode.id + " " + status, { id: selectedNode.id, patch: { status: status } }); },
                  }, t("status." + status));
                }),
                h("button", { type: "button", style: { border: "1px solid transparent", background: "transparent", cursor: "pointer", opacity: 0.5, padding: "0 4px" }, title: t("close"), onClick: function () { setSelected(null); } }, "✕")
              ),
              selectedNode.note ? h("div", { style: { marginTop: 4, opacity: 0.8, whiteSpace: "pre-wrap" } }, selectedNode.note) : null
            )
      );
    }

    function PlanMapTitle() {
      return React.createElement("span", null, ZH.title);
    }

    /** 一小段样式表：hover / 选中 / 拖拽落点的状态，用 CSS 比内联样式干净得多。 */
    function installStyles() {
      var id = "dsh-plan-map/css";
      if (typeof document === "undefined" || document.querySelector("style[data-plugin-css=" + JSON.stringify(id) + "]") !== null) return;
      var style = document.createElement("style");
      style.dataset.plugin = "@local/dsh-plan-map";
      style.dataset.pluginCss = id;
      style.textContent = [
        ".pm-canvas { cursor: default; }",
        ".pm-canvas[data-panning=\"true\"] { cursor: grabbing; }",
        ".pm-card { cursor: pointer; }",
        ".pm-card .pm-bg { transition: fill 120ms ease, stroke 120ms ease, stroke-opacity 120ms ease; }",
        ".pm-card:hover .pm-bg { stroke-opacity: .85; }",
        ".pm-card[data-selected=\"true\"] .pm-bg { stroke: #6366f1 !important; stroke-opacity: 1 !important; stroke-width: 2; }",
        ".pm-card[data-drop=\"true\"] .pm-bg { stroke: #22c55e !important; stroke-opacity: 1 !important; stroke-dasharray: 5 3; }",
        ".pm-card .pm-toggle { opacity: 0; transition: opacity 120ms ease; }",
        ".pm-card:hover .pm-toggle { opacity: .75; }",
        ".pm-card[data-selected=\"true\"] .pm-toggle { opacity: .75; }",
        ".pm-link { transition: opacity 120ms ease; }",
        ".pm-icon-btn:hover { background: rgba(148,163,184,.16) !important; }",
        ".pm-icon-btn[data-open=\"true\"] { background: rgba(99,102,241,.16) !important; color: #6366f1 !important; }",
        ".pm-pop-backdrop { position: absolute; inset: 0; z-index: 20; }",
        ".pm-pop { position: absolute; top: 36px; right: 8px; z-index: 21; min-width: 248px; padding: 9px; border-radius: 10px;",
        "  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.35));",
        "  box-shadow: 0 10px 28px rgba(15,23,42,.16); display: flex; flex-direction: column; gap: 7px; font-size: 11px; }",
        ".pm-pop-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }",
        ".pm-pop-label { width: 40px; flex: none; opacity: .5; }",
        ".pm-pop-info { justify-content: space-between; opacity: .6; padding-top: 5px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.2)); }",
        ".pm-detail { flex: none; max-height: 132px; overflow: auto; padding: 8px 10px; font-size: 12px; line-height: 1.6;",
        "  border-top: 1px solid var(--dsw-alias-border-l2, rgba(148,163,184,.25)); }",
        ".pm-input { width: 100%; height: 100%; box-sizing: border-box; font: inherit; font-size: 12px; color: inherit;",
        "  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid #6366f1; border-radius: 5px; padding: 0 6px; outline: none; }",
        ".pm-notice { flex: none; padding: 5px 10px; font-size: 11px; color: #ef4444; border-top: 1px solid rgba(239,68,68,.25); background: rgba(239,68,68,.06); }",
      ].join("\n");
      document.head.appendChild(style);
    }

    var apply = function (ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: ZH, en: EN }); }, "plan-map: dictionaries");
      pluginCtx = ctx;
      ctx.effect(function () { installStyles(); return function () {}; }, "plan-map: styles");
      // 关键：Tab 类型必须登记进 sidebarRightTabs，否则「+」/指南列表里看不到它
      // （只注册 sidebar.right.pane.tab 座位只是「类型的内容」，不是「类型本身」）。
      ctx.effect(function () {
        var t = ctx.locale.bind(NS);
        return ctx.sidebarRightTabs.register({
          id: KEY,
          kind: KEY,
          title: function () { return t("title"); },
          guide: [{
            order: 20,
            title: function () { return t("title"); },
            description: function () { return t("guideDesc"); },
          }],
        });
      }, "plan-map: tab type");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: KEY,
            locale: NS,
            inject: function () { return { ctx: ctx }; },
          }, PlanMapBody);
        });
      }, "plan-map: sidebar tab body");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({
            name: "sidebar.right.pane.tab.title",
            key: KEY,
          }, PlanMapTitle);
        });
      }, "plan-map: sidebar tab title");
    };

    exports.apply = apply;
    // remote / remote.commands 是拖拽与状态切换的唯一写通道（缺声明 = 访问即抛错）
    exports.inject = ["slots", "sessions", "locale", "sidebarRightTabs", "remote", "remote.commands"];
    return module.exports;
  },
});
