/**
 * plan-map 的思维导图布局（纯函数，零依赖）。
 *
 * 学的现成做法：
 *  - **tidy tree / Walker–Buchheim 一族**（Reingold–Tilford 的线性时间改进版）：
 *    兄弟子树按「边界盒」依次堆叠、父节点居中于首末子节点之间；
 *    子树整体归一化到 top=0 后再返回，所以深子树不会和浅子树重叠。
 *    https://dl.acm.org/doi/10.5555/1133013.1133017
 *  - **可变节点尺寸**（non-layered tidy tree）：每个节点的宽度按标题实测宽度算，
 *    每一层（列）的 X 取该列最宽节点 + 列间距 —— 避免固定宽度造成的大片空白。
 *  - **圆角折线连接**（markmap / mind-elixir 观感）：父右中 → 短横 → 竖 → 短横 → 子左中，
 *    拐角用二次贝塞尔倒圆；比直接三次贝塞尔更「接线清楚」。
 *  - **不靠缩小字号来适配**：缩放只缩到可读下限（客户端约束），更宽时纵向/横向滚动。
 *
 * 方向：同一套 tidy tree 支持两种读法——`horizontal`（左根右枝，默认）与
 * `vertical`（上根下枝）；只是把「堆叠轴 / 深度轴」对调，算法完全一致。
 *
 * 客户端 lib/client.js 内联了同一份实现——改这里务必同步（注释已标注）。
 */

/** 布局参数（非 compact / compact 两档，紧凑档靠**重排**而不是缩放来多放内容）。 */
export const NODE_HEIGHT = 34;
export const GAP_X = 44;
export const GAP_Y = 12;
export const PAD_X = 14;
export const DOT_W = 18;
export const NOTE_W = 14;
export const BADGE_W = 30;

export const COMPACT = {
  nodeHeight: 24,
  gapX: 22,
  gapY: 6,
  padX: 10,
  font: 11,
};

/** 标题实测宽度：CJK 按字号 1.0、其余按 0.55 估（与 12px 字号的经验值一致）。 */
export function measureTitle(title, font = 12) {
  let units = 0;
  for (const ch of String(title ?? "")) units += /[\u2E80-\uFFFD]/u.test(ch) ? 1 : 0.55;
  return Math.ceil(units * font);
}

/** 单个字符的渲染宽度（CJK 按字号 1.0、其余 0.55）。 */
export function charWidth(ch, font = 12) {
  return (/[\u2E80-\uFFFD]/u.test(ch) ? 1 : 0.55) * font;
}

/**
 * 按**像素宽度**逐字截断——不能用「字符数 × 平均字宽」估：
 * 中文标题会因此截得太晚，直接冲出卡片边框（验收发现的溢出 bug）。
 * @returns 保证 measureTitle(结果, font) <= maxPx 的文本
 */
export function truncateToWidth(title, maxPx, font = 12, ellipsis = "…") {
  const text = String(title ?? "");
  if (maxPx <= 0) return "";
  // 用 measureTitle（整串 ceil）判定，逐字累加会差 <1px 而与卡片宽度口径不一致
  if (measureTitle(text, font) <= maxPx) return text;
  const budget = Math.max(0, maxPx - charWidth(ellipsis, font));
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch, font);
    if (width + w > budget) break;
    out += ch;
    width += w;
  }
  // 与 measureTitle（整串 ceil）对齐：必要时再退字，保证结果 <= maxPx
  while (out.length > 0 && measureTitle(out + ellipsis, font) > maxPx) out = out.slice(0, -1);
  if (out.length > 0) return out + ellipsis;
  return measureTitle(ellipsis, font) <= maxPx ? ellipsis : "";
}

/** 一个节点的卡片宽度（含状态点、内边距、备注点、折叠徽标）。 */
export function nodeWidthOf(node, options = {}) {
  const compact = options.compact === true;
  const font = compact ? COMPACT.font : 12;
  const padX = compact ? COMPACT.padX : PAD_X;
  const text = measureTitle(node?.title, font);
  const extra = DOT_W + padX * 2 + (node?.note ? NOTE_W : 0) + (node?.collapsedChildren ? BADGE_W : 0);
  const min = compact ? 76 : 88;
  const max = compact ? 180 : 280;
  return Math.max(min, Math.min(max, text + extra));
}

