/**
 * @local/dsh-web-search-plus — 极简 HTML 词法与树构建（零依赖、有界、绝不抛错）。
 *
 * 为什么自己写而不是用 domino/turndown：本插件要装进 profile 的独立包，
 * 依赖越少越不容易随宿主版本漂移；而真正需要的只是「拿到块级结构 + 文本」，
 * 不是完整 DOM 语义。真实网页里畸形嵌套极常见，所以这里的原则是
 * **宁可少认一个标签，也绝不抛错、绝不无限嵌套**。
 *
 * 有界性：输入先截到 {@link MAX_HTML_CHARS}，嵌套深度封顶 {@link MAX_DEPTH}，
 * 超过上限的子树被拍平到当前节点（内容不丢，只是不再分层）。
 */

/** HTML 空元素：不产生子树，也不等待结束标签。 */
export const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** 内容按原始文本解析的元素（内部 `<` 不算标签）。 */
export const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "textarea", "title"]);

/** 这些标签的文字不参与「正文」判定（脚本/样式/模板）。 */
export const NON_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

export const MAX_HTML_CHARS = 400000;
export const MAX_DEPTH = 256;

/** 块级元素：出现时隐式闭合前面的 `<p>`（真实网页里 `<p>` 经常不写结束标签）。 */
const BLOCK_LEVEL = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/**
 * 隐式闭合规则：**栈顶是 key** 时，遇到集合里的标签就弹栈。
 * 注意方向——`<td>` 不能把包着它的 `<tr>` 弹掉（所以 `tr` 的集合里只有 `tr`），
 * 但新的 `<td>` 要弹掉前一个 `<td>`，新的 `<tr>` 要弹掉前一个 `<td>` 与 `<tr>`。
 */
const IMPLICIT_CLOSE = {
  p: BLOCK_LEVEL,
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
  tr: new Set(["tr"]),
  option: new Set(["option"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
  caption: new Set(["colgroup", "thead", "tbody", "tfoot", "tr"]),
};

/** 常见命名实体。未知实体原样保留（不要瞎猜，免得把正文改坏）。 */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", ndash: "\u2013",
  mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c",
  rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb", middot: "\u00b7", bull: "\u2022",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0", plusmn: "\u00b1",
  times: "\u00d7", divide: "\u00f7", frac12: "\u00bd", sup2: "\u00b2", sup3: "\u00b3",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", sect: "\u00a7",
  para: "\u00b6", dagger: "\u2020", permil: "\u2030", prime: "\u2032", ne: "\u2260",
  le: "\u2264", ge: "\u2265", minus: "\u2212", infin: "\u221e", larr: "\u2190",
  rarr: "\u2192", harr: "\u2194", check: "\u2713", cross: "\u2717", star: "\u2605",
  ensp: " ", emsp: " ", thinsp: " ", shy: "", zwj: "\u200d", zwnj: "\u200c",
};

/**
 * 解码 HTML 实体（命名 + 十进制 + 十六进制）。
 * @param text - 原始文本。
 * @returns 解码后的文本。
 */
export function decodeEntities(text) {
  const value = String(text ?? "");
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/giu, (match, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeCodePoint(code) : match;
    }
    const known = ENTITIES[lower];
    return known === undefined ? match : known;
  });
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function element(name, attrs) {
  return { type: "element", name, attrs: attrs ?? {}, children: [] };
}

function isNameChar(char) {
  return char !== undefined && /[a-z0-9:_-]/iu.test(char);
}

/**
 * 解析 `attrs`：支持双引号/单引号/无引号、属性值里带 `>`、布尔属性。
 * 解析不出结构时返回 `null`（调用方把 `<` 当普通文本）。
 */
