/**
 * @local/dsh-xinshi-ledger — 规则观察台账（observations.md）的读写内核（纯函数，零依赖）。
 *
 * 为什么需要它：xinshiimprove 的规则演进闭环第 ① 环要求「任务结束追加规则观察」，
 * 而台账有三条硬规矩——**只追加不改不删**、条目格式固定、新增条目必须同步更新「频次索引」
 * （闸 0 的判据）。人在编辑器里手抄容易漏字段、漏更新索引；交给 agent 手写更容易串格式。
 * 这里把「格式 + 追加 + 索引 + 门槛判定」做成可测试的纯函数，插件只负责 IO。
 *
 * 不变式（写回前会被校验）：
 * 1. 已有条目的标题行与正文一字不动；
 * 2. 新条目只能是**追加**在文件末尾；
 * 3. 频次索引表是唯一会被改写的区域，且只动数据行。
 */

/** 台账头里必须出现的东西：认错文件时立刻停手，不要乱写。 */
export const LEDGER_TITLE = "# 规则观察记录";
export const INDEX_HEADING = "## 频次索引";

/** 四问归类：观察阶段唯一的分类维度（`observations.md` §条目格式）。 */
export const CATEGORIES = ["未覆盖", "表述误解", "执行效果不佳", "本该触发却未触发"];

/** 状态流转（`observations.md` §状态流转）。 */
export const STATUSES = ["待分析", "已分析", "执行中", "执行问题-观察中", "已关闭"];

/**
 * 闸 0 频次门槛（`governance.md` §改动门槛 闸 0）：
 * L0/L1 需 3 次，L2 需 2 次，L3~L5 需 1 次。
 */
export const THRESHOLDS = { L0: 3, L1: 3, L2: 2, L3: 1, L4: 1, L5: 1 };

export const LEVELS = Object.keys(THRESHOLDS);

/** 某个层级需要多少次同类观察。 */
export function needFor(level) {
  const key = String(level ?? "").toUpperCase();
  return THRESHOLDS[key] ?? THRESHOLDS.L2;
}

/** 闸 0 判定文案：达标就明说「已达」，没达标就说还差几次（不是含糊的"未达门槛"）。 */
export function verdictFor(count, level) {
  const key = String(level ?? "").toUpperCase();
  const need = needFor(key);
  if (!Number.isFinite(count) || count <= 0) return `${key} 需 ${need} 次（还没有观察）`;
  if (count >= need) return `已达 ${key} 的 ${need} 次门槛`;
  return `${key} 需 ${need} 次（还差 ${need - count} 次）`;
}

function stripBold(text) {
  return String(text ?? "").replace(/\*\*/gu, "").trim();
}

/** 从 `O002、O004、**O006**` 这种写法里取出全部观察编号。 */
export function parseIds(text) {
  return [...String(text ?? "").matchAll(/O\d{3}/gu)].map((match) => match[0]);
}

/** 条目标题：`## O001　协议链路全量注入…`（编号与标题之间是全角空格）。 */
const ENTRY_HEADING = /^##\s+(O\d{3})[\s\u3000]+(.+?)\s*$/u;

/**
 * 解析台账。
 * @param text - `observations.md` 全文。
 * @returns `{ entries, rows, table, nextId }`；`table` 为频次索引表在文中的行区间（供改写用）。
 * @throws 结构不对时抛错（宁可拒绝写入，也不要写坏台账）。
 */