/**
 * 计算横向 tidy tree 布局。
 * @param nodes 扁平节点 [{id, parent, title, status, note}]
 * @param options {collapsed?: Iterable<string>, compact?: boolean, nodeHeight?, gapX?, gapY?, padX?}
 * @returns {width, height, nodeH, positions: {id: {x, y, w, h, depth, collapsed}}, edges, roots, subtree, columnX}
 */
export function layoutTree(nodes, options = {}) {
  const compact = options.compact === true;
  const vertical = options.direction === "vertical";
  const nodeH = options.nodeHeight ?? (compact ? COMPACT.nodeHeight : NODE_HEIGHT);
  const gapX = options.gapX ?? (compact ? COMPACT.gapX : GAP_X);
  const gapY = options.gapY ?? (compact ? COMPACT.gapY : GAP_Y);
  const collapsed = new Set(options.collapsed ?? []);

  const byId = new Map();
  const list = [];
  for (const n of nodes ?? []) {
    const node = { id: n.id, parent: n.parent ?? "", title: n.title, status: n.status, note: n.note, kids: [], _y: 0, _depth: 0, _visible: false };
    byId.set(node.id, node);
    list.push(node);
  }

  /** 直接父节点；不存在/成环/孤儿当根。 */
  const parentOf = (node) => {
    const p0 = node.parent;
    if (p0 === "" || !byId.has(p0)) return undefined;
    const seen = new Set([node.id]);
    let cur = p0;
    while (cur !== "") {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      cur = byId.get(cur)?.parent ?? "";
    }
    return byId.get(p0);
  };

  const roots = [];
  for (const node of list) {
    const parent = parentOf(node);
    if (parent === undefined) roots.push(node);
    else parent.kids.push(node);
  }

  /** 可见子节点（折叠的当叶子）。 */
  const visibleKids = (node) => (collapsed.has(node.id) ? [] : node.kids);

  // ── 轴抽象 ───────────────────────────────────────────────────────────
  // horizontal：堆叠轴 = Y（兄弟上下排），深度轴 = X，堆叠轴尺寸 = 卡片高
  // vertical：  堆叠轴 = X（兄弟左右排），深度轴 = Y，堆叠轴尺寸 = 卡片宽（可变宽）
  const widthOf = (node) => nodeWidthOf({ title: node.title, note: node.note, collapsedChildren: collapsed.has(node.id) }, { compact });
  const extent = (node) => (vertical ? widthOf(node) : nodeH);
  const gapPrimary = vertical ? gapX : gapY;

  const shift = (node, delta) => {
    node._p += delta;
    for (const kid of visibleKids(node)) shift(kid, delta);
  };

  /** 堆叠子树 + 父居中；返回子树边界盒（返回时归一化到 top=0）。 */
  const place = (node, depth) => {
    node._depth = depth;
    node._visible = true;
    const kids = visibleKids(node);
    const size = extent(node);
    if (kids.length === 0) {
      node._p = size / 2;
      return { top: 0, bottom: size };
    }
    let cursor = 0;
    for (const kid of kids) {
      const box = place(kid, depth + 1);
      shift(kid, cursor - box.top);
      cursor += box.bottom - box.top + gapPrimary;
    }
    const first = kids[0];
    const last = kids[kids.length - 1];
    node._p = (first._p + last._p) / 2;
    const boxTop = Math.min(node._p - size / 2, 0);
    let boxBottom = Math.max(node._p + size / 2, cursor - gapPrimary);
    if (boxTop !== 0) {
      shift(node, -boxTop);
      boxBottom -= boxTop;
    }
    return { top: 0, bottom: boxBottom };
  };
  // 多个根（环被打破 / 孤儿）也要像兄弟一样堆叠，否则会重叠；
  // 根与根之间留 **3 倍间距**，让不同根的子树读起来是分开的"带"
  // （否则同一列里两个根的节点会紧挨着，看起来像乱在一起）。
  const ROOT_GAP = gapPrimary * 3;
  let rootCursor = 0;
  for (const [index, root] of roots.entries()) {
    const box = place(root, 0);
    shift(root, rootCursor - box.top);
    rootCursor += box.bottom - box.top + (index === roots.length - 1 ? 0 : ROOT_GAP);
  }

  // 深度轴：每层取该层最宽/最高的尺寸 + 层间距
  const depthExtent = [];
  const sized = list.filter((node) => node._visible).map((node) => {
    const w = widthOf(node);
    const along = vertical ? nodeH : w;
    depthExtent[node._depth] = Math.max(depthExtent[node._depth] ?? 0, along);
    return { node, w };
  });
  const depthPos = [];
  let cursorDepth = 0;
  for (let d = 0; d < depthExtent.length; d += 1) {
    depthPos[d] = cursorDepth;
    cursorDepth += (depthExtent[d] ?? 0) + (vertical ? gapY : gapX);
  }

  const positions = {};
  for (const { node, w } of sized) {
    const x = vertical ? node._p - w / 2 : (depthPos[node._depth] ?? 0);
    const y = vertical ? (depthPos[node._depth] ?? 0) : node._p - nodeH / 2;
    positions[node.id] = { x, y, w, h: nodeH, depth: node._depth, collapsed: collapsed.has(node.id) };
  }

  // 防御：同一层（列/行）理论上不会重叠，但异常输入下也要保证不叠——
  // 按主坐标排序后依次推开，再做一次整体归一化。
  const minGap = vertical ? gapX : gapY;
  const columns = new Map();
  for (const [id, rect] of Object.entries(positions)) {
    if (!columns.has(rect.depth)) columns.set(rect.depth, []);
    columns.get(rect.depth).push(id);
  }
  for (const ids of columns.values()) {
    if (vertical) ids.sort((a, b) => positions[a].x - positions[b].x);
    else ids.sort((a, b) => positions[a].y - positions[b].y);
    for (let i = 1; i < ids.length; i += 1) {
      const prev = positions[ids[i - 1]];
      const cur = positions[ids[i]];
      if (vertical) cur.x = Math.max(cur.x, prev.x + prev.w + minGap);
      else cur.y = Math.max(cur.y, prev.y + prev.h + minGap);
    }
  }

  let spanDepth = 0;
  let spanPrimary = 0;
  let minPrimary = 0;
  for (const rect of Object.values(positions)) {
    spanDepth = Math.max(spanDepth, vertical ? rect.y + nodeH : rect.x + rect.w);
    spanPrimary = Math.max(spanPrimary, vertical ? rect.x + rect.w : rect.y + rect.h);
    minPrimary = Math.min(minPrimary, vertical ? rect.x : rect.y);
  }
  // 若防御把节点推到负坐标，整体平移回 0（保持画布从原点开始）
  if (minPrimary < 0) {
    for (const rect of Object.values(positions)) {
      if (vertical) rect.x -= minPrimary; else rect.y -= minPrimary;
    }
    spanPrimary -= minPrimary;
    spanDepth -= 0;
  }

  const edges = [];
  for (const node of list) {
    const parent = parentOf(node);
    if (parent !== undefined && visibleKids(parent).includes(node)) edges.push({ from: parent.id, to: node.id });
  }

  const subtree = {};
  for (const node of list) {
    if (!collapsed.has(node.id)) continue;
    let count = 0;
    const stack = [...node.kids];
    const seen = new Set(stack.map((k) => k.id));
    while (stack.length > 0) {
      const cur = stack.pop();
      count += 1;
      for (const kid of cur.kids) if (!seen.has(kid.id)) { seen.add(kid.id); stack.push(kid); }
    }
    subtree[node.id] = count;
  }

  return {
    // 画布尺寸按方向取轴：horizontal 宽度=深度轴跨度；vertical 宽度=堆叠轴跨度
    width: vertical ? Math.max(120, spanPrimary) : Math.max(120, spanDepth),
    height: vertical ? Math.max(nodeH, spanDepth) : Math.max(nodeH, spanPrimary),
    nodeH,
    direction: vertical ? "vertical" : "horizontal",
    positions,
    edges,
    roots: roots.map((r) => r.id),
    subtree,
    depthPos,
  };
}

