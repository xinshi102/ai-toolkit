/**
 * 本工作区适配：把 `dsh-settings` 的两个助手函数本地化。
 *
 * 为什么必须这样做：npm 上发布的 `@deepseek-ai/dsh-settings@0.1.5-rc.2` 只导出
 * `SettingsConflictError / SettingsProvider / default / redactSecrets`，
 * **没有** `installSettingsSection` 与 `settingsNamespace`；而 app 自带的同名同版本构建里**有**
 * （App 构建比发布版多这两个导出）。也就是说「把依赖 pin 到宿主版本」并不足以保证 API 一致——
 * 遇到这种只在 app 构建里存在的助手，只能按它的语义本地实现。
 *
 * 语义来源（等价抄写）：宿主安装里的
 * `…/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js`
 * （社区版时代是 `/Applications/DSH Desktop.app/Contents/Resources/app/…`。路径随宿主变，
 *  定位请用 `scripts/lib/host-app.mjs` 的 `resolveHostModule(host, "@deepseek-ai/dsh-settings/lib/index.js")`，不要写死）
 *   - `installSettingsSection(ctx, ns, schema, entry, hooks)`
 *       → `ctx.inject(['settings'], (c) => c.settings.installSection(ctx, ns, schema, entry, hooks))`
 *   - `settingsNamespace(value)` → 匹配 `^[a-z][a-z0-9-]*$` 后原样返回，否则抛 TypeError
 *
 * 附带收益：这个包不再依赖 `@deepseek-ai/dsh-settings`（profile 里少一份宿主包副本）。
 */

/** 命名空间模式（与 app 构建里的 NAMESPACE_PATTERN 一致）。 */
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * 校验并返回 settings 命名空间。
 * @param value - 形如 `search-mcp` 的命名空间。
 * @returns 原值。
 */
export function settingsNamespace(value) {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
  }
  return value;
}

/**
 * 把一段设置挂到 settings 服务上（等到 `settings` 就绪才注册）。
 * @param ctx - 插件的 ctx。
 * @param ns - 命名空间。
 * @param schema - schemastery schema。
 * @param entry - 初始配置。
 * @param hooks - `{ validate, setSource }`。
 */
export function installSettingsSection(ctx, ns, schema, entry, hooks) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks);
  });
}
