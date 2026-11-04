import { test } from "node:test";
import assert from "node:assert/strict";
import { CHARS_PER_TOKEN, MIN_BUDGET_CHARS, applyBudget, budgetSummary, estimateTokens } from "../lib/budget.js";

test("estimateTokens: 与宿主 CHARS_PER_TOKEN=4 同源，且按码点算（emoji 不吃亏）", () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("中文四个"), 1);
  assert.equal(estimateTokens("😀😀😀😀"), 1, "四个码点，不是八个 UTF-16 单元");
  assert.equal(estimateTokens("😀😀😀😀😀"), 2);
});

test("applyBudget: 预算够就原样给出，不截断、不带标记", () => {
  const text = "第一段。\n\n第二段。";
  const result = applyBudget(text, { maxTokens: 100 });
  assert.equal(result.content, text);
  assert.equal(result.truncated, false);
  assert.equal(result.nextOffset, null);
  assert.equal(result.totalChars, [...text].length);
  assert.equal(result.marker, "");
  assert.equal(result.tokens, estimateTokens(text));
});

test("applyBudget: 超预算时在边界切、给续读标记，并且 offset 能把全文拼回来", () => {
  const paragraph = "这是一段足够长的中文正文，用来验证切点落在段落边界而不是句子中间。";
  const text = Array.from({ length: 20 }, (_, index) => `${paragraph}第${index}段。`).join("\n\n");
  let offset = 0;
  let collected = "";
  let rounds = 0;
  for (;;) {
    const result = applyBudget(text, { maxTokens: 60, offset });
    assert.ok(result.tokens <= 60 + 40, `第 ${rounds} 轮交付 token ${result.tokens} 超预算太多（标记本身也要算）`);
    if (result.truncated) {
      assert.ok(result.content.includes("…[已截断：全文"), "截断必须显式标记");
      assert.ok(result.content.includes(`offset=${result.nextOffset} 继续读`), "必须给出续读 offset");
      collected += result.content.slice(0, result.content.indexOf("\n\n…[已截断"));
      offset = result.nextOffset;
    } else {
      collected += result.content;
      break;
    }
    rounds += 1;
    assert.ok(rounds < 40, "续读不该无限循环");
  }
  assert.equal(collected.replace(/\n+$/u, ""), text.replace(/\n+$/u, ""), "多轮续读拼起来必须等于原文");
});

test("applyBudget: 切点优先段落边界，其次行尾", () => {
  const text = `${"a".repeat(300)}\n\n${"b".repeat(400)}`;
  const result = applyBudget(text, { maxChars: 320 });
  assert.equal(result.truncated, true);
  assert.ok(result.content.startsWith("a".repeat(300)), "应当在空行处切开，而不是切在 a 中间");
  assert.ok(!result.content.slice(0, 300).includes("b"));
});

test("applyBudget: 围栏代码块被切开时补上收尾围栏", () => {
  const text = `说明：\n\n\`\`\`js\n${"const x = 1;\n".repeat(60)}\`\`\`\n结束`;
  const result = applyBudget(text, { maxChars: 300 });
  assert.equal(result.truncated, true);
  const fences = result.content.match(/^```/gmu) ?? [];
  assert.equal(fences.length % 2, 0, "交付的代码围栏必须成对");
  assert.ok(result.content.includes("```"), "补的围栏要在");
});

test("applyBudget: maxChars 优先于 maxTokens；minChars 兜底不让参数把内容裁没", () => {
  const text = "字".repeat(3000);
  const byChars = applyBudget(text, { maxChars: 800, maxTokens: 10 });
  assert.equal(byChars.chars >= 800, true, "maxChars 生效时不受 maxTokens 影响");
  const tiny = applyBudget(text, { maxTokens: 1 });
  assert.ok(tiny.chars >= MIN_BUDGET_CHARS, "预算再小也要给够最小字符数");
});

test("applyBudget: offset 越界 / 非数字参数都不炸", () => {
  const text = "abcdef";
  assert.deepEqual(applyBudget(text, { offset: 99 }).content, "");
  assert.equal(applyBudget(text, { offset: 99 }).truncated, false);
  assert.equal(applyBudget(text, { offset: -5 }).content, "abcdef");
  assert.equal(applyBudget(text, { offset: Number.NaN }).content, "abcdef");
  assert.equal(applyBudget(undefined, {}).content, "");
  assert.equal(applyBudget(text, { maxChars: -1, maxTokens: -1 }).content, "abcdef");
});

test("budgetSummary: 截断与全文两种说法都不撒谎", () => {
  const full = applyBudget("字".repeat(100), { maxTokens: 100 });
  assert.ok(budgetSummary(full).includes("全文"));
  const cut = applyBudget("字".repeat(4000), { maxTokens: 100 });
  assert.ok(budgetSummary(cut).includes("全文约"));
  assert.ok(budgetSummary(cut).includes("本次给"));
});