export function parseLedger(text) {
  const source = String(text ?? "");
  if (!source.includes(LEDGER_TITLE)) throw new Error(`不是规则观察台账：缺少标题「${LEDGER_TITLE}」`);
  const lines = source.split("\n");

  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = ENTRY_HEADING.exec(lines[i]);
    if (match !== null) entries.push({ id: match[1], title: match[2], line: i });
  }

  const headingIndex = lines.findIndex((line) => line.trim() === INDEX_HEADING);
  if (headingIndex === -1) throw new Error(`不是规则观察台账：缺少「${INDEX_HEADING}」小节`);
  let headerIndex = -1;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^\|\s*问题类别\s*\|/u.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) throw new Error("频次索引表结构不对：找不到「| 问题类别 |」表头");
  let end = headerIndex + 2; // 表头 + 分隔行
  while (end < lines.length && lines[end].trim().startsWith("|")) end += 1;

  const rows = [];
  for (let i = headerIndex + 2; i < end; i += 1) {
    const cells = lines[i].split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4) continue;
    rows.push({
      line: i,
      // 注意：频次索引第一列是「问题类别」（一行一个**问题**的类名），
      // 不是条目里的「四问归类」（未覆盖/表述误解/…）。两者别混。
      problemClass: stripBold(cells[0]),
      rawProblemClass: cells[0],
      ids: parseIds(cells[1]),
      count: Number.parseInt(stripBold(cells[2]), 10),
      verdict: stripBold(cells[3]),
      raw: [cells[0], cells[1], cells[2], cells[3]],
    });
  }

  const nextNumber = entries.reduce((max, entry) => Math.max(max, Number.parseInt(entry.id.slice(1), 10)), 0) + 1;
  return {
    entries,
    rows,
    nextId: `O${String(nextNumber).padStart(3, "0")}`,
    table: { header: headerIndex, start: headerIndex + 2, end },
    lines,
  };
}