function readTag(source, lower, at) {
  const len = source.length;
  let i = at + 1;
  let closing = false;
  if (source[i] === "/") {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (isNameChar(source[i])) i += 1;
  if (i === nameStart) return null;
  const name = lower.slice(nameStart, i);
  const attrs = {};
  let selfClosing = false;
  while (i < len) {
    while (i < len && /\s/u.test(source[i])) i += 1;
    if (i >= len) break;
    const char = source[i];
    if (char === ">") {
      i += 1;
      break;
    }
    if (char === "/") {
      if (source[i + 1] === ">") {
        selfClosing = true;
        i += 2;
        break;
      }
      i += 1;
      continue;
    }
    const attrStart = i;
    while (i < len && !/[\s=>/]/u.test(source[i])) i += 1;
    const attrName = lower.slice(attrStart, i);
    while (i < len && /\s/u.test(source[i])) i += 1;
    let value = "";
    if (source[i] === "=") {
      i += 1;
      while (i < len && /\s/u.test(source[i])) i += 1;
      const quote = source[i];
      if (quote === "\"" || quote === "'") {
        const end = source.indexOf(quote, i + 1);
        value = end === -1 ? source.slice(i + 1) : source.slice(i + 1, end);
        i = end === -1 ? len : end + 1;
      } else {
        const start = i;
        while (i < len && !/[\s>]/u.test(source[i])) i += 1;
        value = source.slice(start, i);
      }
    }
    if (attrName !== "" && attrs[attrName] === undefined) attrs[attrName] = decodeEntities(value);
  }
  return { name, attrs, closing, selfClosing, end: i };
}

/** 找原始文本元素的结束标签（`</script >` 这类空白也认）。 */
function findRawEnd(lower, name, from) {
  const prefix = `</${name}`;
  let at = lower.indexOf(prefix, from);
  while (at !== -1) {
    const after = lower[at + prefix.length];
    if (after === undefined || after === ">" || after === "/" || /\s/u.test(after)) {
      const close = lower.indexOf(">", at + prefix.length);
      return { start: at, end: close === -1 ? lower.length : close + 1 };
    }
    at = lower.indexOf(prefix, at + prefix.length);
  }
  return { start: lower.length, end: lower.length };
}

/**
 * 把 HTML 解析成轻量树。
 *
 * 容错规则：未知的结束标签忽略；结束标签与栈内某层同名就弹到那一层；
 * 隐式闭合规则处理 `<p>/<li>/<td>/<tr>`；超过深度上限时不再入栈（内容仍挂在当前节点下）。
 *
 * @param html - HTML 文本（已解码或未解码都可，实体在这里解码）。
 * @param options - `{ maxChars, maxDepth }`。
 * @returns 根节点 `{ type:"element", name:"#root", attrs, children }`。
 */
export function parseHtml(html, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : MAX_HTML_CHARS;
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : MAX_DEPTH;
  const source = String(html ?? "").slice(0, maxChars);
  const lower = source.toLowerCase();
  const root = element("#root", {});
  const stack = [root];

  const pushNode = (node) => {
    stack[stack.length - 1].children.push(node);
  };
  const pushText = (raw) => {
    if (raw === "") return;
    const text = decodeEntities(raw);
    if (text !== "") pushNode({ type: "text", text });
  };
  const closeElement = (name) => {
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      if (stack[k].name === name) {
        stack.length = k;
        return;
      }
    }
  };
  const closeImplicit = (name) => {
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.name === "#root") return;
      const closers = IMPLICIT_CLOSE[top.name];
      if (closers === undefined || !closers.has(name)) return;
      stack.pop();
    }
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) pushText(source.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (lower.startsWith("<!", lt) || lower.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt + 1);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    const tag = readTag(source, lower, lt);
    if (tag === null) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      closeElement(tag.name);
      continue;
    }
    closeImplicit(tag.name);
    const node = element(tag.name, tag.attrs);
    pushNode(node);
    if (tag.selfClosing || VOID_TAGS.has(tag.name)) continue;
    if (RAW_TEXT_TAGS.has(tag.name)) {
      const end = findRawEnd(lower, tag.name, i);
      const raw = source.slice(i, end.start);
      if (raw !== "") node.children.push({ type: "text", text: raw });
      i = end.end;
      continue;
    }
    if (stack.length - 1 < maxDepth) stack.push(node);
  }
  return root;
}

/** 深度优先遍历（先父后子），`visit` 返回 `false` 表示不再进入该子树。 */
export function walk(node, visit) {
  if (visit(node) === false) return;
  const children = node.children ?? [];
  for (const child of children) walk(child, visit);
}

/** 收集满足条件的后代元素（含自身）。 */
export function findAll(root, predicate) {
  const out = [];
  walk(root, (node) => {
    if (node.type === "element" && predicate(node)) out.push(node);
  });
  return out;
}

/** 属性读取（大小写不敏感，属性名在解析时已转小写）。 */
export function attrOf(node, name) {
  return node?.attrs?.[name];
}

/** `class` + `id` 拼成的身份串（小写），用于命名启发式。 */
export function identityOf(node) {
  const cls = attrOf(node, "class") ?? "";
  const id = attrOf(node, "id") ?? "";
  return `${cls} ${id}`.trim().toLowerCase();
}

/** `hidden` / `aria-hidden` / 行内 `display:none` 都算不可见内容。 */
export function isHidden(node) {
  if (attrOf(node, "hidden") !== undefined) return true;
  const aria = (attrOf(node, "aria-hidden") ?? "").toLowerCase();
  if (aria === "true") return true;
  const style = (attrOf(node, "style") ?? "").toLowerCase().replace(/\s+/gu, "");
  if (style === "") return false;
  return /display:none/u.test(style) || /visibility:(hidden|collapse)/u.test(style);
}

/**
 * 拼接元素的纯文本（跳过 skip 集合里的标签）。
 * @param node - 起始节点。
 * @param options - `{ skip }`：额外跳过的标签名集合（默认跳过脚本/样式/模板）。
 * @returns 原始文本（未做空白归一化，调用方按需处理）。
 */
export function textOf(node, options = {}) {
  const skip = options.skip ?? NON_TEXT_TAGS;
  let out = "";
  walk(node, (current) => {
    if (current.type === "text") {
      out += current.text;
      return true;
    }
    if (current.type !== "element") return false;
    // 起点是 hidden 元素时也返回空串：调用方拿到的文本必须和「渲染时会跳过」一致
    if (isHidden(current)) return false;
    if (current !== node && skip.has(current.name)) return false;
    return true;
  });
  return out;
}

/**
 * 归一化空白：把连续空白折成单空格。
 * 中日韩之间不留空格（`text 文本` 这种缝隙会污染检索），由渲染层按需处理。
 */
export function collapseSpaces(text) {
  return String(text ?? "").replace(/[\t\f\v\u00a0]+/gu, " ").replace(/[ \r\n]+/gu, " ").trim();
}