/**
 * 竖向（上根下枝）的圆角折线：父下中 → 短竖 → 横 → 短竖 → 子上中。
 * @returns SVG path d
 */
export function elbowPathVertical(parent, child, options = {}) {
  const radius = options.radius ?? 9;
  const x1 = parent.x + parent.w / 2;
  const y1 = parent.y + parent.h;
  const x2 = child.x + child.w / 2;
  const y2 = child.y;
  const dx = x2 - x1;
  if (Math.abs(dx) < 1.5) return `M ${x1} ${y1} V ${y2}`;
  const gap = y2 - y1;
  if (gap <= radius * 2 + 2) {
    const ddy = Math.max(8, gap * 0.5);
    return `M ${x1} ${y1} C ${x1} ${y1 + ddy}, ${x2} ${y2 - ddy}, ${x2} ${y2}`;
  }
  const mid = y1 + Math.min(gap / 2, Math.max(radius + 4, 16));
  const r = Math.min(radius, Math.abs(dx) / 2, Math.abs(y1 - mid), Math.abs(y2 - mid));
  const sign = dx > 0 ? 1 : -1;
  return [
    `M ${x1} ${y1}`,
    `V ${mid - r}`,
    `Q ${x1} ${mid} ${x1 + sign * r} ${mid}`,
    `H ${x2 - sign * r}`,
    `Q ${x2} ${mid} ${x2} ${mid + r}`,
    `V ${y2}`,
  ].join(" ");
}

