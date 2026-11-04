/**
 * @local/dsh-plan-map — 任务卡（`task_card_template.md`）→ 计划树节点。
 *
 * 为什么单独一层：xinshiimprove 的任务卡是「档位 + 目标 + 边界 + 子任务表 + 验收方式」的固定形状，
 * 用普通大纲解析会得到一堆乱节点（表格行被当标题、`#` 列被当节点）。这里认得出任务卡，
 * 就把它**如实**映射成树：
 *
 * - `# 任务：<任务名>` → 根节点；根节点备注带上档位/目标/预算/整体验收方式（阶段门）
 * - `## 子任务拆分` 表格的每一行 → 一个子节点（标题=子任务，备注=产出 + 验收方式）
 * - 状态列 `待开始 / 进行中 / 已验收`（容错写法见 {@link mapCardStatus}）→ pending / active / done
 * - 根节点状态由子任务汇总：全验收→done，有进行中或部分完成→active，否则 pending
 *
 * 纯函数、零依赖；`parseImport` 把它和普通大纲解析合到同一个入口，
 * 保证 execute 与投影回放走的是**同一条**解析逻辑（否则重启后树会变样）。
 */

/** `# 任务：<任务名>`（中英文冒号都认）。 */
const TASK_HEADING = /^#\s*(?:任务|Task)\s*[：:]\s*(.+?)\s*$/mu;
/** 认得出「子任务拆分」这一节。 */
const SUBTASK_SECTION = /子任务|subtask/i;
/** 表头列名别名（列顺序可以变，按名字找列）。 */
const COLUMNS = {
  index: ["#", "序号", "编号", "no.", "no"],
  title: ["子任务", "任务", "任务项", "子任务名", "subtask"],
  output: ["产出", "交付物", "output"],
  acceptance: ["验收方式", "验收", "验收标准", "acceptance"],
  status: ["状态", "进度", "status"],
};

/** 计划树的状态取值范围（与 plan-map 主模块一致）。 */
export const TREE_STATUSES = ["pending", "active", "done", "blocked"];

/** 任务卡里的状态写法 → 计划树状态。 */
const STATUS_RULES = [
  [/已验收|已完成|已交付|已合并|完成|done|complete/i, "done"],
  [/阻塞|卡住|被阻塞|blocked/i, "blocked"],
  [/进行中|在做|开发中|进行|wip|active|in[ _-]?progress/i, "active"],
  [/待开始|未开始|待办|待处理|排队|pending|todo|^$/i, "pending"],
];

/**
 * 状态列 → 计划树状态。
 * @param raw - 卡片里的原始状态文本。
 * @returns `{ status, known }`；认不出的写法回落 `pending` 且 `known=false`（便于提示人工核对）。
 */