/** 按台账格式渲染一条新条目（字段顺序与 `observations.md` §条目格式 一致）。 */
export function formatEntry(observation) {
  const {
    id, title, date, task, rules, status = "待分析", category,
    phenomenon, evidence, analysis = {}, destination = "待分析，未转提案",
  } = observation;
  const lines = [
    `## ${id}　${String(title).trim()}`,
    "",
    `- 日期：${date}`,
    `- 任务：${task === undefined || String(task).trim() === "" ? "（未填）" : task}`,
    `- 涉及规则：${rules === undefined || String(rules).trim() === "" ? "无对应规则" : rules}`,
    `- 状态：${status}`,
    `- 四问归类：${category}`,
    "",
    "### 现象",
    String(phenomenon).trim(),
    "",
    "### 证据",
    String(evidence).trim(),
    "",
    "### 分析",
    `- A1 规则问题 还是 执行问题：${analysis.a1 ?? "待②环判断"}`,
    `- A2 若是规则问题，改哪一层：${analysis.a2 ?? "待②环判断"}`,
    `- A3 怎么验证改完真的解决了：${analysis.a3 ?? "待②环判断"}`,
    "",
    "### 去向",
    String(destination).trim(),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * 更新频次索引：同类别累加，新类别新增一行；达标就把整行加粗（沿用台账里已有的写法）。
 * @returns 新的数据行数组（不含表头与分隔行）。
 */
export function upsertRow(rows, { problemClass, id, level }) {
  const next = rows.map((row) => ({ ...row, dirty: false }));
  const found = next.find((row) => row.problemClass === problemClass);
  const target = found ?? { problemClass, ids: [], count: 0, verdict: "", line: -1, dirty: true };
  if (found === undefined) next.push(target);
  target.dirty = true;
  if (!target.ids.includes(id)) target.ids.push(id);
  target.count = target.ids.length;
  const need = needFor(level);
  target.reached = target.count >= need;
  const levelKey = String(level).toUpperCase();
  target.verdict = target.reached
    ? `已达 ${levelKey} 的 ${need} 次门槛`
    : `${levelKey} 需 ${need} 次（还差 ${need - target.count} 次）`;
  return next;
}

/** 渲染索引表的数据行（达标行加粗，与台账里 O002/O004/O006 那行一致）。 */
export function renderRow(row) {
  // 没动过的行原样吐回去：改一个类别不该把别人的加粗和括注抹掉（也保证「只追加」能对拍）
  if (row.dirty !== true && Array.isArray(row.raw) && row.raw.length >= 4) return `| ${row.raw.join(" | ")} |`;
  const ids = row.ids.map((id, index) => (row.reached === true && index === row.ids.length - 1 ? `**${id}**` : id)).join("、");
  if (row.reached === true) {
    return `| **${row.problemClass}** | ${ids} | **${row.count}** | **${row.verdict}** |`;
  }
  return `| ${row.problemClass} | ${ids} | ${row.count} | ${row.verdict} |`;
}

/**
 * 追加一条观察并同步频次索引。
 *
 * @param text - 台账全文。
 * @param observation - `{ title, category, phenomenon, evidence, task, rules, level, ... }`。
 * @param options - `{ date }`（便于测试注入日期）。
 * @returns `{ text, id, category, count, reached, verdict, need }`
 */
export function applyObservation(text, observation, options = {}) {
  const parsed = parseLedger(text);
  const category = String(observation.category ?? "").trim();
  if (!CATEGORIES.includes(category)) {
    throw new Error(`四问归类必须是：${CATEGORIES.join(" / ")}（收到「${category}」）`);
  }
  const problemClass = String(observation.problemClass ?? "").trim();
  if (problemClass === "") throw new Error("缺少「问题类别」（频次索引的行键：同一类问题复用同一个类名才能累计次数）");
  if (problemClass.includes("|")) throw new Error("「问题类别」里不能有竖线（会破坏 markdown 表格）");
  const title = String(observation.title ?? "").trim();
  if (title === "") throw new Error("缺少「一句话现象」（title）");
  if (String(observation.phenomenon ?? "").trim() === "") throw new Error("缺少「现象」正文");
  if (String(observation.evidence ?? "").trim() === "") throw new Error("缺少「证据」——没有证据的观察不入台账");
  const level = String(observation.level ?? "L2").toUpperCase();
  if (!LEVELS.includes(level)) throw new Error(`层级必须是 ${LEVELS.join(" / ")}（收到「${level}」）`);

  const id = parsed.nextId;
  const entry = formatEntry({
    ...observation,
    id,
    title,
    category,
    date: observation.date ?? options.date ?? new Date().toISOString().slice(0, 10),
  });

  const rows = upsertRow(parsed.rows, { problemClass, id, level });
  const tableLines = rows.map(renderRow);
  const lines = [...parsed.lines];
  // 只替换数据行：表头与分隔行原样保留
  lines.splice(parsed.table.start, parsed.table.end - parsed.table.start, ...tableLines);
  let output = `${lines.join("\n").replace(/\n+$/u, "")}\n`;

  // 新条目只能追加在文件末尾
  output = `${output}\n${entry}`;
  const row = rows.find((item) => item.problemClass === problemClass);
  return {
    text: output,
    id,
    category,
    problemClass,
    level,
    count: row.count,
    need: needFor(level),
    reached: row.reached === true,
    verdict: row.verdict,
  };
}

/**
 * 写回前的守卫：确认「只追加」——原有内容必须是新内容的前缀（除索引表行以外）。
 * 实现方式：把旧文与新文都按索引表行剔除后比对。
 */
export function assertAppendOnly(before, after) {
  const oldParsed = parseLedger(before);
  const newParsed = parseLedger(after);
  const withoutTable = (parsed) => parsed.lines.filter((_, index) => index < parsed.table.start || index >= parsed.table.end).join("\n");
  const oldRest = withoutTable(oldParsed);
  const newRest = withoutTable(newParsed);
  if (!newRest.startsWith(oldRest)) {
    throw new Error("守卫拦下：写回不是「只追加」，原有条目被改动了");
  }
  if (newParsed.entries.length !== oldParsed.entries.length + 1) {
    throw new Error(`守卫拦下：条目数应为 ${oldParsed.entries.length + 1}，实际 ${newParsed.entries.length}`);
  }
  for (let i = 0; i < oldParsed.entries.length; i += 1) {
    if (oldParsed.entries[i].id !== newParsed.entries[i].id || oldParsed.entries[i].title !== newParsed.entries[i].title) {
      throw new Error(`守卫拦下：原条目 ${oldParsed.entries[i].id} 被改动`);
    }
  }
  return true;
}

/** 台账现状：给「改规则前统计频次」用的一览。 */
export function ledgerStatus(text) {
  const parsed = parseLedger(text);
  const rows = parsed.rows.map((row) => {
    const levelMatch = /L([0-5])/u.exec(row.verdict);
    const level = levelMatch === null ? undefined : `L${levelMatch[1]}`;
    const need = level === undefined ? undefined : needFor(level);
    return {
      problemClass: row.problemClass,
      ids: row.ids,
      count: row.count,
      level: level ?? "",
      need: need ?? 0,
      reached: level === undefined ? /已达/u.test(row.verdict) : row.count >= need,
      verdict: row.verdict,
    };
  });
  return {
    entries: parsed.entries.length,
    lastId: parsed.entries.length === 0 ? "" : parsed.entries[parsed.entries.length - 1].id,
    nextId: parsed.nextId,
    rows,
    reached: rows.filter((row) => row.reached).map((row) => row.problemClass),
  };
}
