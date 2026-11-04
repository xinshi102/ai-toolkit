/**
 * @local/dsh-web-search-plus — 本地缓存（同一个 URL 不重复付费）。
 *
 * 存什么：**抽取后的正文**（markdown）+ 元数据，而不是原始 HTML。
 * 理由：省 token 的收益在「模型读到的东西」，而抽取是纯函数、确定性；
 * 缓存成品可以同时省掉网络与解析。密钥里带 `EXTRACTOR_VERSION`，
 * 抽取算法一升级，老条目自动失效（不会拿旧算法的结果糊弄人）。
 *
 * 淘汰：TTL（默认 7 天）+ LRU（默认 200 条 / 200 万字符）。
 * 落盘：单个 JSON 文件，原子写（临时文件 + rename），读到坏文件就当空缓存。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 抽取算法版本：改抽取逻辑时 +1，老缓存自动作废。 */
export const EXTRACTOR_VERSION = 1;

export const CACHE_VERSION = 1;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_MAX_CHARS = 2000000;

/**
 * 规范化 URL：去掉 fragment、小写 host、去掉默认端口、去掉追踪参数。
 * 同一篇文章的 `?utm_source=…` 变体必须命中同一条缓存，否则白花钱。
 */
export function normalizeUrl(url) {
  const raw = String(url ?? "").trim();
  if (raw === "") return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|spm|from|share_token)/iu.test(key)) parsed.searchParams.delete(key);
    }
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

/** 缓存键：抽取算法版本 + 规范化 URL 的 sha256 前 32 位。 */
export function cacheKey(url) {
  return createHash("sha256").update(`${EXTRACTOR_VERSION}\n${normalizeUrl(url)}`).digest("hex").slice(0, 32);
}

export function emptyCache() {
  return { version: CACHE_VERSION, entries: {}, stats: { hits: 0, misses: 0, writes: 0, evictions: 0 } };
}

/** 兼容读取：坏结构一律降级成空缓存（宁可重抓，不可崩）。 */
export function normalizeCache(value) {
  if (value === null || typeof value !== "object" || value.version !== CACHE_VERSION) return emptyCache();
  const entries = {};
  for (const [key, entry] of Object.entries(value.entries ?? {})) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.markdown !== "string" || typeof entry.url !== "string") continue;
    entries[key] = {
      key,
      url: entry.url,
      title: typeof entry.title === "string" ? entry.title : "",
      markdown: entry.markdown,
      statusCode: Number.isInteger(entry.statusCode) ? entry.statusCode : 200,
      fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0,
      lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : (Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0),
      hits: Number.isFinite(entry.hits) ? entry.hits : 0,
      // 展示用元数据：缓存命中时也要能原样告诉模型「正文区/最终地址/是否可疑」。
      // 少存这几个字段曾经让命中路径吐出 `region: undefined`，而宿主的
      // snapshotJsonValue 会因此整条工具输出判为非法（not lossless JSON）。
      finalUrl: typeof entry.finalUrl === "string" ? entry.finalUrl : entry.url,
      region: typeof entry.region === "string" ? entry.region : "",
      suspicious: entry.suspicious === true,
      notice: typeof entry.notice === "string" ? entry.notice : "",
    };
  }
  const stats = value.stats ?? {};
  return {
    version: CACHE_VERSION,
    entries,
    stats: {
      hits: Number.isFinite(stats.hits) ? stats.hits : 0,
      misses: Number.isFinite(stats.misses) ? stats.misses : 0,
      writes: Number.isFinite(stats.writes) ? stats.writes : 0,
      evictions: Number.isFinite(stats.evictions) ? stats.evictions : 0,
    },
  };
}

/**
 * 查缓存。
 * @param cache - 缓存对象。
 * @param url - 原始 URL。
 * @param options - `{ ttlMs, now }`。
 * @returns `{ hit, entry, key, ageMs, reason }`；`reason` ∈ `miss|expired|version`。
 */
export function cacheGet(cache, url, options = {}) {
  const key = cacheKey(url);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const entry = cache.entries[key];
  if (entry === undefined) return { hit: false, key, reason: "miss" };
  const ageMs = Math.max(0, now - entry.fetchedAt);
  if (ttlMs >= 0 && ageMs > ttlMs) return { hit: false, key, entry, ageMs, reason: "expired" };
  return { hit: true, key, entry, ageMs, reason: "hit" };
}

/**
 * 写入缓存（不可变：返回新对象），并按 LRU + 容量淘汰。
 * @param cache - 缓存对象。
 * @param entry - `{ url, title, markdown, statusCode, fetchedAt }`。
 * @param options - `{ now, maxEntries, maxChars }`。
 */
