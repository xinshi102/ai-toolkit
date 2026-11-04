import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DEPTH,
  attrOf,
  collapseSpaces,
  decodeEntities,
  findAll,
  identityOf,
  isHidden,
  parseHtml,
  textOf,
  walk,
} from "../lib/html.js";

test("decodeEntities: 命名 / 十进制 / 十六进制 / 未知原样保留", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;"), "a & b <c> \"d\"");
  assert.equal(decodeEntities("&#65;&#x4e2d;"), "A中");
  assert.equal(decodeEntities("&nbsp;x"), "\u00a0x");
  assert.equal(decodeEntities("&unknownthing;"), "&unknownthing;", "不认识的实体不能瞎猜");
  assert.equal(decodeEntities("100% & 200%"), "100% & 200%", "裸 & 不动");
  assert.equal(decodeEntities("&#x110000;"), "&#x110000;", "越界码点原样保留");
});

test("parseHtml: 空元素 / 原始文本 / 注释 / doctype", () => {
  const root = parseHtml(`<!DOCTYPE html><!-- 注释 <p>不该出现</p> --><div>a<br>b<img src="x.png">c</div>`);
  const div = findAll(root, (node) => node.name === "div")[0];
  assert.ok(div !== undefined);
  assert.equal(textOf(div).replace(/\s+/gu, ""), "abc", "br/img 不产生子树");
  assert.equal(findAll(root, (node) => node.name === "p").length, 0, "注释里的标签不算标签");
});

test("parseHtml: script/style 里的尖括号与 `</` 不破坏结构", () => {
  const html = `<p>before</p><script>var s = "</div>"; if (a<b) {}</script><p>after</p>`;
  const root = parseHtml(html);
  const paragraphs = findAll(root, (node) => node.name === "p").map((node) => collapseSpaces(textOf(node)));
  assert.deepEqual(paragraphs, ["before", "after"]);
  const script = findAll(root, (node) => node.name === "script")[0];
  assert.equal(textOf(script), `var s = "</div>"; if (a<b) {}`);
});

test("parseHtml: 隐式闭合 p / li / td / tr（真实网页经常不写结束标签）", () => {
  const root = parseHtml("<div><p>one<p>two<ul><li>a<li>b</ul><table><tr><td>1<td>2<tr><td>3</table></div>");
  const ps = findAll(root, (node) => node.name === "p").map((node) => textOf(node));
  assert.deepEqual(ps, ["one", "two"], "第二个 <p> 必须把第一个顶掉，不能嵌套");
  const lis = findAll(root, (node) => node.name === "li").map((node) => textOf(node));
  assert.deepEqual(lis, ["a", "b"]);
  const rows = findAll(root, (node) => node.name === "tr");
  assert.equal(rows.length, 2, "第二个 <tr> 应当另起一行");
  assert.deepEqual(rows.map((row) => findAll(row, (cell) => cell.name === "td").map((cell) => textOf(cell))), [["1", "2"], ["3"]]);
});

test("parseHtml: 属性值里带 >、单引号、无引号、布尔属性", () => {
  const root = parseHtml(`<a href="/x?a=1&b=2" title='a > b' data-flag hidden>x</a><a href="/y">y</a>`);
  const link = findAll(root, (node) => node.name === "a")[0];
  assert.equal(attrOf(link, "href"), "/x?a=1&b=2");
  assert.equal(attrOf(link, "title"), "a > b");
  assert.equal(attrOf(link, "data-flag"), "");
  assert.equal(isHidden(link), true, "hidden 布尔属性");
  assert.equal(textOf(link), "", "hidden 元素自身取文本也是空（与渲染口径一致）");
  const visible = findAll(root, (node) => node.name === "a")[1];
  assert.equal(textOf(visible), "y");
});

test("parseHtml: 畸形嵌套 / 无归属结束标签 都不抛错", () => {
  const cases = [
    "<div><span></div></span>",
    "</p>text",
    "<b><i>x</b></i>",
    "<a href=",
    "<div><p>未闭合",
    "<>",
    "<div",
    "",
  ];
  for (const html of cases) {
    const root = parseHtml(html);
    assert.equal(root.name, "#root");
    assert.ok(typeof textOf(root) === "string");
  }
});

test("parseHtml: 深度封顶后内容不丢（只是不再分层）", () => {
  const deep = `${"<div>".repeat(MAX_DEPTH + 40)}深层内容${"</div>".repeat(MAX_DEPTH + 40)}`;
  const root = parseHtml(deep);
  assert.ok(textOf(root).includes("深层内容"));
  let depth = 0;
  walk(root, (node) => {
    if (node.type === "element") depth = Math.max(depth, 0);
    return true;
  });
  const measure = (node, level) => {
    let max = level;
    for (const child of node.children ?? []) if (child.type === "element") max = Math.max(max, measure(child, level + 1));
    return max;
  };
  assert.ok(measure(root, 0) <= MAX_DEPTH + 1, `实际深度 ${measure(root, 0)} 应被封顶`);
});

test("parseHtml: maxChars 截断输入（有界性）", () => {
  const html = `<p>${"字".repeat(5000)}</p>`;
  const root = parseHtml(html, { maxChars: 500 });
  assert.ok(textOf(root).length <= 500);
});

test("textOf: 跳过脚本/样式/模板，也跳过 hidden 子树", () => {
  const root = parseHtml(`<div>keep<script>drop()</script><style>.a{}</style><template>tpl</template><span hidden>hid</span>tail</div>`);
  const text = collapseSpaces(textOf(root));
  assert.equal(text, "keeptail");
  const withHidden = collapseSpaces(textOf(root, { skip: new Set() }));
  assert.ok(withHidden.includes("drop()"), "显式传 skip 空集时脚本内容也在");
});

test("identityOf / isHidden: class+id 身份与行内不可见样式", () => {
  const root = parseHtml(`<div class="Entry-Header" id="Main">x</div><p style="display: none; color: red">y</p><p style="visibility: hidden">z</p>`);
  const div = findAll(root, (node) => node.name === "div")[0];
  assert.equal(identityOf(div), "entry-header main");
  const paragraphs = findAll(root, (node) => node.name === "p");
  assert.equal(isHidden(paragraphs[0]), true);
  assert.equal(isHidden(paragraphs[1]), true);
  assert.equal(collapseSpaces(textOf(paragraphs[0])), "", "display:none 的内容不进文本");
});