export function mapCardStatus(raw) {
  const text = String(raw ?? "").replace(/\*\*|`/gu, "").trim();
  for (const [pattern, status] of STATUS_RULES) if (pattern.test(text)) return { status, known: true };
  return { status: "pending", known: false };
}

/** 是否是任务卡（有 `# 任务：` 且至少一节子任务表）。 */
export function isTaskCard(text) {
  const source = String(text ?? "");
  if (!TASK_HEADING.test(source)) return false;
  return splitSections(source).some((section) => SUBTASK_SECTION.test(section.title) && parseTable(section.body).rows.length > 0);
}

/** 按 `##` 切小节；返回 `[{ title, body }]`（正文含该节标题之后到下一节之前的行）。 */
export function splitSections(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const sections = [];
  let current = { title: "", body: [] };
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/u.exec(line);
    if (match !== null) {
      sections.push(current);
      current = { title: match[1].trim(), body: [] };
      continue;
    }
    current.body.push(line);
  }
  sections.push(current);
  return sections.filter((section) => section.title !== "" || section.body.some((line) => line.trim() !== ""));
}

/** 小节正文里的普通文本（去掉表格行与空行），用于档位/目标/验收方式这类短字段。 */
function plainText(body) {
  return body
    .filter((line) => !line.trim().startsWith("|"))
    .join("\n")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split("\n")
    .map((line) => line.replace(/^[-*+]\s*/u, "").trim())
    .filter((line) => line !== "" && !/^[-|:\s]+$/u.test(line))
    .join("；")
    .trim();
}

/** 解析 markdown 表格：返回 `{ header, rows }`（rows 是单元格数组）。 */
export function parseTable(body) {
  const lines = (Array.isArray(body) ? body : String(body ?? "").split(/\r?\n/u)).filter((line) => line.trim().startsWith("|"));
  if (lines.length === 0) return { header: [], rows: [] };
  const cellsOf = (line) => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
  const header = cellsOf(lines[0]);
  const rows = lines
    .slice(1)
    .filter((line) => !/^\|[\s:|-]+\|?$/u.test(line.trim()))
    .map(cellsOf)
    .filter((cells) => cells.some((cell) => cell !== ""));
  return { header, rows };
}

/** 按别名把表头映射成列下标；找不到就返回空对象（调用方退回位置约定）。 */
function columnIndex(header) {
  const found = {};
  header.forEach((raw, index) => {
    const name = raw.replace(/[*`]/gu, "").trim().toLowerCase();
    for (const [key, aliases] of Object.entries(COLUMNS)) {
      if (found[key] !== undefined) continue;
      if (aliases.some((alias) => alias.toLowerCase() === name)) found[key] = index;
    }
  });
  return found;
}

/**
 * 解析任务卡。
 * @param text - 任务卡 markdown。
 * @returns `{ task, tier, goal, boundaries, budget, files, irreversible, acceptance, notes, subtasks }`；
 *   `subtasks` 每项 `{ index, title, output, acceptance, rawStatus, status, known }`。
 */
export function parseTaskCard(text) {
  const source = String(text ?? "");
  const task = TASK_HEADING.exec(source)?.[1]?.trim() ?? "";
  const sections = splitSections(source);
  const byTitle = (pattern) => sections.find((section) => pattern.test(section.title));
  const sectionText = (pattern) => {
    const section = byTitle(pattern);
    return section === undefined ? "" : plainText(section.body);
  };

  const subtaskSection = byTitle(SUBTASK_SECTION);
  const table = subtaskSection === undefined ? { header: [], rows: [] } : parseTable(subtaskSection.body);
  const index = columnIndex(table.header);
  const at = (cells, key, fallback) => {
    const position = index[key] ?? fallback;
    const value = cells[position] ?? "";
    return value.replace(/\*\*|`/gu, "").trim();
  };
  const subtasks = table.rows
    .map((cells, order) => {
      const hasIndexColumn = index.index !== undefined || /^\d+$/u.test(cells[0] ?? "");
      const title = at(cells, "title", hasIndexColumn ? 1 : 0);
      const mapped = mapCardStatus(at(cells, "status", hasIndexColumn ? 4 : 3));
      return {
        index: at(cells, "index", 0) || String(order + 1),
        title,
        output: at(cells, "output", hasIndexColumn ? 2 : 1),
        acceptance: at(cells, "acceptance", hasIndexColumn ? 3 : 2),
        rawStatus: at(cells, "status", hasIndexColumn ? 4 : 3),
        status: mapped.status,
        known: mapped.known,
      };
    })
    .filter((item) => item.title !== "");

  const tierRaw = sectionText(/档位/u);
  const tier = /(^|\s)(XL|L|M|S)(\s|$|\/|（|\()/iu.exec(tierRaw)?.[2]?.toUpperCase() ?? tierRaw.slice(0, 24);
  return {
    task,
    tier,
    goal: sectionText(/目标/u),
    boundaries: sectionText(/边界|范围/u),
    budget: sectionText(/预算/u),
    files: sectionText(/涉及文件|文件/u),
    irreversible: sectionText(/不可逆/u),
    acceptance: sectionText(/^验收方式$/u) || sectionText(/验收方式/u),
    notes: sectionText(/备注/u),
    subtasks,
  };
}

/** 子任务状态汇总成根节点状态。 */
export function rollupStatus(subtasks) {
  if (subtasks.length === 0) return "pending";
  const statuses = subtasks.map((item) => item.status);
  if (statuses.every((status) => status === "done")) return "done";
  if (statuses.some((status) => status === "active" || status === "done" || status === "blocked")) return "active";
  return "pending";
}

/**
 * 任务卡 → 计划树节点（与 `parseOutline` 同形状：`{ id, parent, title, status, note }`）。
 * @param card - {@link parseTaskCard} 的结果。
 * @param options - `{ maxNodes, maxNote, maxTitle }`。
 */
export function cardToNodes(card, options = {}) {
  const maxNodes = Number.isInteger(options.maxNodes) ? options.maxNodes : 200;
  const maxTitle = Number.isInteger(options.maxTitle) ? options.maxTitle : 120;
  const maxNote = Number.isInteger(options.maxNote) ? options.maxNote : 600;
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/gu, " ").trim();
    return text.length <= max ? text : `${text.slice(0, max)}…`;
  };
  const subtasks = card.subtasks.slice(0, Math.max(0, maxNodes - 1));
  const rootNote = [
    card.tier === "" ? "" : `档位：${card.tier}`,
    card.goal === "" ? "" : `目标：${card.goal}`,
    card.budget === "" ? "" : `预算：${card.budget}`,
    card.boundaries === "" ? "" : `边界：${card.boundaries}`,
    card.acceptance === "" ? "" : `验收方式（阶段门）：${card.acceptance}`,
  ].filter((line) => line !== "").join(" ｜ ");
  const nodes = [{
    id: "p1",
    parent: "",
    title: clip(card.task === "" ? "未命名任务卡" : card.task, maxTitle),
    status: rollupStatus(subtasks),
    note: clip(rootNote, maxNote),
  }];
  subtasks.forEach((item, order) => {
    const note = [
      item.output === "" ? "" : `产出：${item.output}`,
      item.acceptance === "" ? "" : `验收：${item.acceptance}`,
      item.known === false ? `状态「${item.rawStatus}」认不出，按 pending 处理` : "",
    ].filter((line) => line !== "").join(" ｜ ");
    nodes.push({
      id: `p${order + 2}`,
      parent: "p1",
      title: clip(item.title, maxTitle),
      status: item.status,
      note: clip(note, maxNote),
    });
  });
  return nodes;
}

/**
 * 导入入口：任务卡走任务卡解析，其余仍走大纲解析。
 * execute 与投影回放**必须**都调它，否则同一次导入在两处会得到不同的树。
 */
export function parseImport(text, options = {}, parseOutline) {
  if (!isTaskCard(text)) return parseOutline(text, options);
  return cardToNodes(parseTaskCard(text), options);
}