export function cachePut(cache, entry, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
  const key = cacheKey(entry.url);
  const next = {
    version: CACHE_VERSION,
    entries: {
      ...cache.entries,
      [key]: {
        key,
        url: normalizeUrl(entry.url),
        title: entry.title ?? "",
        markdown: entry.markdown ?? "",
        statusCode: entry.statusCode ?? 200,
        fetchedAt: now,
        lastUsedAt: now,
        hits: 0,
        finalUrl: entry.finalUrl ?? normalizeUrl(entry.url),
        region: entry.region ?? "",
        suspicious: entry.suspicious === true,
        notice: entry.notice ?? "",
      },
    },
    stats: { ...cache.stats, writes: cache.stats.writes + 1 },
  };
  return evict(next, { maxEntries, maxChars });
}

/** 记录一次命中（用于 LRU 与统计）。 */
export function cacheTouch(cache, key, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const entry = cache.entries[key];
  if (entry === undefined) return cache;
  return {
    ...cache,
    entries: { ...cache.entries, [key]: { ...entry, lastUsedAt: now, hits: entry.hits + 1 } },
    stats: { ...cache.stats, hits: cache.stats.hits + 1 },
  };
}

/** 记录一次未命中（统计用；`expired` 也计入 miss，但不清条目——可能只是暂时过期）。 */
export function cacheMiss(cache) {
  return { ...cache, stats: { ...cache.stats, misses: cache.stats.misses + 1 } };
}

/** LRU 淘汰：先按条目数，再按总字符数。 */
export function evict(cache, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
  const entries = Object.values(cache.entries).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const total = () => entries.reduce((sum, entry) => sum + entry.markdown.length, 0);
  let chars = total();
  let removed = 0;
  while ((entries.length - removed > maxEntries || chars > maxChars) && removed < entries.length - 1) {
    chars -= entries[removed].markdown.length;
    removed += 1;
  }
  if (removed === 0) return cache;
  const kept = {};
  for (const entry of entries.slice(removed)) kept[entry.key] = entry;
  return { ...cache, entries: kept, stats: { ...cache.stats, evictions: cache.stats.evictions + removed } };
}

/** 清理过期条目。 */
export function pruneCache(cache, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const kept = {};
  let removed = 0;
  for (const entry of Object.values(cache.entries)) {
    if (ttlMs >= 0 && now - entry.fetchedAt > ttlMs) {
      removed += 1;
      continue;
    }
    kept[entry.key] = entry;
  }
  if (removed === 0) return cache;
  return { ...cache, entries: kept, stats: { ...cache.stats, evictions: cache.stats.evictions + removed } };
}

/** 统计摘要（工具 `stats:true` 与日志用）。 */
export function cacheStats(cache, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const entries = Object.values(cache.entries);
  const chars = entries.reduce((sum, entry) => sum + entry.markdown.length, 0);
  const tokens = entries.reduce((sum, entry) => sum + Math.ceil(entry.markdown.length / 4), 0);
  const hits = entries.reduce((sum, entry) => sum + entry.hits, 0);
  const lastFetchedAt = entries.reduce((max, entry) => Math.max(max, entry.fetchedAt), 0);
  return {
    entries: entries.length,
    chars,
    tokens,
    hits,
    misses: cache.stats.misses,
    writes: cache.stats.writes,
    evictions: cache.stats.evictions,
    ageMs: lastFetchedAt === 0 ? 0 : Math.max(0, now - lastFetchedAt),
  };
}

/**
 * 文件缓存。全部 IO 集中在这里，纯逻辑（上面那些）留给测试。
 *
 * @param options - `{ file, now }`；`now` 便于测试注入。
 */
export function createStore(options = {}) {
  const file = options.file;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let cache = null;

  const loadFrom = (target) => {
    try {
      if (!existsSync(target)) return emptyCache();
      return normalizeCache(JSON.parse(readFileSync(target, "utf8")));
    } catch {
      return emptyCache();
    }
  };

  return {
    file,
    /** 首次访问才读盘；之后走内存。 */
    read() {
      if (cache === null) cache = loadFrom(file);
      return cache;
    },
    /** 原子写：临时文件 + rename，断电也不会留下半个 JSON。 */
    write(next) {
      cache = next;
      if (typeof file !== "string" || file === "") return false;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(next), "utf8");
        renameSync(temp, file);
        return true;
      } catch {
        return false;
      }
    },
    now,
    /** 测试/诊断用：丢掉内存副本。 */
    reload() {
      cache = loadFrom(file);
      return cache;
    },
  };
}

/** 默认缓存文件：`$DSH_HOME/storages/web-search-plus/cache.json`。 */
export function defaultCacheFile(env = process.env, home = homedir()) {
  const root = typeof env?.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : path.join(home, ".dsh");
  return path.join(root, "storages", "web-search-plus", "cache.json");
}
