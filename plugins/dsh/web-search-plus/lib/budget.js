/**
 * @local/dsh-web-search-plus — token 估算与预算裁剪。
 *
 * 估算法与宿主同源：`@deepseek-ai/dsh-token-meter` 的文本块定价就是
 * `ceil(字符数 / CHARS_PER_TOKEN)` 且 `CHARS_PER_TOKEN = 4`（固定密度启发式，
 * 不分中英文）。这里用同一条公式，好处是「插件报的省了多少 token」和
 * token-lever/上下文压力表显示的口径一致，不会出现两个数打架。
 *
 * 裁剪原则：
 * - 在**行边界**切，优先段落边界；
 * - 绝不把围栏代码块切成半截（必要时补上收尾围栏）；
 * - 被截断时给出明确的续读标记（含 offset），不假装全文就这么多。
 */

/** 与 `@deepseek-ai/dsh-token-meter` 的 CHARS_PER_TOKEN 保持一致。 */
export const CHARS_PER_TOKEN = 4;

/** 再小也要给这么多字符，否则预算参数会把内容裁成一句半。 */
export const MIN_BUDGET_CHARS = 200;

/**
 * 估算文本 token 数（与宿主密度启发式同源）。
 * @param text - 任意文本。
 * @returns token 估算值（`ceil(码点数 / 4)`，按码点算所以 emoji 不吃亏）。
 */
export function estimateTokens(text) {
  const chars = [...String(text ?? "")].length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 按预算裁剪正文。
 *
 * @param text - 已抽取的 markdown 正文。
 * @param options - `{ maxTokens, maxChars, offset, minChars }`：
 *   `maxChars` 优先于 `maxTokens`；`offset` 是本次从第几个字符开始（续读）。
 * @returns `{ content, truncated, nextOffset, chars, tokens, totalChars, totalTokens, marker }`
 */
export function applyBudget(text, options = {}) {
  const source = String(text ?? "");
  const totalChars = [...source].length;
  const totalTokens = estimateTokens(source);
  const offsetRaw = Number.isFinite(options.offset) ? Math.floor(options.offset) : 0;
  const offset = Math.min(Math.max(0, offsetRaw), totalChars);
  const minChars = Number.isFinite(options.minChars) && options.minChars > 0 ? Math.floor(options.minChars) : MIN_BUDGET_CHARS;
  const requested = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : (Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.floor(options.maxTokens) * CHARS_PER_TOKEN : 0);
  const budget = requested > 0 ? Math.max(requested, Math.min(minChars, totalChars - offset)) : totalChars - offset;

  const points = [...source];
  const remaining = totalChars - offset;
  if (remaining <= budget) {
    const content = points.slice(offset).join("");
    return {
      content,
      truncated: false,
      nextOffset: null,
      chars: [...content].length,
      tokens: estimateTokens(content),
      totalChars,
      totalTokens,
      marker: "",
    };
  }

  // 全程按**码点**下标运算：offset/totalChars 是码点数，用 UTF-16 下标会在 emoji 处错位
  const cut = cutIndex(points, offset, budget);
  let content = points.slice(offset, offset + cut).join("").replace(/[ \t]+$/u, "").replace(/\n{3,}$/u, "\n\n").trimEnd();
  // 围栏代码块被切开时补上收尾围栏，避免模型读到半截代码
  if ((content.match(/^```/gmu) ?? []).length % 2 === 1) content += "\n```";
  const nextOffset = offset + [...content].length;
  const marker = `\n\n…[已截断：全文 ${totalChars} 字符 / 约 ${totalTokens} token；本次给出第 ${offset + 1}–${nextOffset} 字符（约 ${estimateTokens(content)} token）。用 offset=${nextOffset} 继续读。]`;
  const withMarker = `${content}${marker}`;
  return {
    content: withMarker,
    truncated: true,
    nextOffset,
    chars: [...withMarker].length,
    tokens: estimateTokens(withMarker),
    totalChars,
    totalTokens,
    marker,
  };
}

/**
 * 在码点数组里找切点：优先「空行」（段落边界），其次行尾，最后词边界。
 * 只从预算的 60% 之后往回找，免得把内容切得太碎。
 */
function cutIndex(points, offset, budget) {
  const limit = Math.min(offset + budget, points.length);
  const floor = Math.max(offset + 1, offset + Math.floor(budget * 0.6));
  let paragraph = -1;
  let lineBreak = -1;
  let space = -1;
  for (let i = limit - 1; i >= floor; i -= 1) {
    const char = points[i];
    if (char === "\n") {
      if (points[i + 1] === "\n") {
        paragraph = i + 1;
        break;
      }
      if (lineBreak === -1) lineBreak = i + 1;
    } else if (char === " " && space === -1) {
      space = i + 1;
    }
  }
  const found = paragraph !== -1 ? paragraph : (lineBreak !== -1 ? lineBreak : space);
  return (found === -1 ? limit : found) - offset;
}

/**
 * 友好的一行摘要：给工具输出头部与日志用。
 * @param result - {@link applyBudget} 的返回值。
 */
export function budgetSummary(result) {
  const reduction = result.totalTokens === 0 ? 0 : Math.round((1 - result.tokens / result.totalTokens) * 100);
  return result.truncated
    ? `${result.chars} 字符 / 约 ${result.tokens} token（全文约 ${result.totalTokens} token，本次给 ${100 - reduction}%）`
    : `${result.chars} 字符 / 约 ${result.tokens} token（全文）`;
}