/** 按方向分发连线。 */
export function linkPath(parent, child, options = {}) {
  return options.direction === "vertical" ? elbowPathVertical(parent, child, options) : elbowPath(parent, child, options);
}

/**
 * 找出互相压住（矩形相交）的节点 id。
 * 手工自由摆放没有防重叠，载入时用它做一次自修复（把参与冲突的手工位置复位回自动布局）。
 * @param positions {id: {x, y, w, h}}
 * @returns 参与冲突的 id 数组（去重、稳定序）
 */
export function collidingIds(positions) {
  const entries = Object.entries(positions || {});
  const hit = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i][1];
      const b = entries[j][1];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        hit.add(entries[i][0]);
        hit.add(entries[j][0]);
      }
    }
  }
  return [...hit];
}

/**
 * 圆角折线连接：父右中 → 短横 → 竖向 → 短横 → 子左中。
 * 竖向位移很小或为 0 时退化成一条直线，不会出现多余的拐角。
 * @returns SVG path d
 */
export function elbowPath(parent, child, options = {}) {
  const radius = options.radius ?? 9;
  const x1 = parent.x + parent.w;
  const y1 = parent.y + parent.h / 2;
  const x2 = child.x;
  const y2 = child.y + child.h / 2;
  const dy = y2 - y1;
  if (Math.abs(dy) < 1.5) return `M ${x1} ${y1} H ${x2}`;
  const gap = x2 - x1;
  if (gap <= radius * 2 + 2) {
    // 列间距太窄：退化为直接贝塞尔，避免拐角互相吃掉
    const dx = Math.max(8, gap * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  const mid = x1 + Math.min(gap / 2, Math.max(radius + 4, 18));
  const r = Math.min(radius, Math.abs(dy) / 2, Math.abs(x1 - mid), Math.abs(x2 - mid));
  const sign = dy > 0 ? 1 : -1;
  return [
    `M ${x1} ${y1}`,
    `H ${mid - r}`,
    `Q ${mid} ${y1} ${mid} ${y1 + sign * r}`,
    `V ${y2 - sign * r}`,
    `Q ${mid} ${y2} ${mid + r} ${y2}`,
    `H ${x2}`,
  ].join(" ");
}
